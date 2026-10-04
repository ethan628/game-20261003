/**
 * WeatherTypes.ts - 天氣與氣象資料模型定義
 * 遵循 RULES.md：純型別與資料物件，不依賴 Three.js
 */

export type WeatherStateType =
  | 'clear'
  | 'cloudy'
  | 'overcast'
  | 'fog'
  | 'light_rain'
  | 'heavy_rain'
  | 'thunderstorm'
  | 'typhoon';

export type TimeSourceMode = 'real' | 'virtual';
export type WeatherSourceMode = 'real' | 'virtual';

export type TwilightPhase = 'dawn' | 'sunrise' | 'day' | 'sunset' | 'dusk' | 'night';

export interface WeatherData {
  temperature: number;          // 氣溫 (°C)
  relativeHumidity: number;     // 相對濕度 (%)
  precipitation: number;        // 當前降雨量 (mm/h)
  rain: number;                 // 雨量 (mm)
  weatherCode: number;          // WMO 原始天氣代碼
  cloudCover: number;           // 雲量 (%) (0 ~ 100)
  windSpeed: number;            // 風速 (km/h)
  windDirection: number;        // 風向 (度，0~360)
  isDay: boolean;               // 是否白天
  utcOffsetSeconds: number;     // 與 UTC 之時區位移秒數
  timezone: string;             // 時區名稱 (例如 Asia/Taipei)
  weatherState: WeatherStateType;// 映射之內部天氣狀態
  rainIntensity: number;        // 連續降雨強度 (0.0 ~ 1.0)
  fetchedAt: number;            // 抓取時間戳記 (ms)
  source: 'live' | 'cache' | 'fallback'; // 資料來源
  cacheTimeStr?: string;        // 離線快取時間字串
  cacheAgeSec?: number;         // 快取存活秒數
  diagnostics?: {
    lastRequestUrl?: string;
    lastHttpStatus?: number;
    lastFetchTime?: number;
    rawSummary?: string;
  };
}

export interface CelestialCoordinates {
  altitudeRad: number;          // 高度角 (弧度)
  altitudeDeg: number;          // 高度角 (度)
  azimuthRad: number;           // 方位角 (弧度，北為0/南為180)
  azimuthDeg: number;           // 方位角 (度)
  directionVector: [number, number, number]; // 單位方向向量 (x, y, z)
}

export interface SunMoonInfo {
  sun: CelestialCoordinates;
  moon: CelestialCoordinates;
  moonPhase: number;            // 月相 (0.0=新月, 0.25=上弦, 0.5=滿月, 0.75=下弦, 1.0=新月)
  moonIllumination: number;     // 照亮比例 (0.0 ~ 1.0)
  twilightPhase: TwilightPhase; // 暮光階段
  isSunAboveHorizon: boolean;
  isNight: boolean;
}

export interface WeatherVisualParams {
  rainIntensity: number;        // 0.0 ~ 1.0
  cloudCover: number;           // 0.0 ~ 1.0
  fogDensity: number;           // 霧氣倍率 (1.0 基準)
  windSpeedMps: number;         // 風速 (m/s)
  windAngleRad: number;         // 風向 (弧度)
  wetness: number;              // 路面濕潤度 (0.0 ~ 1.0)
  thunderFlash: number;         // 閃電增益 (0.0 ~ 1.0)
  saturationMult: number;       // 色彩飽和度調節 (1.0 基準)
  contrastMult: number;         // 對比度調節 (1.0 基準)
}
