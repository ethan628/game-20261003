/**
 * LightmapComputer.ts - 區塊光照圖核心計算引擎
 * 採用物理光度學衰減公式與 2D 建築輪廓格網遮擋演算法
 *
 * 核心公式：
 * E = I * h / (h^2 + d^2)^1.5 * smoothstep(R, 0, d)
 */

import { LightSource, OcclusionSegment, LightmapChunkRequest, LightmapChunkResult } from './LightmapTypes.ts';

// 2D 線段相交判定
function linesIntersect(
  x1: number, z1: number, x2: number, z2: number,
  x3: number, z3: number, x4: number, z4: number
): boolean {
  const denom = (z4 - z3) * (x2 - x1) - (x4 - x3) * (z2 - z1);
  if (Math.abs(denom) < 1e-7) return false;

  const ua = ((x4 - x3) * (z1 - z3) - (z4 - z3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (z1 - z3) - (z2 - z1) * (x1 - x3)) / denom;

  // 稍微縮進端點，防止自遮擋
  return ua > 0.03 && ua < 0.97 && ub > 0.02 && ub < 0.98;
}

// 空間格網加速結構
class SpatialOcclusionGrid {
  private cellSize: number;
  private minX: number;
  private minZ: number;
  private cols: number;
  private rows: number;
  private grid: OcclusionSegment[][];

  constructor(segments: OcclusionSegment[], minX: number, minZ: number, maxX: number, maxZ: number, cellSize = 16) {
    this.cellSize = cellSize;
    this.minX = minX;
    this.minZ = minZ;
    this.cols = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1);
    this.rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 1);
    this.grid = new Array(this.cols * this.rows);
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i] = [];
    }

    for (const seg of segments) {
      const sx1 = seg[0];
      const sz1 = seg[1];
      const sx2 = seg[2];
      const sz2 = seg[3];

      const c1 = Math.max(0, Math.min(this.cols - 1, Math.floor((Math.min(sx1, sx2) - this.minX) / cellSize)));
      const c2 = Math.max(0, Math.min(this.cols - 1, Math.floor((Math.max(sx1, sx2) - this.minX) / cellSize)));
      const r1 = Math.max(0, Math.min(this.rows - 1, Math.floor((Math.min(sz1, sz2) - this.minZ) / cellSize)));
      const r2 = Math.max(0, Math.min(this.rows - 1, Math.floor((Math.max(sz1, sz2) - this.minZ) / cellSize)));

      for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          this.grid[r * this.cols + c].push(seg);
        }
      }
    }
  }

  public isOccluded(x1: number, z1: number, x2: number, z2: number): boolean {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minZ = Math.min(z1, z2);
    const maxZ = Math.max(z1, z2);

    const c1 = Math.max(0, Math.min(this.cols - 1, Math.floor((minX - this.minX) / this.cellSize)));
    const c2 = Math.max(0, Math.min(this.cols - 1, Math.floor((maxX - this.minX) / this.cellSize)));
    const r1 = Math.max(0, Math.min(this.rows - 1, Math.floor((minZ - this.minZ) / this.cellSize)));
    const r2 = Math.max(0, Math.min(this.rows - 1, Math.floor((maxZ - this.minZ) / this.cellSize)));

    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const segs = this.grid[r * this.cols + c];
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (linesIntersect(x1, z1, x2, z2, s[0], s[1], s[2], s[3])) {
            return true;
          }
        }
      }
    }
    return false;
  }
}

