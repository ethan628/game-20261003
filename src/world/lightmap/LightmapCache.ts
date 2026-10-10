/**
 * LightmapCache.ts - 區塊光照圖 IndexedDB 快取管理
 * 切換地點時主動清除舊地點快取，避免佔用儲存空間
 */

export class LightmapCache {
  private static DB_NAME = 'GTA_Lightmap_Cache_v1';
  private static STORE_NAME = 'chunks';
  private dbPromise: Promise<IDBDatabase | null> | null = null;

  constructor() {
    this.initDB();
  }

  private initDB(): Promise<IDBDatabase | null> {
    if (this.dbPromise) return this.dbPromise;

    if (typeof window === 'undefined' || !window.indexedDB) {
      this.dbPromise = Promise.resolve(null);
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve) => {
      const request = window.indexedDB.open(LightmapCache.DB_NAME, 1);

      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(LightmapCache.STORE_NAME)) {
          db.createObjectStore(LightmapCache.STORE_NAME, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });

    return this.dbPromise;
  }

  public async getChunk(key: string): Promise<{ pixels: Uint8ClampedArray; width: number; height: number } | null> {
    try {
      const db = await this.initDB();
      if (!db) return null;

      return new Promise((resolve) => {
        const tx = db.transaction(LightmapCache.STORE_NAME, 'readonly');
        const store = tx.objectStore(LightmapCache.STORE_NAME);
        const req = store.get(key);

        req.onsuccess = () => {
          if (req.result && req.result.pixels) {
            resolve({
              pixels: new Uint8ClampedArray(req.result.pixels),
              width: req.result.width,
              height: req.result.height
            });
          } else {
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  public async setChunk(
    key: string,
    width: number,
    height: number,
    pixels: Uint8ClampedArray
  ): Promise<void> {
    try {
      const db = await this.initDB();
      if (!db) return;

      return new Promise((resolve) => {
        const tx = db.transaction(LightmapCache.STORE_NAME, 'readwrite');
        const store = tx.objectStore(LightmapCache.STORE_NAME);
        store.put({
          key,
          width,
          height,
          pixels: pixels.buffer
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // 忽略快取寫入錯誤
    }
  }

  public async clearLocation(locationPrefix: string): Promise<void> {
    try {
      const db = await this.initDB();
      if (!db) return;

      return new Promise((resolve) => {
        const tx = db.transaction(LightmapCache.STORE_NAME, 'readwrite');
        const store = tx.objectStore(LightmapCache.STORE_NAME);
        const req = store.openCursor();

        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            if (String(cursor.key).startsWith(locationPrefix)) {
              cursor.delete();
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => resolve();
      });
    } catch {
      // 忽略
    }
  }

  public async clearAll(): Promise<void> {
    try {
      const db = await this.initDB();
      if (!db) return;
      const tx = db.transaction(LightmapCache.STORE_NAME, 'readwrite');
      tx.objectStore(LightmapCache.STORE_NAME).clear();
    } catch {
      // 忽略
    }
  }
}
