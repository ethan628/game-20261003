/**
 * HUD.ts - 遊戲內抬頭顯示器 (Heads-Up Display)
 */

import { BuildingSourceStats } from '../geo/OsmTypes.ts';
import { PedestrianSystemStats, PedestrianSamplingReport } from '../geo/PedestrianTypes.ts';
import { TrafficSystemStats, StopLineStats, VehicleSamplingReport } from '../geo/TrafficTypes.ts';

export class HUD {
  private container: HTMLDivElement;
  private fpsBadge: HTMLSpanElement;
  private callsBadge: HTMLSpanElement;
  private locationEl: HTMLDivElement;
  private coordsEl: HTMLDivElement;
  private latLonEl: HTMLDivElement;
  private renderStatsEl: HTMLDivElement;
  private buildingStatsEl: HTMLDivElement;
  private sourceStatsEl: HTMLDivElement;
  private signboardStatsEl: HTMLDivElement;
  private mapStatsEl: HTMLDivElement;
  private pedStatsEl: HTMLDivElement;
  private signalStatsEl: HTMLDivElement;
  private trafficStatsEl: HTMLDivElement;
  private policeStatsEl: HTMLDivElement;
  private qualityValEl: HTMLSpanElement;
  private wetBtn: HTMLElement | null = null;
  private nightBtn: HTMLElement | null = null;

  // 天氣與時間小組件
  private weatherTimeEl: HTMLSpanElement;
  private weatherSourceEl: HTMLSpanElement;
  private weatherStateEl: HTMLSpanElement;
  private weatherTempEl: HTMLSpanElement;
  private weatherDebugOverlay: HTMLDivElement;
  private weatherDebugContent: HTMLDivElement;
  private isWeatherDebugVisible = false;

  // F8 行人除錯診斷面板
  private pedDebugOverlay: HTMLDivElement | null = null;
  private pedDebugContent: HTMLDivElement | null = null;
  private pedSamplingReportEl: HTMLDivElement | null = null;
  public isPedDebugVisible = false;

  // F12 夜景分區亮度分析
  private nightAnalysisOverlay: HTMLDivElement;
  private nightAnalysisContent: HTMLDivElement;
  public isNightAnalysisVisible = false;

  // F13 駕駛與交通除錯面板
  private trafficDebugOverlay: HTMLDivElement;
  private trafficDebugContent: HTMLDivElement;
  private trafficSamplingReportEl: HTMLDivElement | null = null;
  public isTrafficDebugVisible = false;

