/**
 * StreetViewWindow.ts - Mapillary 官方真實街景參考視窗
 * 依據 RULES.md 與使用者要求：
 * 1. 僅使用 MapillaryJS 官方檢視器與 Mapillary Graph API
 * 2. 嚴禁下載、批次抓取影像，也不得把街景畫面當貼圖或做 OCR
 * 3. 金鑰從 .env 的 VITE_MAPILLARY_TOKEN 讀取；沒設定時友善提示
 * 4. 只有第一次開啟街景時才動態載入 mapillary-js
 * 5. 按 G 開關街景視窗（預設右下角約 400x260），按 H 切換 50/50 左右分割對照模式
 * 6. 玩家移動時節流更新（每 1 秒最多一次），換到新影像用 moveTo，朝向同步相機真北方位角
 * 7. 街景視窗取得焦點時暫停遊戲鍵盤輸入並釋放 Pointer Lock，點回遊戲畫面恢復
 * 8. 找不到影像顯示「此處沒有街景」，不報錯
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { GeoProjection } from '../geo/Projection.ts';
import { InputManager } from '../core/InputManager.ts';
import { MapillaryService, MapillaryImageResult } from '../geo/MapillaryService.ts';

export class StreetViewWindow {
  private el: HTMLDivElement;
  private headerEl: HTMLDivElement;
  private titleEl: HTMLSpanElement;
  private btnSplit: HTMLButtonElement;
  private btnFullscreen: HTMLButtonElement;
  private btnClose: HTMLButtonElement;
  private viewerContainer: HTMLDivElement;
  private noDataOverlay: HTMLDivElement;
  private noTokenOverlay: HTMLDivElement;
  private statusIndicator: HTMLSpanElement;

  private inputManager: InputManager;
  private mapillaryService: MapillaryService;
  private onSplitChangeCallback?: (isSplit: boolean) => void;

  // MapillaryJS 檢視器實例 (動態載入)
  private viewer: any = null;
  private isViewerLoaded = false;
  private isViewerLoading = false;

  private isVisible = false;
  private isSplitMode = false;
  private isFullscreen = false;

  private currentImageId: string | null = null;
  private currentImageLat: number = 0;
  private currentImageLon: number = 0;
  private lastUpdateTime = 0;
  private lastHeading = 0;

  // 拖曳狀態
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private initialWindowX = 0;
  private initialWindowY = 0;

  // 縮放狀態
  private isResizing = false;
  private resizeDir = '';
  private resizeStartX = 0;
  private resizeStartY = 0;
  private initialWindowWidth = 0;
  private initialWindowHeight = 0;
  private resizeRafId = 0;

  constructor(inputManager: InputManager, mapillaryService: MapillaryService) {
    this.inputManager = inputManager;
    this.mapillaryService = mapillaryService;

    // 1. 建立視窗本體 DOM
    this.el = document.createElement('div');
    this.el.id = 'mapillary-streetview-window';
    this.el.className = 'streetview-window hidden';

    this.el.innerHTML = `
      <div class="streetview-header" id="sv-drag-header" title="按住拖曳位置；雙擊重設；邊緣可調整大小">
        <div class="header-left">
          <span class="streetview-status-indicator" id="sv-status-dot" style="background:#eab308;box-shadow:0 0 8px #eab308;"></span>
          <span class="streetview-title" id="sv-title-text">📷 Mapillary 真實街景</span>
        </div>
        <div class="header-actions">
          <button id="btn-sv-split" class="sv-btn" title="左右對照模式 (H)">◫ 對照</button>
          <button id="btn-sv-fullscreen" class="sv-btn" title="切換全螢幕">⛶ 全螢幕</button>
          <button id="btn-sv-close" class="sv-btn close" title="關閉街景視窗 (G)">&times;</button>
        </div>
      </div>
      <div class="streetview-body">
        <div id="mapillary-viewer-container" class="streetview-container" style="background:#090d16;"></div>

        <!-- 此處沒有街景覆蓋層 -->
        <div id="sv-no-data-overlay" class="streetview-overlay hidden">
          <div class="no-data-icon">📍</div>
          <div class="no-data-text">此處沒有街景</div>
          <div class="no-data-sub">半徑 100 公尺內尚無 Mapillary 街景影像<br>移動至周邊主要幹道將自動載入</div>
        </div>

        <!-- 未設定 Token 覆蓋層 -->
        <div id="sv-no-token-overlay" class="streetview-overlay hidden">
          <div class="no-data-icon">🔑</div>
          <div class="no-data-text" style="color:#fde047;">尚未設定 VITE_MAPILLARY_TOKEN</div>
          <div class="no-data-sub" style="max-width:320px;">
            請前往 <a href="https://www.mapillary.com/dashboard/developers" target="_blank" style="color:#38bdf8;text-decoration:underline;">Mapillary Developers</a> 免費取得 Client Token，並於專案 <code>.env</code> 檔案中填入：<br>
            <code style="background:rgba(0,0,0,0.5);padding:2px 6px;border-radius:4px;display:inline-block;margin-top:6px;">VITE_MAPILLARY_TOKEN=MLY|...</code>
          </div>
        </div>

        <!-- 官方品牌標章與版權（不得遮蓋） -->
        <div class="mly-attribution-bar">
          <a href="https://www.mapillary.com" target="_blank" rel="noopener noreferrer" class="mly-attribution-link">
            Photos &copy; <b>Mapillary</b>
          </a>
        </div>
      </div>
      <!-- 8 方向邊緣與角落縮放手把 -->
      <div class="resize-handle resize-edge-t" data-dir="n"></div>
      <div class="resize-handle resize-edge-b" data-dir="s"></div>
      <div class="resize-handle resize-edge-l" data-dir="w"></div>
      <div class="resize-handle resize-edge-r" data-dir="e"></div>
      <div class="resize-handle resize-corner-tl" data-dir="nw" title="拖曳調整大小">
        <svg viewBox="0 0 10 10" width="9" height="9"><path d="M1 9L9 1 M1 5L5 1 M1 1L1 1" stroke="rgba(56,189,248,0.85)" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
      <div class="resize-handle resize-corner-tr" data-dir="ne"></div>
      <div class="resize-handle resize-corner-bl" data-dir="sw"></div>
      <div class="resize-handle resize-corner-br" data-dir="se" title="拖曳調整大小">
        <svg viewBox="0 0 10 10" width="9" height="9"><path d="M9 1L1 9 M9 5L5 9 M9 9L9 9" stroke="rgba(56,189,248,0.85)" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
    `;

    document.body.appendChild(this.el);

    // 2. 取得子元素
    this.headerEl = this.el.querySelector('#sv-drag-header')!;
    this.titleEl = this.el.querySelector('#sv-title-text')!;
    this.btnSplit = this.el.querySelector('#btn-sv-split')!;
    this.btnFullscreen = this.el.querySelector('#btn-sv-fullscreen')!;
    this.btnClose = this.el.querySelector('#btn-sv-close')!;
    this.viewerContainer = this.el.querySelector('#mapillary-viewer-container')!;
    this.noDataOverlay = this.el.querySelector('#sv-no-data-overlay')!;
    this.noTokenOverlay = this.el.querySelector('#sv-no-token-overlay')!;
    this.statusIndicator = this.el.querySelector('#sv-status-dot')!;

    // 3. 綁定按鈕與拖曳事件
    this.setupWindowInteractions();

    // 檢查金鑰狀態
    if (!this.mapillaryService.hasToken()) {
      this.noTokenOverlay.classList.remove('hidden');
      this.statusIndicator.style.background = '#ef4444';
      this.statusIndicator.style.boxShadow = '0 0 8px #ef4444';
    }
  }

  private setupWindowInteractions(): void {
    // 關閉
    this.btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });

    // 左右對照分割
    this.btnSplit.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSplitMode();
    });

    // 全螢幕切換
    this.btnFullscreen.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleFullscreen();
    });

    // 雙擊標題列重設至右下角預設位置與尺寸
    this.headerEl.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.resetToDefaultPositionAndSize();
    });

    // 視窗取得焦點時暫停遊戲鍵盤輸入並釋放 Pointer Lock
    this.el.addEventListener('mouseenter', () => {
      this.inputManager.suspendKeyboard();
    });
    this.el.addEventListener('mouseleave', () => {
      this.inputManager.resumeKeyboard();
    });
    this.el.addEventListener('focusin', () => {
      this.inputManager.suspendKeyboard();
    });
    this.el.addEventListener('focusout', () => {
      this.inputManager.resumeKeyboard();
    });
    this.el.addEventListener('mousedown', () => {
      if (this.inputManager.getPointerLocked()) {
        this.inputManager.exitPointerLock();
      }
    });

    // 標題列拖曳
    this.headerEl.addEventListener('mousedown', (e) => {
      if (this.isSplitMode || this.isFullscreen) return;
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;

      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;

      const rect = this.el.getBoundingClientRect();
      this.initialWindowX = rect.left;
      this.initialWindowY = rect.top;

      this.el.style.left = `${rect.left}px`;
      this.el.style.top = `${rect.top}px`;
      this.el.style.right = 'auto';
      this.el.style.bottom = 'auto';
      this.el.style.width = `${rect.width}px`;
      this.el.style.height = `${rect.height}px`;

      document.body.classList.add('is-dragging-window');
      window.addEventListener('mousemove', this.onMouseMoveDrag);
      window.addEventListener('mouseup', this.onMouseUpDrag);
      e.preventDefault();
    });

    // 8 方向縮放手把
    const handles = this.el.querySelectorAll('.resize-handle');
    handles.forEach((handle) => {
      handle.addEventListener('mousedown', (e) => {
        const dir = (handle as HTMLElement).dataset.dir;
        if (dir) {
          this.onResizeMouseDown(e as MouseEvent, dir);
        }
      });
    });
  }

  private onMouseMoveDrag = (e: MouseEvent): void => {
    if (!this.isDragging) return;

    const dx = e.clientX - this.dragStartX;
    const dy = e.clientY - this.dragStartY;

    const newX = Math.max(10, Math.min(window.innerWidth - this.el.offsetWidth - 10, this.initialWindowX + dx));
    const newY = Math.max(10, Math.min(window.innerHeight - this.el.offsetHeight - 10, this.initialWindowY + dy));

    this.el.style.left = `${newX}px`;
    this.el.style.top = `${newY}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
  };

  private onMouseUpDrag = (): void => {
    this.isDragging = false;
    window.removeEventListener('mousemove', this.onMouseMoveDrag);
    window.removeEventListener('mouseup', this.onMouseUpDrag);
    document.body.classList.remove('is-dragging-window');
  };

  private onResizeMouseDown = (e: MouseEvent, dir: string): void => {
    if (this.isSplitMode || this.isFullscreen) return;
    e.stopPropagation();
    e.preventDefault();

    this.isResizing = true;
    this.resizeDir = dir;
    this.resizeStartX = e.clientX;
    this.resizeStartY = e.clientY;

    const rect = this.el.getBoundingClientRect();
    this.initialWindowX = rect.left;
    this.initialWindowY = rect.top;
    this.initialWindowWidth = rect.width;
    this.initialWindowHeight = rect.height;

    this.el.style.left = `${rect.left}px`;
    this.el.style.top = `${rect.top}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';
    this.el.style.width = `${rect.width}px`;
    this.el.style.height = `${rect.height}px`;

    document.body.classList.add('is-resizing-window');
    window.addEventListener('mousemove', this.onMouseMoveResize);
    window.addEventListener('mouseup', this.onMouseUpResize);
  };

  private onMouseMoveResize = (e: MouseEvent): void => {
    if (!this.isResizing) return;

    const dx = e.clientX - this.resizeStartX;
    const dy = e.clientY - this.resizeStartY;

    const minWidth = 280;
    const minHeight = 180;
    const maxWidth = window.innerWidth - 20;
    const maxHeight = window.innerHeight - 20;

    let newWidth = this.initialWindowWidth;
    let newHeight = this.initialWindowHeight;
    let newLeft = this.initialWindowX;
    let newTop = this.initialWindowY;

    if (this.resizeDir.includes('w')) {
      newWidth = Math.max(minWidth, Math.min(maxWidth, this.initialWindowWidth - dx));
      newLeft = this.initialWindowX + (this.initialWindowWidth - newWidth);
      newLeft = Math.max(10, Math.min(window.innerWidth - newWidth - 10, newLeft));
    } else if (this.resizeDir.includes('e')) {
      newWidth = Math.max(minWidth, Math.min(window.innerWidth - this.initialWindowX - 10, this.initialWindowWidth + dx));
    }

    if (this.resizeDir.includes('n')) {
      newHeight = Math.max(minHeight, Math.min(maxHeight, this.initialWindowHeight - dy));
      newTop = this.initialWindowY + (this.initialWindowHeight - newHeight);
      newTop = Math.max(10, Math.min(window.innerHeight - newHeight - 10, newTop));
    } else if (this.resizeDir.includes('s')) {
      newHeight = Math.max(minHeight, Math.min(window.innerHeight - this.initialWindowY - 10, this.initialWindowHeight + dy));
    }

    this.el.style.width = `${newWidth}px`;
    this.el.style.height = `${newHeight}px`;
    this.el.style.left = `${newLeft}px`;
    this.el.style.top = `${newTop}px`;

    if (!this.resizeRafId) {
      this.resizeRafId = requestAnimationFrame(() => {
        this.resizeRafId = 0;
        this.viewer?.resize();
      });
    }
  };

  private onMouseUpResize = (): void => {
    this.isResizing = false;
    if (this.resizeRafId) {
      cancelAnimationFrame(this.resizeRafId);
      this.resizeRafId = 0;
    }
    window.removeEventListener('mousemove', this.onMouseMoveResize);
    window.removeEventListener('mouseup', this.onMouseUpResize);
    document.body.classList.remove('is-resizing-window');

    this.viewer?.resize();
  };

  /**
   * 第一次開啟街景時動態載入 mapillary-js 套件與樣式
   */
  private async ensureViewerInitialized(): Promise<boolean> {
    if (this.isViewerLoaded) return true;
    if (this.isViewerLoading) return false;

    if (!this.mapillaryService.hasToken()) {
      this.noTokenOverlay.classList.remove('hidden');
      return false;
    }

    this.isViewerLoading = true;

    try {
      // 動態載入 CSS 與 mapillary-js 核心
      import('mapillary-js/dist/mapillary.css');
      const { Viewer } = await import('mapillary-js');

      this.viewer = new Viewer({
        accessToken: this.mapillaryService.getToken(),
        container: this.viewerContainer,
        component: {
          cover: false,
          direction: true,
          sequence: false,
          zoom: false
        }
      });

      this.isViewerLoaded = true;
      this.isViewerLoading = false;
      this.statusIndicator.style.background = '#22c55e';
      this.statusIndicator.style.boxShadow = '0 0 8px #22c55e';
      console.log('[Mapillary] 成功動態載入 MapillaryJS 檢視器');
      return true;
    } catch (err: any) {
      this.isViewerLoading = false;
      console.error('[Mapillary] 動態載入 MapillaryJS 失敗', err);
      return false;
    }
  }

  /**
   * 顯示街景視窗
   */
  public async show(lat?: number, lon?: number): Promise<void> {
    this.isVisible = true;
    this.el.classList.remove('hidden');

    await this.ensureViewerInitialized();

    if (this.viewer) {
      setTimeout(() => {
        this.viewer.resize();
      }, 60);
    }

    if (lat !== undefined && lon !== undefined) {
      this.updateLocation(lat, lon, 0, true);
    }
  }

  /**
   * 隱藏街景視窗
   */
  public hide(): void {
    this.isVisible = false;
    this.el.classList.add('hidden');
    if (this.isSplitMode) {
      this.toggleSplitMode();
    }
    this.inputManager.resumeKeyboard();
  }

  public toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * 切換左右對照分割模式 (按 H 鍵)
   */
  public toggleSplitMode(): void {
    if (!this.isVisible) {
      this.show();
    }

    this.isSplitMode = !this.isSplitMode;

    if (this.isSplitMode) {
      this.isFullscreen = false;
      this.el.classList.remove('fullscreen-mode');
      this.btnFullscreen.textContent = '⛶ 全螢幕';

      this.el.classList.add('split-mode');
      document.body.classList.add('split-screen-active');
      this.btnSplit.textContent = '◫ 浮動視窗';
      this.btnSplit.classList.add('active');

      this.el.style.left = '';
      this.el.style.top = '';
      this.el.style.right = '';
      this.el.style.bottom = '';
      this.el.style.width = '';
      this.el.style.height = '';
    } else {
      this.el.classList.remove('split-mode');
      document.body.classList.remove('split-screen-active');
      this.btnSplit.textContent = '◫ 對照';
      this.btnSplit.classList.remove('active');

      this.resetToDefaultPositionAndSize();
    }

    this.onSplitChangeCallback?.(this.isSplitMode);

    if (this.viewer) {
      setTimeout(() => {
        this.viewer.resize();
      }, 50);
    }
  }

  /**
   * 切換全螢幕模式
   */
  public toggleFullscreen(): void {
    if (!this.isVisible) return;

    this.isFullscreen = !this.isFullscreen;

    if (this.isFullscreen) {
      if (this.isSplitMode) {
        this.el.classList.remove('split-mode');
        document.body.classList.remove('split-screen-active');
        this.btnSplit.textContent = '◫ 對照';
        this.btnSplit.classList.remove('active');
        this.isSplitMode = false;
        this.onSplitChangeCallback?.(false);
      }
      this.el.classList.add('fullscreen-mode');
      this.btnFullscreen.textContent = '🗗 縮小';
    } else {
      this.el.classList.remove('fullscreen-mode');
      this.btnFullscreen.textContent = '⛶ 全螢幕';
      this.resetToDefaultPositionAndSize();
    }

    if (this.viewer) {
      setTimeout(() => {
        this.viewer.resize();
      }, 50);
    }
  }

  public resetToDefaultPositionAndSize(): void {
    this.el.style.left = '';
    this.el.style.top = '';
    this.el.style.right = '20px';
    this.el.style.bottom = '20px';
    this.el.style.width = '400px';
    this.el.style.height = '260px';
    if (this.viewer) {
      setTimeout(() => this.viewer.resize(), 50);
    }
  }

  /**
   * 逐幀由遊戲迴圈更新：將玩家世界座標轉回經緯度並節流同步街景
   */
  public update(
    playerPos: THREE.Vector3,
    cameraYaw: number,
    projection: GeoProjection | null
  ): void {
    if (!this.isVisible || !projection) return;

    const now = performance.now();
    if (now - this.lastUpdateTime < CONFIG.MAPILLARY.THROTTLE_INTERVAL_MS) {
      return;
    }
    this.lastUpdateTime = now;

    // 1. 座標轉換：遊戲世界公尺座標 ➔ 真實經緯度
    const geo = projection.unproject(playerPos.x, playerPos.z);

    // 2. 朝向計算：Three.js 相機 Yaw ➔ 真北 Heading (0~360度)
    // 0° = 北 (-Z), 90° = 東 (+X), 180° = 南 (+Z), 270° = 西 (-X)
    const heading = ((-cameraYaw * 180 / Math.PI) % 360 + 360) % 360;

    this.updateLocation(geo.lat, geo.lon, heading);
  }

  /**
   * 更新街景位置與方位
   */
  public async updateLocation(lat: number, lon: number, heading: number, force: boolean = false): Promise<void> {
    if (!this.mapillaryService.hasToken()) {
      this.noTokenOverlay.classList.remove('hidden');
      return;
    }

    // 計算距離上次已載入影像之位移距離
    const distToCurrentImage = this.currentImageLat !== 0
      ? Math.hypot((lat - this.currentImageLat) * 111000, (lon - this.currentImageLon) * 101000)
      : Infinity;

    // 若位移未達閥值且非強制，僅同步視野朝向
    if (!force && distToCurrentImage < CONFIG.MAPILLARY.MIN_DISTANCE_FOR_NEW_IMAGE) {
      this.syncHeading(heading);
      return;
    }

    // 查詢離該點最近之 Mapillary 影像
    const imgResult: MapillaryImageResult | null = await this.mapillaryService.findNearestImage(lat, lon);

    if (imgResult) {
      this.noDataOverlay.classList.add('hidden');

      if (imgResult.id !== this.currentImageId) {
        this.currentImageId = imgResult.id;
        this.currentImageLat = imgResult.lat;
        this.currentImageLon = imgResult.lon;
        this.titleEl.textContent = `📷 Mapillary 街景 (${imgResult.distance < 10 ? '精確' : Math.round(imgResult.distance) + 'm'})`;

        if (this.viewer && this.isViewerLoaded) {
          try {
            await this.viewer.moveTo(imgResult.id);
            this.syncHeading(heading);
          } catch (err) {
            console.warn('[Mapillary] moveTo 影像失敗', err);
          }
        }
      } else {
        this.syncHeading(heading);
      }
    } else {
      // 找不到街景時顯示提示，不報錯
      this.noDataOverlay.classList.remove('hidden');
      this.titleEl.textContent = '📷 Mapillary 街景 (周邊無影像)';
    }
  }

  /**
   * 同步街景相機水平方位角至玩家相機視角朝向 (真北對齊)
   */
  private syncHeading(heading: number): void {
    if (!this.viewer || !this.isViewerLoaded) return;
    if (Math.abs(heading - this.lastHeading) < 1.0) return;
    this.lastHeading = heading;

    try {
      // Mapillary basic coordinates [0, 1]: 根據視角朝向平移中心
      // 0 = 北, 90 = 東, 180 = 南, 270 = 西
      const x = ((heading / 360) % 1 + 1) % 1;
      this.viewer.setCenter([x, 0.5]);
    } catch {}
  }

  public onSplitChange(callback: (isSplit: boolean) => void): void {
    this.onSplitChangeCallback = callback;
  }

  public getIsVisible(): boolean {
    return this.isVisible;
  }

  public dispose(): void {
    this.hide();
    if (this.viewer) {
      try {
        this.viewer.remove();
      } catch {}
      this.viewer = null;
    }
  }
}