export class LightmapComputer {
  /**
   * 計算單一區塊光照圖
   */
  public static computeChunk(request: LightmapChunkRequest): LightmapChunkResult {
    const t0 = performance.now();
    const { chunkId, minX, minZ, maxX, maxZ, resolution, lights, occluders } = request;

    const width = Math.round((maxX - minX) / resolution);
    const height = Math.round((maxZ - minZ) / resolution);
    const pixels = new Uint8ClampedArray(width * height * 4);

    // 建立 16m 建築遮擋空間網格
    const grid = new SpatialOcclusionGrid(occluders, minX, minZ, maxX, maxZ, 16);

    // 篩選影響本區塊的光源 (落在區塊半徑內)
    const activeLights: LightSource[] = [];
    for (const l of lights) {
      if (
        l.x >= minX - l.radius &&
        l.x <= maxX + l.radius &&
        l.z >= minZ - l.radius &&
        l.z <= maxZ + l.radius
      ) {
        activeLights.push(l);
      }
    }

    const lampHeight = 8.0;
    const hSq = lampHeight * lampHeight; // 64
    const intensityScale = 110.0; // 物理常數調整係數

    // 逐像素計算光照 (每像素 1 公尺)
    for (let py = 0; py < height; py++) {
      const wz = minZ + (py + 0.5) * resolution;
      const rowOffset = py * width * 4;

      for (let px = 0; px < width; px++) {
        const wx = minX + (px + 0.5) * resolution;

        let accumR = 0.0;
        let accumG = 0.0;
        let accumB = 0.0;
        let thresholdWeight = 0.0;
        let totalLampWeight = 0.0;

        for (let li = 0; li < activeLights.length; li++) {
          const light = activeLights[li];
          const dx = wx - light.x;
          const dz = wz - light.z;
          const distSq = dx * dx + dz * dz;
          const R = light.radius;

          if (distSq >= R * R) continue;

          const dist = Math.sqrt(distSq);

          // 遮擋測試 (路燈地表投影點與像素點之間是否有建築牆壁)
          // 僅對距離 > 1.2m 的點做遮擋判定，防自身柱子近端誤判
          if (dist > 1.2 && grid.isOccluded(light.x, light.z, wx, wz)) {
            continue;
          }

          let contrib = 0.0;

          if (light.type === 'street_lamp') {
            // 物理公式：E = I * h / (h^2 + d^2)^1.5
            const denom = Math.pow(hSq + distSq, 1.5);
            const physicalE = (light.intensity * lampHeight) / denom * intensityScale;

            // smoothstep 在半徑 R 處平滑截止 (在 0.65R ~ R 間由 1 平滑落至 0)
            const fadeStart = R * 0.60;
            let cutoff = 1.0;
            if (dist > fadeStart) {
              const u = Math.max(0.0, Math.min(1.0, (R - dist) / (R - fadeStart)));
              cutoff = u * u * (3.0 - 2.0 * u);
            }

            contrib = physicalE * cutoff;
            // 軟飽和壓制，防止燈正下方過曝死白
            contrib = contrib / (1.0 + 0.28 * contrib);

            thresholdWeight += light.turnOnThreshold * contrib;
            totalLampWeight += contrib;
          } else if (light.type === 'shop') {
            // 店面與騎樓溢光 (半徑 6~8m，漫射光)
            const u = Math.max(0.0, 1.0 - dist / R);
            contrib = light.intensity * u * u * (3.0 - 2.0 * u) * 0.85;
          } else if (light.type === 'signal') {
            // 交通號誌路口色光 (半徑 8~10m)
            const u = Math.max(0.0, 1.0 - dist / R);
            contrib = light.intensity * (u * u) * 0.65;
          } else if (light.type === 'window') {
            // 窗戶弱溢光 (半徑 3m)
            const u = Math.max(0.0, 1.0 - dist / R);
            contrib = light.intensity * u * 0.35;
          }

          accumR += light.color.r * contrib;
          accumG += light.color.g * contrib;
          accumB += light.color.b * contrib;
        }

        // 光源開關閥值：若無路燈則為 0 (常亮)，否則為路燈平均門檻
        const threshold = totalLampWeight > 0.001 ? thresholdWeight / totalLampWeight : 0.0;

        const idx = rowOffset + px * 4;
        pixels[idx] = Math.min(255, Math.round(accumR * 255));
        pixels[idx + 1] = Math.min(255, Math.round(accumG * 255));
        pixels[idx + 2] = Math.min(255, Math.round(accumB * 255));
        pixels[idx + 3] = Math.min(255, Math.round(threshold * 255));
      }
    }

    const computeTimeMs = Number((performance.now() - t0).toFixed(2));

    return {
      chunkId,
      minX,
      minZ,
      maxX,
      maxZ,
      width,
      height,
      pixels,
      computeTimeMs
    };
  }
}
