/**
 * MapReferenceWindow.ts - 即時實境地圖與衛星航照圖對照視窗
 * 依據 RULES.md 與使用者要求：
 * 1. 100% 免金鑰、免註冊、無須 Google Cloud，開箱即用
 * 2. 採用開源 Leaflet 引擎，支援 OSM 街道地圖與高解析衛星航照圖雙圖層一鍵切換
 * 3. 玩家位置與視野朝向 (真北對齊) 即時同步更新
 * 4. 支援右下角懸浮拖曳、全螢幕展開與左右分割對照模式 (按 H 鍵)
 * 5. 移入視窗時停用遊戲移動鍵，點回遊戲畫布無縫銜接
 */

import * as THREE from 'three';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { CONFIG } from '../config.ts';
import { GeoProjection } from '../geo/Projection.ts';
import { InputManager } from '../core/InputManager.ts';

export class MapReferenceWindow {
  private el: HTMLDivElement;
  private headerEl: HTMLDivElement;
  private titleEl: HTMLSpanElement;
  private btnSize: HTMLButtonElement;
  private btnLayerToggle: HTMLButtonElement;
  private btnSplit: HTMLButtonElement;
  private btnFullscreen: HTMLButtonElement;
  private btnClose: HTMLButtonElement;
  private mapContainer: HTMLDivElement;

  private inputManager: InputManager;
  private onSplitChangeCallback?: (isSplit: boolean) => void;
  private onLocationClickCallback?: (lat: number, lon: number) => void;

  private map: L.Map | null = null;
  private osmLayer: L.TileLayer | null = null;
  private satelliteLayer: L.TileLayer | null = null;
  private currentLayerType: 'osm' | 'satellite' = 'osm';

  private playerMarker: L.Marker | null = null;
  private markerConeEl: HTMLElement | null = null;
  private destMarker: L.Marker | null = null;

  private isMapInitialized = false;
  private isVisible = false;
  private isSplitMode = false;
  private isFullscreen = false;

  private lastUpdateTime = 0;
  private lastLat = 0;
  private lastLon = 0;
  private lastHeading = 0;

  // 拖曳位置狀態
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private initialWindowX = 0;
  private initialWindowY = 0;

  // 調整大小狀態
  private isResizing = false;
  private resizeDir = '';
  private resizeStartX = 0;
  private resizeStartY = 0;
  private initialWindowWidth = 0;
  private initialWindowHeight = 0;
  private resizeRafId = 0;

