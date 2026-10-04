/**
 * TimeSystem.ts - 現實與虛擬時間系統核心控制器
 * 遵循 RULES.md：高內聚低耦合，純時間與天文狀態驅動
 */

import { CONFIG } from '../../config.ts';
import { TimeSourceMode, SunMoonInfo, TwilightPhase } from '../../geo/WeatherTypes.ts';
import { getSunMoonInfo } from './SunCalcUtils.ts';

export interface TimeDisplayInfo {
  hours: number;
  minutes: number;
  seconds: number;
  timeString: string;
  isNight: boolean;
  phase: TwilightPhase;
  hourFraction: number; // 0.0 ~ 24.0
}

export type TimePhaseCallback = (phase: TwilightPhase, prevPhase: TwilightPhase) => void;
export type TimeTickCallback = (info: TimeDisplayInfo) => void;

const STORAGE_KEY = 'gta_time_settings_v1';

export class TimeSystem {
  private mode: TimeSourceMode = CONFIG.TIME.DEFAULT_MODE;
  private virtualHour: number = CONFIG.TIME.DEFAULT_VIRTUAL_HOUR;
  private timeRate: number = CONFIG.TIME.DEFAULT_RATE;

  private currentLat: number = 24.827; // 預設礁溪
  private currentLon: number = 121.771;
  private utcOffsetSeconds: number = 8 * 3600; // 預設 UTC+8

  private sunMoonInfo: SunMoonInfo;
  private currentPhase: TwilightPhase = 'day';
  private phaseListeners: TimePhaseCallback[] = [];
  private tickListeners: TimeTickCallback[] = [];

  private lastBroadcastPhase: TwilightPhase = 'day';
  private tickTimer: number = 0;

  constructor() {
    this.loadSettings();

    // 初始日月計算
    this.sunMoonInfo = this.computeSunMoon();
    this.currentPhase = this.sunMoonInfo.twilightPhase;
    this.lastBroadcastPhase = this.currentPhase;
  }

