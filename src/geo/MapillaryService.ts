/**
 * MapillaryService.ts - Mapillary Graph API 查詢服務
 * 依據 RULES.md 與使用者要求：
 * 1. 嚴禁下載或批次抓取影像，也不得把街景畫面當貼圖或做 OCR
 * 2. 僅查詢離玩家座標最近的影像中繼資料（id、經緯度、方位角）
 * 3. 查詢範圍從 30 公尺起，找不到再放寬到 100 公尺；仍找不到顯示「此處沒有街景」，不報錯
 * 4. 查詢結果快取至 IndexedDB，避免重複發送 Graph API 請求
 */

import { CONFIG } from '../config.ts';
import { MapillaryCache } from './MapillaryCache.ts';

export interface MapillaryImageResult {
  id: string;
  lat: number;
  lon: number;
  compassAngle: number;
  distance: number;
}

export class MapillaryService {
  private token: string = '';
  private cache: MapillaryCache;
  private hasWarnedMissingToken = false;

  constructor() {
    this.cache = new MapillaryCache();
    // 從環境變數讀取 VITE_MAPILLARY_TOKEN
    this.token = (import.meta.env.VITE_MAPILLARY_TOKEN || '').trim();

    if (!this.token && !this.hasWarnedMissingToken) {
      console.info(
        '[Mapillary] 未偵測到 VITE_MAPILLARY_TOKEN。街景功能已就緒，若需啟用請在 .env 設定免費 Token（格式為 MLY|...，參考 .env.example）。'
      );
      this.hasWarnedMissingToken = true;
    }
  }

  public hasToken(): boolean {
    return !!this.token;
  }

  public getToken(): string {
    return this.token;
  }

  /**
   * 計算兩點經緯度之近似地面距離 (公尺)
   */
  private getApproxDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const earthRadius = 6378137.0;
    const avgLatRad = ((lat1 + lat2) * 0.5 * Math.PI) / 180.0;
    const dLatMeters = ((lat2 - lat1) * Math.PI * earthRadius) / 180.0;
    const dLonMeters = ((lon2 - lon1) * Math.PI * earthRadius * Math.cos(avgLatRad)) / 180.0;
    return Math.hypot(dLatMeters, dLonMeters);
  }

  /**
   * 根據中心經緯度與半徑 (公尺) 計算 Bounding Box 字串
   */
  private computeBBox(lat: number, lon: number, radiusMeters: number): string {
    const earthRadius = 6378137.0;
    const dLat = (radiusMeters / earthRadius) * (180.0 / Math.PI);
    const dLon = (radiusMeters / (earthRadius * Math.cos((lat * Math.PI) / 180.0))) * (180.0 / Math.PI);

    const minLon = lon - dLon;
    const minLat = lat - dLat;
    const maxLon = lon + dLon;
    const maxLat = lat + dLat;

    return `${minLon.toFixed(6)},${minLat.toFixed(6)},${maxLon.toFixed(6)},${maxLat.toFixed(6)}`;
  }

  /**
   * 向 Mapillary Graph API 查詢給定半徑範圍內的街景影像清單
   */
  private async queryGraphApi(lat: number, lon: number, radiusMeters: number): Promise<MapillaryImageResult | null> {
    if (!this.token) return null;

    const bbox = this.computeBBox(lat, lon, radiusMeters);
    const fields = 'id,geometry,computed_geometry,compass_angle,computed_compass_angle';
    const url = `${CONFIG.MAPILLARY.API_URL}?access_token=${encodeURIComponent(this.token)}&bbox=${bbox}&fields=${fields}&limit=20`;

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' }
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          console.warn('[Mapillary] Token 無效或已過期，請檢查 .env 中的 VITE_MAPILLARY_TOKEN');
        } else {
          console.warn(`[Mapillary] Graph API 回傳狀態碼: ${response.status}`);
        }
        return null;
      }

      const json = await response.json();
      const items = json.data;

      if (!items || items.length === 0) {
        return null;
      }

      // 遍歷所有候選照片，挑選距離目標座標最近的一張
      let bestItem: MapillaryImageResult | null = null;
      let minDistance = Infinity;

      for (const item of items) {
        const coords = item.computed_geometry?.coordinates || item.geometry?.coordinates;
        if (!coords || coords.length < 2) continue;

        const imgLon = coords[0];
        const imgLat = coords[1];
        const dist = this.getApproxDistance(lat, lon, imgLat, imgLon);

        if (dist < minDistance) {
          minDistance = dist;
          bestItem = {
            id: item.id,
            lat: imgLat,
            lon: imgLon,
            compassAngle: item.computed_compass_angle ?? item.compass_angle ?? 0,
            distance: dist
          };
        }
      }

      return bestItem;
    } catch (err: any) {
      console.warn('[Mapillary] 查詢 Graph API 失敗 (網路連線或 CORS 限制)', err.message);
      return null;
    }
  }

  /**
   * 查詢離玩家經緯度最近之真實街景影像
   * 先以 30 公尺搜尋，找不到再放寬到 100 公尺；若仍找不到則回傳 null
   */
  public async findNearestImage(lat: number, lon: number): Promise<MapillaryImageResult | null> {
    if (!this.token) {
      return null;
    }

    // 1. 優先查詢本地 IndexedDB 快取
    const cached = await this.cache.get(lat, lon);
    if (cached) {
      if (cached.imageId === null) {
        // 本地快取已知此區無街景
        return null;
      }
      return {
        id: cached.imageId,
        lat: cached.imageLat ?? lat,
        lon: cached.imageLon ?? lon,
        compassAngle: cached.compassAngle ?? 0,
        distance: this.getApproxDistance(lat, lon, cached.imageLat ?? lat, cached.imageLon ?? lon)
      };
    }

    // 2. 第一階段：以 30 公尺為半徑尋找最近影像
    let result = await this.queryGraphApi(lat, lon, CONFIG.MAPILLARY.INITIAL_SEARCH_RADIUS);

    // 3. 第二階段：若 30 公尺找不到，放寬至 100 公尺
    if (!result) {
      result = await this.queryGraphApi(lat, lon, CONFIG.MAPILLARY.EXTENDED_SEARCH_RADIUS);
    }

    // 4. 寫入本地快取
    if (result) {
      await this.cache.set(lat, lon, {
        imageId: result.id,
        imageLat: result.lat,
        imageLon: result.lon,
        compassAngle: result.compassAngle,
        timestamp: Date.now()
      });
    } else {
      // 標記此處無街景
      await this.cache.set(lat, lon, {
        imageId: null,
        timestamp: Date.now()
      });
    }

    return result;
  }
}
