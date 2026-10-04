/**
 * WeatherSystem.ts - 現實與虛擬天氣系統核心控制器
 * 遵循 RULES.md：平滑狀態切換、降雨/風力/路面濕潤驅動、雷雨閃電排程
 */

import { CONFIG } from '../../config.ts';
import {
  WeatherStateType,
  WeatherSourceMode,
  WeatherData,
  WeatherVisualParams
} from '../../geo/WeatherTypes.ts';
import { WeatherService } from '../../geo/WeatherService.ts';

const STORAGE_KEY = 'gta_weather_settings_v1';

// 天氣類型基準視覺目標參數 (包含降雨、雲量、霧、風速、濕潤目標、雷擊機率)
export interface WeatherPresetDefinition {
  rain: number;           // 降雨強度 (0.0 ~ 1.0)
  cloud: number;          // 雲量 (0.0 ~ 1.0)
  fog: number;            // 濃霧倍率 (0.1 ~ 3.0)
  windMps: number;        // 風速 (m/s)
  wetnessTarget: number;  // 路面濕潤度目標 (0.0 ~ 1.0)
  lightningChance: number;// 雷擊機率 (0.0 ~ 1.0)
  sat: number;            // 飽和度調節
  contrast: number;       // 對比度調節
}

export const WEATHER_TYPE_PRESETS: Record<WeatherStateType, WeatherPresetDefinition> = {
  clear: { rain: 0.0, cloud: 0.08, fog: 0.12, windMps: 2.2, wetnessTarget: 0.0, lightningChance: 0.0, sat: 1.0, contrast: 1.0 },
  cloudy: { rain: 0.0, cloud: 0.55, fog: 0.25, windMps: 4.2, wetnessTarget: 0.0, lightningChance: 0.0, sat: 0.95, contrast: 0.96 },
  overcast: { rain: 0.0, cloud: 0.95, fog: 0.45, windMps: 5.5, wetnessTarget: 0.0, lightningChance: 0.0, sat: 0.86, contrast: 0.90 },
  fog: { rain: 0.0, cloud: 0.85, fog: 2.50, windMps: 1.2, wetnessTarget: 0.15, lightningChance: 0.0, sat: 0.78, contrast: 0.80 },
  light_rain: { rain: 0.35, cloud: 0.88, fog: 0.55, windMps: 6.2, wetnessTarget: 0.60, lightningChance: 0.0, sat: 0.84, contrast: 0.88 },
  heavy_rain: { rain: 0.85, cloud: 1.00, fog: 1.10, windMps: 12.5, wetnessTarget: 1.00, lightningChance: 0.15, sat: 0.74, contrast: 0.82 },
  thunderstorm: { rain: 0.95, cloud: 1.00, fog: 1.30, windMps: 16.0, wetnessTarget: 1.00, lightningChance: 1.00, sat: 0.68, contrast: 0.78 },
  typhoon: { rain: 1.00, cloud: 1.00, fog: 1.90, windMps: 26.0, wetnessTarget: 1.00, lightningChance: 0.80, sat: 0.58, contrast: 0.72 }
};

export type WeatherChangeCallback = (current: WeatherData, params: WeatherVisualParams) => void;
export type LightningCallback = (intensity: number, delayToThunderSec: number) => void;

export class WeatherSystem {
  private mode: WeatherSourceMode = CONFIG.WEATHER.DEFAULT_MODE;
  private virtualType: WeatherStateType = CONFIG.WEATHER.DEFAULT_VIRTUAL_TYPE;
  private autoChangeEnabled: boolean = false;
  private autoChangeTimer: number = 0;
  private instantApply: boolean = false; // 立即套用勾選

  private currentLat: number = 24.827; // 礁溪
  private currentLon: number = 121.771;

  // 即時天氣資料
  private liveData: WeatherData | null = null;
  private lastFetchTime: number = 0;
  private isFetching: boolean = false;

  // 過渡狀態管理
  private isTransitioning: boolean = false;
  private transitionProgress: number = 1.0;
  private transitionElapsedSec: number = 0;
  private transitionTotalSec: number = CONFIG.WEATHER.TRANSITION_DURATION_SEC;