  /**
   * 自 localStorage 還原玩家偏好
   */
  private loadSettings(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        if (data.mode === 'real' || data.mode === 'virtual') {
          this.mode = data.mode;
        }
        if (typeof data.virtualHour === 'number' && data.virtualHour >= 0 && data.virtualHour <= 24) {
          this.virtualHour = data.virtualHour;
        }
        if (typeof data.timeRate === 'number') {
          this.timeRate = data.timeRate;
        }
      }
    } catch (e) {
      console.warn('[TimeSystem] Failed to load settings from localStorage', e);
    }
  }

  /**
   * 儲存設定至 localStorage
   */
  private saveSettings(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          mode: this.mode,
          virtualHour: this.virtualHour,
          timeRate: this.timeRate
        })
      );
    } catch (e) {
      console.warn('[TimeSystem] Failed to save settings to localStorage', e);
    }
  }

  /**
   * 設定地理經緯度與時區位移 (M 鍵切換地點時呼叫)
   */
  public setCoordinates(lat: number, lon: number, utcOffsetSec?: number): void {
    this.currentLat = lat;
    this.currentLon = lon;
    if (typeof utcOffsetSec === 'number') {
      this.utcOffsetSeconds = utcOffsetSec;
    }
    this.update(0);
  }

  public setUtcOffsetSeconds(sec: number): void {
    this.utcOffsetSeconds = sec;
  }

  public setMode(mode: TimeSourceMode): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.saveSettings();
      this.update(0);
    }
  }

  public getMode(): TimeSourceMode {
    return this.mode;
  }

  public setVirtualHour(hour: number): void {
    this.virtualHour = Math.max(0, Math.min(24, hour)) % 24;
    this.saveSettings();
    this.update(0);
  }

  public getVirtualHour(): number {
    return this.virtualHour;
  }

  public setTimeRate(rate: number): void {
    this.timeRate = rate;
    this.saveSettings();
  }

  public getTimeRate(): number {
    return this.timeRate;
  }

  /**
   * 每幀更新時間邏輯 (每幀耗時嚴格 < 0.1 ms)
   */
  public update(deltaSec: number): void {
    if (this.mode === 'virtual') {
      if (this.timeRate > 0 && deltaSec > 0) {
        // 每秒推進 (rate / 3600) 小時
        this.virtualHour = (this.virtualHour + (deltaSec * this.timeRate) / 3600.0) % 24.0;
        if (this.virtualHour < 0) this.virtualHour += 24.0;
      }
    }

    this.sunMoonInfo = this.computeSunMoon();
    this.currentPhase = this.sunMoonInfo.twilightPhase;

    // 暮光階段變更廣播
    if (this.currentPhase !== this.lastBroadcastPhase) {
      const prev = this.lastBroadcastPhase;
      this.lastBroadcastPhase = this.currentPhase;
      for (const listener of this.phaseListeners) {
        listener(this.currentPhase, prev);
      }
    }

    // 每 0.25 秒或每次更新廣播 tick
    this.tickTimer += deltaSec;
    if (this.tickTimer >= 0.25 || deltaSec === 0) {
      this.tickTimer = 0;
      const display = this.getTimeOfDay();
      for (const listener of this.tickListeners) {
        listener(display);
      }
    }
  }

  /**
   * 取得日月天體詳細資訊
   */
  public getSunMoonInfo(): SunMoonInfo {
    return this.sunMoonInfo;
  }

  /**
   * 取得太陽單位方向向量 (x, y, z)
   */
  public getSunDirection(): [number, number, number] {
    return this.sunMoonInfo.sun.directionVector;
  }

  /**
   * 取得月球單位方向向量 (x, y, z)
   */
  public getMoonDirection(): [number, number, number] {
    return this.sunMoonInfo.moon.directionVector;
  }

  /**
   * 取得顯示用鐘錶時分秒資訊
   */
  public getTimeOfDay(): TimeDisplayInfo {
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    let hourFraction = 0;

    if (this.mode === 'real') {
      // 根據目標地點之 utcOffsetSeconds 還原當地鐘錶時間
      const nowUtc = Date.now();
      const localMs = nowUtc + this.utcOffsetSeconds * 1000;
      const d = new Date(localMs);
      hours = d.getUTCHours();
      minutes = d.getUTCMinutes();
      seconds = d.getUTCSeconds();
      hourFraction = hours + minutes / 60.0 + seconds / 3600.0;
    } else {
      hours = Math.floor(this.virtualHour);
      const remMin = (this.virtualHour - hours) * 60;
      minutes = Math.floor(remMin);
      seconds = Math.floor((remMin - minutes) * 60);
      hourFraction = this.virtualHour;
    }

    const pad = (n: number) => n.toString().padStart(2, '0');
    const timeString = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;

    return {
      hours,
      minutes,
      seconds,
      timeString,
      isNight: this.sunMoonInfo.isNight,
      phase: this.currentPhase,
      hourFraction
    };
  }

  /**
   * 註冊暮光階段變更監聽
   */
  public onPhaseChange(callback: TimePhaseCallback): () => void {
    this.phaseListeners.push(callback);
    return () => {
      const idx = this.phaseListeners.indexOf(callback);
      if (idx !== -1) this.phaseListeners.splice(idx, 1);
    };
  }

  /**
   * 註冊定時鐘錶更新監聽
   */
  public onTick(callback: TimeTickCallback): () => void {
    this.tickListeners.push(callback);
    return () => {
      const idx = this.tickListeners.indexOf(callback);
      if (idx !== -1) this.tickListeners.splice(idx, 1);
    };
  }

  /**
   * 計算當前日月位置
   */
  private computeSunMoon(): SunMoonInfo {
    let evalTimestampMs: number;

    if (this.mode === 'real') {
      evalTimestampMs = Date.now();
    } else {
      // 虛擬時間：構造對應虛擬小時的 UTC timestamp
      const now = new Date();
      // 目標當地時間 = (baseDate) 年/月/日 + virtualHour
      // UTC 時間 = 當地時間 - utcOffset
      const baseYear = now.getUTCFullYear();
      const baseMonth = now.getUTCMonth();
      const baseDate = now.getUTCDate();
      const virtualTotalSeconds = this.virtualHour * 3600;
      const targetUtcTotalSeconds = virtualTotalSeconds - this.utcOffsetSeconds;

      const dateUtc = new Date(Date.UTC(baseYear, baseMonth, baseDate, 0, 0, 0, 0));
      evalTimestampMs = dateUtc.getTime() + targetUtcTotalSeconds * 1000;
    }

    return getSunMoonInfo(this.currentLat, this.currentLon, evalTimestampMs);
  }
}
