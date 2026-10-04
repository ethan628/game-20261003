/**
 * WeatherService.ts - Open-Meteo 即時氣象獲取與 IndexedDB 快取管理
 * 遵循 RULES.md：純地理氣象資料模組，不依賴 Three.js
 */

import { CONFIG } from '../config.ts';
import { WeatherData, WeatherStateType } from './WeatherTypes.ts';

export class WeatherService {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor() {
    this.initDb();
  }

  private initDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(CONFIG.WEATHER.CACHE_DB_NAME, 1);
        req.onupgradeneeded = (e: any) => {
          const db = e.target.result as IDBDatabase;
          if (!db.objectStoreNames.contains(CONFIG.WEATHER.CACHE_STORE_NAME)) {
            db.createObjectStore(CONFIG.WEATHER.CACHE_STORE_NAME, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  private getCacheKey(lat: number, lon: number): string {
    return `${lat.toFixed(2)}_${lon.toFixed(2)}`;
  }

  /**
   * 取得指定經緯度之氣象資料 (優先連網，失敗時使用本地 IndexedDB 快取，完全無資料則優雅降級)
   */
  public async getWeather(lat: number, lon: number, forceRefresh = false): Promise<WeatherData> {
    const key = this.getCacheKey(lat, lon);

    // 1. 若非強制重新整理，先檢查本地快取是否仍在 10 分鐘內有效
    if (!forceRefresh) {
      try {
        const cached = await this.readCache(key);
        if (cached && Date.now() - cached.fetchedAt < CONFIG.WEATHER.CACHE_TTL_MS) {
          // 在 10 分鐘 TTL 內，視為即時資料的有效本地暫存 (不誤標為離線快取)
          cached.source = 'live';
          cached.cacheAgeSec = Math.round((Date.now() - cached.fetchedAt) / 1000);
          return cached;
        }
      } catch (err) {
        console.warn('[WeatherService] 讀取本地快取異常:', err);
      }
    }

    // 2. 連線 Open-Meteo API
    const url = `${CONFIG.WEATHER.OPEN_METEO_BASE}?latitude=${lat}&longitude=${lon}&timezone=auto&current=temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 7000); // 7s 逾時防卡

      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!resp.ok) {
        throw new Error(`Open-Meteo 伺服器回應狀態: ${resp.status}`);
      }

      const json = await resp.json();
      const current = json.current || {};

      const weatherCode = Number(current.weather_code ?? 0);
      const precipitation = Number(current.precipitation ?? 0);
      const rain = Number(current.rain ?? 0);
      const temperature = Number(current.temperature_2m ?? 25.0);
      const relativeHumidity = Number(current.relative_humidity_2m ?? 70);
      const cloudCover = Number(current.cloud_cover ?? 20);
      const windSpeed = Number(current.wind_speed_10m ?? 8.0);
      const windDirection = Number(current.wind_direction_10m ?? 90);
      const isDay = current.is_day === 1 || current.is_day === undefined;
      const utcOffsetSeconds = Number(json.utc_offset_seconds ?? 28800);
      const timezone = String(json.timezone || 'Asia/Taipei');

      const weatherState = this.mapWmoCodeToState(weatherCode, precipitation);
      const rainIntensity = this.calcRainIntensity(precipitation, weatherCode);

      const data: WeatherData = {
        temperature,
        relativeHumidity,
        precipitation,
        rain,
        weatherCode,
        cloudCover,
        windSpeed,
        windDirection,
        isDay,
        utcOffsetSeconds,
        timezone,
        weatherState,
        rainIntensity,
        fetchedAt: Date.now(),
        source: 'live',
        cacheAgeSec: 0,
        diagnostics: {
          lastRequestUrl: url,
          lastHttpStatus: resp.status,
          lastFetchTime: Date.now(),
          rawSummary: `HTTP ${resp.status} OK | 氣溫 ${temperature}°C, WMO: ${weatherCode}, 降雨: ${precipitation} mm/h, 時區: ${timezone}`
        }
      };

      // 寫入 IndexedDB 本地快取
      await this.saveCache(key, data);
      console.log(`[WeatherService] 成功獲取即時天氣: ${weatherState}, 氣溫 ${temperature}°C, 雨量 ${precipitation} mm/h`);
      return data;
    } catch (err: any) {
      console.warn(`[WeatherService] 連線 Open-Meteo 失敗 (${err.message})，嘗試使用最近一次離線快取...`);

      // 3. 失敗時讀取最近一次離線快取 (標記為真正的離線快取)
      try {
        const cached = await this.readCache(key);
        if (cached) {
          cached.source = 'cache';
          cached.cacheAgeSec = Math.round((Date.now() - cached.fetchedAt) / 1000);
          const d = new Date(cached.fetchedAt);
          cached.cacheTimeStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          if (!cached.diagnostics) cached.diagnostics = {};
          cached.diagnostics.lastRequestUrl = url;
          cached.diagnostics.lastHttpStatus = 0;
          cached.diagnostics.rawSummary = `連線失敗 (${err.message})，使用離線快取 (${cached.cacheTimeStr})`;
          return cached;
        }
      } catch (cErr) {
        console.warn('[WeatherService] 讀取備援快取失敗:', cErr);
      }

      // 4. 完全沒有資料時優雅退回預設晴天
      return this.createFallbackData(lat, lon);
    }
  }

  /**
   * 強制連網重新抓取最新天氣 (手動重整按鈕調用)
   */
  public async forceRefreshWeather(lat: number, lon: number): Promise<WeatherData> {
    return this.getWeather(lat, lon, true);
  }

  /**
   * 將 WMO Weather Code 與降雨量轉換為內部天氣狀態
   */
  public mapWmoCodeToState(code: number, precipitation: number): WeatherStateType {
    // 雷雨
    if ([95, 96, 99].includes(code)) return 'thunderstorm';

    // 豪大雨
    if ([65, 82].includes(code) || precipitation >= 8.0) return 'heavy_rain';

    // 雨 (毛毛雨 / 小雨 / 中雨)
    if ([51, 53, 55, 56, 57, 61, 63, 80, 81].includes(code) || precipitation > 0.1) {
      return precipitation > 3.0 ? 'heavy_rain' : 'light_rain';
    }

    // 濃霧
    if ([45, 48].includes(code)) return 'fog';

    // 陰天
    if (code === 3) return 'overcast';

    // 多雲
    if ([1, 2].includes(code)) return 'cloudy';

    // 晴天
    return 'clear';
  }

  /**
   * 連續降雨強度換算 (0.0 ~ 1.0)
   */
  public calcRainIntensity(precipMmPerHour: number, code: number): number {
    if (precipMmPerHour <= 0.05) {
      // 依 WMO code 給予基礎微雨
      if ([51, 56].includes(code)) return 0.18;
      if ([53, 55, 61].includes(code)) return 0.28;
      if ([63, 80, 81].includes(code)) return 0.50;
      if ([65, 82, 95, 96, 99].includes(code)) return 0.85;
      return 0.0;
    }

    if (precipMmPerHour < 1.5) {
      return 0.15 + (precipMmPerHour / 1.5) * 0.25; // 0.15 ~ 0.40
    }
    if (precipMmPerHour < 6.0) {
      return 0.40 + ((precipMmPerHour - 1.5) / 4.5) * 0.35; // 0.40 ~ 0.75
    }
    return Math.min(1.0, 0.75 + ((precipMmPerHour - 6.0) / 14.0) * 0.25); // 0.75 ~ 1.0
  }

  private async readCache(key: string): Promise<WeatherData | null> {
    const db = await this.initDb();
    return new Promise((resolve) => {
      const tx = db.transaction(CONFIG.WEATHER.CACHE_STORE_NAME, 'readonly');
      const store = tx.objectStore(CONFIG.WEATHER.CACHE_STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result && req.result.data) {
          resolve(req.result.data);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  }

  private async saveCache(key: string, data: WeatherData): Promise<void> {
    const db = await this.initDb();
    return new Promise((resolve) => {
      const tx = db.transaction(CONFIG.WEATHER.CACHE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(CONFIG.WEATHER.CACHE_STORE_NAME);
      store.put({ key, data, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  private createFallbackData(_lat: number, _lon: number): WeatherData {
    return {
      temperature: 26.0,
      relativeHumidity: 65,
      precipitation: 0.0,
      rain: 0.0,
      weatherCode: 0,
      cloudCover: 15,
      windSpeed: 8.0,
      windDirection: 90,
      isDay: true,
      utcOffsetSeconds: 28800,
      timezone: 'Asia/Taipei',
      weatherState: 'clear',
      rainIntensity: 0.0,
      fetchedAt: Date.now(),
      source: 'fallback'
    };
  }
}
