/**
 * StreetLampPlacement.ts - 智慧路燈排布與 95%+ 光照覆蓋率保證系統
 *
 * 規則：
 * 1. 沿主要道路兩側（有人行道的一側）以固定間距擺放路燈，預設最大間距 28 公尺，寬路兩側交錯排列，路口四個轉角各至少一盞
 * 2. 小巷與無人行道窄路改用牆面燈，間距 20 公尺
 * 3. 優先使用 OSM highway=street_lamp 資料，缺口再補齊，每盞標記來源 (osm / auto)
 * 4. 有效照射半徑預設 18 公尺，以路面中心線取樣，任何一點到最近兩盞燈的光照總和都要達標 (0.25)
 * 5. 覆蓋率未達 95% 時，自動在最大缺口處補燈，直到達標，並回報補燈數
 */

import * as THREE from 'three';
import { RoadFeature, IntersectionFeature, Point2D, OsmWorldData } from '../../geo/OsmTypes.ts';
import { LightSource, LightCoverageReport } from './LightmapTypes.ts';

export interface LampPlacementItem {
  id: string;
  pos: THREE.Vector3;       // 地表立柱/牆基位置
  headPos: THREE.Vector3;   // 燈頭出光點 (世界高程)
  rotY: number;             // 燈臂朝向 (朝向車道中心)
  color: THREE.Color;
  intensity: number;
  radius: number;           // 有效照射半徑 (預設 18m * 範圍倍率)
  isWallLamp: boolean;
  source: 'osm' | 'auto';
  roadType: string;
  turnOnThreshold: number;  // 0.15 ~ 0.95 隨機點亮順序
  isFlicker: boolean;       // 3% 隨機微顫
  flickerSeed: number;
}

export interface StreetLampConfig {
  maxSpacing: number;          // 預設 28m (20 ~ 40m 可調)
  radiusMultiplier: number;    // 預設 1.0 (0.7 ~ 1.6 可調)
  intensityMultiplier: number; // 預設 1.0 (0.5 ~ 2.0 可調)
  alleySpacing: number;        // 預設 20m
}

export class StreetLampPlacement {
  private config: StreetLampConfig = {
    maxSpacing: 28.0,
    radiusMultiplier: 1.0,
    intensityMultiplier: 1.0,
    alleySpacing: 20.0
  };

  private placedLamps: LampPlacementItem[] = [];
  private lastReport: LightCoverageReport | null = null;
  private addedAutoCount = 0;

  constructor(cfg?: Partial<StreetLampConfig>) {
    if (cfg) Object.assign(this.config, cfg);
  }

  public setConfig(cfg: Partial<StreetLampConfig>): void {
    Object.assign(this.config, cfg);
  }

  public getConfig(): StreetLampConfig {
    return { ...this.config };
  }

  public getPlacedLamps(): LampPlacementItem[] {
    return this.placedLamps;
  }

  public getLastReport(): LightCoverageReport | null {
    return this.lastReport;
  }

  public getAddedAutoCount(): number {
    return this.addedAutoCount;
  }