  // F14 停止線停等量測面板
  private stopLineOverlay: HTMLDivElement | null = null;
  private stopLineContent: HTMLDivElement | null = null;
  public isStopLineMeasurementVisible = false;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'game-hud';
    this.container.innerHTML = `
      <div class="hud-top-left">
        <div class="hud-card">
          <div class="hud-header">
            <span class="hud-badge" id="hud-fps">FPS: --</span>
            <span class="hud-badge" id="hud-calls" style="background: rgba(14, 165, 233, 0.85);">Calls: 0</span>
            <span class="hud-status-dot"></span>
            <span class="hud-title" id="hud-location">載入中...</span>
          </div>
          <div class="hud-meta">
            <div id="hud-coords">局部座標: X: 0.0m, Z: 0.0m</div>
            <div id="hud-latlon">經緯度: --, --</div>
            <div id="hud-render-stats" style="color: #38bdf8; margin-top: 2px;">渲染面數: 0 △</div>
            <div id="hud-building-stats" style="color: #4ade80; margin-top: 2px; font-weight: 500;">建物: 0 棟 (100m內: 0) | 頂點: 0</div>
            <div id="hud-source-stats" style="color: #c084fc; margin-top: 2px; font-size: 11px; font-weight: 500;">來源: 載入中...</div>
            <div id="hud-signboard-stats" style="color: #fbbf24; margin-top: 2px; font-weight: 500;">店家招牌: 0 (可見: 0) [真建: 0 | 補店: 0 | 立柱: 0]</div>
            <div id="hud-pedestrian-stats" style="color: #f472b6; margin-top: 2px; font-weight: 500;">行人: 0 (走:0 停:0 等:0 渡:0 避:0) | AI: 0.00ms | Calls: 4</div>
            <div id="hud-signal-stats" style="color: #34d399; margin-top: 2px; font-weight: 500;">交通號誌: 0 路口 (OSM:0 自:0) | 邏輯: 0.00ms | Calls: 6</div>
            <div id="hud-traffic-stats" style="color: #38bdf8; margin-top: 2px; font-weight: 500;">車輛駕駛: 0 (轎:0 計:0 機:0 | 乘:0) | 謹:0 常:0 急:0 慢:0 | 叭:0 | AI: 0.00ms | Calls: 6</div>
            <div id="hud-police-stats" style="color: #60a5fa; margin-top: 2px; font-weight: 500;">警車執法: 0 輛 (巡:0 追:0 罰:0) | 違規: 0 | AI: 0.00ms | Calls: 4</div>
            <div id="hud-map-stats" style="color: #67e8f9; margin-top: 2px; font-weight: 500;">自繪地圖: 0.0ms | 標記: 0</div>
          </div>
        </div>
      </div>

      <div class="hud-top-right" style="position: absolute; top: 16px; right: 16px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: auto;">
        <div class="hud-card" id="hud-weather-card" style="cursor: pointer; padding: 10px 14px; min-width: 175px;" title="點擊或按 K 鍵開啟天氣與時間控制面板">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
            <span id="hud-weather-time" style="font-size: 16px; font-weight: 700; color: #f8fafc; font-family: monospace;">--:--:--</span>
            <span id="hud-weather-source-badge" class="hud-badge" style="background: rgba(56, 189, 248, 0.2); color: #38bdf8; font-size: 11px; padding: 2px 6px;">[即時]</span>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px; font-size: 13px;">
            <span id="hud-weather-state" style="color: #fde047; font-weight: 600;">☀️ 晴天</span>
            <span id="hud-weather-temp" style="color: #cbd5e1; font-weight: 600;">--°C</span>
          </div>
        </div>

        <!-- F11 天氣與時間詳細除錯面板 -->
        <div class="hud-card hidden" id="hud-weather-debug-overlay" style="font-size: 11px; color: #cbd5e1; width: 310px; line-height: 1.5; background: rgba(15, 23, 42, 0.94); border: 1px solid rgba(56, 189, 248, 0.35); text-align: left;">
          <div style="font-weight: 700; color: #38bdf8; margin-bottom: 4px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 3px; display: flex; justify-content: space-between;">
            <span>🌦️ 天氣與時間除錯診斷 (F11)</span>
            <span style="color: #94a3b8; font-size: 10px;">Open-Meteo.com</span>
          </div>
          <div id="hud-weather-debug-content">
            載入中...
          </div>
        </div>

        <!-- F12 夜景分區亮度分析面板 -->
        <div class="hud-card hidden" id="hud-night-analysis-overlay" style="font-size: 11px; color: #cbd5e1; width: 330px; line-height: 1.5; background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(245, 158, 11, 0.4); text-align: left;">
          <div style="font-weight: 700; color: #f59e0b; margin-bottom: 4px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 3px; display: flex; justify-content: space-between;">
            <span>🌙 夜景分區亮度分析 (F12)</span>
            <span style="color: #94a3b8; font-size: 10px;">GTA 城市夜景</span>
          </div>
          <div id="hud-night-analysis-content">
            載入中...
          </div>
        </div>

        <!-- F8 行人行為除錯診斷面板 -->
        <div class="hud-card hidden" id="hud-ped-debug-overlay" style="font-size: 11px; color: #cbd5e1; width: 340px; max-height: 480px; overflow-y: auto; line-height: 1.5; background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(244, 114, 182, 0.4); text-align: left; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
          <div style="font-weight: 700; color: #f472b6; margin-bottom: 4px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 3px; display: flex; justify-content: space-between; align-items: center;">
            <span>🚶 行人行為除錯診斷 (F8)</span>
            <span style="color: #94a3b8; font-size: 10px;">Poisson 6m / 斑馬線</span>
          </div>
          <div id="hud-ped-debug-content">
            載入中...
          </div>
          <div style="margin-top: 8px; display: flex; gap: 6px;">
            <button id="btn-ped-sampling-60s" class="hud-btn" style="flex: 1; background: rgba(244, 114, 182, 0.25); border: 1px solid #f472b6; color: #fbcfe8; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">⏱️ 60 秒行為抽樣</button>
            <button id="btn-ped-refresh" class="hud-btn" style="background: rgba(56, 189, 248, 0.2); border: 1px solid #38bdf8; color: #bae6fd; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;">🔄 整理</button>
          </div>
          <div id="hud-ped-sampling-report" style="margin-top: 8px;"></div>
        </div>

        <!-- F13 駕駛與交通除錯面板 -->
        <div class="hud-card hidden" id="hud-traffic-debug-overlay" style="font-size: 11px; color: #cbd5e1; width: 340px; max-height: 520px; overflow-y: auto; line-height: 1.5; background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(56, 189, 248, 0.4); text-align: left; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
          <div style="font-weight: 700; color: #38bdf8; margin-bottom: 4px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 3px; display: flex; justify-content: space-between;">
            <span>🚗 NPC 駕駛與交通除錯 (F13)</span>
            <span style="color: #94a3b8; font-size: 10px;">LOD 60/120m</span>
          </div>
          <div id="hud-traffic-debug-content">
            載入中...
          </div>
          <div style="margin-top: 8px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px;">
            <button id="btn-force-honk" class="hud-btn" style="background: rgba(239, 68, 68, 0.25); border: 1px solid #ef4444; color: #fca5a5; padding: 4px; border-radius: 4px; cursor: pointer; font-size: 11px;">強制鳴笛 📢</button>
            <button id="btn-force-annoy" class="hud-btn" style="background: rgba(245, 158, 11, 0.25); border: 1px solid #f59e0b; color: #fde68a; padding: 4px; border-radius: 4px; cursor: pointer; font-size: 11px;">強制煩躁 💢</button>
            <button id="btn-eject-driver" class="hud-btn" style="background: rgba(168, 85, 247, 0.25); border: 1px solid #a855f7; color: #e9d5ff; padding: 4px; border-radius: 4px; cursor: pointer; font-size: 11px;">彈出駕駛 🏃</button>
          </div>
          <div style="margin-top: 8px; display: flex; gap: 6px;">
            <button id="btn-traffic-sampling-60s" class="hud-btn" style="flex: 1; background: rgba(56, 189, 248, 0.25); border: 1px solid #38bdf8; color: #bae6fd; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">⏱️ 60 秒行為抽樣</button>
            <button id="btn-traffic-refresh" class="hud-btn" style="background: rgba(56, 189, 248, 0.2); border: 1px solid #38bdf8; color: #bae6fd; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px;">🔄 整理</button>
          </div>
          <div id="hud-traffic-sampling-report" style="margin-top: 8px;"></div>
        </div>

        <!-- F14 停止線停等量測面板 -->
        <div class="hud-card hidden" id="hud-stopline-measurement-overlay" style="font-size: 11px; color: #cbd5e1; width: 360px; max-height: 480px; overflow-y: auto; line-height: 1.5; background: rgba(15, 23, 42, 0.96); border: 1px solid rgba(34, 197, 94, 0.5); text-align: left; box-shadow: 0 10px 25px rgba(0,0,0,0.5);">
          <div style="font-weight: 700; color: #4ade80; margin-bottom: 6px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 4px; display: flex; justify-content: space-between; align-items: center;">
            <span>🚦 停止線停等量測面板 (F14)</span>
            <span style="color: #94a3b8; font-size: 10px;">目標: 壓線 0 輛</span>
          </div>
          <div style="margin-bottom: 8px; display: flex; gap: 6px;">
            <button id="btn-stopline-toggle-all-red" class="hud-btn" style="flex: 1; background: rgba(239, 68, 68, 0.25); border: 1px solid #ef4444; color: #fca5a5; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">🚨 全城紅燈 (強制停等)</button>
            <button id="btn-stopline-refresh" class="hud-btn" style="flex: 1; background: rgba(56, 189, 248, 0.25); border: 1px solid #38bdf8; color: #bae6fd; padding: 4px 6px; border-radius: 4px; cursor: pointer; font-size: 11px; font-weight: bold;">📐 即時量測</button>
          </div>
          <div id="hud-stopline-measurement-content">
            點擊「即時量測」或開啟全城紅燈以檢視停等數據...
          </div>
        </div>
      </div>

      <div class="hud-controls-hint">
        <div class="hint-pill"><b>WASD</b> 移動</div>
        <div class="hint-pill"><b>Shift</b> 奔跑</div>
        <div class="hint-pill"><b>空白鍵</b> 跳躍</div>
        <div class="hint-pill"><b>滑鼠</b> 環繞視角 (點擊鎖定)</div>
        <div class="hint-pill" id="btn-toggle-fullscreen-map" title="開啟全螢幕導航地圖 (Tab)"><b>Tab</b> 全螢幕地圖</div>
        <div class="hint-pill" id="btn-toggle-map" title="切換小地圖大小 (N)"><b>N 鍵</b> 小地圖大小</div>
        <div class="hint-pill highlight" id="btn-toggle-weather" title="開啟天氣與時間控制面板 (K)"><b>K 鍵</b> 天氣與時間</div>
        <div class="hint-pill" id="btn-toggle-streetview"><b>G 鍵</b> 實境街景</div>
        <div class="hint-pill" id="btn-toggle-split"><b>H 鍵</b> 街景對照</div>
        <div class="hint-pill" id="btn-toggle-signboard-debug" title="切換招牌除錯視覺化 (F3)"><b>F3</b> 招牌標記</div>
        <div class="hint-pill" id="btn-clear-cache" title="清除 IndexedDB 快取並重整載入 (F4)"><b>F4</b> 清除快取重整</div>
        <div class="hint-pill" id="btn-toggle-bldg-debug" title="切換建築輪廓線框 (F5)"><b>F5</b> 建築輪廓</div>
        <div class="hint-pill" id="btn-toggle-bldg-inspector" title="切換建築檢視校正模式 (F6)"><b>F6</b> 建築校正</div>
        <div class="hint-pill" id="btn-toggle-floor-labels" title="切換 3D 浮動樓層數字標籤 (F7)"><b>F7</b> 樓層標籤</div>
        <div class="hint-pill" id="btn-toggle-ped-debug" title="切換行人路網與狀態除錯視覺化 (F8)"><b>F8</b> 行人除錯</div>
        <div class="hint-pill" id="btn-toggle-signal-debug" title="切換交通號誌除錯視覺化 (F9)"><b>F9</b> 號誌除錯</div>
        <div class="hint-pill" id="btn-teleport-signal" title="循環傳送至號誌路口 (F10)"><b>F10</b> 號誌路口</div>
        <div class="hint-pill" id="btn-toggle-weather-debug" title="切換天氣與日月診斷覆蓋層 (F11)"><b>F11</b> 天氣資訊</div>
        <div class="hint-pill" id="btn-toggle-night-analysis" title="切換夜景分區亮度分析面板 (F12)"><b>F12</b> 夜景分析</div>
        <div class="hint-pill highlight" id="btn-toggle-traffic-debug" title="切換車輛與駕駛除錯視覺化 (F13)"><b>F13</b> 駕駛除錯</div>
        <div class="hint-pill highlight" id="btn-toggle-stopline-measurement" title="切換停止線量測面板 (F14 / Shift+F2)"><b>F14</b> 停止線量測</div>
        <div class="hint-pill highlight" id="btn-toggle-police-debug" title="切換警察執法除錯面板 (F15 / Shift+\`)"><b>F15</b> 警察執法</div>
        <div class="hint-pill" id="btn-export-estimated" title="匯出待校正推測建築清單 JSON"><b>匯出</b>推測清單</div>
        <div class="hint-pill" id="btn-toggle-wet" title="切換濕潤路面 (R)"><b>R</b> 濕潤路面</div>
        <div class="hint-pill" id="btn-toggle-night" title="切換夜間霓虹 (T)"><b>T</b> 夜間霓虹</div>
        <div class="hint-pill" id="btn-toggle-quality" title="切換後處理畫質 (高/中/低)"><b>畫質</b>: <span id="hud-quality-val" style="color: #38bdf8;">高</span></div>
        <div class="hint-pill highlight" id="btn-open-menu"><b>M 鍵</b> 切換地點選單</div>
      </div>
    `;

