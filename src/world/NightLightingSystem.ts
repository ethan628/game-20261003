/**
 * NightLightingSystem.ts - 區塊光照圖 (Web Worker) 與城市夜景光學系統
 * 遵循 RULES.md：
 * 1. 採用 Web Worker 預先計算之 256m 區塊光照圖取代逐盞路燈貼花，徹底消除硬邊小光斑與 Overdraw
 * 2. 嚴格效能預算：移除地面貼花 Mesh，夜間 Draw Calls 減少 1 個；CPU 逐幀耗時控制在 0.15 ms 以內
 * 3. 實體與路面共用全域光照圖取樣，保證路面、人行道、斑馬線連續照亮，光斑柔和自然交疊
 * 4. 支援 95% 以上光照覆蓋率自適應補燈、OSM 路燈優先、小巷壁燈、雨夜倒影與 F16 熱圖檢測
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PropGenerator } from './PropGenerator.ts';
import { SignboardGenerator } from './SignboardGenerator.ts';
import { TrafficSignalSystem } from '../systems/traffic-signals/TrafficSignalSystem.ts';
import { BuildingGenerator } from './BuildingGenerator.ts';
import { RoadGenerator } from './RoadGenerator.ts';
import { TerrainFeatureGenerator } from './TerrainFeatureGenerator.ts';
import { EnvironmentGenerator } from './EnvironmentGenerator.ts';
import { StreetLampPlacement, LampPlacementItem } from './lightmap/StreetLampPlacement.ts';
import { ChunkLightmapManager } from './lightmap/ChunkLightmapManager.ts';
import { LightSource, OcclusionSegment, LightCoverageReport } from './lightmap/LightmapTypes.ts';
import { RoadFeature, IntersectionFeature, BuildingFeature, ShopFeature, OsmWorldData } from '../geo/OsmTypes.ts';

export interface NightLightingStats {
  activeDecals: number;
  drawCalls: number;
  cpuTimeMs: number;
}

export class NightLightingSystem {
  private scene: THREE.Scene;
  private propGen: PropGenerator;
  private signboardGen: SignboardGenerator;
  public signalSystem: TrafficSignalSystem;
  public buildingGen: BuildingGenerator;
  public roadGen: RoadGenerator;
  public terrainGen?: TerrainFeatureGenerator;
  public envGen?: EnvironmentGenerator;

  // 1. 燈頭光暈 Billboard (InstancedMesh, 1 Draw Call, 保留)
  private lampGlowMesh: THREE.InstancedMesh | null = null;
  // 2. 錐形光柱 (InstancedMesh, 1 Draw Call, 高畫質/雨霧時可見, 保留)
  private lampConesMesh: THREE.InstancedMesh | null = null;
  // 3. 濕潤路面長條倒影貼花 (InstancedMesh, 1 Draw Call, 雨夜保留)
  private wetReflectMesh: THREE.InstancedMesh | null = null;

  // 貼圖快取
  private radialGlowTexture: THREE.CanvasTexture | null = null;
  private coneGradientTexture: THREE.CanvasTexture | null = null;
  private streakTexture: THREE.CanvasTexture | null = null;

  // 智慧路燈配置器與區塊光照圖管理器
  private lampPlacement: StreetLampPlacement;
  private lightmapManager: ChunkLightmapManager;

  // 當前地圖快取資料
  private currentRoads: RoadFeature[] = [];
  private currentIntersections: IntersectionFeature[] = [];
  private currentBuildings: BuildingFeature[] = [];
  private currentShops: ShopFeature[] = [];
  private currentOsmData: OsmWorldData | null = null;

  // 快取之路燈資料供燈頭光暈使用
  private cachedLamps: LampPlacementItem[] = [];

  // 暫存運算變數
  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();

  // 可微調參數 (K 面板與 localStorage 聯動)
  private baseNightBrightness = CONFIG.NIGHT_LIGHTING.BASE_NIGHT_BRIGHTNESS;
  private lampBrightness = 1.0;          // 0.5 ~ 2.0
  private lampRadiusMultiplier = 1.0;    // 0.7 ~ 1.6
  private lampMaxSpacing = CONFIG.NIGHT_LIGHTING.LIGHTMAP.DEFAULT_SPACING; // 20 ~ 40m
  private windowLightRatio = CONFIG.NIGHT_LIGHTING.WINDOW_LIGHT_RATIO;
  private urbanLightPollution = CONFIG.NIGHT_LIGHTING.URBAN_LIGHT_POLLUTION;
  private groundVisibility = CONFIG.NIGHT_LIGHTING.GROUND_VISIBILITY;

  // 效能統計
  private lastCpuTimeMs = 0;
  private lastWindowUpdateHour = -999;
  private lastWindowUpdateNight = false;

  constructor(
    scene: THREE.Scene,
    propGen: PropGenerator,
    signboardGen: SignboardGenerator,
    signalSystem: TrafficSignalSystem,
    buildingGen: BuildingGenerator,
    roadGen: RoadGenerator
  ) {
    this.scene = scene;
    this.propGen = propGen;
    this.signboardGen = signboardGen;
    this.signalSystem = signalSystem;
    this.buildingGen = buildingGen;
    this.roadGen = roadGen;

    this.lampPlacement = new StreetLampPlacement({
      maxSpacing: this.lampMaxSpacing,
      radiusMultiplier: this.lampRadiusMultiplier,
      intensityMultiplier: this.lampBrightness
    });

    this.lightmapManager = ChunkLightmapManager.getInstance();

    this.initTextures();
    this.initMeshes();
  }

  // --- 貼圖生成 (Canvas 2D 極速漸層) ---

  private initTextures(): void {
    // 燈頭光暈
    const c1 = document.createElement('canvas');
    const size = 128;
    c1.width = size;
    c1.height = size;
    const ctx1 = c1.getContext('2d')!;
    const rad1 = ctx1.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    rad1.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
    rad1.addColorStop(0.35, 'rgba(255, 230, 180, 0.6)');
    rad1.addColorStop(0.7, 'rgba(255, 180, 80, 0.15)');
    rad1.addColorStop(1.0, 'rgba(255, 140, 40, 0.0)');
    ctx1.fillStyle = rad1;
    ctx1.fillRect(0, 0, size, size);

    this.radialGlowTexture = new THREE.CanvasTexture(c1);
    this.radialGlowTexture.colorSpace = THREE.SRGBColorSpace;

    // 光柱垂直漸層
    const c2 = document.createElement('canvas');
    c2.width = 32;
    c2.height = 128;
    const ctx2 = c2.getContext('2d')!;
    const grad2 = ctx2.createLinearGradient(0, 0, 0, 128);
    grad2.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
    grad2.addColorStop(0.25, 'rgba(255, 255, 255, 0.20)');
    grad2.addColorStop(0.65, 'rgba(255, 255, 255, 0.06)');
    grad2.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
    ctx2.fillStyle = grad2;
    ctx2.fillRect(0, 0, 32, 128);

    this.coneGradientTexture = new THREE.CanvasTexture(c2);
    this.coneGradientTexture.colorSpace = THREE.SRGBColorSpace;

    // 雨夜濕潤路面長條倒影貼圖
    const c3 = document.createElement('canvas');
    c3.width = 64;
    c3.height = 256;
    const ctx3 = c3.getContext('2d')!;
    const grad3 = ctx3.createLinearGradient(0, 0, 0, 256);
    grad3.addColorStop(0, 'rgba(255, 255, 255, 0.0)');
    grad3.addColorStop(0.2, 'rgba(255, 255, 255, 0.45)');
    grad3.addColorStop(0.5, 'rgba(255, 255, 255, 0.75)');
    grad3.addColorStop(0.8, 'rgba(255, 255, 255, 0.35)');
    grad3.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
    ctx3.fillStyle = grad3;
    ctx3.fillRect(0, 0, 64, 256);

    this.streakTexture = new THREE.CanvasTexture(c3);
    this.streakTexture.colorSpace = THREE.SRGBColorSpace;
  }

  // --- 初始化 InstancedMesh (僅保留燈頭光暈與倒影，完全移除靜態地面貼花 Mesh) ---

  private initMeshes(): void {
    const maxLamps = 1200; // 支援全城擴充路燈

    // 1. 燈頭光暈 Billboard (精巧尺寸，不遮擋視野，1 Draw Call)
    const glowGeo = new THREE.PlaneGeometry(0.85, 0.85);
    const glowMat = new THREE.MeshBasicMaterial({
      map: this.radialGlowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    this.lampGlowMesh = new THREE.InstancedMesh(glowGeo, glowMat, maxLamps);
    this.lampGlowMesh.name = 'Night_LampGlow_Instanced';
    this.lampGlowMesh.frustumCulled = false;
    this.lampGlowMesh.renderOrder = 4;
    this.lampGlowMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxLamps * 3), 3);
    this.lampGlowMesh.count = 0;
    this.scene.add(this.lampGlowMesh);

    // 2. 窄錐形光柱 (雨霧時可見，晴天隱藏)
    const coneGeo = new THREE.CylinderGeometry(0.15, 2.0, 5.8, 12, 1, true);
    coneGeo.translate(0, -2.9, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      map: this.coneGradientTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      opacity: CONFIG.NIGHT_LIGHTING.LIGHT_CONE_OPACITY
    });
    this.lampConesMesh = new THREE.InstancedMesh(coneGeo, coneMat, maxLamps);
    this.lampConesMesh.name = 'Night_LampCones_Instanced';
    this.lampConesMesh.frustumCulled = false;
    this.lampConesMesh.renderOrder = 2;
    this.lampConesMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxLamps * 3), 3);
    this.lampConesMesh.count = 0;
    this.scene.add(this.lampConesMesh);

    // 3. 雨夜濕潤路面長條倒影 (受光照圖強度驅動，上限 80)
    const maxWetStreaks = 80;
    const wetGeo = new THREE.PlaneGeometry(2.4, 14.0);
    wetGeo.rotateX(-Math.PI / 2);
    const wetMat = new THREE.MeshBasicMaterial({
      map: this.streakTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    this.wetReflectMesh = new THREE.InstancedMesh(wetGeo, wetMat, maxWetStreaks);
    this.wetReflectMesh.name = 'Night_WetReflect_Instanced';
    this.wetReflectMesh.frustumCulled = false;
    this.wetReflectMesh.renderOrder = 3;
    this.wetReflectMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxWetStreaks * 3), 3);
    this.wetReflectMesh.count = 0;
    this.scene.add(this.wetReflectMesh);
  }

  /**
   * 當新地圖載入或參數變更時重建路燈佈局並啟動 Worker 計算光照圖
   */
  public async rebuildWorldLighting(
    roads: RoadFeature[],
    intersections: IntersectionFeature[] = [],
    buildings: BuildingFeature[] = [],
    shops: ShopFeature[] = [],
    osmData?: OsmWorldData | null,
    progressCb?: (p: number, t: string) => void
  ): Promise<void> {
    this.currentRoads = roads;
    this.currentIntersections = intersections;
    this.currentBuildings = buildings;
    this.currentShops = shops;
    this.currentOsmData = osmData ?? null;

    if (progressCb) {
      this.lightmapManager.setProgressCallback(progressCb);
    }

    // 1. 執行路燈智能佈局（95% 以上覆蓋率保證）
    this.lampPlacement.setConfig({
      maxSpacing: this.lampMaxSpacing,
      radiusMultiplier: this.lampRadiusMultiplier,
      intensityMultiplier: this.lampBrightness
    });

    this.cachedLamps = this.lampPlacement.generate(roads, intersections, osmData);

    // 2. 同步 3D 燈桿模型到 PropGenerator
    const lampTransforms: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();
    const sideY = CONFIG.ROADS.ELEVATION.SIDEWALK;

    for (let i = 0; i < this.cachedLamps.length; i++) {
      const lamp = this.cachedLamps[i];
      dummy.position.set(lamp.pos.x, sideY, lamp.pos.z);
      dummy.rotation.set(0, lamp.rotY, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      lampTransforms.push(dummy.matrix.clone());
    }

    this.propGen.updateStreetLamps(lampTransforms, this.scene);

    // 3. 收集所有光源（路燈、店面溢光、交通號誌、窗戶）
    const lightSources: LightSource[] = this.lampPlacement.toLightSources();

    // 3.1 店面與騎樓溢光
    const cStoreThemes = ['7-eleven', '全家', 'family', '全聯', 'ok', 'hilife', '萊爾富'];
    for (let s = 0; s < shops.length; s++) {
      const shop = shops[s];
      const isCStore = cStoreThemes.some(t => (shop.name || '').toLowerCase().includes(t));
      const r = isCStore ? 8.0 : 6.0;
      const intensity = isCStore ? 1.25 : 0.75;
      const themeColor = this.signboardGen.getShopColorTheme(shop);
      const col = new THREE.Color(themeColor.accent || themeColor.bg || '#ff9e3b');

      lightSources.push({
        id: `shop_${s}`,
        type: 'shop',
        x: shop.point.x,
        y: 1.5,
        z: shop.point.z,
        radius: r,
        intensity,
        color: { r: col.r, g: col.g, b: col.b },
        turnOnThreshold: 0.05 // 店面入夜即亮
      });
    }

    // 3.2 交通號誌路口色光
    for (let k = 0; k < intersections.length; k++) {
      const inter = intersections[k];
      if (inter.hasSignals) {
        lightSources.push({
          id: `signal_${k}`,
          type: 'signal',
          x: inter.center.x,
          y: 6.0,
          z: inter.center.z,
          radius: 10.0,
          intensity: 0.65,
          color: { r: 0.9, g: 0.7, b: 0.2 },
          turnOnThreshold: 0.0 // 號誌常亮
        });
      }
    }

    // 4. 收集建築 2D 遮擋線段
    const occluders: OcclusionSegment[] = [];
    for (let b = 0; b < buildings.length; b++) {
      const pts = buildings[b].footprint;
      if (!pts || pts.length < 2) continue;
      for (let p = 0; p < pts.length - 1; p++) {
        occluders.push([pts[p].x, pts[p].z, pts[p + 1].x, pts[p + 1].z]);
      }
      if (pts.length > 2) {
        occluders.push([pts[pts.length - 1].x, pts[pts.length - 1].z, pts[0].x, pts[0].z]);
      }
    }

    // 5. 啟動 Web Worker 多區塊光照圖計算與快取
    const configHash = `sp${Math.round(this.lampMaxSpacing)}_rd${Math.round(this.lampRadiusMultiplier * 10)}_br${Math.round(this.lampBrightness * 10)}`;
    await this.lightmapManager.rebuildLightmaps(lightSources, occluders, configHash);

    console.log(`[NightLightingSystem] 光照圖系統就緒！路燈: ${this.cachedLamps.length} 盞，總光源: ${lightSources.length} 個，遮擋線段: ${occluders.length} 條`);
  }

  public async rebuildLampCache(progressCb?: (p: number, t: string) => void): Promise<void> {
    if (this.currentRoads.length > 0) {
      await this.rebuildWorldLighting(
        this.currentRoads,
        this.currentIntersections,
        this.currentBuildings,
        this.currentShops,
        this.currentOsmData,
        progressCb
      );
    }
  }

  // --- 逐幀更新 (極致輕量，CPU < 0.15 ms) ---

  public update(
    playerPos: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    nightFactor: number,
    wetness: number,
    rainIntensity: number,
    currentHour: number,
    totalGameTimeSec: number
  ): void {
    const t0 = performance.now();

    // 1. 計算黃昏逐盞點亮開關比率 (turnOnRatio)
    // 黃昏入夜過程中，依隨機門檻陸續點亮，深夜全部點亮
    const turnOnRatio = Math.min(1.0, nightFactor * 1.35);

    // 2. 同步全域光照圖 Uniforms
    this.lightmapManager.updateNightUniforms(
      nightFactor,
      turnOnRatio,
      this.groundVisibility,
      this.baseNightBrightness
    );

    // 白天且無濕潤時，隱藏所有光暈與倒影
    if (nightFactor <= 0.005 && wetness <= 0.01) {
      if (this.lampGlowMesh) this.lampGlowMesh.count = 0;
      if (this.lampConesMesh) this.lampConesMesh.count = 0;
      if (this.wetReflectMesh) this.wetReflectMesh.count = 0;
      this.lastCpuTimeMs = performance.now() - t0;
      return;
    }

    const maxDist = CONFIG.NIGHT_LIGHTING.STREETLIGHT_MAX_DISTANCE; // 150m
    const maxDistSq = maxDist * maxDist;

    // 3. 篩選玩家 150m 內的燈頭光暈
    interface NearbyLamp {
      distSq: number;
      data: LampPlacementItem;
    }
    const nearbyLamps: NearbyLamp[] = [];

    for (let i = 0; i < this.cachedLamps.length; i++) {
      const lamp = this.cachedLamps[i];
      const dx = lamp.headPos.x - playerPos.x;
      const dz = lamp.headPos.z - playerPos.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < maxDistSq) {
        nearbyLamps.push({ distSq: dSq, data: lamp });
      }
    }

    nearbyLamps.sort((a, b) => a.distSq - b.distSq);
    const activeLampCount = Math.min(150, nearbyLamps.length);

    // 4. 更新燈頭光暈 Billboard (lampGlowMesh)
    if (this.lampGlowMesh) {
      const glowColors = this.lampGlowMesh.instanceColor!;
      const camPos = camera.position;

      for (let i = 0; i < activeLampCount; i++) {
        const item = nearbyLamps[i];
        const lamp = item.data;

        // 隨機接觸不良微顫 (3%)
        let flickerMult = 1.0;
        if (lamp.isFlicker) {
          const t = totalGameTimeSec + lamp.flickerSeed;
          const cycle = t % 24.0;
          if (cycle < 0.35) {
            flickerMult = 0.25 + 0.75 * Math.sin(t * 42.0);
          } else if (cycle > 12.0 && cycle < 12.18) {
            flickerMult = 0.15;
          }
        }

        // 開關狀態
        const lampOn = Math.max(0.0, Math.min(1.0, (turnOnRatio - lamp.turnOnThreshold + 0.08) / 0.16));
        const effectiveIntensity = nightFactor * this.baseNightBrightness * flickerMult * lampOn;

        this.dummy.position.copy(lamp.headPos);
        this.dummy.lookAt(camPos);
        const camDist = Math.sqrt(item.distSq);
        const distFade = THREE.MathUtils.clamp(1.0 - camDist / 140.0, 0.25, 1.0);
        const glowScale = (0.75 + rainIntensity * 0.35) * distFade;
        this.dummy.scale.set(glowScale, glowScale, glowScale);
        this.dummy.updateMatrix();
        this.lampGlowMesh.setMatrixAt(i, this.dummy.matrix);

        this.tmpColor.copy(lamp.color).multiplyScalar(effectiveIntensity * 0.95);
        glowColors.setXYZ(i, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
      }

      this.lampGlowMesh.count = activeLampCount;
      this.lampGlowMesh.instanceMatrix.needsUpdate = true;
      glowColors.needsUpdate = true;

      if (this.lampConesMesh) {
        this.lampConesMesh.count = 0;
      }
    }

    // 5. 雨夜濕潤路面長條倒影 (wetReflectMesh)
    if (this.wetReflectMesh) {
      if ((wetness > 0.08 || rainIntensity > 0.08) && nightFactor > 0.05) {
        let wetCount = 0;
        const wetColors = this.wetReflectMesh.instanceColor!;
        const reflectCount = Math.min(80, nearbyLamps.length);

        for (let w = 0; w < reflectCount; w++) {
          const lamp = nearbyLamps[w].data;
          const toCamX = camera.position.x - lamp.pos.x;
          const toCamZ = camera.position.z - lamp.pos.z;
          const streakAngle = Math.atan2(toCamX, toCamZ);

          const rx = lamp.pos.x + Math.sin(streakAngle) * 2.5;
          const rz = lamp.pos.z + Math.cos(streakAngle) * 2.5;

          this.dummy.position.set(rx, 0.038, rz);
          this.dummy.rotation.set(0, streakAngle, 0);
          this.dummy.scale.set(1.0, 1.0, 1.0);
          this.dummy.updateMatrix();
          this.wetReflectMesh.setMatrixAt(wetCount, this.dummy.matrix);

          const wetStrength = Math.min(1.0, wetness * 1.2 + rainIntensity * 0.8) * nightFactor * 0.65;
          this.tmpColor.copy(lamp.color).multiplyScalar(wetStrength);
          wetColors.setXYZ(wetCount, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
          wetCount++;
        }

        this.wetReflectMesh.count = wetCount;
        this.wetReflectMesh.instanceMatrix.needsUpdate = true;
        wetColors.needsUpdate = true;
      } else {
        this.wetReflectMesh.count = 0;
      }
    }

    // 6. 更新建築窗戶夜間亮暗
    this.updateBuildingWindowsLighting(nightFactor, currentHour, totalGameTimeSec);

    this.lastCpuTimeMs = performance.now() - t0;
  }

  private updateBuildingWindowsLighting(nightFactor: number, currentHour: number, timeSec: number): void {
    const winMesh = this.buildingGen.getWindowsMesh();
    if (!winMesh) return;
    const count = winMesh.count;
    if (count === 0) return;

    if (!winMesh.instanceColor) {
      const colors = new Float32Array(count * 3);
      winMesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    }

    const isLateNight = currentHour >= 0.0 && currentHour < 5.0;
    const hourInt = Math.floor(currentHour * 10);
    const isNightNow = nightFactor > 0.05;
    const shouldRefreshAll = hourInt !== this.lastWindowUpdateHour || isNightNow !== this.lastWindowUpdateNight;

    if (!shouldRefreshAll && nightFactor <= 0.01) return;

    this.lastWindowUpdateHour = hourInt;
    this.lastWindowUpdateNight = isNightNow;

    const colorsAttr = winMesh.instanceColor;
    const baseLitChance = (isLateNight ? 0.20 : 0.52) * this.windowLightRatio;

    const hash = (n: number) => {
      const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
      return s - Math.floor(s);
    };

    const warmLight = new THREE.Color(0xffdf80);
    const coolLight = new THREE.Color(0xf1f5f9);
    const darkGlass = new THREE.Color(0x182030);
    const tvBlue = new THREE.Color(0x38bdf8);

    for (let i = 0; i < count; i++) {
      const hVal = hash(i);
      const isLit = hVal < baseLitChance && nightFactor > 0.02;

      if (isLit) {
        if (hVal < 0.03) {
          const tvFlicker = 0.85 + 0.15 * Math.sin(timeSec * 8.0 + i * 3.0);
          this.tmpColor.copy(tvBlue).multiplyScalar(tvFlicker * nightFactor);
        } else if (hVal < baseLitChance * 0.82) {
          this.tmpColor.copy(warmLight).multiplyScalar(1.25 * nightFactor);
        } else {
          this.tmpColor.copy(coolLight).multiplyScalar(1.10 * nightFactor);
        }
      } else {
        this.tmpColor.copy(darkGlass);
      }

      colorsAttr.setXYZ(i, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
    }

    colorsAttr.needsUpdate = true;
  }

  public setEnvironmentGenerator(gen: EnvironmentGenerator): void {
    this.envGen = gen;
  }

  public setTerrainFeatureGenerator(gen: TerrainFeatureGenerator): void {
    this.terrainGen = gen;
  }

  // --- K 面板與除錯參數接口 ---

  public setLocation(name: string): void {
    this.lightmapManager.setLocation(name);
  }

  public setBaseNightBrightness(val: number): void {
    this.baseNightBrightness = Math.max(0.4, Math.min(2.5, val));
  }

  public getBaseNightBrightness(): number {
    return this.baseNightBrightness;
  }

  public setLampBrightness(val: number): void {
    this.lampBrightness = Math.max(0.5, Math.min(2.0, val));
  }

  public getLampBrightness(): number {
    return this.lampBrightness;
  }

  public setLampRadiusMultiplier(val: number): void {
    this.lampRadiusMultiplier = Math.max(0.7, Math.min(1.6, val));
  }

  public getLampRadiusMultiplier(): number {
    return this.lampRadiusMultiplier;
  }

  public setLampMaxSpacing(val: number): void {
    this.lampMaxSpacing = Math.max(20.0, Math.min(40.0, val));
  }

  public getLampMaxSpacing(): number {
    return this.lampMaxSpacing;
  }

  // 相容舊接口
  public setLampDecalIntensity(val: number): void {
    this.setLampBrightness(val);
  }

  public getLampDecalIntensity(): number {
    return this.lampBrightness;
  }

  public setWindowLightRatio(val: number): void {
    this.windowLightRatio = Math.max(0.0, Math.min(1.5, val));
    this.lastWindowUpdateHour = -999;
  }

  public getWindowLightRatio(): number {
    return this.windowLightRatio;
  }

  public setUrbanLightPollution(val: number): void {
    this.urbanLightPollution = Math.max(0.0, Math.min(2.0, val));
  }

  public getUrbanLightPollution(): number {
    return this.urbanLightPollution;
  }

  public setGroundVisibility(val: number): void {
    this.groundVisibility = Math.max(0.5, Math.min(2.0, val));
  }

  public getGroundVisibility(): number {
    return this.groundVisibility;
  }

  public toggleHeatmapMode(): boolean {
    const next = !this.lightmapManager.getHeatmapMode();
    this.lightmapManager.setHeatmapMode(next);
    return next;
  }

  public getHeatmapMode(): boolean {
    return this.lightmapManager.getHeatmapMode();
  }

  public getCoverageReport(): LightCoverageReport | null {
    return this.lampPlacement.getLastReport();
  }

  public getStats(): NightLightingStats {
    let dc = 0;
    if (this.lampGlowMesh && this.lampGlowMesh.count > 0) dc++;
    if (this.lampConesMesh && this.lampConesMesh.count > 0) dc++;
    if (this.wetReflectMesh && this.wetReflectMesh.count > 0) dc++;

    return {
      activeDecals: 0, // 逐盞地面貼花已完全由區塊光照圖取代 (0 個地面貼花)
      drawCalls: dc,
      cpuTimeMs: Number(this.lastCpuTimeMs.toFixed(2))
    };
  }

  public dispose(): void {
    const list = [this.lampGlowMesh, this.lampConesMesh, this.wetReflectMesh];
    for (const m of list) {
      if (m) {
        this.scene.remove(m);
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
        else m.material.dispose();
      }
    }
    this.lightmapManager.dispose();
  }
}
