/**
 * NightLightingSystem.ts - GTA 風格城市夜景假光與氛圍系統
 * 遵循 RULES.md：
 * 1. 嚴禁新增真實 PointLight，全數採用 InstancedMesh 假光貼花 (Decals)、光暈 (Billboards)、光柱 (Cones) 與 Shader 技巧
 * 2. 嚴格效能預算：全部新增夜間效果合計 Draw Calls <= 6 (預算 <= 8)
 * 3. CPU 逐幀耗時控制在 0.3 ms 以內
 * 4. 支援暖橘路燈光斑、燈頭光暈、3% 隨機接觸不良閃爍、騎樓/店家地面溢光、號誌地面光斑、雨天濕潤路面長條倒影
 * 5. 建築窗戶夜間隨機亮燈（深夜衰減）與周圍路燈照亮 Shader 驅動
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PropGenerator } from './PropGenerator.ts';
import { SignboardGenerator } from './SignboardGenerator.ts';
import { TrafficSignalSystem } from '../systems/traffic-signals/TrafficSignalSystem.ts';
import { BuildingGenerator } from './BuildingGenerator.ts';
import { RoadGenerator } from './RoadGenerator.ts';

export interface NightLightingStats {
  activeDecals: number;
  drawCalls: number;
  cpuTimeMs: number;
}

export interface LampCachedItem {
  pos: THREE.Vector3;
  groundPos: THREE.Vector3;
  polePos: THREE.Vector3;
  rotY: number;
  color: THREE.Color;
  isFlicker: boolean;
  flickerSeed: number;
}

export class NightLightingSystem {
  private scene: THREE.Scene;
  private propGen: PropGenerator;
  private signboardGen: SignboardGenerator;
  private signalSystem: TrafficSignalSystem;
  private buildingGen: BuildingGenerator;
  private roadGen: RoadGenerator;

  // 1. 路燈地面光斑貼花 (InstancedMesh, 1 Draw Call)
  private lampDecalsMesh: THREE.InstancedMesh | null = null;
  // 2. 燈頭光暈 Billboard (InstancedMesh, 1 Draw Call)
  private lampGlowMesh: THREE.InstancedMesh | null = null;
  // 3. 錐形光柱 (InstancedMesh, 1 Draw Call, 高畫質/雨霧時可見)
  private lampConesMesh: THREE.InstancedMesh | null = null;
  // 4. 店面/招牌地面溢光貼花 (InstancedMesh, 1 Draw Call)
  private shopDecalsMesh: THREE.InstancedMesh | null = null;
  // 5. 交通號誌地面色斑貼花 (InstancedMesh, 1 Draw Call)
  private signalDecalsMesh: THREE.InstancedMesh | null = null;
  // 6. 濕潤路面長條倒影貼花 (InstancedMesh, 1 Draw Call)
  private wetReflectMesh: THREE.InstancedMesh | null = null;

  // 貼圖快取
  private radialGlowTexture: THREE.CanvasTexture | null = null;
  private coneGradientTexture: THREE.CanvasTexture | null = null;
  private streakTexture: THREE.CanvasTexture | null = null;

  // 路燈快取資料
  private lampData: LampCachedItem[] = [];

  // 暫存運算變數
  private dummy = new THREE.Object3D();
  private tmpColor = new THREE.Color();
  private nearbyLightPos: THREE.Vector3[] = [];
  private nearbyLightCols: THREE.Vector4[] = [];

  // 使用者可微調參數 (K 面板與 localStorage 聯動)
  private baseNightBrightness = CONFIG.NIGHT_LIGHTING.BASE_NIGHT_BRIGHTNESS;
  private lampDecalIntensity = CONFIG.NIGHT_LIGHTING.STREETLIGHT_GROUND_DECAL_INTENSITY;
  private windowLightRatio = CONFIG.NIGHT_LIGHTING.WINDOW_LIGHT_RATIO;
  private urbanLightPollution = CONFIG.NIGHT_LIGHTING.URBAN_LIGHT_POLLUTION;
  private groundVisibility = CONFIG.NIGHT_LIGHTING.GROUND_VISIBILITY;

  // 效能統計
  private activeDecalsCount = 0;
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

    // 初始化 8 盞近處路燈暫存陣列供 Shader 傳遞
    for (let i = 0; i < 8; i++) {
      this.nearbyLightPos.push(new THREE.Vector3());
      this.nearbyLightCols.push(new THREE.Vector4(0, 0, 0, 0));
    }

    this.initTextures();
    this.initMeshes();
  }

  // --- 貼圖生成 (Canvas 2D 極速漸層) ---

  private initTextures(): void {
    // A. 圓形光斑與光暈 (像素級 smoothstep 衰減至邊緣恰好為 0，無任何硬邊與方框溢出)
    const c1 = document.createElement('canvas');
    const size = 256;
    c1.width = size;
    c1.height = size;
    const ctx1 = c1.getContext('2d')!;
    const imgData = ctx1.createImageData(size, size);
    const center = (size - 1) * 0.5;
    const maxR = size * 0.5;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - center) / maxR;
        const dy = (y - center) / maxR;
        const dist = Math.hypot(dx, dy);
        let alpha = 0.0;
        if (dist < 1.0) {
          // smoothstep: 从 1 平滑过渡到 0，边缘导数为 0
          const t = 1.0 - dist;
          const s = t * t * (3.0 - 2.0 * t);
          alpha = Math.pow(s, 2.2); // 柔和自然高斯感衰减
        }
        const idx = (y * size + x) * 4;
        imgData.data[idx] = 255;
        imgData.data[idx + 1] = 255;
        imgData.data[idx + 2] = 255;
        imgData.data[idx + 3] = Math.round(alpha * 255);
      }
    }
    ctx1.putImageData(imgData, 0, 0);

    this.radialGlowTexture = new THREE.CanvasTexture(c1);
    this.radialGlowTexture.colorSpace = THREE.SRGBColorSpace;
    this.radialGlowTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.radialGlowTexture.wrapT = THREE.ClampToEdgeWrapping;

    // B. 光柱垂直漸層 (上亮下透，柔和不突兀)
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

    // C. 濕潤路面長條倒影貼圖
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

  // --- 初始化 InstancedMesh (嚴格控制 Draw Calls) ---

  private initMeshes(): void {
    const maxLamps = 180;
    const maxDecals = 360; // 支援每盞路燈雙貼花 (車道 + 人行道靠牆)

    // 1. 路燈地面光斑貼花 (半徑 6~9m，以 15.0x15.0 平面為基準，柔和自然加色混合)
    const decalGeo = new THREE.PlaneGeometry(15.0, 15.0);
    decalGeo.rotateX(-Math.PI / 2);
    const decalMat = new THREE.MeshBasicMaterial({
      map: this.radialGlowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: THREE.DoubleSide
    });
    this.lampDecalsMesh = new THREE.InstancedMesh(decalGeo, decalMat, maxDecals);
    this.lampDecalsMesh.name = 'Night_LampDecals_Instanced';
    this.lampDecalsMesh.frustumCulled = false;
    this.lampDecalsMesh.renderOrder = 3;
    this.lampDecalsMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxDecals * 3), 3);
    this.lampDecalsMesh.count = 0;
    this.scene.add(this.lampDecalsMesh);

    // 2. 燈頭光暈 Billboard (精巧尺寸，不遮擋視野)
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

    // 3. 窄錐形光柱 (寬度約 3~5m，底端半徑 2.0m，高度 5.8m，低透明度，晴天隱藏)
    const coneGeo = new THREE.CylinderGeometry(0.15, 2.0, 5.8, 12, 1, true);
    coneGeo.translate(0, -2.9, 0); // 頂部原點對齊燈頭
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

    // 4. 店面/招牌地面溢光貼花 (上限 90)
    const maxShops = 90;
    const shopDecalGeo = new THREE.PlaneGeometry(5.2, 3.8);
    shopDecalGeo.rotateX(-Math.PI / 2);
    const shopDecalMat = new THREE.MeshBasicMaterial({
      map: this.radialGlowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    this.shopDecalsMesh = new THREE.InstancedMesh(shopDecalGeo, shopDecalMat, maxShops);
    this.shopDecalsMesh.name = 'Night_ShopDecals_Instanced';
    this.shopDecalsMesh.frustumCulled = false;
    this.shopDecalsMesh.renderOrder = 3;
    this.shopDecalsMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxShops * 3), 3);
    this.shopDecalsMesh.count = 0;
    this.scene.add(this.shopDecalsMesh);

    // 5. 交通號誌地面色斑貼花 (上限 60)
    const maxSignals = 60;
    const signalDecalGeo = new THREE.PlaneGeometry(6.5, 6.5);
    signalDecalGeo.rotateX(-Math.PI / 2);
    const signalDecalMat = new THREE.MeshBasicMaterial({
      map: this.radialGlowTexture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    this.signalDecalsMesh = new THREE.InstancedMesh(signalDecalGeo, signalDecalMat, maxSignals);
    this.signalDecalsMesh.name = 'Night_SignalDecals_Instanced';
    this.signalDecalsMesh.frustumCulled = false;
    this.signalDecalsMesh.renderOrder = 3;
    this.signalDecalsMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxSignals * 3), 3);
    this.signalDecalsMesh.count = 0;
    this.scene.add(this.signalDecalsMesh);

    // 6. 濕潤路面長條倒影貼花 (上限 80)
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
   * 當新地圖載入或路網重建時刷新路燈快取位置
   */
  public rebuildLampCache(): void {
    this.lampData = [];
    const transforms = this.propGen.getLampTransforms();

    const warmOrange = new THREE.Color(CONFIG.NIGHT_LIGHTING.COLOR_WARM_ORANGE);
    const warmWhite = new THREE.Color(CONFIG.NIGHT_LIGHTING.COLOR_WARM_WHITE);

    const mPos = new THREE.Vector3();
    const mQuat = new THREE.Quaternion();
    const mScale = new THREE.Vector3();
    const mEuler = new THREE.Euler();

    for (let i = 0; i < transforms.length; i++) {
      transforms[i].decompose(mPos, mQuat, mScale);
      mEuler.setFromQuaternion(mQuat);
      const rotY = mEuler.y;

      // 燈臂朝向：local +X 偏移 1.2m，高度 6.4m
      const headX = mPos.x + 1.2 * Math.cos(rotY);
      const headZ = mPos.z - 1.2 * Math.sin(rotY);
      const headPos = new THREE.Vector3(headX, mPos.y + 6.4, headZ);
      const groundPos = new THREE.Vector3(headX, 0.035, headZ);
      const polePos = new THREE.Vector3(mPos.x, 0.185, mPos.z);

      // 色彩混合：70% 暖橘 (3000K)，30% 暖白
      const isWarm = (i * 7 + 3) % 10 < 7;
      const col = (isWarm ? warmOrange : warmWhite).clone();

      // 3% 隨機接觸不良路燈
      const isFlicker = (i * 137 + 19) % 100 < 3;
      const flickerSeed = (i * 31.7) % 1000;

      this.lampData.push({
        pos: headPos,
        groundPos,
        polePos,
        rotY,
        color: col,
        isFlicker,
        flickerSeed
      });
    }
  }

  // --- 逐幀更新 (極致優化，CPU < 0.3 ms) ---

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
    this.activeDecalsCount = 0;

    // 若尚未快取路燈，嘗試重建
    if (this.lampData.length === 0 && this.propGen.getLampTransforms().length > 0) {
      this.rebuildLampCache();
    }

    // 白天且完全無濕潤時，隱藏所有夜間貼花以節省渲染負載
    if (nightFactor <= 0.005 && wetness <= 0.01) {
      if (this.lampDecalsMesh) this.lampDecalsMesh.count = 0;
      if (this.lampGlowMesh) this.lampGlowMesh.count = 0;
      if (this.lampConesMesh) this.lampConesMesh.count = 0;
      if (this.shopDecalsMesh) this.shopDecalsMesh.count = 0;
      if (this.signalDecalsMesh) this.signalDecalsMesh.count = 0;
      if (this.wetReflectMesh) this.wetReflectMesh.count = 0;
      this.lastCpuTimeMs = performance.now() - t0;
      return;
    }

    const maxDist = CONFIG.NIGHT_LIGHTING.STREETLIGHT_MAX_DISTANCE; // 150m
    const maxDistSq = maxDist * maxDist;

    // 1. 篩選玩家 150m 內的路燈
    interface NearbyLamp {
      idx: number;
      distSq: number;
      data: LampCachedItem;
    }
    const nearbyLamps: NearbyLamp[] = [];

    for (let i = 0; i < this.lampData.length; i++) {
      const lamp = this.lampData[i];
      const dx = lamp.groundPos.x - playerPos.x;
      const dz = lamp.groundPos.z - playerPos.z;
      const dSq = dx * dx + dz * dz;
      if (dSq < maxDistSq) {
        nearbyLamps.push({ idx: i, distSq: dSq, data: lamp });
      }
    }

    // 依距離排序，保留最近 150 盞
    nearbyLamps.sort((a, b) => a.distSq - b.distSq);
    const activeLampCount = Math.min(150, nearbyLamps.length);

    // 2. 更新 8 盞最近路燈資料供建築與地面 Shader 注入使用
    const closest8Count = Math.min(8, nearbyLamps.length);
    for (let i = 0; i < 8; i++) {
      if (i < closest8Count) {
        const l = nearbyLamps[i].data;
        this.nearbyLightPos[i].copy(l.pos);
        // a 通道存放強度
        this.nearbyLightCols[i].set(
          l.color.r,
          l.color.g,
          l.color.b,
          nightFactor * this.baseNightBrightness
        );
      } else {
        this.nearbyLightCols[i].set(0, 0, 0, 0);
      }
    }

    // 3. 更新路燈地面光斑貼花 (lampDecalsMesh) 與燈頭光暈 (lampGlowMesh)
    if (this.lampDecalsMesh && this.lampGlowMesh) {
      const decalColors = this.lampDecalsMesh.instanceColor!;
      const glowColors = this.lampGlowMesh.instanceColor!;

      const camPos = camera.position;
      let decalCount = 0;

      for (let i = 0; i < activeLampCount; i++) {
        const item = nearbyLamps[i];
        const lamp = item.data;

        // 3% 接觸不良路燈隨機閃爍運算
        let flickerMult = 1.0;
        if (lamp.isFlicker) {
          const t = totalGameTimeSec + lamp.flickerSeed;
          // 每 24 秒週期性接觸不良微顫與瞬間瞬滅
          const cycle = t % 24.0;
          if (cycle < 0.35) {
            flickerMult = 0.25 + 0.75 * Math.sin(t * 42.0);
          } else if (cycle > 12.0 && cycle < 12.18) {
            flickerMult = 0.15;
          }
        }

        const effectiveIntensity =
          nightFactor * this.lampDecalIntensity * this.baseNightBrightness * flickerMult;

        // A1. 車道路面柔和光斑 (y=0.035, 平鋪車道，純加色混合，smoothstep 邊緣至 0)
        this.dummy.position.set(lamp.groundPos.x, 0.035, lamp.groundPos.z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1.0, 1.0, 1.0);
        this.dummy.updateMatrix();
        this.lampDecalsMesh.setMatrixAt(decalCount, this.dummy.matrix);

        this.tmpColor.copy(lamp.color).multiplyScalar(effectiveIntensity * 0.82);
        decalColors.setXYZ(decalCount, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
        decalCount++;

        // A2. 人行道與靠牆反彈光斑 (y=0.185，在路燈立柱基底，照亮人行道地磚與建築底部，消除硬邊切痕)
        this.dummy.position.set(lamp.polePos.x, 0.185, lamp.polePos.z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(0.70, 0.70, 0.70);
        this.dummy.updateMatrix();
        this.lampDecalsMesh.setMatrixAt(decalCount, this.dummy.matrix);

        this.tmpColor.copy(lamp.color).multiplyScalar(effectiveIntensity * 0.50);
        decalColors.setXYZ(decalCount, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
        decalCount++;

        // B. 燈頭光暈 Billboard (朝向鏡頭，依距離平滑衰減，近看不過曝)
        this.dummy.position.copy(lamp.pos);
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

      this.lampDecalsMesh.count = decalCount;
      this.lampDecalsMesh.instanceMatrix.needsUpdate = true;
      decalColors.needsUpdate = true;

      this.lampGlowMesh.count = activeLampCount;
      this.lampGlowMesh.instanceMatrix.needsUpdate = true;
      glowColors.needsUpdate = true;

      // 突兀錐形光柱完全關閉，防止出現黑色三角形幾何陰影偽影
      if (this.lampConesMesh) {
        this.lampConesMesh.count = 0;
      }

      this.activeDecalsCount += decalCount;
    }

    // 4. 店面與招牌前方地面溢光貼花 (shopDecalsMesh)
    if (this.shopDecalsMesh) {
      const shopItems = this.signboardGen.getSignboardItems ? this.signboardGen.getSignboardItems() : [];
      let shopCount = 0;
      const shopColors = this.shopDecalsMesh.instanceColor!;

      for (let s = 0; s < shopItems.length && shopCount < 90; s++) {
        const item = shopItems[s];
        if (!item.mesh) continue;
        const sp = item.mesh.position;
        const distSq = (sp.x - playerPos.x) * (sp.x - playerPos.x) + (sp.z - playerPos.z) * (sp.z - playerPos.z);
        if (distSq > 110.0 * 110.0) continue;

        // 放在店家門口前方地面 (y=0.04)
        this.dummy.position.set(sp.x, 0.04, sp.z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1.0, 1.0, 1.0);
        this.dummy.updateMatrix();
        this.shopDecalsMesh.setMatrixAt(shopCount, this.dummy.matrix);

        // 提取店招主色或以溫暖金橘作為店面溢光
        const theme = this.signboardGen.getShopColorTheme(item.shop);
        const shopCol = new THREE.Color(theme.accent || theme.bg || '#ff9933');
        shopCol.multiplyScalar(nightFactor * 0.35 * this.baseNightBrightness);
        shopColors.setXYZ(shopCount, shopCol.r, shopCol.g, shopCol.b);
        shopCount++;
      }

      this.shopDecalsMesh.count = shopCount;
      this.shopDecalsMesh.instanceMatrix.needsUpdate = true;
      shopColors.needsUpdate = true;
      this.activeDecalsCount += shopCount;
    }

    // 5. 交通號誌路口地面色斑貼花 (signalDecalsMesh)
    if (this.signalDecalsMesh) {
      const inters = this.signalSystem.getIntersections();
      let sigCount = 0;
      const sigColors = this.signalDecalsMesh.instanceColor!;

      for (let k = 0; k < inters.length && sigCount < 60; k++) {
        const inter = inters[k];
        if (!inter.hasSignals) continue;
        const dx = inter.center.x - playerPos.x;
        const dz = inter.center.z - playerPos.z;
        if (dx * dx + dz * dz > 130.0 * 130.0) continue;

        // 透過號誌系統公開介面查詢當前路口燈色
        const app0 = inter.approaches[0]?.id || '';
        const vInfo = this.signalSystem.getVehicleState(inter.id, app0);
        const state = vInfo.state;
        let lightCol = new THREE.Color(0x00ff77);
        if (state === 'yellow' || state === 'flashingYellow') lightCol.set(0xffbb00);
        else if (state === 'red') lightCol.set(0xff2222);

        this.dummy.position.set(inter.center.x, 0.042, inter.center.z);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.scale.set(1.0, 1.0, 1.0);
        this.dummy.updateMatrix();
        this.signalDecalsMesh.setMatrixAt(sigCount, this.dummy.matrix);

        lightCol.multiplyScalar(nightFactor * 0.40 * this.baseNightBrightness);
        sigColors.setXYZ(sigCount, lightCol.r, lightCol.g, lightCol.b);
        sigCount++;
      }

      this.signalDecalsMesh.count = sigCount;
      this.signalDecalsMesh.instanceMatrix.needsUpdate = true;
      sigColors.needsUpdate = true;
      this.activeDecalsCount += sigCount;
    }

    // 6. 雨夜濕潤路面長條倒影 (wetReflectMesh)
    if (this.wetReflectMesh) {
      if ((wetness > 0.08 || rainIntensity > 0.08) && nightFactor > 0.05) {
        let wetCount = 0;
        const wetColors = this.wetReflectMesh.instanceColor!;
        const reflectCount = Math.min(80, nearbyLamps.length);

        for (let w = 0; w < reflectCount; w++) {
          const lamp = nearbyLamps[w].data;
          // 倒影朝向鏡頭方向拉長
          const toCamX = camera.position.x - lamp.groundPos.x;
          const toCamZ = camera.position.z - lamp.groundPos.z;
          const streakAngle = Math.atan2(toCamX, toCamZ);

          // 倒影位置位於路燈與玩家視線中間偏路面
          const rx = lamp.groundPos.x + Math.sin(streakAngle) * 2.5;
          const rz = lamp.groundPos.z + Math.cos(streakAngle) * 2.5;

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
        this.activeDecalsCount += wetCount;
      } else {
        this.wetReflectMesh.count = 0;
      }
    }

    // 7. 更新建築窗戶夜間亮燈 (深夜衰減與電視藍光)
    this.updateBuildingWindowsLighting(nightFactor, currentHour, totalGameTimeSec);

    // 8. 注入建築與地面 Shader 之 Uniforms
    this.updateInjectedMaterialUniforms(nightFactor, wetness);

    this.lastCpuTimeMs = performance.now() - t0;
  }

  /**
   * 建築窗戶夜間亮燈狀態機
   * 晚間 (19~24點)：45%~60% 窗戶點亮暖黃/冷白
   * 深夜 (0~5點)：降至 15%~25%
   * 3% 窗戶微弱電視藍光閃爍
   */
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
    // 每數秒更新一次或在日夜切換時刷新，避免不必要的每幀遍歷
    const hourInt = Math.floor(currentHour * 10);
    const isNightNow = nightFactor > 0.05;
    const shouldRefreshAll = hourInt !== this.lastWindowUpdateHour || isNightNow !== this.lastWindowUpdateNight;

    if (!shouldRefreshAll && nightFactor <= 0.01) return;

    this.lastWindowUpdateHour = hourInt;
    this.lastWindowUpdateNight = isNightNow;

    const colorsAttr = winMesh.instanceColor;
    const baseLitChance = (isLateNight ? 0.20 : 0.52) * this.windowLightRatio;

    // 穩定偽隨機雜湊
    const hash = (n: number) => {
      const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
      return s - Math.floor(s);
    };

    const warmLight = new THREE.Color(0xffdf80); // 暖黃室內燈
    const coolLight = new THREE.Color(0xf1f5f9); // 冷白燈
    const darkGlass = new THREE.Color(0x182030); // 未點亮深藍反光玻璃
    const tvBlue = new THREE.Color(0x38bdf8);    // 電視微光

    for (let i = 0; i < count; i++) {
      const hVal = hash(i);
      const isLit = hVal < baseLitChance && nightFactor > 0.02;

      if (isLit) {
        if (hVal < 0.03) {
          // 電視微弱藍光輕微頻閃
          const tvFlicker = 0.85 + 0.15 * Math.sin(timeSec * 8.0 + i * 3.0);
          this.tmpColor.copy(tvBlue).multiplyScalar(tvFlicker * nightFactor);
        } else if (hVal < baseLitChance * 0.82) {
          // 80% 暖黃室內燈
          this.tmpColor.copy(warmLight).multiplyScalar(1.25 * nightFactor);
        } else {
          // 20% 冷白燈
          this.tmpColor.copy(coolLight).multiplyScalar(1.10 * nightFactor);
        }
      } else {
        this.tmpColor.copy(darkGlass);
      }

      colorsAttr.setXYZ(i, this.tmpColor.r, this.tmpColor.g, this.tmpColor.b);
    }

    colorsAttr.needsUpdate = true;
  }

  /**
   * 注入建築牆面與柏油路面的 Custom Shader Uniforms
   */
  private updateInjectedMaterialUniforms(nightFactor: number, wetness: number): void {
    const bldgMesh = this.buildingGen.getBuildingsMesh();
    if (bldgMesh && (bldgMesh.material as any).customShader) {
      const uniforms = (bldgMesh.material as any).customShader.uniforms;
      if (uniforms.uNightFactor) uniforms.uNightFactor.value = nightFactor;
      if (uniforms.uBaseNightBrightness) uniforms.uBaseNightBrightness.value = this.baseNightBrightness;
      if (uniforms.uNearbyLights) {
        for (let i = 0; i < 8; i++) {
          uniforms.uNearbyLights.value[i].copy(this.nearbyLightPos[i]);
          uniforms.uNearbyLightColors.value[i].copy(this.nearbyLightCols[i]);
        }
      }
    }

    const roadMesh = this.roadGen.getRoadMesh ? this.roadGen.getRoadMesh() : null;
    if (roadMesh && (roadMesh.material as any).customShader) {
      const uniforms = (roadMesh.material as any).customShader.uniforms;
      if (uniforms.uNightFactor) uniforms.uNightFactor.value = nightFactor;
      if (uniforms.uBaseNightBrightness) uniforms.uBaseNightBrightness.value = this.baseNightBrightness;
      if (uniforms.uWetness) uniforms.uWetness.value = wetness;
      if (uniforms.uNearbyLights) {
        for (let i = 0; i < 8; i++) {
          uniforms.uNearbyLights.value[i].copy(this.nearbyLightPos[i]);
          uniforms.uNearbyLightColors.value[i].copy(this.nearbyLightCols[i]);
        }
      }
    }

    const sideMesh = this.roadGen.getSidewalkMesh ? this.roadGen.getSidewalkMesh() : null;
    if (sideMesh && (sideMesh.material as any).customShader) {
      const uniforms = (sideMesh.material as any).customShader.uniforms;
      if (uniforms.uNightFactor) uniforms.uNightFactor.value = nightFactor;
      if (uniforms.uBaseNightBrightness) uniforms.uBaseNightBrightness.value = this.baseNightBrightness;
      if (uniforms.uNearbyLights) {
        for (let i = 0; i < 8; i++) {
          uniforms.uNearbyLights.value[i].copy(this.nearbyLightPos[i]);
          uniforms.uNearbyLightColors.value[i].copy(this.nearbyLightCols[i]);
        }
      }
    }
  }

  // --- UI 與控制接口 ---

  public setBaseNightBrightness(val: number): void {
    this.baseNightBrightness = Math.max(0.4, Math.min(2.5, val));
  }

  public getBaseNightBrightness(): number {
    return this.baseNightBrightness;
  }

  public setLampDecalIntensity(val: number): void {
    this.lampDecalIntensity = Math.max(0.0, Math.min(2.5, val));
  }

  public getLampDecalIntensity(): number {
    return this.lampDecalIntensity;
  }

  public setWindowLightRatio(val: number): void {
    this.windowLightRatio = Math.max(0.0, Math.min(1.5, val));
    this.lastWindowUpdateHour = -999; // 強制重繪
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

  public getStats(): NightLightingStats {
    let dc = 0;
    if (this.lampDecalsMesh && this.lampDecalsMesh.count > 0) dc++;
    if (this.lampGlowMesh && this.lampGlowMesh.count > 0) dc++;
    if (this.lampConesMesh && this.lampConesMesh.count > 0) dc++;
    if (this.shopDecalsMesh && this.shopDecalsMesh.count > 0) dc++;
    if (this.signalDecalsMesh && this.signalDecalsMesh.count > 0) dc++;
    if (this.wetReflectMesh && this.wetReflectMesh.count > 0) dc++;

    return {
      activeDecals: this.activeDecalsCount,
      drawCalls: dc,
      cpuTimeMs: Number(this.lastCpuTimeMs.toFixed(2))
    };
  }

  public dispose(): void {
    const list = [
      this.lampDecalsMesh,
      this.lampGlowMesh,
      this.lampConesMesh,
      this.shopDecalsMesh,
      this.signalDecalsMesh,
      this.wetReflectMesh
    ];
    for (const m of list) {
      if (m) {
        this.scene.remove(m);
        m.geometry.dispose();
        if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
        else m.material.dispose();
      }
    }
  }
}
