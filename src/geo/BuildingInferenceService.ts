/**
 * BuildingInferenceService.ts - 建築樓層高度推測與信心等級管線
 * 實作規則：
 * 1. 樓高公式：一樓 3.6m，其餘每層 3.1m，頂樓加蓋 2.8m。height 與 levels 同時存在時以 height 為準。
 * 2. 推測補值要素：
 *    - building 標籤類型基準 (hotel, commercial, apartments, house, temple 等)
 *    - 輪廓面積 (大面積商業綜合體 vs 小型獨立透天)
 *    - 離最近主要道路距離 (臨主要幹道商業樓層較高)
 *    - 周圍 50 公尺內「有實測資料建築」之樓層中位數 (Spatial context)
 *    - 決定性小幅擾動 (+1, 0, -1)
 * 3. 匯出推測清單 (JSON 格式)
 */

import { CONFIG } from '../config.ts';
import {
  BuildingFeature,
  BuildingRoofShape,
  Point2D,
  RoadFeature
} from './OsmTypes.ts';

export interface InferenceCandidateInput {
  osmId: string;
  tags: Record<string, string>;
  footprint: Point2D[];
  area: number;
  center: Point2D;
}

export interface EstimatedExportItem {
  osmId: string;
  lat: number;
  lon: number;
  localX: number;
  localZ: number;
  estimatedLevels: number;
  estimatedHeight: number;
  area: number;
  buildingType: string;
  confidence: number;
  nearestRoad?: string;
}

export class BuildingInferenceService {
  /**
   * 計算樓層轉高度：一樓 3.6m、其餘每層 3.1m、選配頂樓加蓋 2.8m
   */
  public static calcHeightFromLevels(levels: number, hasRooftopAddon = false): number {
    const safeLevels = Math.max(1, Math.round(levels));
    const h1 = CONFIG.BUILDINGS.FIRST_FLOOR_HEIGHT; // 3.6m
    const upper = (safeLevels - 1) * CONFIG.BUILDINGS.TYPICAL_FLOOR_HEIGHT; // 3.1m
    const rooftop = hasRooftopAddon ? CONFIG.BUILDINGS.ROOFTOP_ADDON_HEIGHT : 0; // 2.8m
    return +(h1 + upper + rooftop).toFixed(2);
  }

  /**
   * 計算高度轉樓層
   */
  public static calcLevelsFromHeight(height: number): number {
    const h1 = CONFIG.BUILDINGS.FIRST_FLOOR_HEIGHT;
    if (height <= h1 + 1.0) return 1;
    const remaining = height - h1;
    return Math.max(1, Math.round(1 + remaining / CONFIG.BUILDINGS.TYPICAL_FLOOR_HEIGHT));
  }

