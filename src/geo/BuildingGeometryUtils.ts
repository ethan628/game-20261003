/**
 * BuildingGeometryUtils.ts - 建築多邊形精確處理工具
 * 包含：
 * 1. Douglas-Peucker (RDP) 多邊形化簡 (嚴格限制容差 <= 0.3m，完整保留轉角與凹凸)
 * 2. Shoelace 有向面積與幾何中心點計算
 * 3. 點在多邊形內判定 (Point-in-Polygon)
 * 4. 連棟透天厝 (Row Houses) 臨街分戶切分演算法
 */

import { BuildingFeature, Point2D } from './OsmTypes.ts';

export class BuildingGeometryUtils {
  /**
   * 計算多邊形有向面積 (Shoelace Formula)
   */
  public static computeSignedArea(poly: Point2D[]): number {
    let sum = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % n];
      sum += p1.x * p2.z - p2.x * p1.z;
    }
    return sum * 0.5;
  }

  /**
   * 計算多邊形幾何中心 (Centroid)
   */
  public static computeCentroid(poly: Point2D[]): Point2D {
    if (poly.length === 0) return { x: 0, z: 0 };
    let cx = 0, cz = 0;
    for (const p of poly) {
      cx += p.x;
      cz += p.z;
    }
    return { x: cx / poly.length, z: cz / poly.length };
  }

  /**
   * 多邊形化簡 (Douglas-Peucker，容差嚴格限制在 <= 0.3m)
   */
  public static simplifyPolygon(points: Point2D[], tolerance = 0.25): Point2D[] {
    if (points.length <= 4) return points;

    // 確保容差不超過 0.3 公尺
    const tol = Math.min(0.3, Math.max(0.05, tolerance));
    const isClosed = Math.hypot(points[0].x - points[points.length - 1].x, points[0].z - points[points.length - 1].z) < 0.1;
    const pts = isClosed ? points.slice(0, -1) : points.slice();

    const simplified = this.rdpRecursive(pts, tol);
    if (isClosed && simplified.length >= 3) {
      simplified.push({ x: simplified[0].x, z: simplified[0].z });
    }
    return simplified.length >= 3 ? simplified : points;
  }

  private static rdpRecursive(points: Point2D[], tolerance: number): Point2D[] {
    if (points.length <= 2) return points;

    let maxDist = 0;
    let maxIdx = 0;
    const start = points[0];
    const end = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
      const d = this.perpendicularDistance(points[i], start, end);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance) {
      const left = this.rdpRecursive(points.slice(0, maxIdx + 1), tolerance);
      const right = this.rdpRecursive(points.slice(maxIdx), tolerance);
      return left.slice(0, -1).concat(right);
    } else {
      return [start, end];
    }
  }

  private static perpendicularDistance(pt: Point2D, lineStart: Point2D, lineEnd: Point2D): number {
    const dx = lineEnd.x - lineStart.x;
    const dz = lineEnd.z - lineStart.z;
    const lineLen = Math.hypot(dx, dz);
    if (lineLen < 1e-6) {
      return Math.hypot(pt.x - lineStart.x, pt.z - lineStart.z);
    }
    const num = Math.abs((pt.x - lineStart.x) * dz - (pt.z - lineStart.z) * dx);
    return num / lineLen;
  }

  /**
   * 點在多邊形內判定 (Ray-Casting Algorithm)
   */
  public static pointInPolygon(pt: Point2D, poly: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, zi = poly[i].z;
      const xj = poly[j].x, zj = poly[j].z;
      const intersect = zi > pt.z !== zj > pt.z && pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * 連棟透天厝分戶 (Row House Subdivision)
   * 規則：當一棟長條建築長度 >= 16m、寬度 8~20m 且長寬比 >= 1.7 時，
   * 依戶寬 4~6 公尺切分成單元戶，賦予不同調色盤顏色與微幅樓層差異
   */
  public static subdivideRowHouse(
    bldg: BuildingFeature,
    unitWidthMin = 4.2,
    unitWidthMax = 5.6
  ): BuildingFeature[] | null {
    const poly = bldg.footprint;
    // 判斷是否為近似四邊形 (頂點數 4 或 5 個封閉點)
    const pts = (poly.length >= 4 && Math.hypot(poly[0].x - poly[poly.length - 1].x, poly[0].z - poly[poly.length - 1].z) < 0.2)
      ? poly.slice(0, -1)
      : poly;

    if (pts.length !== 4) return null;

    // 計算 4 條邊長度
    const edges = [
      { p1: pts[0], p2: pts[1], len: Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z) },
      { p1: pts[1], p2: pts[2], len: Math.hypot(pts[2].x - pts[1].x, pts[2].z - pts[1].z) },
      { p1: pts[2], p2: pts[3], len: Math.hypot(pts[3].x - pts[2].x, pts[3].z - pts[2].z) },
      { p1: pts[3], p2: pts[0], len: Math.hypot(pts[0].x - pts[3].x, pts[0].z - pts[3].z) },
    ];

    // 找出兩對對邊：(e0, e2) 與 (e1, e3)
    const lenA = (edges[0].len + edges[2].len) * 0.5;
    const lenB = (edges[1].len + edges[3].len) * 0.5;

    let longEdge1: { p1: Point2D; p2: Point2D; len: number };
    let longEdge2: { p1: Point2D; p2: Point2D; len: number };
    let longLen: number;
    let shortLen: number;

    if (lenA >= lenB) {
      longLen = lenA;
      shortLen = lenB;
      longEdge1 = edges[0]; // pts[0] -> pts[1]
      longEdge2 = { p1: pts[3], p2: pts[2], len: edges[2].len }; // pts[3] -> pts[2]
    } else {
      longLen = lenB;
      shortLen = lenA;
      longEdge1 = edges[1]; // pts[1] -> pts[2]
      longEdge2 = { p1: pts[0], p2: pts[3], len: edges[3].len }; // pts[0] -> pts[3]
    }

    // 門檻：長度 >= 16m、寬度 6~22m、長寬比 >= 1.7
    if (longLen < 16.0 || shortLen < 6.0 || shortLen > 22.0 || longLen / shortLen < 1.6) {
      return null;
    }

    // 計算分戶數量
    const avgUnitW = (unitWidthMin + unitWidthMax) * 0.5;
    const numUnits = Math.max(2, Math.round(longLen / avgUnitW));
    if (numUnits <= 1) return null;

    const result: BuildingFeature[] = [];
    const baseLevels = bldg.levels;

    for (let u = 0; u < numUnits; u++) {
      const t1 = u / numUnits;
      const t2 = (u + 1) / numUnits;

      // 沿兩條長邊插值取得該戶之四邊形頂點
      const pA1 = {
        x: longEdge1.p1.x + (longEdge1.p2.x - longEdge1.p1.x) * t1,
        z: longEdge1.p1.z + (longEdge1.p2.z - longEdge1.p1.z) * t1,
      };
      const pA2 = {
        x: longEdge1.p1.x + (longEdge1.p2.x - longEdge1.p1.x) * t2,
        z: longEdge1.p1.z + (longEdge1.p2.z - longEdge1.p1.z) * t2,
      };
      const pB2 = {
        x: longEdge2.p1.x + (longEdge2.p2.x - longEdge2.p1.x) * t2,
        z: longEdge2.p1.z + (longEdge2.p2.z - longEdge2.p1.z) * t2,
      };
      const pB1 = {
        x: longEdge2.p1.x + (longEdge2.p2.x - longEdge2.p1.x) * t1,
        z: longEdge2.p1.z + (longEdge2.p2.z - longEdge2.p1.z) * t1,
      };

      const unitFootprint = [pA1, pA2, pB2, pB1, { x: pA1.x, z: pA1.z }];
      const unitArea = Math.abs(this.computeSignedArea(unitFootprint));
      const unitCenter = this.computeCentroid(unitFootprint);

      // 各戶顏色與樓層些微變化 (例如 3 層、4 層混搭)
      let unitHash = 0;
      const unitId = `${bldg.id}_u${u + 1}`;
      for (let c = 0; c < unitId.length; c++) unitHash = (unitHash << 5) - unitHash + unitId.charCodeAt(c);
      const levelDiff = (Math.abs(unitHash) % 3) - 1; // -1, 0, +1
      const unitLevels = Math.max(1, baseLevels + levelDiff);
      const unitHeight = +(3.6 + Math.max(0, unitLevels - 1) * 3.1).toFixed(2);

      result.push({
        id: unitId,
        type: bldg.type,
        name: bldg.name ? `${bldg.name} (${u + 1}號)` : undefined,
        height: unitHeight,
        levels: unitLevels,
        minHeight: bldg.minHeight || 0,
        minLevel: bldg.minLevel,
        footprint: unitFootprint,
        holes: [],
        roofShape: bldg.roofShape,
        roofHeight: bldg.roofHeight,
        roofLevels: bldg.roofLevels,
        colorIndex: (bldg.colorIndex + u * 2) % 8,
        heightSource: bldg.heightSource,
        confidence: bldg.confidence,
        area: unitArea,
        center: unitCenter,
        note: bldg.note,
        tags: bldg.tags,
        isSubdividedUnit: true
      });
    }

    return result;
  }
}