    document.body.appendChild(this.container);

    this.fpsBadge = this.container.querySelector('#hud-fps')!;
    this.callsBadge = this.container.querySelector('#hud-calls')!;
    this.locationEl = this.container.querySelector('#hud-location')!;
    this.coordsEl = this.container.querySelector('#hud-coords')!;
    this.latLonEl = this.container.querySelector('#hud-latlon')!;
    this.renderStatsEl = this.container.querySelector('#hud-render-stats')!;
    this.buildingStatsEl = this.container.querySelector('#hud-building-stats')!;
    this.sourceStatsEl = this.container.querySelector('#hud-source-stats')!;
    this.signboardStatsEl = this.container.querySelector('#hud-signboard-stats')!;
    this.mapStatsEl = this.container.querySelector('#hud-map-stats')!;
    this.pedStatsEl = this.container.querySelector('#hud-pedestrian-stats')!;
    this.signalStatsEl = this.container.querySelector('#hud-signal-stats')!;
    this.trafficStatsEl = this.container.querySelector('#hud-traffic-stats')!;
    this.policeStatsEl = this.container.querySelector('#hud-police-stats')!;
    this.qualityValEl = this.container.querySelector('#hud-quality-val')!;
    this.wetBtn = this.container.querySelector('#btn-toggle-wet');
    this.nightBtn = this.container.querySelector('#btn-toggle-night');

