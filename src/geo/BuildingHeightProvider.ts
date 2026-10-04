/**
 * BuildingHeightProvider.ts - 外部建築高度資料層抽象接口與實作
 * 支援「內政部國土測繪中心 (NLSC) 三維建物模型」或其他政府/商用開放資料
 * 包含：
 * 1. 幾何空間重疊率 (Polygon IoU / Overlap Ratio >= 60%) 比對演算法
 * 2. 外部資料快取機制
 * 3. 預留完整資料匯入接口，目前回傳空資料 (或預置模型)，未來僅需載入資料檔即可即刻生效
 */

import { Point2D } from './OsmTypes.ts';

export interface ExternalBuildingEntry {
  id: string;
  osmId?: string;
  footprint: Point2D[];
  height?: number;
  levels?: number;
  source: string;
  confidence: number;
}

export interface BuildingHeightResult {
  height?: number;
  levels?: number;
  source: string;
  confidence: number;
  externalId?: string;
}

export interface BuildingHeightProvider {
  name: string;
  getBuildingHeight(polygon: Point2D[], osmId?: string): Promise<BuildingHeightResult | null>;
  loadDataset?(entries: ExternalBuildingEntry[]): void;
}

/**
 * 內政部國土測繪中心 (NLSC) 三維建物模型高度提供者
 */
export class NLSCBuildingHeightProvider implements BuildingHeightProvider {
  public name = 'NLSC 內政部國土測繪中心三維建物模型';
  private dataset: ExternalBuildingEntry[] = [];
  private cache = new Map<string, BuildingHeightResult | null>();

  constructor(initialData?: ExternalBuildingEntry[]) {
    if (initialData) {
      this.dataset = initialData;
    }
  }

  public loadDataset(entries: ExternalBuildingEntry[]): void {
    this.dataset = entries;
    this.cache.clear();
  }

  /**
   * 查詢外部建築高度：
   * 1. 優先使用 osmId 直接精確比對
   * 2. 若無精確 ID，計算多邊形重疊面積比 (Overlap Ratio >= 60% 門檻)
   */
  public async getBuildingHeight(polygon: Point2D[], osmId?: string): Promise<BuildingHeightResult | null> {
    if (this.dataset.length === 0) {
      return null;
    }

    if (osmId && this.cache.has(osmId)) {
      return this.cache.get(osmId)!;
    }

    // 1. OSM ID 直接比對
    if (osmId) {
      const matchById = this.dataset.find((e) => e.osmId === osmId || e.id === osmId);
      if (matchById) {
        const res: BuildingHeightResult = {
          height: matchById.height,
          levels: matchById.levels,
          source: 'external',
          confidence: matchById.confidence || 0.85,
          externalId: matchById.id
        };
        this.cache.set(osmId, res);
        return res;
      }
    }

    // 2. 空間輪廓重疊面積比對 (要求重疊率 >= 60%)
    if (polygon.length < 3) return null;

    const osmBox = this.computeBoundingBox(polygon);
    const osmArea = Math.max(0.1, this.computeArea(polygon));

    for (const ext of this.dataset) {
      if (ext.footprint.length < 3) continue;

      const extBox = this.computeBoundingBox(ext.footprint);

      // AABB 粗篩
      if (
        osmBox.maxX < extBox.minX ||
        osmBox.minX > extBox.maxX ||
        osmBox.maxZ < extBox.minZ ||
        osmBox.minZ > extBox.maxZ
      ) {
        continue;
      }

      // 重疊率採樣近似計算
      const overlapRatio = this.estimateOverlapRatio(polygon, osmArea, ext.footprint);
      if (overlapRatio >= 0.60) {
        const res: BuildingHeightResult = {
          height: ext.height,
          levels: ext.levels,
          source: 'external',
          confidence: 0.85,
          externalId: ext.id
        };
        if (osmId) this.cache.set(osmId, res);
        return res;
      }
    }

    if (osmId) this.cache.set(osmId, null);
    return null;
  }

  private computeBoundingBox(pts: Point2D[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, maxX, minZ, maxZ };
  }

  private computeArea(poly: Point2D[]): number {
    let sum = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % n];
      sum += p1.x * p2.z - p2.x * p1.z;
    }
    return Math.abs(sum * 0.5);
  }

  /**
   * 點採樣法計算多邊形重疊面積比例
   */
  private estimateOverlapRatio(polyA: Point2D[], areaA: number, polyB: Point2D[]): number {
    const box = this.computeBoundingBox(polyA);
    const step = Math.max(1.0, Math.sqrt(areaA) / 10.0);
    let totalSamples = 0;
    let hitSamples = 0;

    for (let x = box.minX; x <= box.maxX; x += step) {
      for (let z = box.minZ; z <= box.maxZ; z += step) {
        const pt = { x, z };
        if (this.pointInPolygon(pt, polyA)) {
          totalSamples++;
          if (this.pointInPolygon(pt, polyB)) {
            hitSamples++;
          }
        }
      }
    }

    if (totalSamples === 0) return 0;
    return hitSamples / totalSamples;
  }

  private pointInPolygon(pt: Point2D, poly: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, zi = poly[i].z;
      const xj = poly[j].x, zj = poly[j].z;
      const intersect = zi > pt.z !== zj > pt.z && pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
}
