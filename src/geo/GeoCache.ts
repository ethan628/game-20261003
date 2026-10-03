/**
 * GeoCache.ts - IndexedDB 本地快取層
 * 將下載與解析後的 OSM 地理資料持久化，避免重複請求 Overpass API
 */

import { CONFIG } from '../config.ts';
import { OsmWorldData } from './OsmTypes.ts';

export class GeoCache {
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor() {
    this.checkVersionAndInit();
  }

  private checkVersionAndInit(): void {
    if (typeof window === 'undefined') return;
    const currentVersion = CONFIG.GEO.CACHE_VERSION;
    const storedVersion = localStorage.getItem('GTA_CACHE_VERSION');
    if (storedVersion !== currentVersion) {
      console.log(`[GeoCache] 偵測到快取版本升級 (${storedVersion || 'none'} -> ${currentVersion})，自動清除舊快取`);
      try {
        localStorage.setItem('GTA_CACHE_VERSION', currentVersion);
        if (window.indexedDB) {
          window.indexedDB.deleteDatabase(CONFIG.GEO.CACHE_DB_NAME);
          window.indexedDB.deleteDatabase('GTA_OSM_Cache_v1');
          window.indexedDB.deleteDatabase('GTA_OSM_Cache_v2');
        }
      } catch (e) {
        console.warn('[GeoCache] 清除舊快取失敗', e);
      }
    }
    this.initDB();
  }

  private initDB(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;

    if (typeof window === 'undefined' || !window.indexedDB) {
      console.warn('[GeoCache] IndexedDB 不支援，快取已停用');
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve) => {
      const request = window.indexedDB.open(CONFIG.GEO.CACHE_DB_NAME, 1);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(CONFIG.GEO.CACHE_STORE_NAME)) {
          db.createObjectStore(CONFIG.GEO.CACHE_STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = (e) => {
        console.warn('[GeoCache] 開啟 IndexedDB 失敗', e);
        resolve(null);
      };
    });

    return this.dbPromise;
  }

  private makeKey(lat: number, lon: number, radiusMeters: number): string {
    // 經緯度保留至小數點後 3 位 (約 100 公尺精度網格)
    return `loc_${lat.toFixed(3)}_${lon.toFixed(3)}_${Math.round(radiusMeters)}`;
  }

  /**
   * 嘗試從 IndexedDB 讀取已快取之地理資料
   */
  public async get(lat: number, lon: number, radiusMeters: number): Promise<OsmWorldData | null> {
    try {
      const db = await this.initDB();
      if (!db) return null;

      const key = this.makeKey(lat, lon, radiusMeters);

      return new Promise((resolve) => {
        const tx = db.transaction(CONFIG.GEO.CACHE_STORE_NAME, 'readonly');
        const store = tx.objectStore(CONFIG.GEO.CACHE_STORE_NAME);
        const req = store.get(key);

        req.onsuccess = () => {
          if (req.result && req.result.data) {
            console.log(`[GeoCache] 命中本地快取 (${key})`);
            resolve(req.result.data as OsmWorldData);
          } else {
            resolve(null);
          }
        };

        req.onerror = () => {
          resolve(null);
        };
      });
    } catch (err) {
      console.warn('[GeoCache] 讀取快取例外', err);
      return null;
    }
  }

  /**
   * 寫入地理資料至 IndexedDB
   */
  public async set(lat: number, lon: number, radiusMeters: number, data: OsmWorldData): Promise<void> {
    try {
      const db = await this.initDB();
      if (!db) return;

      const key = this.makeKey(lat, lon, radiusMeters);

      return new Promise((resolve) => {
        const tx = db.transaction(CONFIG.GEO.CACHE_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CONFIG.GEO.CACHE_STORE_NAME);
        const req = store.put({
          key,
          data,
          savedAt: Date.now()
        });

        req.onsuccess = () => {
          console.log(`[GeoCache] 成功儲存快取 (${key})`);
          resolve();
        };

        req.onerror = (e) => {
          console.warn('[GeoCache] 寫入快取失敗', e);
          resolve();
        };
      });
    } catch (err) {
      console.warn('[GeoCache] 寫入快取例外', err);
    }
  }

  /**
   * 手動清除所有快取（支援 F4 快捷鍵與 HUD 按鈕）
   */
  public async clearAll(): Promise<void> {
    try {
      const db = await this.initDB();
      if (db) {
        db.close();
        this.dbPromise = null;
      }
      if (typeof window !== 'undefined' && window.indexedDB) {
        window.indexedDB.deleteDatabase(CONFIG.GEO.CACHE_DB_NAME);
        window.indexedDB.deleteDatabase('GTA_OSM_Cache_v1');
        window.indexedDB.deleteDatabase('GTA_OSM_Cache_v2');
      }
      console.log('[GeoCache] 已完全清除本地 IndexedDB 地理快取');
    } catch (e) {
      console.warn('[GeoCache] 清除快取時發生錯誤', e);
    }
  }
}
