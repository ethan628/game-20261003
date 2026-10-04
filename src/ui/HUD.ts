/**
 * HUD.ts - 遊戲內抬頭顯示器 (Heads-Up Display)
 */

import { BuildingSourceStats } from '../geo/OsmTypes.ts';
import { PedestrianSystemStats } from '../geo/PedestrianTypes.ts';

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
  private qualityValEl: HTMLSpanElement;
  private wetBtn: HTMLElement | null = null;
  private nightBtn: HTMLElement | null = null;

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
            <div id="hud-map-stats" style="color: #67e8f9; margin-top: 2px; font-weight: 500;">自繪地圖: 0.0ms | 標記: 0</div>
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
        <div class="hint-pill" id="btn-toggle-streetview"><b>G 鍵</b> 實境街景</div>
        <div class="hint-pill" id="btn-toggle-split"><b>H 鍵</b> 街景對照</div>
        <div class="hint-pill" id="btn-toggle-signboard-debug" title="切換招牌除錯視覺化 (F3)"><b>F3</b> 招牌標記</div>
        <div class="hint-pill" id="btn-clear-cache" title="清除 IndexedDB 快取並重整載入 (F4)"><b>F4</b> 清除快取重整</div>
        <div class="hint-pill" id="btn-toggle-bldg-debug" title="切換建築輪廓線框 (F5)"><b>F5</b> 建築輪廓</div>
        <div class="hint-pill" id="btn-toggle-bldg-inspector" title="切換建築檢視校正模式 (F6)"><b>F6</b> 建築校正</div>
        <div class="hint-pill" id="btn-toggle-floor-labels" title="切換 3D 浮動樓層數字標籤 (F7)"><b>F7</b> 樓層標籤</div>
        <div class="hint-pill" id="btn-toggle-ped-debug" title="切換行人路網與狀態除錯視覺化 (F8)"><b>F8</b> 行人除錯</div>
        <div class="hint-pill" id="btn-toggle-signal-debug" title="切換交通號誌除錯視覺化 (F9)"><b>F9</b> 號誌除錯</div>
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
    this.qualityValEl = this.container.querySelector('#hud-quality-val')!;
    this.wetBtn = this.container.querySelector('#btn-toggle-wet');
    this.nightBtn = this.container.querySelector('#btn-toggle-night');

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
    this.pedStatsEl.textContent = `行人: ${stats.total}人 (走:${stats.walking} 停:${stats.idle} 等:${stats.waiting} 渡:${stats.crossing} 避:${stats.evading}${panicPart}) | AI: ${stats.aiTimeMs.toFixed(2)}ms | Calls: ${stats.drawCalls}`;
  }

  public onPedestrianDebugClick(handler: () => void): void {
    const btn = this.container.querySelector('#btn-toggle-ped-debug');
    btn?.addEventListener('click', handler);
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

  public show(): void {
    this.container.style.display = 'block';
  }

  public hide(): void {
    this.container.style.display = 'none';
  }
}