  /**
   * 執行路燈生成與自動補燈至 95% 以上覆蓋率
   */
  public generate(
    roads: RoadFeature[],
    intersections: IntersectionFeature[] = [],
    osmData?: OsmWorldData | null
  ): LampPlacementItem[] {
    this.placedLamps = [];
    this.addedAutoCount = 0;

    const baseRadius = 18.0 * this.config.radiusMultiplier;
    const baseIntensity = 1.0 * this.config.intensityMultiplier;
    const lampSpacing = this.config.maxSpacing;
    const alleySpacing = this.config.alleySpacing;

    const warmOrange = new THREE.Color(0xff9e3b); // 3000K 暖橘
    const warmWhite = new THREE.Color(0xfff0d0);  // 4500K 暖白

    const signalPoles: Point2D[] = [];
    for (const inter of intersections) {
      if (inter.hasSignals) {
        for (const p of inter.poles) {
          signalPoles.push(p.position);
        }
      }
    }

    const isNearExisting = (x: number, z: number, minDist = 8.0) => {
      for (let i = 0; i < this.placedLamps.length; i++) {
        const l = this.placedLamps[i];
        if (Math.hypot(l.pos.x - x, l.pos.z - z) < minDist) return true;
      }
      return false;
    };

    const isNearSignalPole = (x: number, z: number, dist = 5.0) => {
      for (let s = 0; s < signalPoles.length; s++) {
        if (Math.hypot(signalPoles[s].x - x, signalPoles[s].z - z) < dist) return true;
      }
      return false;
    };

    // --- 1. 優先載入 OSM 實測路燈 (highway=street_lamp) ---
    let osmCount = 0;
    // 檢查 osmData 是否包含 OSM 路燈點位
    if (osmData && (osmData as any).streetLamps && Array.isArray((osmData as any).streetLamps)) {
      for (const sl of (osmData as any).streetLamps) {
        if (!isNearExisting(sl.x, sl.z, 6.0)) {
          const isFlicker = (osmCount * 137 + 19) % 100 < 3;
          this.placedLamps.push({
            id: `lamp_osm_${osmCount++}`,
            pos: new THREE.Vector3(sl.x, 0.17, sl.z),
            headPos: new THREE.Vector3(sl.x, 7.2, sl.z),
            rotY: sl.rotation ?? 0,
            color: warmOrange.clone(),
            intensity: baseIntensity,
            radius: baseRadius,
            isWallLamp: false,
            source: 'osm',
            roadType: 'osm',
            turnOnThreshold: 0.15 + ((osmCount * 47) % 70) / 100,
            isFlicker,
            flickerSeed: (osmCount * 31.7) % 1000
          });
        }
      }
    }

    // --- 2. 路口轉角保證路燈 (四個轉角各至少一盞) ---
    for (let idx = 0; idx < intersections.length; idx++) {
      const inter = intersections[idx];
      const r = Math.max(10.0, inter.radius);
      const appCount = inter.approaches.length;
      if (appCount >= 3 || inter.hasSignals) {
        // 在路口各個 approach 的轉角外側放置路燈
        for (let a = 0; a < appCount; a++) {
          const app = inter.approaches[a];
          const az = app.azimuthRad;
          // 轉角偏移角度 (順時針 45 度與逆時針 45 度)
          const cornerAz = az + Math.PI * 0.45;
          const cx = inter.center.x + Math.sin(cornerAz) * (r + 2.5);
          const cz = inter.center.z + Math.cos(cornerAz) * (r + 2.5);

          if (!isNearExisting(cx, cz, 12.0) && !isNearSignalPole(cx, cz, 4.5)) {
            const lampId = `lamp_corner_${idx}_${a}`;
            const isFlicker = (this.placedLamps.length * 137 + 19) % 100 < 3;
            // 朝向路口中心
            const rotY = Math.atan2(inter.center.x - cx, inter.center.z - cz);
            const headX = cx + Math.sin(rotY) * 1.5;
            const headZ = cz + Math.cos(rotY) * 1.5;

            this.placedLamps.push({
              id: lampId,
              pos: new THREE.Vector3(cx, 0.17, cz),
              headPos: new THREE.Vector3(headX, 7.5, headZ),
              rotY,
              color: warmWhite.clone(),
              intensity: baseIntensity * 1.15, // 路口燈光稍亮
              radius: baseRadius * 1.05,
              isWallLamp: false,
              source: 'auto',
              roadType: 'intersection',
              turnOnThreshold: 0.15 + ((this.placedLamps.length * 47) % 70) / 100,
              isFlicker,
              flickerSeed: (this.placedLamps.length * 31.7) % 1000
            });
          }
        }
      }
    }

    // --- 3. 道路路燈配置 (主幹道兩側交錯，窄路牆面燈) ---
    for (let rIdx = 0; rIdx < roads.length; rIdx++) {
      const road = roads[rIdx];
      const pts = road.points;
      if (pts.length < 2) continue;

      const halfW = road.width * 0.5;
      const sW = road.sidewalkWidth;
      const isWideRoad = road.width >= 7.5 || sW >= 1.2;
      const isMajor = ['motorway', 'trunk', 'primary', 'secondary'].includes(road.type);
      const isNarrowOrAlley = road.width < 5.0 || sW < 0.6 || ['service', 'living_street', 'footway', 'pedestrian'].includes(road.type);

      const lampColor = isMajor ? warmWhite : warmOrange;
      const effectiveSpacing = isNarrowOrAlley ? alleySpacing : lampSpacing;

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 6.0) continue;

        const ux = dx / len;
        const uz = dz / len;
        const nx = -uz;
        const nz = ux;
        const roadAngle = Math.atan2(dx, dz);

        if (isNarrowOrAlley) {
          // 小巷與無人行道窄路：牆面燈 (間距 20m，安裝高度 4.5m，靠路緣 0.35m)
          let d = 8.0;
          while (d < len - 4.0) {
            const side = (Math.floor(d / effectiveSpacing) % 2 === 0) ? 1 : -1;
            const lx = p1.x + ux * d + nx * (halfW + 0.35) * side;
            const lz = p1.z + uz * d + nz * (halfW + 0.35) * side;

            if (!isNearExisting(lx, lz, 14.0) && !isNearSignalPole(lx, lz)) {
              const lampId = `lamp_wall_${rIdx}_${i}_${Math.round(d)}`;
              const isFlicker = (this.placedLamps.length * 137 + 19) % 100 < 3;
              // 牆面燈頭朝路中央
              const facingAngle = side > 0 ? roadAngle - Math.PI / 2 : roadAngle + Math.PI / 2;

              this.placedLamps.push({
                id: lampId,
                pos: new THREE.Vector3(lx, 0.17, lz),
                headPos: new THREE.Vector3(lx - nx * 0.4 * side, 4.5, lz - nz * 0.4 * side),
                rotY: facingAngle,
                color: warmOrange.clone(),
                intensity: baseIntensity * 0.9,
                radius: baseRadius * 0.85,
                isWallLamp: true,
                source: 'auto',
                roadType: road.type,
                turnOnThreshold: 0.15 + ((this.placedLamps.length * 47) % 70) / 100,
                isFlicker,
                flickerSeed: (this.placedLamps.length * 31.7) % 1000
              });
            }
            d += effectiveSpacing;
          }
        } else if (isWideRoad) {
          // 寬路與主要道路：兩側交錯排列 (最大間距 28m)
          const lampOffset = halfW + Math.max(0.4, sW * 0.25);
          let dLeft = 10.0;
          let dRight = 10.0 + effectiveSpacing * 0.5;

          while (dLeft < len - 6.0 || dRight < len - 6.0) {
            if (dLeft < len - 6.0) {
              const lx = p1.x + ux * dLeft - nx * lampOffset;
              const lz = p1.z + uz * dLeft - nz * lampOffset;
              if (!isNearExisting(lx, lz, 14.0) && !isNearSignalPole(lx, lz)) {
                const lampId = `lamp_l_${rIdx}_${i}_${Math.round(dLeft)}`;
                const isFlicker = (this.placedLamps.length * 137 + 19) % 100 < 3;
                const rotY = roadAngle + Math.PI / 2;
                const headX = lx + 1.2 * Math.cos(rotY);
                const headZ = lz - 1.2 * Math.sin(rotY);

                this.placedLamps.push({
                  id: lampId,
                  pos: new THREE.Vector3(lx, 0.17, lz),
                  headPos: new THREE.Vector3(headX, 7.5, headZ),
                  rotY,
                  color: lampColor.clone(),
                  intensity: baseIntensity,
                  radius: baseRadius,
                  isWallLamp: false,
                  source: 'auto',
                  roadType: road.type,
                  turnOnThreshold: 0.15 + ((this.placedLamps.length * 47) % 70) / 100,
                  isFlicker,
                  flickerSeed: (this.placedLamps.length * 31.7) % 1000
                });
              }
              dLeft += effectiveSpacing;
            }

            if (dRight < len - 6.0) {
              const rx = p1.x + ux * dRight + nx * lampOffset;
              const rz = p1.z + uz * dRight + nz * lampOffset;
              if (!isNearExisting(rx, rz, 14.0) && !isNearSignalPole(rx, rz)) {
                const lampId = `lamp_r_${rIdx}_${i}_${Math.round(dRight)}`;
                const isFlicker = (this.placedLamps.length * 137 + 19) % 100 < 3;
                const rotY = roadAngle - Math.PI / 2;
                const headX = rx + 1.2 * Math.cos(rotY);
                const headZ = rz - 1.2 * Math.sin(rotY);

                this.placedLamps.push({
                  id: lampId,
                  pos: new THREE.Vector3(rx, 0.17, rz),
                  headPos: new THREE.Vector3(headX, 7.5, headZ),
                  rotY,
                  color: lampColor.clone(),
                  intensity: baseIntensity,
                  radius: baseRadius,
                  isWallLamp: false,
                  source: 'auto',
                  roadType: road.type,
                  turnOnThreshold: 0.15 + ((this.placedLamps.length * 47) % 70) / 100,
                  isFlicker,
                  flickerSeed: (this.placedLamps.length * 31.7) % 1000
                });
              }
              dRight += effectiveSpacing;
            }
          }
        } else {
          // 一般有人行道道路：沿有人行道一側排布，間距 28m
          const lampOffset = halfW + Math.max(0.4, sW * 0.25);
          let d = 12.0;
          while (d < len - 6.0) {
            const rx = p1.x + ux * d + nx * lampOffset;
            const rz = p1.z + uz * d + nz * lampOffset;
            if (!isNearExisting(rx, rz, 15.0) && !isNearSignalPole(rx, rz)) {
              const lampId = `lamp_std_${rIdx}_${i}_${Math.round(d)}`;
              const isFlicker = (this.placedLamps.length * 137 + 19) % 100 < 3;
              const rotY = roadAngle - Math.PI / 2;
              const headX = rx + 1.2 * Math.cos(rotY);
              const headZ = rz - 1.2 * Math.sin(rotY);

              this.placedLamps.push({
                id: lampId,
                pos: new THREE.Vector3(rx, 0.17, rz),
                headPos: new THREE.Vector3(headX, 7.5, headZ),
                rotY,
                color: lampColor.clone(),
                intensity: baseIntensity,
                radius: baseRadius,
                isWallLamp: false,
                source: 'auto',
                roadType: road.type,
                turnOnThreshold: 0.15 + ((this.placedLamps.length * 47) % 70) / 100,
                isFlicker,
                flickerSeed: (this.placedLamps.length * 31.7) % 1000
              });
            }
            d += effectiveSpacing;
          }
        }
      }
    }

    // --- 4. 覆蓋率檢查與自動補燈 (保證達標 95% 以上) ---
    this.ensureCoverage(roads, baseRadius, baseIntensity);

    return this.placedLamps;
  }

  /**
   * 覆蓋率評估與缺口自適應補燈演算法
   */
  private ensureCoverage(roads: RoadFeature[], baseRadius: number, baseIntensity: number): void {
    const samplePoints: Array<{ x: number; z: number; roadIdx: number; ptIdx: number; dist: number; halfW: number; nx: number; nz: number }> = [];

    // 取樣路面中心線與邊界 (每 2.5m 一點)
    for (let rIdx = 0; rIdx < roads.length; rIdx++) {
      const road = roads[rIdx];
      const pts = road.points;
      const halfW = road.width * 0.5;
      const sW = road.sidewalkWidth;

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 3.0) continue;

        const ux = dx / len;
        const uz = dz / len;
        const nx = -uz;
        const nz = ux;

        for (let d = 1.5; d < len; d += 2.5) {
          const cx = p1.x + ux * d;
          const cz = p1.z + uz * d;

          // 中心線
          samplePoints.push({ x: cx, z: cz, roadIdx: rIdx, ptIdx: i, dist: d, halfW, nx, nz });

          // 車道邊緣 / 人行道
          const offsetEdge = halfW + (sW > 0.5 ? sW * 0.5 : 0.0);
          samplePoints.push({ x: cx + nx * offsetEdge, z: cz + nz * offsetEdge, roadIdx: rIdx, ptIdx: i, dist: d, halfW, nx, nz });
          samplePoints.push({ x: cx - nx * offsetEdge, z: cz - nz * offsetEdge, roadIdx: rIdx, ptIdx: i, dist: d, halfW, nx, nz });
        }
      }
    }

    const calcIllum = (px: number, pz: number): number => {
      let total = 0.0;
      const lampHeight = 8.0;
      const hSq = 64.0;
      for (let j = 0; j < this.placedLamps.length; j++) {
        const lamp = this.placedLamps[j];
        const dx = px - lamp.pos.x;
        const dz = pz - lamp.pos.z;
        const dSq = dx * dx + dz * dz;
        const R = lamp.radius;
        if (dSq >= R * R) continue;

        const d = Math.sqrt(dSq);
        const physicalE = (lamp.intensity * lampHeight) / Math.pow(hSq + dSq, 1.5) * 110.0;
        const fadeStart = R * 0.60;
        let cutoff = 1.0;
        if (d > fadeStart) {
          const u = Math.max(0.0, Math.min(1.0, (R - d) / (R - fadeStart)));
          cutoff = u * u * (3.0 - 2.0 * u);
        }
        total += physicalE * cutoff / (1.0 + 0.28 * physicalE);
      }
      return total;
    };

    const threshold = 0.25;
    let litCount = 0;
    const illumArray = new Float32Array(samplePoints.length);

    for (let i = 0; i < samplePoints.length; i++) {
      const val = calcIllum(samplePoints[i].x, samplePoints[i].z);
      illumArray[i] = val;
      if (val >= threshold) litCount++;
    }

    let coverage = samplePoints.length > 0 ? (litCount / samplePoints.length) * 100 : 100;
    const warmOrange = new THREE.Color(0xff9e3b);
    let autoAdded = 0;
    const maxAutoToAdd = 300;

    // 若未達 95%，在最大缺口處自動補燈
    while (coverage < 95.0 && autoAdded < maxAutoToAdd) {
      // 找出照度最低且遠離路燈的樣本點
      let minIllum = Infinity;
      let worstIdx = -1;

      for (let i = 0; i < samplePoints.length; i++) {
        if (illumArray[i] < minIllum) {
          minIllum = illumArray[i];
          worstIdx = i;
        }
      }

      if (worstIdx === -1 || minIllum >= threshold) break;

      const target = samplePoints[worstIdx];
      // 放置在該取樣點路側
      const road = roads[target.roadIdx];
      const sW = road.sidewalkWidth;
      const offset = target.halfW + Math.max(0.4, sW * 0.35);

      const lampX = target.x + target.nx * offset;
      const lampZ = target.z + target.nz * offset;

      const lampId = `lamp_fill_${autoAdded++}`;
      const isFlicker = (this.placedLamps.length * 137 + 19) % 100 < 3;
      const rotY = Math.atan2(target.nx, target.nz);

      const newLamp: LampPlacementItem = {
        id: lampId,
        pos: new THREE.Vector3(lampX, 0.17, lampZ),
        headPos: new THREE.Vector3(lampX - target.nx * 1.0, 7.5, lampZ - target.nz * 1.0),
        rotY,
        color: warmOrange.clone(),
        intensity: baseIntensity,
        radius: baseRadius,
        isWallLamp: sW < 0.6,
        source: 'auto',
        roadType: road.type,
        turnOnThreshold: 0.15 + ((this.placedLamps.length * 47) % 70) / 100,
        isFlicker,
        flickerSeed: (this.placedLamps.length * 31.7) % 1000
      };

      this.placedLamps.push(newLamp);

      // 更新受影響取樣點照度
      const R = newLamp.radius;
      const lampHeight = 8.0;
      const hSq = 64.0;
      const fadeStart = R * 0.60;

      for (let i = 0; i < samplePoints.length; i++) {
        const sp = samplePoints[i];
        const dx = sp.x - newLamp.pos.x;
        const dz = sp.z - newLamp.pos.z;
        const dSq = dx * dx + dz * dz;
        if (dSq < R * R) {
          const d = Math.sqrt(dSq);
          const physicalE = (newLamp.intensity * lampHeight) / Math.pow(hSq + dSq, 1.5) * 110.0;
          let cutoff = 1.0;
          if (d > fadeStart) {
            const u = Math.max(0.0, Math.min(1.0, (R - d) / (R - fadeStart)));
            cutoff = u * u * (3.0 - 2.0 * u);
          }
          const addVal = physicalE * cutoff / (1.0 + 0.28 * physicalE);
          const oldVal = illumArray[i];
          const newVal = oldVal + addVal;
          illumArray[i] = newVal;
          if (oldVal < threshold && newVal >= threshold) {
            litCount++;
          }
        }
      }

      coverage = (litCount / samplePoints.length) * 100;
    }

    this.addedAutoCount = autoAdded;

    // 尋找最大黑洞 (照度最低區域)
    let minFinalIllum = Infinity;
    let worstPos: { x: number; z: number } | null = null;
    let darkHolePoints = 0;

    for (let i = 0; i < samplePoints.length; i++) {
      if (illumArray[i] < threshold) {
        darkHolePoints++;
        if (illumArray[i] < minFinalIllum) {
          minFinalIllum = illumArray[i];
          worstPos = { x: samplePoints[i].x, z: samplePoints[i].z };
        }
      }
    }

    let osmLamps = 0;
    let autoLamps = 0;
    for (const l of this.placedLamps) {
      if (l.source === 'osm') osmLamps++;
      else autoLamps++;
    }

    this.lastReport = {
      totalSamplePoints: samplePoints.length,
      litPoints: litCount,
      coveragePercent: Number(coverage.toFixed(2)),
      totalLamps: this.placedLamps.length,
      osmLamps,
      autoLamps,
      maxDarkHole: worstPos ? {
        x: Number(worstPos.x.toFixed(1)),
        z: Number(worstPos.z.toFixed(1)),
        estimatedAreaM2: Number((darkHolePoints * 6.25).toFixed(1)),
        minIntensity: Number(minFinalIllum.toFixed(3))
      } : null
    };

    console.log(
      `[StreetLampPlacement] 路燈佈局完成！總燈數: ${this.placedLamps.length} (OSM: ${osmLamps}, Auto: ${autoLamps}, 補燈: ${autoAdded})，光照覆蓋率: ${this.lastReport.coveragePercent}%`
    );
  }

  /**
   * 轉為 LightSource 結構供光照圖 Worker 計算
   */
  public toLightSources(): LightSource[] {
    return this.placedLamps.map(l => ({
      id: l.id,
      type: 'street_lamp',
      x: l.headPos.x,
      y: l.headPos.y,
      z: l.headPos.z,
      radius: l.radius,
      intensity: l.intensity,
      color: { r: l.color.r, g: l.color.g, b: l.color.b },
      turnOnThreshold: l.turnOnThreshold,
      source: l.source,
      roadType: l.roadType
    }));
  }
}