  // 視覺參數與目標參數 (用於平滑過渡)
  private currentParams: WeatherVisualParams = {
    rainIntensity: 0.0,
    cloudCover: 0.08,
    fogDensity: 0.12,
    windSpeedMps: 2.2,
    windAngleRad: 0.78, // 東北風
    wetness: 0.0,
    thunderFlash: 0.0,
    saturationMult: 1.0,
    contrastMult: 1.0
  };

  private targetParams: WeatherVisualParams = { ...this.currentParams };
  private currentWetnessTarget: number = 0.0;

  // 閃電定時器
  private lightningTimer: number = 12.0;

  // 事件回調
  private changeListeners: WeatherChangeCallback[] = [];
  private lightningListeners: LightningCallback[] = [];

  constructor() {
    this.loadSettings();
    this.refreshTargetParams();

    // 立即對齊當前參數
    this.currentParams = { ...this.targetParams };
    this.currentParams.wetness = this.currentWetnessTarget;

    // 啟動首次天氣拉取
    this.fetchLiveWeather();
  }

  private loadSettings(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.mode === 'real' || data.mode === 'virtual') {
          this.mode = data.mode;
        }
        if (data.virtualType && WEATHER_TYPE_PRESETS[data.virtualType as WeatherStateType]) {
          this.virtualType = data.virtualType;
        }
        if (typeof data.autoChange === 'boolean') {
          this.autoChangeEnabled = data.autoChange;
        }
        if (typeof data.instantApply === 'boolean') {
          this.instantApply = data.instantApply;
        }
      }
    } catch (e) {
      console.warn('[WeatherSystem] Failed to load settings', e);
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          mode: this.mode,
          virtualType: this.virtualType,
          autoChange: this.autoChangeEnabled,
          instantApply: this.instantApply
        })
      );
    } catch (e) {
      console.warn('[WeatherSystem] Failed to save settings', e);
    }
  }

  /**
   * 設定經緯度 (地點切換時重新取得天氣)
   */
  public async setCoordinates(lat: number, lon: number): Promise<void> {
    this.currentLat = lat;
    this.currentLon = lon;
    this.lastFetchTime = 0; // 強制刷新
    await this.fetchLiveWeather();
  }

  public setMode(mode: WeatherSourceMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.saveSettings();
      if (mode === 'real' && !this.liveData) {
        this.fetchLiveWeather();
      }
      this.refreshTargetParams();
    }
  }

  public getMode(): WeatherSourceMode {
    return this.mode;
  }

  public setInstantApply(enabled: boolean): void {
    this.instantApply = enabled;
    this.saveSettings();
  }

  public getInstantApply(): boolean {
    return this.instantApply;
  }

  /**
   * 立即乾燥路面 (依要求點擊後立即將濕潤度清零)
   */
  public instantDryRoad(): void {
    this.currentParams.wetness = 0.0;
    this.targetParams.wetness = 0.0;
    this.currentWetnessTarget = 0.0;
    this.broadcastChange();
  }

  public setVirtualType(type: WeatherStateType, instant: boolean = false): void {
    this.virtualType = type;
    this.saveSettings();
    this.refreshTargetParams();

    const doInstant = this.instantApply || instant;
    if (doInstant) {
      // 立即套用：跳過漸變，直接對齊所有參數與濕潤目標
      const preset = WEATHER_TYPE_PRESETS[type] || WEATHER_TYPE_PRESETS.clear;
      this.currentParams = { ...this.targetParams };
      this.currentParams.wetness = preset.wetnessTarget;
      this.isTransitioning = false;
      this.transitionProgress = 1.0;
      this.transitionElapsedSec = this.transitionTotalSec;
    } else {
      // 啟動 20~40 秒平滑漸變
      this.isTransitioning = true;
      this.transitionProgress = 0.0;
      this.transitionElapsedSec = 0.0;
      this.transitionTotalSec = CONFIG.WEATHER.TRANSITION_DURATION_SEC;
    }
    this.broadcastChange();
  }

  public getVirtualType(): WeatherStateType {
    return this.virtualType;
  }

  public setAutoChange(enabled: boolean): void {
    this.autoChangeEnabled = enabled;
    this.autoChangeTimer = 0;
    this.saveSettings();
  }

  public isAutoChangeEnabled(): boolean {
    return this.autoChangeEnabled;
  }

  /**
   * 手動覆蓋虛擬參數 (使用者在 UI 滑桿拖動時)
   */
  public setCustomParams(partial: Partial<WeatherVisualParams>): void {
    if (partial.rainIntensity !== undefined) {
      this.targetParams.rainIntensity = Math.max(0, Math.min(1, partial.rainIntensity));
    }
    if (partial.cloudCover !== undefined) {
      this.targetParams.cloudCover = Math.max(0, Math.min(1, partial.cloudCover));
    }
    if (partial.fogDensity !== undefined) {
      this.targetParams.fogDensity = Math.max(0, Math.min(3, partial.fogDensity));
    }
    if (partial.windSpeedMps !== undefined) {
      this.targetParams.windSpeedMps = Math.max(0, Math.min(35, partial.windSpeedMps));
    }
    if (partial.windAngleRad !== undefined) {
      this.targetParams.windAngleRad = partial.windAngleRad;
    }
    if (this.instantApply) {
      this.currentParams = { ...this.targetParams };
      this.isTransitioning = false;
      this.transitionProgress = 1.0;
    } else {
      this.isTransitioning = true;
      this.transitionElapsedSec = 0;
      this.transitionProgress = 0;
    }
    this.broadcastChange();
  }

  private weatherService = new WeatherService();

  /**
   * 抓取即時天氣資料 (Open-Meteo)
   */
  public async fetchLiveWeather(): Promise<void> {
    if (this.isFetching) return;
    this.isFetching = true;

    try {
      const data = await this.weatherService.getWeather(this.currentLat, this.currentLon);
      this.liveData = data;
      this.lastFetchTime = Date.now();
      if (this.mode === 'real') {
        this.refreshTargetParams();
      }
    } catch (err) {
      console.warn('[WeatherSystem] fetchLiveWeather error:', err);
    } finally {
      this.isFetching = false;
    }
  }

  /**
   * 手動強制連線刷新即時天氣
   */
  public async forceRefreshLiveWeather(): Promise<WeatherData | null> {
    if (this.isFetching) return this.liveData;
    this.isFetching = true;
    try {
      const data = await this.weatherService.forceRefreshWeather(this.currentLat, this.currentLon);
      this.liveData = data;
      this.lastFetchTime = Date.now();
      if (this.mode === 'real') {
        this.refreshTargetParams();
      }
      return data;
    } catch (err) {
      console.warn('[WeatherSystem] forceRefreshLiveWeather error:', err);
      return this.liveData;
    } finally {
      this.isFetching = false;
    }
  }

  public getWeatherService(): WeatherService {
    return this.weatherService;
  }

  /**
   * 刷新目標視覺參數 (切換預設時一次寫入全部目標組合)
   */
  private refreshTargetParams(): void {
    if (this.mode === 'real' && this.liveData) {
      const d = this.liveData;
      const preset = WEATHER_TYPE_PRESETS[d.weatherState] || WEATHER_TYPE_PRESETS.clear;
      this.targetParams.rainIntensity = d.rainIntensity;
      this.targetParams.cloudCover = d.cloudCover / 100.0;
      this.targetParams.fogDensity = d.weatherState === 'fog' ? 2.5 : (d.relativeHumidity > 85 ? 0.4 : 0.15);
      this.targetParams.windSpeedMps = d.windSpeed / 3.6; // km/h to m/s
      this.targetParams.windAngleRad = (d.windDirection * Math.PI) / 180.0;
      this.targetParams.saturationMult = preset.sat;
      this.targetParams.contrastMult = preset.contrast;
      this.currentWetnessTarget = d.weatherState.includes('rain') ? 0.8 : (d.weatherState === 'fog' ? 0.2 : 0.0);
    } else {
      const preset = WEATHER_TYPE_PRESETS[this.virtualType] || WEATHER_TYPE_PRESETS.clear;
      this.targetParams.rainIntensity = preset.rain;
      this.targetParams.cloudCover = preset.cloud;
      this.targetParams.fogDensity = preset.fog;
      this.targetParams.windSpeedMps = preset.windMps;
      this.targetParams.windAngleRad = 0.78; // 東北風
      this.targetParams.saturationMult = preset.sat;
      this.targetParams.contrastMult = preset.contrast;
      this.currentWetnessTarget = preset.wetnessTarget;
    }

    this.broadcastChange();
  }

  /**
   * 取得過渡狀態與目標值 (供 F11 面板與 HUD 顯示「目前值 → 目標值」及進度條)
   */
  public getTransitionInfo() {
    return {
      isTransitioning: this.isTransitioning,
      progress: this.transitionProgress,
      elapsedSec: this.transitionElapsedSec,
      totalSec: this.transitionTotalSec,
      targetParams: {
        ...this.targetParams,
        wetnessTarget: this.currentWetnessTarget
      },
      currentParams: this.currentParams
    };
  }

  /**
   * 每幀更新天氣過渡、降雨先降、路面乾燥、閃電定時
   */
  public update(deltaSec: number): void {
    // 1. 每 10 分鐘自動更新一次即時天氣
    if (this.mode === 'real' && Date.now() - this.lastFetchTime > CONFIG.WEATHER.CACHE_TTL_MS) {
      this.fetchLiveWeather();
    }

    // 2. 虛擬模式下自動隨機變化
    if (this.mode === 'virtual' && this.autoChangeEnabled) {
      this.autoChangeTimer += deltaSec;
      if (this.autoChangeTimer > 180.0) { // 每 3 分鐘可能切換一次
        this.autoChangeTimer = 0;
        this.randomizeVirtualWeather();
      }
    }

    // 3. 過渡進度推進
    if (this.isTransitioning) {
      this.transitionElapsedSec += deltaSec;
      this.transitionProgress = Math.min(1.0, this.transitionElapsedSec / this.transitionTotalSec);
      if (this.transitionProgress >= 1.0) {
        this.isTransitioning = false;
      }
    }

    // 4. 降雨二階段過渡：切換到無雨或減雨時，降雨量在 3.5 秒內優先衰減歸零，雨絲先消失
    if (this.targetParams.rainIntensity < this.currentParams.rainIntensity) {
      const rainCutRate = Math.min(1.0, deltaSec / 3.5);
      this.currentParams.rainIntensity += (this.targetParams.rainIntensity - this.currentParams.rainIntensity) * rainCutRate;
      if (this.targetParams.rainIntensity === 0 && this.currentParams.rainIntensity < 0.005) {
        this.currentParams.rainIntensity = 0.0;
      }
    } else {
      const rainLerp = Math.min(1.0, deltaSec / this.transitionTotalSec);
      this.currentParams.rainIntensity += (this.targetParams.rainIntensity - this.currentParams.rainIntensity) * rainLerp;
    }

    // 其餘參數平滑過渡 (以 28 秒漸變)
    const lerpRate = Math.min(1.0, deltaSec / this.transitionTotalSec);
    this.currentParams.cloudCover += (this.targetParams.cloudCover - this.currentParams.cloudCover) * lerpRate;
    this.currentParams.fogDensity += (this.targetParams.fogDensity - this.currentParams.fogDensity) * lerpRate;
    this.currentParams.windSpeedMps += (this.targetParams.windSpeedMps - this.currentParams.windSpeedMps) * lerpRate;
    this.currentParams.saturationMult += (this.targetParams.saturationMult - this.currentParams.saturationMult) * lerpRate;
    this.currentParams.contrastMult += (this.targetParams.contrastMult - this.currentParams.contrastMult) * lerpRate;

    // 5. 路面濕潤與乾燥狀態 (Wetness)
    if (this.currentParams.rainIntensity > 0.05) {
      // 下雨時路面在 12 秒內變濕至目標濕潤度
      const wetRate = Math.min(1.0, (deltaSec / 12.0) * this.currentParams.rainIntensity);
      this.currentParams.wetness = Math.min(this.currentWetnessTarget, this.currentParams.wetness + wetRate);
    } else {
      // 雨停後路面乾燥：基準 80 秒完全乾燥 (符合 60~120 秒要求)；晴天時乾燥速度加倍 (40 秒完全乾燥)
      const isClear =
        (this.mode === 'virtual' && this.virtualType === 'clear') ||
        (this.mode === 'real' && this.liveData?.weatherState === 'clear');
      const dryDuration = isClear
        ? (CONFIG.WEATHER.ROAD_DRYING_DURATION_SEC * 0.5)
        : CONFIG.WEATHER.ROAD_DRYING_DURATION_SEC;
      const dryRate = deltaSec / dryDuration;
      this.currentParams.wetness = Math.max(0.0, this.currentParams.wetness - dryRate);
    }

    // 6. 狀態自我檢驗與錯誤修復 (Requirement A-5)
    // 若過渡已結束且實際降雨強度與預期目標差距超過 0.15，判定為 bug，自動警告並校正
    if (!this.isTransitioning || this.transitionElapsedSec > 12.0) {
      const expectedRain = this.targetParams.rainIntensity;
      if (Math.abs(this.currentParams.rainIntensity - expectedRain) > 0.15) {
        console.warn(
          `[WeatherSystem] WARNING: 天氣狀態(${this.virtualType})與實際降雨強度差距超過 0.15 ` +
          `(當前: ${(this.currentParams.rainIntensity * 100).toFixed(0)}%, 目標: ${(expectedRain * 100).toFixed(0)}%)，自動修正至目標值`
        );
        this.currentParams.rainIntensity = expectedRain;
      }
    }

    // 5. 閃電與雷聲觸發 (雷雨或颱風時)
    const isThunder =
      (this.mode === 'real' && this.liveData?.weatherState === 'thunderstorm') ||
      (this.mode === 'virtual' && (this.virtualType === 'thunderstorm' || this.virtualType === 'typhoon'));

    if (isThunder) {
      this.lightningTimer -= deltaSec;
      if (this.lightningTimer <= 0) {
        // 重設下次閃電間隔 (9 ~ 22 秒)
        this.lightningTimer =
          CONFIG.WEATHER.LIGHTNING.MIN_INTERVAL_SEC +
          Math.random() * (CONFIG.WEATHER.LIGHTNING.MAX_INTERVAL_SEC - CONFIG.WEATHER.LIGHTNING.MIN_INTERVAL_SEC);

        // 觸發閃電
        this.currentParams.thunderFlash = 1.0;
        const delayToThunder = 0.3 + Math.random() * 1.2; // 0.3 ~ 1.5 秒後雷響
        for (const listener of this.lightningListeners) {
          listener(1.0, delayToThunder);
        }
      }
    }

    // 閃電亮度快速衰減 (0.12 秒內消退)
    if (this.currentParams.thunderFlash > 0) {
      this.currentParams.thunderFlash = Math.max(0, this.currentParams.thunderFlash - deltaSec / 0.12);
    }
  }

  private randomizeVirtualWeather(): void {
    const types: WeatherStateType[] = [
      'clear',
      'cloudy',
      'overcast',
      'light_rain',
      'heavy_rain',
      'fog'
    ];
    const next = types[Math.floor(Math.random() * types.length)];
    this.setVirtualType(next);
  }

  private broadcastChange(): void {
    const currentData = this.getWeatherData();
    for (const listener of this.changeListeners) {
      listener(currentData, this.currentParams);
    }
  }

  /**
   * 取得標準化 WeatherData 物件
   */
  public getWeatherData(): WeatherData {
    if (this.mode === 'real' && this.liveData) {
      return this.liveData;
    }

    // 虛擬模式構造資料物件
    const preset = WEATHER_TYPE_PRESETS[this.virtualType] || WEATHER_TYPE_PRESETS.clear;
    return {
      temperature: 25.5,
      relativeHumidity: this.virtualType === 'fog' || this.virtualType.includes('rain') ? 92 : 65,
      precipitation: preset.rain * 15.0, // mm/h
      rain: preset.rain * 15.0,
      weatherCode: 0,
      cloudCover: preset.cloud * 100,
      windSpeed: preset.windMps * 3.6,
      windDirection: 45,
      isDay: true,
      utcOffsetSeconds: 8 * 3600,
      timezone: 'Asia/Taipei',
      weatherState: this.virtualType,
      rainIntensity: preset.rain,
      fetchedAt: Date.now(),
      source: 'live'
    };
  }

  public getVisualParams(): WeatherVisualParams {
    return this.currentParams;
  }

  public getRainIntensity(): number {
    return this.currentParams.rainIntensity;
  }

  public getWetness(): number {
    return this.currentParams.wetness;
  }

  public onWeatherChange(callback: WeatherChangeCallback): () => void {
    this.changeListeners.push(callback);
    return () => {
      const idx = this.changeListeners.indexOf(callback);
      if (idx !== -1) this.changeListeners.splice(idx, 1);
    };
  }

  public onLightning(callback: LightningCallback): () => void {
    this.lightningListeners.push(callback);
    return () => {
      const idx = this.lightningListeners.indexOf(callback);
      if (idx !== -1) this.lightningListeners.splice(idx, 1);
    };
  }
}
