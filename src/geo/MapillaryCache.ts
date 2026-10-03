/**
 * MapillaryCache.ts - Mapillary 查詢結果 IndexedDB 快取
 * 依據規範：
 * 嚴禁下載或快取任何影像檔案，只快取「座標 ➔ 影像 id 與經緯度、方位角」等輕量中繼資料
 */

export interface MapillaryCachedLocation {
  imageId: string | null;
  imageLat?: number;
  imageLon?: number;
  compassAngle?: number;
  timestamp: number;
}

export class MapillaryCache {
  private static DB_NAME = 'gta_mapillary_cache_db';
  private static STORE_NAME = 'location_images';
  private static DB_VERSION = 1;
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor() {
    this.initDB();
  }

  private initDB(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;

    if (typeof window === 'undefined' || !window.indexedDB) {
      console.warn('[MapillaryCache] IndexedDB 不支援，快取已停用');
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve) => {
      const request = window.indexedDB.open(MapillaryCache.DB_NAME, MapillaryCache.DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(MapillaryCache.STORE_NAME)) {
          db.createObjectStore(MapillaryCache.STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = (e) => {
        console.warn('[MapillaryCache] 開啟 IndexedDB 失敗', e);
        resolve(null);
      };
    });

    return this.dbPromise;
  }

  /**
   * 建立空間網格 Key（約 10 公尺精度，小數點後 4 位）
   */
  private makeKey(lat: number, lon: number): string {
    return `mly_${lat.toFixed(4)}_${lon.toFixed(4)}`;
  }

  /**
   * 查詢座標附近是否有已快取的街景影像 ID
   */
  public async get(lat: number, lon: number): Promise<MapillaryCachedLocation | null> {
    try {
      const db = await this.initDB();
      if (!db) return null;

      const key = this.makeKey(lat, lon);

      return new Promise((resolve) => {
        const tx = db.transaction(MapillaryCache.STORE_NAME, 'readonly');
        const store = tx.objectStore(MapillaryCache.STORE_NAME);
        const req = store.get(key);

        req.onsuccess = () => {
          if (req.result) {
            const data = req.result as { key: string; val: MapillaryCachedLocation };
            // 快取有效期 7 天
            if (Date.now() - data.val.timestamp < 7 * 24 * 3600 * 1000) {
              resolve(data.val);
              return;
            }
          }
          resolve(null);
        };

        req.onerror = () => {
          resolve(null);
        };
      });
    } catch (err) {
      console.warn('[MapillaryCache] 讀取快取例外', err);
      return null;
    }
  }

  /**
   * 寫入座標與對應影像 ID 快取（不含任何影像本體）
   */
  public async set(lat: number, lon: number, val: MapillaryCachedLocation): Promise<void> {
    try {
      const db = await this.initDB();
      if (!db) return;

      const key = this.makeKey(lat, lon);

      return new Promise((resolve) => {
        const tx = db.transaction(MapillaryCache.STORE_NAME, 'readwrite');
        const store = tx.objectStore(MapillaryCache.STORE_NAME);
        const req = store.put({ key, val });

        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    } catch (err) {
      console.warn('[MapillaryCache] 寫入快取例外', err);
    }
  }
}