  /**
   * 批次對整批建物執行空間中位數與推測補值
   */
  public static inferMissingBuildings(
    buildings: BuildingFeature[],
    roads: RoadFeature[]
  ): void {
    // 1. 建立有實測/校正資料建物清單
    const knownBuildings = buildings.filter(
      (b) => b.heightSource === 'osm' || b.heightSource === 'override' || b.heightSource === 'external'
    );

    // 2. 找出主要幹道清單 (用於計算臨路寬闊度)
    const primaryRoads = roads.filter((r) => r.width >= 7.0);

    for (const bldg of buildings) {
      if (bldg.heightSource !== 'estimated') continue;

      const tags = bldg.tags || {};
      const area = bldg.area;
      const center = bldg.center;

      // 要素 A: 類型基準樓層
      const bType = tags.building || 'yes';
      let typeBaseline = 3; // 預設 3 層 (台灣市區常見透天厝)
      let roofShape: BuildingRoofShape = 'flat';

      if (bType === 'hotel' || tags.tourism === 'hotel') {
        typeBaseline = area > 600 ? 10 : 7;
      } else if (bType === 'apartments') {
        typeBaseline = area > 500 ? 8 : 6;
      } else if (bType === 'commercial' || bType === 'retail' || bType === 'office') {
        typeBaseline = area > 400 ? 6 : 4;
      } else if (bType === 'residential' || bType === 'house' || bType === 'terrace') {
        typeBaseline = area > 250 ? 4 : 3;
      } else if (bType === 'temple' || tags.amenity === 'place_of_worship') {
        typeBaseline = 2;
        roofShape = 'gabled';
      } else if (bType === 'industrial' || bType === 'warehouse') {
        typeBaseline = 1;
      } else if (bType === 'school' || bType === 'civic') {
        typeBaseline = 4;
      }

      // 要素 B: 面積加權
      if (area >= 1200) typeBaseline += 3;
      else if (area >= 600) typeBaseline += 2;
      else if (area >= 300) typeBaseline += 1;
      else if (area < 65) typeBaseline = Math.min(typeBaseline, 3);

      // 要素 C: 臨主要道路加權 (距離主要幹道 < 25m 者通常為較高街屋或飯店)
      let minDistToMajor = Infinity;
      for (const pr of primaryRoads) {
        for (const pt of pr.points) {
          const d = Math.hypot(pt.x - center.x, pt.z - center.z);
          if (d < minDistToMajor) minDistToMajor = d;
        }
      }
      if (minDistToMajor < 20.0) {
        typeBaseline += 1;
      } else if (minDistToMajor > 90.0) {
        typeBaseline = Math.max(2, typeBaseline - 1);
      }

      // 要素 D: 空間鄰近 50m 內有資料建築樓層中位數
      const nearbyLevels: number[] = [];
      for (const kb of knownBuildings) {
        const d = Math.hypot(kb.center.x - center.x, kb.center.z - center.z);
        if (d <= 50.0) {
          nearbyLevels.push(kb.levels);
        }
      }

      let finalLevels = typeBaseline;
      let confidence = 0.50;

      if (nearbyLevels.length > 0) {
        nearbyLevels.sort((a, b) => a - b);
        const mid = Math.floor(nearbyLevels.length / 2);
        const median = nearbyLevels.length % 2 === 0
          ? Math.round((nearbyLevels[mid - 1] + nearbyLevels[mid]) / 2)
          : nearbyLevels[mid];

        // 鄰近中位數佔 60% 權重，類型佔 40%
        finalLevels = Math.round(0.6 * median + 0.4 * typeBaseline);
        confidence = Math.min(0.68, 0.52 + nearbyLevels.length * 0.03);
      }

      // 決定性 Hash 擾動 (+1, 0, -1)
      let hash = 0;
      for (let i = 0; i < bldg.id.length; i++) {
        hash = (hash << 5) - hash + bldg.id.charCodeAt(i);
      }
      const jitter = (Math.abs(hash) % 3) - 1; // -1, 0, +1
      finalLevels = Math.max(1, Math.min(18, finalLevels + jitter));

      // 屋頂加蓋判定 (透天厝或一般民宅約 35% 機率有頂樓鐵皮加蓋)
      const hasRooftopAddon = (bType === 'residential' || bType === 'house' || bType === 'yes') && (Math.abs(hash * 7) % 10 < 4);

      bldg.levels = finalLevels;
      bldg.height = this.calcHeightFromLevels(finalLevels, hasRooftopAddon);
      bldg.roofShape = roofShape;
      bldg.confidence = +confidence.toFixed(2);
    }
  }

  /**
   * 產生「推測樓層建築清單」JSON
   */
  public static generateEstimatedListJson(
    buildings: BuildingFeature[],
    roads: RoadFeature[],
    unprojectFn: (x: number, z: number) => { lat: number; lon: number }
  ): string {
    const estimatedList = buildings.filter((b) => b.heightSource === 'estimated');

    const items: EstimatedExportItem[] = estimatedList.map((b) => {
      const geo = unprojectFn(b.center.x, b.center.z);
      // 尋找最近道路名稱
      let nearestRoadName = '未知道路';
      let minDist = Infinity;
      for (const r of roads) {
        for (const pt of r.points) {
          const d = Math.hypot(pt.x - b.center.x, pt.z - b.center.z);
          if (d < minDist) {
            minDist = d;
            if (r.name) nearestRoadName = r.name;
          }
        }
      }

      return {
        osmId: b.id,
        lat: +geo.lat.toFixed(6),
        lon: +geo.lon.toFixed(6),
        localX: +b.center.x.toFixed(1),
        localZ: +b.center.z.toFixed(1),
        estimatedLevels: b.levels,
        estimatedHeight: b.height,
        area: +b.area.toFixed(1),
        buildingType: b.type,
        confidence: b.confidence,
        nearestRoad: nearestRoadName
      };
    });

    return JSON.stringify(
      {
        description: '宜蘭礁溪推測樓層建築清單 (待人工校正)',
        generatedAt: new Date().toISOString(),
        totalEstimated: items.length,
        items
      },
      null,
      2
    );
  }
}