  constructor(inputManager: InputManager) {
    this.inputManager = inputManager;

    // 1. 建立視窗本體 DOM（含 8 方向縮放控制手把與頂部拖曳列）
    this.el = document.createElement('div');
    this.el.id = 'map-reference-window';
    this.el.className = 'streetview-window hidden';

    this.el.innerHTML = `
      <div class="streetview-header" id="map-drag-header" title="點擊地圖任意地點可飛越前往；按住拖曳移動位置；雙擊重設右下角預設；邊緣與角落可縮放大小">
        <div class="header-left">
          <span class="streetview-status-indicator" style="background:#22c55e;box-shadow:0 0 8px #22c55e;"></span>
          <span class="streetview-title" id="map-title-text">🗺️ 實境雷達</span>
        </div>
        <div class="header-actions">
          <button id="btn-map-size" class="sv-btn" title="切換常用預設尺寸 (S 小 / M 中 / L 大)">📐 尺寸</button>
          <button id="btn-map-layer" class="sv-btn" title="切換街道 / 衛星航照圖">🛰️ 衛星</button>
          <button id="btn-map-split" class="sv-btn" title="左右對照模式 (H)">◫ 對照</button>
          <button id="btn-map-fullscreen" class="sv-btn" title="切換全螢幕">⛶ 全螢幕</button>
          <button id="btn-map-close" class="sv-btn close" title="關閉地圖視窗 (G)">&times;</button>
        </div>
      </div>
      <div class="streetview-body">
        <div id="leaflet-map-container" class="streetview-container" style="background:#1e293b;"></div>
      </div>
      <!-- 8 方向邊緣與角落縮放手把 -->
      <div class="resize-handle resize-edge-t" data-dir="n"></div>
      <div class="resize-handle resize-edge-b" data-dir="s"></div>
      <div class="resize-handle resize-edge-l" data-dir="w"></div>
      <div class="resize-handle resize-edge-r" data-dir="e"></div>
      <div class="resize-handle resize-corner-tl" data-dir="nw" title="拖曳縮放大小">
        <svg viewBox="0 0 10 10" width="9" height="9"><path d="M1 9L9 1 M1 5L5 1 M1 1L1 1" stroke="rgba(56,189,248,0.85)" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
      <div class="resize-handle resize-corner-tr" data-dir="ne"></div>
      <div class="resize-handle resize-corner-bl" data-dir="sw"></div>
      <div class="resize-handle resize-corner-br" data-dir="se" title="拖曳縮放大小">
        <svg viewBox="0 0 10 10" width="9" height="9"><path d="M9 1L1 9 M9 5L5 9 M9 9L9 9" stroke="rgba(56,189,248,0.85)" stroke-width="1.5" stroke-linecap="round"/></svg>
      </div>
    `;

    document.body.appendChild(this.el);

    // 2. 取得子元素
    this.headerEl = this.el.querySelector('#map-drag-header')!;
    this.titleEl = this.el.querySelector('#map-title-text')!;
    this.btnSize = this.el.querySelector('#btn-map-size')!;
    this.btnLayerToggle = this.el.querySelector('#btn-map-layer')!;
    this.btnSplit = this.el.querySelector('#btn-map-split')!;
    this.btnFullscreen = this.el.querySelector('#btn-map-fullscreen')!;
    this.btnClose = this.el.querySelector('#btn-map-close')!;
    this.mapContainer = this.el.querySelector('#leaflet-map-container')!;

    // 3. 綁定按鈕與拖曳/縮放事件
    this.setupWindowInteractions();
  }