    // 天氣與時間小組件綁定
    this.weatherTimeEl = this.container.querySelector('#hud-weather-time')!;
    this.weatherSourceEl = this.container.querySelector('#hud-weather-source-badge')!;
    this.weatherStateEl = this.container.querySelector('#hud-weather-state')!;
    this.weatherTempEl = this.container.querySelector('#hud-weather-temp')!;
    this.weatherDebugOverlay = this.container.querySelector('#hud-weather-debug-overlay')!;
    this.weatherDebugContent = this.container.querySelector('#hud-weather-debug-content')!;

    // 夜景分析小組件綁定
    this.nightAnalysisOverlay = this.container.querySelector('#hud-night-analysis-overlay')!;
    this.nightAnalysisContent = this.container.querySelector('#hud-night-analysis-content')!;

    // 行人行為除錯小組件綁定
    this.pedDebugOverlay = this.container.querySelector('#hud-ped-debug-overlay');
    this.pedDebugContent = this.container.querySelector('#hud-ped-debug-content');
    this.pedSamplingReportEl = this.container.querySelector('#hud-ped-sampling-report');

    // 交通駕駛除錯小組件綁定
    this.trafficDebugOverlay = this.container.querySelector('#hud-traffic-debug-overlay')!;
    this.trafficDebugContent = this.container.querySelector('#hud-traffic-debug-content')!;
    this.trafficSamplingReportEl = this.container.querySelector('#hud-traffic-sampling-report');

    // 停止線量測小組件綁定
    this.stopLineOverlay = this.container.querySelector('#hud-stopline-measurement-overlay');
    this.stopLineContent = this.container.querySelector('#hud-stopline-measurement-content');

