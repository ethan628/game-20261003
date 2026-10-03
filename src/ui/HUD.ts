/**
 * HUD.ts - 遊戲內抬頭顯示器 (Heads-Up Display)
 */

export class HUD {
  private container: HTMLDivElement;
  private fpsBadge: HTMLSpanElement;
  private callsBadge: HTMLSpanElement;
  private locationEl: HTMLDivElement;
  private coordsEl: HTMLDivElement;
  private latLonEl: HTMLDivElement;
  private renderStatsEl: HTMLDivElement;
  private buildingStatsEl: HTMLDivElement;
  private signboardStatsEl: HTMLDivElement;

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
            <div id="hud-signboard-stats" style="color: #fbbf24; margin-top: 2px; font-weight: 500;">店家招牌: 0 (可見: 0) [真建: 0 | 補店: 0 | 立柱: 0]</div>
          </div>
        </div>
      </div>

      <div class="hud-controls-hint">
        <div class="hint-pill"><b>WASD</b> 移動</div>
        <div class="hint-pill"><b>Shift</b> 奔跑</div>
        <div class="hint-pill"><b>空白鍵</b> 跳躍</div>
        <div class="hint-pill"><b>滑鼠</b> 環繞視角 (點擊鎖定)</div>
        <div class="hint-pill" id="btn-toggle-streetview"><b>G 鍵</b> 實境街景</div>
        <div class="hint-pill" id="btn-toggle-split"><b>H 鍵</b> 街景對照</div>
        <div class="hint-pill" id="btn-toggle-map"><b>N 鍵</b> 雷達地圖</div>
        <div class="hint-pill" id="btn-toggle-signboard-debug" title="切換招牌除錯視覺化 (F3)"><b>F3</b> 招牌標記</div>
        <div class="hint-pill" id="btn-clear-cache" title="清除 IndexedDB 快取並重整載入 (F4)"><b>F4</b> 清除快取重整</div>
        <div class="hint-pill" id="btn-toggle-bldg-debug" title="切換建築輪廓線框 (F5)"><b>F5</b> 建築輪廓</div>
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
    this.signboardStatsEl = this.container.querySelector('#hud-signboard-stats')!;
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

  /**
   * 更新 HUD 建築管線即時統計數據
   */
  public updateBuildingStats(stats: { total: number; nearby: number; vertices: number; discarded?: number }): void {
    const discStr = stats.discarded !== undefined && stats.discarded > 0 ? ` (棄: ${stats.discarded})` : '';
    this.buildingStatsEl.textContent = `建物: ${stats.total} 棟 (100m內: ${stats.nearby}) | 頂點: ${stats.vertices.toLocaleString()}${discStr}`;
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
