/**
 * BuildingOverrideService.ts - 人工校正檔服務 (優先權最高)
 * 管理 public/data/overrides.json 的載入、依 OSM ID 或座標點命中比對、
 * 即時套用、向 Vite 開發端點存檔或下載 JSON
 */

import { BuildingOverrideData, BuildingOverridesFile, Point2D } from './OsmTypes.ts';
import { GeoProjection } from './Projection.ts';

export class BuildingOverrideService {
  private static instance: BuildingOverrideService | null = null;
  private overrides: BuildingOverridesFile = {
    byOsmId: {},
    byCoord: []
  };
  private isLoaded = false;

  public static getInstance(): BuildingOverrideService {
    if (!this.instance) {
      this.instance = new BuildingOverrideService();
    }
    return this.instance;
  }

  /**
   * 載入 public/data/overrides.json
   */
  public async loadOverrides(): Promise<void> {
    try {
      const resp = await fetch('/data/overrides.json?t=' + Date.now());
      if (resp.ok) {
        const json = await resp.json();
        if (json) {
          this.overrides = {
            byOsmId: json.byOsmId || {},
            byCoord: json.byCoord || []
          };
          this.isLoaded = true;
          console.log(`[BuildingOverrideService] 成功載入人工校正檔，包含 ${Object.keys(this.overrides.byOsmId).length} 筆 OSM ID 校正、${this.overrides.byCoord.length} 筆座標校正`);
          return;
        }
      }
    } catch (err) {
      console.warn('[BuildingOverrideService] 載入 overrides.json 失敗，採用空白配置', err);
    }
    this.isLoaded = true;
  }

  /**
   * 查詢建築是否有對應之人工校正資料
   * 1. 優先依 osmId 比對 (支援 way/123, 123, bldg_123 等多種格式)
   * 2. 其次依座標點比對 (檢查 byCoord 中的點是否落在建物範圍內)
   */
  public findOverride(
    osmId: string,
    footprint: Point2D[],
    projection: GeoProjection
  ): BuildingOverrideData | null {
    if (!this.isLoaded) return null;

    // 1. OSM ID 比對
    const cleanId = osmId.replace(/^bldg_/, '').replace(/^way_/, '').replace(/^relation_/, '');
    const candidates = [
      osmId,
      cleanId,
      `way/${cleanId}`,
      `relation/${cleanId}`,
      `way_${cleanId}`,
      `bldg_${cleanId}`
    ];

    for (const key of candidates) {
      if (this.overrides.byOsmId[key]) {
        return this.overrides.byOsmId[key];
      }
    }

    // 2. 座標點比對 (經緯度轉局部座標檢測)
    if (this.overrides.byCoord.length > 0 && footprint.length >= 3) {
      for (const entry of this.overrides.byCoord) {
        const ptLocal = projection.project(entry.lat, entry.lon);
        if (this.pointInPolygon(ptLocal, footprint)) {
          return {
            levels: entry.levels,
            height: entry.height,
            roofShape: entry.roofShape,
            note: entry.note
          };
        }
      }
    }

    return null;
  }

  /**
   * 套用並儲存新的校正項
   * 優先呼叫 Vite 開發端點 /api/save-override 寫入磁碟，若失敗則觸發瀏覽器下載
   */
  public async setOverride(
    osmId: string,
    data: BuildingOverrideData
  ): Promise<{ savedToDisk: boolean; message: string }> {
    const cleanId = osmId.replace(/^bldg_/, '').replace(/^way_/, '').replace(/^relation_/, '');
    const canonicalKey = osmId.startsWith('relation') ? `relation/${cleanId}` : `way/${cleanId}`;

    this.overrides.byOsmId[canonicalKey] = {
      levels: data.levels,
      height: data.height,
      roofShape: data.roofShape,
      minHeight: data.minHeight,
      note: data.note
    };

    // 嘗試向 Vite 開發端點發送寫入請求
    try {
      const resp = await fetch('/api/save-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.overrides, null, 2)
      });
      if (resp.ok) {
        return { savedToDisk: true, message: `已成功寫入磁碟 public/data/overrides.json (${canonicalKey})` };
      }
    } catch {
      // 開發端點未啟用或在生產模式
    }

    return { savedToDisk: false, message: `已更新記憶體，可點擊「下載 JSON」存檔` };
  }

  public getOverrides(): BuildingOverridesFile {
    return this.overrides;
  }

  /**
   * 匯出 overrides.json 檔案
   */
  public downloadOverridesJson(): void {
    const blob = new Blob([JSON.stringify(this.overrides, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'overrides.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