    // 點擊任何 HUD 按鈕時主動釋放焦點，避免按空白鍵 (跳躍) 時誤觸按鈕
    this.container.addEventListener('click', () => {
      if (document.activeElement && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
  }

  public updateFps(fps: number): void {
    this.fpsBadge.textContent = `FPS: ${fps}`;
    if (fps >= 50) {
      this.fpsBadge.style.background = 'rgba(40, 167, 69, 0.85)';
    } else if (fps >= 30) {
      this.fpsBadge.style.background = 'rgba(255, 193, 7, 0.85)';
    } else {
      this.fpsBadge.style.background = 'rgba(220, 53, 69, 0.85)';
    }
  }

  public updateRenderStats(calls: number, triangles: number): void {
    this.callsBadge.textContent = `Calls: ${calls}`;
    this.renderStatsEl.textContent = `Draw Calls: ${calls} | 渲染面數: ${triangles.toLocaleString()} △`;
  }

  public setLocationName(name: string): void {
    this.locationEl.textContent = name;
  }

  public updateCoordinates(x: number, z: number, lat: number, lon: number): void {
    this.coordsEl.textContent = `局部座標: X: ${x.toFixed(1)}m, Z: ${z.toFixed(1)}m`;
    this.latLonEl.textContent = `經緯度: ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
  }

  public onMenuButtonClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-open-menu');
    btn?.addEventListener('click', handler);
  }

  public onSignboardDebugClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-signboard-debug');
    btn?.addEventListener('click', handler);
  }

  public onClearCacheClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-clear-cache');
    btn?.addEventListener('click', handler);
  }

  public onBuildingDebugClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-bldg-debug');
    btn?.addEventListener('click', handler);
  }

  public onWetModeClick(handler: () => void): void {
    this.wetBtn?.addEventListener('click', handler);
  }

  public onNightModeClick(handler: () => void): void {
    this.nightBtn?.addEventListener('click', handler);
  }

  public onQualityClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-quality');
    btn?.addEventListener('click', handler);
  }

  public setQualityText(val: string): void {
    if (this.qualityValEl) {
      this.qualityValEl.textContent = val;
    }
  }

  public setWetModeActive(active: boolean): void {
    if (this.wetBtn) {
      if (active) {
        this.wetBtn.classList.add('highlight');
      } else {
        this.wetBtn.classList.remove('highlight');
      }
    }
  }

  public setNightModeActive(active: boolean): void {
    if (this.nightBtn) {
      if (active) {
        this.nightBtn.classList.add('highlight');
      } else {
        this.nightBtn.classList.remove('highlight');
      }
    }
  }

  /**
   * 更新 HUD 建築管線即時統計數據 (含來源比例與推測均高)
   */
  public updateBuildingStats(stats: {
    total: number;
    nearby: number;
    vertices: number;
    discarded?: number;
    sourceStats?: BuildingSourceStats;
  }): void {
    const discStr = stats.discarded !== undefined && stats.discarded > 0 ? ` (棄: ${stats.discarded})` : '';
    this.buildingStatsEl.textContent = `建物: ${stats.total} 棟 (100m內: ${stats.nearby}) | 頂點: ${stats.vertices.toLocaleString()}${discStr}`;

    if (this.sourceStatsEl) {
      if (stats.sourceStats) {
        const s = stats.sourceStats;
        this.sourceStatsEl.innerHTML = `來源: <span style="color:#4ade80;">OSM ${s.osmCount} (${s.osmPercent}%)</span> | <span style="color:#60a5fa;">外部 ${s.externalCount} (${s.externalPercent}%)</span> | <span style="color:#c084fc;">校正 ${s.overrideCount} (${s.overridePercent}%)</span> | <span style="color:#fb923c;">推測 ${s.estimatedCount} (${s.estimatedPercent}%) [均${s.estimatedAvgLevels}層]</span>`;
      } else {
        this.sourceStatsEl.textContent = '';
      }
    }
  }

  public onBuildingInspectorClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-bldg-inspector');
    btn?.addEventListener('click', handler);
  }

  public onFloorLabelsClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-floor-labels');
    btn?.addEventListener('click', handler);
  }

  public onExportEstimatedClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-export-estimated');
    btn?.addEventListener('click', handler);
  }

  /**
   * 更新 HUD 店家招牌即時統計數據 (總數、視野錐可見、真實/補店/立柱比)
   */
  public updateSignboardStats(stats: {
    generatedMeshes: number;
    visibleInFrustum: number;
    realCount?: number;
    fictionalCount?: number;
    onRealBuilding?: number;
    onProceduralShop?: number;
    standalonePole?: number;
  }): void {
    const realBldg = stats.onRealBuilding ?? stats.realCount ?? 0;
    const procShop = stats.onProceduralShop ?? 0;
    const standPole = stats.standalonePole ?? 0;
    this.signboardStatsEl.textContent = `店家招牌: ${stats.generatedMeshes} (可見: ${stats.visibleInFrustum}) [真建: ${realBldg} | 補店: ${procShop} | 立柱: ${standPole}]`;
  }

  /**
   * 根據是否有設定 Mapillary Token 顯示或隱藏街景相關快捷提示按鈕
   */
  public setStreetViewAvailable(available: boolean): void {
    const svBtn = this.container.querySelector('#btn-toggle-streetview') as HTMLElement | null;
    const splitBtn = this.container.querySelector('#btn-toggle-split') as HTMLElement | null;
    if (svBtn) {
      svBtn.style.display = available ? '' : 'none';
    }
    if (splitBtn) {
      splitBtn.style.display = available ? '' : 'none';
    }
  }

  public updateMapStats(drawTimeMs: number, blipCount: number): void {
    this.mapStatsEl.textContent = `自繪地圖: ${drawTimeMs.toFixed(2)}ms | 標記: ${blipCount}`;
  }

  public updatePedestrianStats(stats: PedestrianSystemStats): void {
    const panicPart = stats.panic > 0 ? ` 驚:${stats.panic}` : '';
    const hailPart = stats.hailing && stats.hailing > 0 ? ` 叫:${stats.hailing}` : '';
    const crossZebraRate = stats.crossingsTotal > 0 ? Math.round((stats.crossingsOnZebra / stats.crossingsTotal) * 100) : 100;
    this.pedStatsEl.textContent = `行人: ${stats.total}人 (走:${stats.walking} 停:${stats.idle} 等:${stats.waiting} 渡:${stats.crossing} 避:${stats.evading}${panicPart}${hailPart}) | 聚:${stats.crowdedRatePercent.toFixed(1)}% | 斑:${crossZebraRate}% | 規:${stats.violationsCount.total}(${stats.violationRatePercent.toFixed(1)}%) | 逆:${stats.backwardsWalkCount} | AI: ${stats.aiTimeMs.toFixed(2)}ms | Calls: ${stats.drawCalls}`;
  }

  public togglePedestrianDebug(): boolean {
    this.isPedDebugVisible = !this.isPedDebugVisible;
    if (this.pedDebugOverlay) {
      if (this.isPedDebugVisible) {
        this.pedDebugOverlay.classList.remove('hidden');
      } else {
        this.pedDebugOverlay.classList.add('hidden');
      }
    }
    return this.isPedDebugVisible;
  }

  public updatePedestrianDebugContent(infoHtml: string): void {
    if (this.pedDebugContent) {
      this.pedDebugContent.innerHTML = infoHtml;
    }
  }

  public updatePedestrianSamplingReport(
    report: PedestrianSamplingReport | null,
    remainingSec: number,
    isActive: boolean
  ): void {
    if (!this.pedSamplingReportEl) return;
    if (isActive) {
      this.pedSamplingReportEl.innerHTML = `
        <div style="background: rgba(30, 41, 59, 0.85); border: 1px solid #f472b6; border-radius: 4px; padding: 8px; text-align: center; color: #fbcfe8;">
          <div style="font-weight: bold; margin-bottom: 2px;">⏳ 正在進行 60 秒行人行為抽樣...</div>
          <div style="font-size: 13px; font-weight: bold; color: #f472b6;">剩餘 ${Math.ceil(remainingSec)} 秒</div>
        </div>
      `;
      return;
    }
    if (!report) {
      this.pedSamplingReportEl.innerHTML = '';
      return;
    }

    const badge = report.isCompliant
      ? '<span style="color: #4ade80; background: rgba(34, 197, 94, 0.2); padding: 1px 6px; border-radius: 3px; font-weight: bold;">✅ 合格</span>'
      : '<span style="color: #f87171; background: rgba(239, 68, 68, 0.2); padding: 1px 6px; border-radius: 3px; font-weight: bold;">⚠️ 需改善</span>';

    const backwardsCol = report.backwardsCount === 0 ? '#4ade80' : '#ef4444';
    const crowdCol = report.crowdedRatePercent < 3.0 ? '#4ade80' : '#f59e0b';
    const zebraCol = report.zebraComplianceRatePercent >= 90 ? '#4ade80' : '#f59e0b';

    this.pedSamplingReportEl.innerHTML = `
      <div style="background: rgba(15, 23, 42, 0.95); border: 1px solid ${report.isCompliant ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}; border-radius: 4px; padding: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 4px;">
          <b style="color: #f472b6;">【行人 60 秒行為抽樣評估報告】</b>
          ${badge}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 10px;">
          <div>抽樣總人數: <b>${report.totalPedestriansSampled} 人</b></div>
          <div>倒退走事件: <b style="color: ${backwardsCol};">${report.backwardsCount} 次 (目標: 0)</b></div>
          <div>聚集比例: <b style="color: ${crowdCol};">${report.crowdedRatePercent.toFixed(1)}% (目標: &lt;3%)</b></div>
          <div>守規斑馬線率: <b style="color: ${zebraCol};">${report.zebraComplianceRatePercent.toFixed(1)}%</b></div>
          <div style="grid-column: span 2;">過街次數: 總計 ${report.crossingsTotal} (斑馬線: ${report.crossingsOnZebra}, 違規: ${report.crossingsViolations})</div>
          <div style="grid-column: span 2;">違規統計: 總計 <b>${report.violationsCount.total} 次 (${report.violationRatePercent.toFixed(1)}%)</b> (紅燈: ${report.violationsCount.jaywalkRed}, 無斑馬線: ${report.violationsCount.crossNoZebra}, 貼車道: ${report.violationsCount.walkRoadEdge})</div>
        </div>
      </div>
    `;
  }

  public onPedestrianDebugClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-ped-debug');
    btn?.addEventListener('click', handler);
  }

  public onPedSamplingClick(handler: () => void): void {
    this.container.querySelector('#btn-ped-sampling-60s')?.addEventListener('click', handler);
  }

  public onPedRefreshClick(handler: () => void): void {
    this.container.querySelector('#btn-ped-refresh')?.addEventListener('click', handler);
  }

  public updateTrafficSignalStats(stats: {
    totalIntersections: number;
    signalizedCount: number;
    osmCount: number;
    autoCount: number;
    inRangeCount: number;
    updateTimeMs: number;
    drawCalls: number;
  }): void {
    this.signalStatsEl.textContent = `交通號誌: ${stats.signalizedCount} 路口 (OSM:${stats.osmCount} 自:${stats.autoCount}) | 邏輯: ${stats.updateTimeMs.toFixed(2)}ms | Calls: ${stats.drawCalls}`;
  }

  public onTrafficSignalDebugClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-signal-debug');
    btn?.addEventListener('click', handler);
  }

  public onTrafficSignalTeleportClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-teleport-signal');
    btn?.addEventListener('click', handler);
  }

  private notificationEl: HTMLDivElement | null = null;
  private notificationTimer = 0;

  public showNotification(msg: string, durationMs: number = 2400): void {
    if (!this.notificationEl) {
      this.notificationEl = document.createElement('div');
      this.notificationEl.className = 'hud-toast-notification';
      document.body.appendChild(this.notificationEl);
    }

    this.notificationEl.textContent = msg;
    this.notificationEl.classList.remove('hidden');
    this.notificationEl.classList.add('show');

    window.clearTimeout(this.notificationTimer);
    this.notificationTimer = window.setTimeout(() => {
      this.notificationEl?.classList.remove('show');
      this.notificationEl?.classList.add('hidden');
    }, durationMs);
  }

  public updateWeatherTime(
    timeStr: string,
    weatherIcon: string,
    weatherName: string,
    tempC: number,
    sourceTag: string
  ): void {
    if (this.weatherTimeEl) this.weatherTimeEl.textContent = timeStr;
    if (this.weatherSourceEl) this.weatherSourceEl.textContent = `[${sourceTag}]`;
    if (this.weatherStateEl) this.weatherStateEl.textContent = `${weatherIcon} ${weatherName}`;
    if (this.weatherTempEl) this.weatherTempEl.textContent = `${tempC.toFixed(1)}°C`;
  }

  public updateWeatherDebug(infoHtml: string): void {
    if (this.weatherDebugContent) {
      this.weatherDebugContent.innerHTML = infoHtml;
    }
  }

  public toggleWeatherDebug(): boolean {
    this.isWeatherDebugVisible = !this.isWeatherDebugVisible;
    if (this.weatherDebugOverlay) {
      if (this.isWeatherDebugVisible) {
        this.weatherDebugOverlay.classList.remove('hidden');
      } else {
        this.weatherDebugOverlay.classList.add('hidden');
      }
    }
    return this.isWeatherDebugVisible;
  }

  public onWeatherModalClick(handler: () => void): void {
    this.container.querySelector('#hud-weather-card')?.addEventListener('click', handler);
    this.container.querySelector('#btn-toggle-weather')?.addEventListener('click', handler);
  }

  public onWeatherDebugClick(handler: () => void): void {
    this.container.querySelector('#btn-toggle-weather-debug')?.addEventListener('click', handler);
  }

  public updateNightAnalysis(infoHtml: string): void {
    if (this.nightAnalysisContent) {
      this.nightAnalysisContent.innerHTML = infoHtml;
    }
  }

  public toggleNightAnalysis(): boolean {
    this.isNightAnalysisVisible = !this.isNightAnalysisVisible;
    if (this.nightAnalysisOverlay) {
      if (this.isNightAnalysisVisible) {
        this.nightAnalysisOverlay.classList.remove('hidden');
      } else {
        this.nightAnalysisOverlay.classList.add('hidden');
      }
    }
    return this.isNightAnalysisVisible;
  }

  public onNightAnalysisClick(handler: () => void): void {
    this.container.querySelector('#btn-toggle-night-analysis')?.addEventListener('click', handler);
  }

  public updateTrafficStats(stats: TrafficSystemStats): void {
    if (this.trafficStatsEl) {
      this.trafficStatsEl.textContent = `車輛駕駛: ${stats.totalVehicles} (轎:${stats.sedans} 計:${stats.taxis} 機:${stats.scooters} | 乘:${stats.passengersCount}) | 謹:${stats.cautiousCount} 常:${stats.normalCount} 急:${stats.hurriedCount} 慢:${stats.slowCount} | 逆:${stats.wrongWayEvents} | 規:${stats.violationsCount.total}(${stats.violationRatePercent.toFixed(1)}%) | 叭:${stats.totalHonks} | AI: ${stats.aiTimeMs.toFixed(2)}ms | Calls: ${stats.drawCalls}`;
    }
  }

  public updatePoliceStats(
    stats: { activeCars: number; patrollingCars: number; activePursuits: number; totalCitations: number; aiTimeMs: number; totalViolations: number },
    drawCalls: number
  ): void {
    if (this.policeStatsEl) {
      this.policeStatsEl.textContent = `警車執法: ${stats.activeCars} 輛 (巡:${stats.patrollingCars} 追:${stats.activePursuits} 罰:${stats.totalCitations}) | 違規: ${stats.totalViolations} | AI: ${stats.aiTimeMs.toFixed(2)}ms | Calls: ${drawCalls}`;
    }
  }

  public onPoliceDebugClick(handler: () => void): void {
    this.container.querySelector('#btn-toggle-police-debug')?.addEventListener('click', handler);
  }

  public updateTrafficSamplingReport(
    report: VehicleSamplingReport | null,
    remainingSec: number,
    isActive: boolean
  ): void {
    if (!this.trafficSamplingReportEl) return;
    if (isActive) {
      this.trafficSamplingReportEl.innerHTML = `
        <div style="background: rgba(30, 41, 59, 0.85); border: 1px solid #38bdf8; border-radius: 4px; padding: 8px; text-align: center; color: #bae6fd;">
          <div style="font-weight: bold; margin-bottom: 2px;">⏳ 正在進行 60 秒車輛行為抽樣...</div>
          <div style="font-size: 13px; font-weight: bold; color: #38bdf8;">剩餘 ${Math.ceil(remainingSec)} 秒</div>
        </div>
      `;
      return;
    }
    if (!report) {
      this.trafficSamplingReportEl.innerHTML = '';
      return;
    }

    const badge = report.isCompliant
      ? '<span style="color: #4ade80; background: rgba(34, 197, 94, 0.2); padding: 1px 6px; border-radius: 3px; font-weight: bold;">✅ 合格</span>'
      : '<span style="color: #f87171; background: rgba(239, 68, 68, 0.2); padding: 1px 6px; border-radius: 3px; font-weight: bold;">⚠️ 需改善</span>';

    const wrongCol = report.wrongWayCount === 0 ? '#4ade80' : '#ef4444';
    const oppCol = report.headOppositeSpeedCount === 0 ? '#4ade80' : '#ef4444';

    this.trafficSamplingReportEl.innerHTML = `
      <div style="background: rgba(15, 23, 42, 0.95); border: 1px solid ${report.isCompliant ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}; border-radius: 4px; padding: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 4px;">
          <b style="color: #38bdf8;">【車輛 60 秒行為抽樣評估報告】</b>
          ${badge}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 10px;">
          <div>抽樣總車次: <b>${report.totalVehiclesSampled} 輛</b></div>
          <div>平均車速: <b>${report.averageSpeedKmh ? report.averageSpeedKmh.toFixed(1) : '--'} km/h</b></div>
          <div>逆向行駛事件: <b style="color: ${wrongCol};">${report.wrongWayCount} 次 (目標: 0)</b></div>
          <div>車頭反向事件: <b style="color: ${oppCol};">${report.headOppositeSpeedCount} 次 (目標: 0)</b></div>
          <div style="grid-column: span 2;">違規統計: 總計 <b>${report.violationsCount.total} 次 (${report.violationRatePercent.toFixed(1)}%)</b> (搶燈: ${report.violationsCount.earlyRedRun}, 超速: ${report.violationsCount.speeding}, 壓線: ${report.violationsCount.pressCrosswalk}, 人行道: ${report.violationsCount.scooterSidewalk})</div>
        </div>
      </div>
    `;
  }

  public updateTrafficDebugContent(infoHtml: string): void {
    if (this.trafficDebugContent) {
      this.trafficDebugContent.innerHTML = infoHtml;
    }
  }

  public toggleTrafficDebug(): boolean {
    this.isTrafficDebugVisible = !this.isTrafficDebugVisible;
    if (this.trafficDebugOverlay) {
      if (this.isTrafficDebugVisible) {
        this.trafficDebugOverlay.classList.remove('hidden');
      } else {
        this.trafficDebugOverlay.classList.add('hidden');
      }
    }
    return this.isTrafficDebugVisible;
  }

  public onTrafficDebugClick(handler: () => void): void {
    this.container.querySelector('#btn-toggle-traffic-debug')?.addEventListener('click', handler);
  }

  public onTrafficSamplingClick(handler: () => void): void {
    this.container.querySelector('#btn-traffic-sampling-60s')?.addEventListener('click', handler);
  }

  public onTrafficRefreshClick(handler: () => void): void {
    this.container.querySelector('#btn-traffic-refresh')?.addEventListener('click', handler);
  }

  public onForceHonkClick(handler: () => void): void {
    this.container.querySelector('#btn-force-honk')?.addEventListener('click', handler);
  }

  public onForceAnnoyClick(handler: () => void): void {
    this.container.querySelector('#btn-force-annoy')?.addEventListener('click', handler);
  }

  public onEjectDriverClick(handler: () => void): void {
    this.container.querySelector('#btn-eject-driver')?.addEventListener('click', handler);
  }

  public toggleStopLineMeasurement(): boolean {
    this.isStopLineMeasurementVisible = !this.isStopLineMeasurementVisible;
    if (this.stopLineOverlay) {
      if (this.isStopLineMeasurementVisible) {
        this.stopLineOverlay.classList.remove('hidden');
      } else {
        this.stopLineOverlay.classList.add('hidden');
      }
    }
    return this.isStopLineMeasurementVisible;
  }

  public updateStopLineMeasurement(stats: StopLineStats, isAllRed: boolean): void {
    if (!this.stopLineContent) return;

    const allRedBtn = this.container.querySelector('#btn-stopline-toggle-all-red') as HTMLButtonElement | null;
    if (allRedBtn) {
      if (isAllRed) {
        allRedBtn.textContent = '🟢 恢復正常號誌 (解除全紅)';
        allRedBtn.style.background = 'rgba(34, 197, 94, 0.25)';
        allRedBtn.style.borderColor = '#22c55e';
        allRedBtn.style.color = '#86efac';
      } else {
        allRedBtn.textContent = '🚨 全城紅燈 (強制停等)';
        allRedBtn.style.background = 'rgba(239, 68, 68, 0.25)';
        allRedBtn.style.borderColor = '#ef4444';
        allRedBtn.style.color = '#fca5a5';
      }
    }

    const { totalStopped, leadStoppedCount, compliantCount, compliantRate, pressedCount, averageDistanceToLine, measurements } = stats;

    let html = `
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;">
        <div style="background: rgba(30, 41, 59, 0.7); padding: 6px; border-radius: 4px; border: 1px solid rgba(148, 163, 184, 0.2);">
          <div style="color: #94a3b8; font-size: 10px;">停等車輛 / 領頭車</div>
          <div style="font-size: 14px; font-weight: bold; color: #f8fafc;">${totalStopped} 輛 <span style="font-size: 10px; color: #94a3b8;">(${leadStoppedCount} 領頭)</span></div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.7); padding: 6px; border-radius: 4px; border: 1px solid rgba(148, 163, 184, 0.2);">
          <div style="color: #94a3b8; font-size: 10px;">平均停等間隙</div>
          <div style="font-size: 14px; font-weight: bold; color: #38bdf8;">${averageDistanceToLine > 0 ? averageDistanceToLine.toFixed(2) + ' m' : '--'}</div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.7); padding: 6px; border-radius: 4px; border: 1px solid ${compliantRate >= 90 ? '#22c55e' : '#eab308'};">
          <div style="color: #94a3b8; font-size: 10px;">合規率 (0.5~1.0m)</div>
          <div style="font-size: 15px; font-weight: bold; color: #4ade80;">${leadStoppedCount > 0 ? compliantRate.toFixed(1) + '%' : '100%'} <span style="font-size: 10px;">(${compliantCount}/${leadStoppedCount})</span></div>
        </div>
        <div style="background: rgba(30, 41, 59, 0.7); padding: 6px; border-radius: 4px; border: 1px solid ${pressedCount === 0 ? '#22c55e' : '#ef4444'};">
          <div style="color: #94a3b8; font-size: 10px;">壓線車輛 (目標 0)</div>
          <div style="font-size: 15px; font-weight: bold; color: ${pressedCount === 0 ? '#4ade80' : '#ef4444'};">${pressedCount} 輛 <span style="font-size: 10px;">(${stats.pressedRate.toFixed(1)}%)</span></div>
        </div>
      </div>
    `;

    if (measurements.length === 0) {
      html += `<div style="text-align: center; color: #94a3b8; padding: 12px;">路口暫無停等車輛，可點擊「全城紅燈」測試停等！</div>`;
    } else {
      html += `
        <div style="max-height: 220px; overflow-y: auto; border: 1px solid rgba(148, 163, 184, 0.15); border-radius: 4px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 10px; text-align: left;">
            <thead>
              <tr style="background: rgba(30, 41, 59, 0.9); color: #94a3b8; border-bottom: 1px solid rgba(148, 163, 184, 0.2);">
                <th style="padding: 4px 6px;">車輛</th>
                <th style="padding: 4px 6px;">車頭距線</th>
                <th style="padding: 4px 6px;">位置/目標</th>
                <th style="padding: 4px 6px;">狀態判定</th>
              </tr>
            </thead>
            <tbody>
      `;

      for (const m of measurements) {
        const typeIcon = m.vehicleType === 'scooter' ? '🛵' : m.vehicleType === 'taxi' ? '🚕' : '🚗';
        let statusBadge = '';
        if (m.status === 'compliant') {
          statusBadge = '<span style="color: #4ade80; background: rgba(34, 197, 94, 0.2); padding: 1px 4px; border-radius: 3px; font-weight: bold;">合格</span>';
        } else if (m.status === 'too_close') {
          statusBadge = '<span style="color: #fde047; background: rgba(234, 179, 8, 0.2); padding: 1px 4px; border-radius: 3px; font-weight: bold;">太近</span>';
        } else if (m.status === 'line_pressed') {
          statusBadge = '<span style="color: #f87171; background: rgba(239, 68, 68, 0.2); padding: 1px 4px; border-radius: 3px; font-weight: bold;">壓線</span>';
        } else {
          statusBadge = `<span style="color: #38bdf8; background: rgba(56, 189, 248, 0.2); padding: 1px 4px; border-radius: 3px;">排隊 (${(m.queueGapToLead || 0).toFixed(1)}m)</span>`;
        }

        const targetTxt = m.targetStopLineType === 'scooter_box_line' ? '機慢車停等區' : '汽車停止線';
        const distColor = m.frontBumperDistanceToStopLine < 0 ? '#ef4444' : (m.frontBumperDistanceToStopLine < 0.5 ? '#f59e0b' : '#4ade80');

        html += `
          <tr style="border-bottom: 1px solid rgba(148, 163, 184, 0.1);">
            <td style="padding: 3px 6px; font-family: monospace;">${typeIcon} ${m.vehicleId}</td>
            <td style="padding: 3px 6px; font-weight: bold; color: ${distColor}; font-family: monospace;">+${m.frontBumperDistanceToStopLine.toFixed(2)} m</td>
            <td style="padding: 3px 6px; color: #cbd5e1;">${targetTxt}</td>
            <td style="padding: 3px 6px;">${statusBadge}</td>
          </tr>
        `;
      }

      html += `</tbody></table></div>`;
    }

    this.stopLineContent.innerHTML = html;
  }

  public onStopLineMeasurementClick(handler: () => void): void {
    this.container.querySelector('#btn-toggle-stopline-measurement')?.addEventListener('click', handler);
  }

  public onStopLineToggleAllRedClick(handler: () => void): void {
    this.container.querySelector('#btn-stopline-toggle-all-red')?.addEventListener('click', handler);
  }

  public onStopLineRefreshClick(handler: () => void): void {
    this.container.querySelector('#btn-stopline-refresh')?.addEventListener('click', handler);
  }

  public show(): void {
    this.container.style.display = 'block';
  }

  public hide(): void {
    this.container.style.display = 'none';
  }
}