  private setupWindowInteractions(): void {
    // 關閉
    this.btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });

    // 快速預設尺寸切換 (S / M / L)
    this.btnSize.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cyclePresetSize();
    });

    // 圖層切換 (街道 / 衛星圖)
    this.btnLayerToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleLayer();
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

    // 雙擊標題列重設至預設右下角位置與標準尺寸
    this.headerEl.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.resetToDefaultPositionAndSize();
    });

    // 視窗取得焦點時暫停遊戲移動，避免角色亂跑
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

    // 點擊地圖時釋放 Pointer Lock，方便平移縮放地圖
    this.el.addEventListener('mousedown', () => {
      if (this.inputManager.getPointerLocked()) {
        this.inputManager.exitPointerLock();
      }
    });

    // 標題列拖曳位置
    this.headerEl.addEventListener('mousedown', (e) => {
      if (this.isSplitMode || this.isFullscreen) return;
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;

      this.isDragging = true;
      this.dragStartX = e.clientX;
      this.dragStartY = e.clientY;

      const rect = this.el.getBoundingClientRect();
      this.initialWindowX = rect.left;
      this.initialWindowY = rect.top;

      // 鎖定為絕對左上角座標，避免 right/bottom 干擾拖曳計算
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

    // 8 方向縮放手把事件綁定
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
    this.saveCustomLayout();
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

    // 鎖定為絕對左上角座標
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

    const minWidth = 260;
    const minHeight = 180;
    const maxWidth = window.innerWidth - 20;
    const maxHeight = window.innerHeight - 20;

    let newWidth = this.initialWindowWidth;
    let newHeight = this.initialWindowHeight;
    let newLeft = this.initialWindowX;
    let newTop = this.initialWindowY;

    // 水平縮放
    if (this.resizeDir.includes('w')) {
      newWidth = Math.max(minWidth, Math.min(maxWidth, this.initialWindowWidth - dx));
      newLeft = this.initialWindowX + (this.initialWindowWidth - newWidth);
      newLeft = Math.max(10, Math.min(window.innerWidth - newWidth - 10, newLeft));
    } else if (this.resizeDir.includes('e')) {
      newWidth = Math.max(minWidth, Math.min(window.innerWidth - this.initialWindowX - 10, this.initialWindowWidth + dx));
    }

    // 垂直縮放
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

    // 使用 requestAnimationFrame 平滑通知 Leaflet 調整圖層尺寸
    if (!this.resizeRafId) {
      this.resizeRafId = requestAnimationFrame(() => {
        this.resizeRafId = 0;
        this.map?.invalidateSize({ animate: false });
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

    this.map?.invalidateSize({ animate: false });
    this.saveCustomLayout();
  };

  /**
   * 循環切換常用預設尺寸 (S / M / L)
   */
  public cyclePresetSize(): void {
    if (this.isSplitMode || this.isFullscreen) return;

    const SIZES = [
      { name: '小', width: 300, height: 200 },
      { name: '中', width: 420, height: 270 },
      { name: '大', width: 560, height: 370 }
    ];

    const currentWidth = this.el.offsetWidth;
    let nextIndex = 0;
    if (currentWidth < 360) nextIndex = 1; // 小 -> 中
    else if (currentWidth < 500) nextIndex = 2; // 中 -> 大
    else nextIndex = 0; // 大 -> 小

    const target = SIZES[nextIndex];
    const rect = this.el.getBoundingClientRect();

    // 以右下角為錨點向左上展開，若靠左則向右擴展
    let newLeft = rect.right - target.width;
    let newTop = rect.bottom - target.height;

    newLeft = Math.max(10, Math.min(window.innerWidth - target.width - 10, newLeft));
    newTop = Math.max(10, Math.min(window.innerHeight - target.height - 10, newTop));

    this.el.style.width = `${target.width}px`;
    this.el.style.height = `${target.height}px`;
    this.el.style.left = `${newLeft}px`;
    this.el.style.top = `${newTop}px`;
    this.el.style.right = 'auto';
    this.el.style.bottom = 'auto';

    this.btnSize.textContent = `📐 ${target.name}`;

    if (this.map) {
      setTimeout(() => this.map?.invalidateSize(), 50);
    }
    this.saveCustomLayout();
  }

  /**
   * 儲存自訂位置與大小至 localStorage
   */
  private saveCustomLayout(): void {
    if (this.isSplitMode || this.isFullscreen) return;
    try {
      const rect = this.el.getBoundingClientRect();
      const layout = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      };
      localStorage.setItem('gta_osm_map_layout', JSON.stringify(layout));
    } catch {}
  }

  /**
   * 恢復使用者先前設定的自訂位置與大小
   */
  private restoreCustomLayout(): boolean {
    if (this.isSplitMode || this.isFullscreen) return false;
    try {
      const saved = localStorage.getItem('gta_osm_map_layout');
      if (saved) {
        const layout = JSON.parse(saved);
        if (layout.width && layout.height && layout.left !== undefined && layout.top !== undefined) {
          const width = Math.max(260, Math.min(window.innerWidth - 20, layout.width));
          const height = Math.max(180, Math.min(window.innerHeight - 20, layout.height));
          const left = Math.max(10, Math.min(window.innerWidth - width - 10, layout.left));
          const top = Math.max(10, Math.min(window.innerHeight - height - 10, layout.top));

          this.el.style.width = `${width}px`;
          this.el.style.height = `${height}px`;
          this.el.style.left = `${left}px`;
          this.el.style.top = `${top}px`;
          this.el.style.right = 'auto';
          this.el.style.bottom = 'auto';
          return true;
        }
      }
    } catch {}
    return false;
  }

  /**
   * 雙擊重設為右下角預設位置與尺寸
   */
  public resetToDefaultPositionAndSize(): void {
    this.el.style.left = '';
    this.el.style.top = '';
    this.el.style.right = '20px';
    this.el.style.bottom = '20px';
    this.el.style.width = '380px';
    this.el.style.height = '250px';
    this.btnSize.textContent = '📐 尺寸';
    try {
      localStorage.removeItem('gta_osm_map_layout');
    } catch {}
    if (this.map) {
      setTimeout(() => this.map?.invalidateSize(), 50);
    }
  }

  /**
   * 初始化 Leaflet 地圖實例 (首次顯示時建構)
   */
  private initMap(lat: number = 24.828, lon: number = 121.772): void {
    if (this.isMapInitialized) return;

    this.map = L.map(this.mapContainer, {
      center: [lat, lon],
      zoom: CONFIG.MAP_REFERENCE.DEFAULT_ZOOM,
      zoomControl: true,
      attributionControl: true
    });

    // 1. OSM 街道地圖圖層
    this.osmLayer = L.tileLayer(CONFIG.MAP_REFERENCE.LAYERS.OSM.URL, {
      maxZoom: 19,
      attribution: CONFIG.MAP_REFERENCE.LAYERS.OSM.ATTRIBUTION
    });

    // 2. Esri 全球高解析衛星航照圖圖層 (完全免費、免金鑰)
    this.satelliteLayer = L.tileLayer(CONFIG.MAP_REFERENCE.LAYERS.SATELLITE.URL, {
      maxZoom: 19,
      attribution: CONFIG.MAP_REFERENCE.LAYERS.SATELLITE.ATTRIBUTION
    });

    // 預設加載街道圖
    this.osmLayer.addTo(this.map);

    // 3. 建立自訂玩家位置與視角視野錐標記
    const customIcon = L.divIcon({
      className: 'player-map-pin-container',
      html: `
        <div class="player-pin-wrapper">
          <div class="player-pin-cone" id="player-map-cone"></div>
          <div class="player-pin-dot"></div>
        </div>
      `,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });

    this.playerMarker = L.marker([lat, lon], {
      icon: customIcon,
      zIndexOffset: 1000
    }).addTo(this.map);

    this.markerConeEl = document.getElementById('player-map-cone');

    // 4. 點擊地圖任意地點觸發飛行前往
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.onLocationClickCallback?.(e.latlng.lat, e.latlng.lng);
    });

    this.isMapInitialized = true;
  }

  /**
   * 註冊點擊地圖前往事件
   */
  public onLocationClick(callback: (lat: number, lon: number) => void): void {
    this.onLocationClickCallback = callback;
  }

  /**
   * 在地圖上顯示目標地點標記圖釘 (波紋動效)
   */
  public showDestinationPin(lat: number, lon: number): void {
    if (!this.map) return;

    if (this.destMarker) {
      this.destMarker.setLatLng([lat, lon]);
    } else {
      const destIcon = L.divIcon({
        className: 'dest-map-pin-container',
        html: `
          <div class="dest-pin-pulse"></div>
          <div class="dest-pin-dot">🎯</div>
        `,
        iconSize: [32, 32],
        iconAnchor: [16, 16]
      });

      this.destMarker = L.marker([lat, lon], {
        icon: destIcon,
        zIndexOffset: 990
      }).addTo(this.map);
    }
  }

  /**
   * 移除地圖上的目標地點標記圖釘
   */
  public removeDestinationPin(): void {
    if (this.destMarker && this.map) {
      this.map.removeLayer(this.destMarker);
      this.destMarker = null;
    }
  }

  /**
   * 切換地圖圖層 (街道 ⇄ 衛星航照圖)
   */
  public toggleLayer(): void {
    if (!this.map || !this.osmLayer || !this.satelliteLayer) return;

    if (this.currentLayerType === 'osm') {
      this.map.removeLayer(this.osmLayer);
      this.satelliteLayer.addTo(this.map);
      this.currentLayerType = 'satellite';
      this.btnLayerToggle.textContent = '🗺️ 街道';
      this.titleEl.textContent = '🛰️ 實境衛星航照對照';
    } else {
      this.map.removeLayer(this.satelliteLayer);
      this.osmLayer.addTo(this.map);
      this.currentLayerType = 'osm';
      this.btnLayerToggle.textContent = '🛰️ 衛星';
      this.titleEl.textContent = '🗺️ 實境街道地圖對照';
    }
  }

  /**
   * 顯示地圖雷達視窗
   */
  public show(lat?: number, lon?: number): void {
    this.isVisible = true;
    this.el.classList.remove('hidden');

    this.restoreCustomLayout();

    if (!this.isMapInitialized) {
      this.initMap(lat, lon);
    }

    if (this.map) {
      setTimeout(() => {
        this.map!.invalidateSize();
        if (lat !== undefined && lon !== undefined) {
          this.map!.setView([lat, lon], this.map!.getZoom(), { animate: false });
        }
      }, 60);
      setTimeout(() => {
        this.map?.invalidateSize();
      }, 200);
    }
  }

  /**
   * 隱藏地圖雷達視窗
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
      this.inputManager.exitPointerLock();
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
    } else {
      this.el.classList.remove('split-mode');
      document.body.classList.remove('split-screen-active');
      this.btnSplit.textContent = '◫ 對照';
      this.btnSplit.classList.remove('active');
      this.restoreCustomLayout();
    }

    this.onSplitChangeCallback?.(this.isSplitMode);

    if (this.map) {
      setTimeout(() => {
        this.map!.invalidateSize();
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
      this.restoreCustomLayout();
    }

    if (this.map) {
      setTimeout(() => {
        this.map!.invalidateSize();
      }, 50);
    }
  }

  /**
   * 逐幀由遊戲迴圈呼叫：將玩家世界座標轉為經緯度，並同步地圖中心與朝向視野錐
   */
  public update(
    playerPos: THREE.Vector3,
    cameraYaw: number,
    projection: GeoProjection | null
  ): void {
    if (!this.isVisible || !this.map || !this.playerMarker || !projection) {
      return;
    }

    const now = performance.now();
    if (now - this.lastUpdateTime < CONFIG.MAP_REFERENCE.THROTTLE_INTERVAL_MS) {
      return;
    }
    this.lastUpdateTime = now;

    // 1. 座標轉換：遊戲世界公尺座標 ➔ 真實經緯度
    const geo = projection.unproject(playerPos.x, playerPos.z);

    // 2. 朝向計算：Three.js 相機 Yaw ➔ 真北 Heading (0~360度)
    const heading = ((-cameraYaw * 180 / Math.PI) % 360 + 360) % 360;

    // 3. 更新標記經緯度與地圖跟隨
    this.playerMarker.setLatLng([geo.lat, geo.lon]);

    // 4. 若玩家位移，平滑將地圖中心跟隨玩家
    const dLat = Math.abs(geo.lat - this.lastLat);
    const dLon = Math.abs(geo.lon - this.lastLon);
    if (dLat > 0.00002 || dLon > 0.00002) {
      this.map.panTo([geo.lat, geo.lon], { animate: false });
      this.lastLat = geo.lat;
      this.lastLon = geo.lon;
    }

    // 5. 即時旋轉視野錐
    if (Math.abs(heading - this.lastHeading) > 0.5) {
      if (!this.markerConeEl) {
        this.markerConeEl = document.getElementById('player-map-cone');
      }
      if (this.markerConeEl) {
        this.markerConeEl.style.transform = `rotate(${heading}deg)`;
      }
      this.lastHeading = heading;
    }
  }

  public onSplitChange(callback: (isSplit: boolean) => void): void {
    this.onSplitChangeCallback = callback;
  }

  public getIsVisible(): boolean {
    return this.isVisible;
  }

  public dispose(): void {
    this.hide();
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    if (this.el.parentElement) {
      this.el.parentElement.removeChild(this.el);
    }
  }
}
