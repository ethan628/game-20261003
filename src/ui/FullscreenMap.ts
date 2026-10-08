/**
 * FullscreenMap.ts - GTA 風格全螢幕導航與互動地圖系統 (Tab 鍵開關)
 * 支援平移拖曳、以滑鼠為中心之滾輪縮放、POI 分類篩選、即時搜尋店家與路名跳轉、
 * 點擊設定/清除導航目的地、文字碰撞避讓、右鍵連動實境街景與圖例面板
 */

import { Point2D, RoadFeature, ShopFeature } from '../geo/OsmTypes.ts';
import { CONFIG } from '../config.ts';
import { BlipManager, BlipCategory } from './BlipManager.ts';
import { MapTileRenderer } from './MapTileRenderer.ts';
import { NavigationSystem, NavigationRoute } from '../systems/NavigationSystem.ts';
import { InputManager } from '../core/InputManager.ts';
import { GeoProjection } from '../geo/Projection.ts';

export class FullscreenMap {
  private modal: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private searchInput: HTMLInputElement;
  private searchResultsEl: HTMLElement;
  private categoryListEl: HTMLElement;
  private navInfoCard: HTMLElement;
  private contextMenuEl: HTMLElement;

  private blipManager: BlipManager;
  private tileRenderer: MapTileRenderer;
  private navSystem: NavigationSystem;
  private inputManager: InputManager;
  private policeSystem: any = null;

  private isOpen = false;
  private playerPos: Point2D = { x: 0, z: 0 };
  private cameraYaw: number = 0;
  private projection: GeoProjection | null = null;
  private roads: RoadFeature[] = [];
  private shops: ShopFeature[] = [];

  // 視圖狀態 (世界座標與縮放倍率)
  private viewCenterX: number = 0;
  private viewCenterZ: number = 0;
  private scale: number = CONFIG.FULLSCREEN_MAP.DEFAULT_SCALE; // px / meter

  // 拖曳平移
  private isDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartCenterX = 0;
  private dragStartCenterZ = 0;

  // 右鍵點擊快顯選單
  private contextMenuTarget: Point2D | null = null;

  // 搜尋跳轉高亮
  private highlightTarget: Point2D | null = null;
  private highlightTimer: any = null;

  private onOpenStreetViewCallback?: (lat: number, lon: number) => void;
  private onDestinationChangeCallback?: (pos: Point2D | null, route: NavigationRoute | null) => void;
  private onFlyToCallback?: (x: number, z: number) => void;

  constructor(
    blipManager: BlipManager,
    tileRenderer: MapTileRenderer,
    navSystem: NavigationSystem,
    inputManager: InputManager
  ) {
    this.blipManager = blipManager;
    this.tileRenderer = tileRenderer;
    this.navSystem = navSystem;
    this.inputManager = inputManager;

    // 1. 建立全螢幕 Modal DOM
    this.modal = document.createElement('div');
    this.modal.id = 'gta-fullscreen-map-modal';
    this.modal.className = 'gta-fullscreen-map-wrapper hidden';

    this.modal.innerHTML = `
      <!-- 左側搜尋與圖例篩選面板 -->
      <div class="fs-map-sidebar">
        <div class="fs-sidebar-header">
          <div class="fs-sidebar-title">
            <span class="fs-title-icon">🗺️</span>
            <span>全螢幕導航地圖</span>
          </div>
          <button id="btn-fs-map-close" class="fs-close-btn" title="關閉全螢幕地圖 (Tab / Esc)">&times;</button>
        </div>

        <!-- 搜尋欄 -->
        <div class="fs-search-box">
          <input type="text" id="fs-search-input" placeholder="🔍 搜尋店名或道路..." autocomplete="off" />
          <div class="fs-search-results hidden" id="fs-search-results"></div>
        </div>

        <!-- 導航資訊卡片 -->
        <div class="fs-nav-card hidden" id="fs-nav-card">
          <div class="fs-nav-header">
            <span class="fs-nav-flag">🎯</span>
            <span class="fs-nav-title" id="fs-nav-title">導航目標</span>
          </div>
          <div class="fs-nav-stats">
            <div class="fs-stat-item">
              <span class="fs-stat-label">路線距離</span>
              <span class="fs-stat-val" id="fs-nav-distance">0 m</span>
            </div>
            <div class="fs-stat-item">
              <span class="fs-stat-label">預估時間</span>
              <span class="fs-stat-val" id="fs-nav-time">--</span>
            </div>
          </div>
          <button id="btn-clear-nav" class="fs-nav-clear-btn">❌ 取消導航路線</button>
        </div>

        <!-- 標記類別篩選 -->
        <div class="fs-category-section">
          <div class="fs-section-title">
            <span>標記分類篩選</span>
            <button id="btn-toggle-all-categories" class="fs-text-btn">全選/清除</button>
          </div>
          <div class="fs-category-list" id="fs-category-list"></div>
        </div>

        <!-- 圖例 -->
        <div class="fs-legend-section">
          <div class="fs-section-title">地圖圖例說明</div>
          <div class="fs-legend-grid">
            <div class="fs-legend-item"><span class="legend-dot" style="background:#38bdf8;"></span> 玩家目前位置</div>
            <div class="fs-legend-item"><span class="legend-dot" style="background:#f43f5e;"></span> 導航目的地</div>
            <div class="fs-legend-item"><span class="legend-line" style="background:#94a3b8;"></span> 主要幹道 / 省道</div>
            <div class="fs-legend-item"><span class="legend-line" style="background:#334155;"></span> 一般市區道路</div>
            <div class="fs-legend-item"><span class="legend-line dashed" style="background:#64748b;"></span> 鐵路軌道</div>
          </div>
        </div>
      </div>

      <!-- 核心地圖畫布 -->
      <div class="fs-map-canvas-container">
        <canvas id="fs-map-canvas"></canvas>

        <!-- 右下角浮動工具列 -->
        <div class="fs-map-tools">
          <button id="btn-fs-recenter" class="fs-tool-btn" title="重設視圖置中至玩家">📍 玩家中心</button>
          <button id="btn-fs-zoom-in" class="fs-tool-btn" title="放大 (+)">＋</button>
          <button id="btn-fs-zoom-out" class="fs-tool-btn" title="縮小 (-)">－</button>
        </div>

        <!-- 浮動右鍵選單 -->
        <div class="fs-context-menu hidden" id="fs-context-menu">
          <div class="fs-menu-item" id="fs-menu-set-dest">🎯 設為導航目的地</div>
          <div class="fs-menu-item" id="fs-menu-fly-to">✈️ 飛躍前往此處</div>
          <div class="fs-menu-item" id="fs-menu-streetview">📷 在此開啟實境街景 (G)</div>
        </div>

        <!-- OSM 官方版權聲明 -->
        <div class="fs-map-attribution">${CONFIG.FULLSCREEN_MAP.ATTRIBUTION}</div>
      </div>
    `;

    document.body.appendChild(this.modal);

    this.canvas = this.modal.querySelector('#fs-map-canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.searchInput = this.modal.querySelector('#fs-search-input')!;
    this.searchResultsEl = this.modal.querySelector('#fs-search-results')!;
    this.categoryListEl = this.modal.querySelector('#fs-category-list')!;
    this.navInfoCard = this.modal.querySelector('#fs-nav-card')!;
    this.contextMenuEl = this.modal.querySelector('#fs-context-menu')!;

    // 2. 設置事件監聽
    this.setupInteractions();
    this.buildCategoryCheckboxes();
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
  }

  private resizeCanvas(): void {
    const container = this.modal.querySelector('.fs-map-canvas-container') as HTMLElement;
    const w = container && container.clientWidth > 0 ? container.clientWidth : (window.innerWidth - 320);
    const h = container && container.clientHeight > 0 ? container.clientHeight : window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.isOpen) {
      this.render();
    }
  }

  private setupInteractions(): void {
    // 關閉按鈕
    this.modal.querySelector('#btn-fs-map-close')?.addEventListener('click', () => {
      this.hide();
    });

    // 取消導航按鈕
    this.modal.querySelector('#btn-clear-nav')?.addEventListener('click', () => {
      this.clearDestination();
    });

    // 置中回玩家
    this.modal.querySelector('#btn-fs-recenter')?.addEventListener('click', () => {
      this.viewCenterX = this.playerPos.x;
      this.viewCenterZ = this.playerPos.z;
      this.render();
    });

    // 放大 / 縮小按鈕
    this.modal.querySelector('#btn-fs-zoom-in')?.addEventListener('click', () => {
      const rect = this.canvas.getBoundingClientRect();
      this.zoomAtScreenPoint(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5, 1.3);
    });
    this.modal.querySelector('#btn-fs-zoom-out')?.addEventListener('click', () => {
      const rect = this.canvas.getBoundingClientRect();
      this.zoomAtScreenPoint(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5, 0.77);
    });

    // 全選 / 清除類別勾選
    this.modal.querySelector('#btn-toggle-all-categories')?.addEventListener('click', () => {
      const cats = this.blipManager.getAllCategories();
      const allVisible = cats.every((c) => this.blipManager.isCategoryVisible(c.id));
      for (const c of cats) {
        this.blipManager.setCategoryVisible(c.id, !allVisible);
      }
      this.buildCategoryCheckboxes();
      this.render();
    });

    // 搜尋輸入即時過濾
    this.searchInput.addEventListener('input', () => {
      this.handleSearch(this.searchInput.value.trim());
    });
    this.searchInput.addEventListener('focus', () => {
      if (this.searchInput.value.trim()) {
        this.searchResultsEl.classList.remove('hidden');
      }
    });

    // 拖曳地圖平移
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        // 左鍵拖曳
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartCenterX = this.viewCenterX;
        this.dragStartCenterZ = this.viewCenterZ;
        this.hideContextMenu();
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isOpen) return;
      if (this.isDragging) {
        const dx = (e.clientX - this.dragStartX) / this.scale;
        const dz = (e.clientY - this.dragStartY) / this.scale;
        this.viewCenterX = this.dragStartCenterX - dx;
        this.viewCenterZ = this.dragStartCenterZ - dz;
        this.render();
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // 以滑鼠游標為中心進行滾輪縮放
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.18 : 0.85;
      this.zoomAtScreenPoint(e.clientX, e.clientY, zoomFactor);
    }, { passive: false });

    // 點擊地圖設定目的地 (左鍵單擊)
    this.canvas.addEventListener('click', (e) => {
      if (Math.hypot(e.clientX - this.dragStartX, e.clientY - this.dragStartY) > 5) {
        return; // 屬於拖曳，非單擊
      }
      this.hideContextMenu();

      // 螢幕座標轉世界座標
      const worldPt = this.screenToWorld(e.clientX, e.clientY);

      // 若點擊在現有目的地附近 (15m內)，則取消目的地
      const currentDest = this.blipManager.getDestination();
      if (currentDest && Math.hypot(worldPt.x - currentDest.position.x, worldPt.z - currentDest.position.z) < 15) {
        this.clearDestination();
      } else {
        this.setDestination(worldPt, '導航目的地');
      }
    });

    // 右鍵開啟上下文選單
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const worldPt = this.screenToWorld(e.clientX, e.clientY);
      this.contextMenuTarget = worldPt;

      this.contextMenuEl.style.left = `${e.clientX}px`;
      this.contextMenuEl.style.top = `${e.clientY}px`;
      this.contextMenuEl.classList.remove('hidden');
    });

    // 右鍵選單項目點擊
    this.modal.querySelector('#fs-menu-set-dest')?.addEventListener('click', () => {
      if (this.contextMenuTarget) {
        this.setDestination(this.contextMenuTarget, '導航目的地');
      }
      this.hideContextMenu();
    });

    this.modal.querySelector('#fs-menu-fly-to')?.addEventListener('click', () => {
      if (this.contextMenuTarget) {
        this.onFlyToCallback?.(this.contextMenuTarget.x, this.contextMenuTarget.z);
        this.hide();
      }
      this.hideContextMenu();
    });

    this.modal.querySelector('#fs-menu-streetview')?.addEventListener('click', () => {
      if (this.contextMenuTarget && this.projection) {
        const geo = this.projection.unproject(this.contextMenuTarget.x, this.contextMenuTarget.z);
        this.onOpenStreetViewCallback?.(geo.lat, geo.lon);
      }
      this.hideContextMenu();
    });

    // 點擊空白處隱藏選單
    this.modal.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('#fs-context-menu')) {
        this.hideContextMenu();
      }
      if (!(e.target as HTMLElement).closest('.fs-search-box')) {
        this.searchResultsEl.classList.add('hidden');
      }
    });

    // 按 Delete 鍵取消目的地
    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.code === 'Delete' || e.code === 'Backspace') {
        if (document.activeElement !== this.searchInput) {
          this.clearDestination();
        }
      } else if (e.code === 'Escape') {
        this.hide();
      }
    });
  }

  private hideContextMenu(): void {
    this.contextMenuEl.classList.add('hidden');
  }

  private zoomAtScreenPoint(screenX: number, screenY: number, factor: number): void {
    const oldScale = this.scale;
    const newScale = Math.max(
      CONFIG.FULLSCREEN_MAP.MIN_SCALE,
      Math.min(CONFIG.FULLSCREEN_MAP.MAX_SCALE, oldScale * factor)
    );
    if (newScale === oldScale) return;

    // 保持滑鼠指針下的世界座標不變
    const worldBefore = this.screenToWorld(screenX, screenY);
    this.scale = newScale;
    const worldAfter = this.screenToWorld(screenX, screenY);

    this.viewCenterX += worldBefore.x - worldAfter.x;
    this.viewCenterZ += worldBefore.z - worldAfter.z;
    this.render();
  }

  private screenToWorld(sx: number, sy: number): Point2D {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width * 0.5;
    const cy = rect.height * 0.5;
    const canvasX = sx - rect.left;
    const canvasY = sy - rect.top;
    return {
      x: this.viewCenterX + (canvasX - cx) / this.scale,
      z: this.viewCenterZ + (canvasY - cy) / this.scale
    };
  }

  private worldToScreen(wx: number, wz: number): { x: number; y: number } {
    const dpr = window.devicePixelRatio || 1;
    const cx = (this.canvas.width / dpr) * 0.5;
    const cy = (this.canvas.height / dpr) * 0.5;
    return {
      x: cx + (wx - this.viewCenterX) * this.scale,
      y: cy + (wz - this.viewCenterZ) * this.scale
    };
  }

  /**
   * 設定導航目的地並即時計算路線
   */
  public async setDestination(pos: Point2D, label: string = '導航目標'): Promise<void> {
    this.blipManager.setDestination(pos, label);

    // 計算 A* 路線
    const route = await this.navSystem.findRoute(this.playerPos, pos);
    this.updateNavCard(route, label);
    this.onDestinationChangeCallback?.(pos, route);
    this.render();
  }

  public clearDestination(): void {
    this.blipManager.setDestination(null);
    this.navSystem.clearRoute();
    this.navInfoCard.classList.add('hidden');
    this.onDestinationChangeCallback?.(null, null);
    this.render();
  }

  private updateNavCard(route: any, label: string): void {
    if (!route) {
      this.navInfoCard.classList.remove('hidden');
      (this.modal.querySelector('#fs-nav-title') as HTMLElement).textContent = label;
      (this.modal.querySelector('#fs-nav-distance') as HTMLElement).textContent = '無法連通路網';
      (this.modal.querySelector('#fs-nav-time') as HTMLElement).textContent = '--';
      return;
    }

    this.navInfoCard.classList.remove('hidden');
    (this.modal.querySelector('#fs-nav-title') as HTMLElement).textContent = label;

    const distMeters = route.totalDistanceMeters;
    const distText = distMeters >= 1000 ? `${(distMeters / 1000).toFixed(1)} km` : `${distMeters} m`;
    (this.modal.querySelector('#fs-nav-distance') as HTMLElement).textContent = distText;

    const walkMin = Math.max(1, Math.round(route.estimatedWalkTimeSec / 60));
    const driveSec = route.estimatedDriveTimeSec;
    const driveText = driveSec >= 60 ? `${Math.round(driveSec / 60)} 分鐘` : `${driveSec} 秒`;
    (this.modal.querySelector('#fs-nav-time') as HTMLElement).textContent = `步行 ${walkMin} 分 | 車行 ${driveText}`;
  }

  /**
   * 搜尋處理
   */
  private handleSearch(keyword: string): void {
    if (!keyword) {
      this.searchResultsEl.classList.add('hidden');
      return;
    }

    const lower = keyword.toLowerCase();
    const results: { name: string; category: string; pos: Point2D }[] = [];

    // 搜尋店家
    for (const shop of this.shops) {
      if (shop.name && shop.name.toLowerCase().includes(lower)) {
        results.push({ name: shop.name, category: shop.subCategory || '店家', pos: shop.point });
        if (results.length >= 8) break;
      }
    }

    // 搜尋道路
    if (results.length < 8) {
      const addedRoads = new Set<string>();
      for (const road of this.roads) {
        if (road.name && road.name.toLowerCase().includes(lower) && !addedRoads.has(road.name)) {
          addedRoads.add(road.name);
          const midPt = road.points[Math.floor(road.points.length / 2)];
          results.push({ name: road.name, category: '道路', pos: midPt });
          if (results.length >= 8) break;
        }
      }
    }

    if (results.length === 0) {
      this.searchResultsEl.innerHTML = `<div class="fs-search-empty">找不到符合的店家或道路</div>`;
      this.searchResultsEl.classList.remove('hidden');
      return;
    }

    this.searchResultsEl.innerHTML = results
      .map(
        (r, idx) => `
        <div class="fs-search-item" data-idx="${idx}">
          <span class="fs-item-name">${r.name}</span>
          <span class="fs-item-cat">${r.category}</span>
        </div>
      `
      )
      .join('');

    this.searchResultsEl.querySelectorAll('.fs-search-item').forEach((itemEl, idx) => {
      itemEl.addEventListener('click', () => {
        const target = results[idx];
        this.jumpTo(target.pos.x, target.pos.z, target.name);
        this.searchResultsEl.classList.add('hidden');
      });
    });

    this.searchResultsEl.classList.remove('hidden');
  }

  /**
   * 平滑跳轉至指定座標並加上焦點脈衝
   */
  public jumpTo(x: number, z: number, label?: string): void {
    this.viewCenterX = x;
    this.viewCenterZ = z;
    this.scale = Math.max(1.2, this.scale);
    this.highlightTarget = { x, z };

    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlightTarget = null;
      this.render();
    }, 3500);

    if (label) {
      this.setDestination({ x, z }, label);
    } else {
      this.render();
    }
  }

  private buildCategoryCheckboxes(): void {
    const cats = this.blipManager.getAllCategories();
    this.categoryListEl.innerHTML = cats
      .map((c) => {
        const isChecked = this.blipManager.isCategoryVisible(c.id);
        return `
          <label class="fs-cat-checkbox-item">
            <input type="checkbox" data-cat="${c.id}" ${isChecked ? 'checked' : ''} />
            <span class="fs-cat-dot" style="background:${c.color};"></span>
            <span class="fs-cat-label">${c.name}</span>
          </label>
        `;
      })
      .join('');

    this.categoryListEl.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', (e) => {
        const cat = (e.target as HTMLElement).getAttribute('data-cat') as BlipCategory;
        const checked = (e.target as HTMLInputElement).checked;
        this.blipManager.setCategoryVisible(cat, checked);
        this.render();
      });
    });
  }

  public setData(
    roads: RoadFeature[],
    shops: ShopFeature[],
    projection: GeoProjection | null
  ): void {
    this.roads = roads;
    this.shops = shops;
    this.projection = projection;
  }

  public show(): void {
    this.isOpen = true;
    this.modal.classList.remove('hidden');
    this.inputManager.suspendKeyboard();
    this.inputManager.exitPointerLock();

    // 初始居中在玩家座標
    this.viewCenterX = this.playerPos.x;
    this.viewCenterZ = this.playerPos.z;

    this.resizeCanvas();
    this.render();
  }

  public hide(): void {
    this.isOpen = false;
    this.modal.classList.add('hidden');
    this.hideContextMenu();
    this.inputManager.resumeKeyboard();
  }

  public toggle(): void {
    if (this.isOpen) {
      this.hide();
    } else {
      this.show();
    }
  }

  public getIsOpen(): boolean {
    return this.isOpen;
  }

  public updatePlayer(pos: Point2D, cameraYaw: number): void {
    this.playerPos = pos;
    this.cameraYaw = cameraYaw;
    if (this.isOpen) {
      this.render();
    }
  }

  /**
   * 核心全螢幕地圖繪製 (底圖圖塊拼貼 + 導航線 + POI 標記 + 文字避讓 + 玩家標記)
   */
  public render(): void {
    if (!this.isOpen) return;

    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. 底圖填充
    ctx.fillStyle = CONFIG.MAP_PALETTE.background;
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const scale = this.scale;

    // 2. 靜態底圖圖塊快取拼貼
    ctx.save();
    ctx.translate(cx - this.viewCenterX * scale, cy - this.viewCenterZ * scale);

    const tileSize = this.tileRenderer.getTileSizeMeters();
    const halfSpanX = (w * 0.5) / scale;
    const halfSpanZ = (h * 0.5) / scale;

    const minTX = Math.floor((this.viewCenterX - halfSpanX) / tileSize);
    const maxTX = Math.floor((this.viewCenterX + halfSpanX) / tileSize);
    const minTZ = Math.floor((this.viewCenterZ - halfSpanZ) / tileSize);
    const maxTZ = Math.floor((this.viewCenterZ + halfSpanZ) / tileSize);

    const lod = scale >= 0.6 ? 'high' : 'low';

    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let tz = minTZ; tz <= maxTZ; tz++) {
        const tileCanvas = this.tileRenderer.getTile(tx, tz, lod);
        ctx.drawImage(
          tileCanvas,
          tx * tileSize * scale,
          tz * tileSize * scale,
          tileSize * scale,
          tileSize * scale
        );
      }
    }

    // 3. 繪製導航路線
    const route = this.navSystem.getCurrentRoute();
    if (route && route.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(route.points[0].x * scale, route.points[0].z * scale);
      for (let i = 1; i < route.points.length; i++) {
        ctx.lineTo(route.points[i].x * scale, route.points[i].z * scale);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.lineWidth = Math.max(6, 8 * scale);
      ctx.strokeStyle = CONFIG.MAP_PALETTE.routeGlow;
      ctx.stroke();

      ctx.lineWidth = Math.max(3.5, 5 * scale);
      ctx.strokeStyle = CONFIG.MAP_PALETTE.route;
      ctx.stroke();
    }

    // 4. 繪製道路名稱 (縮放較近時顯示)
    if (scale >= 0.8) {
      this.renderRoadNames(ctx, scale);
    }

    ctx.restore(); // 恢復螢幕轉換

    // 5. 繪製 POI 標記與文字標籤 (含貪婪碰撞避讓)
    this.renderBlipsWithLabels(ctx);

    // 6. 搜尋跳轉高亮脈衝光圈
    if (this.highlightTarget) {
      const hp = this.worldToScreen(this.highlightTarget.x, this.highlightTarget.z);
      ctx.save();
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 28, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#38bdf8';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hp.x, hp.y, 42, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.4)';
      ctx.stroke();
      ctx.restore();
    }

    // 6.5 繪製警車標記 (藍紅交替閃爍)
    if (CONFIG.POLICE.SHOW_ON_MAP && this.policeSystem) {
      this.renderPoliceCars(ctx);
    }

    // 7. 繪製玩家目前位置圖釘與視角錐
    this.renderPlayerMarker(ctx);

    ctx.restore();
  }

  public setPoliceSystem(sys: any): void {
    this.policeSystem = sys;
  }

  /**
   * 繪製警車標記 (全螢幕地圖藍紅交替閃爍圖示)
   */
  private renderPoliceCars(ctx: CanvasRenderingContext2D): void {
    if (!this.policeSystem) return;
    const cars = this.policeSystem.getVehicles();
    const isRed = Math.sin(performance.now() * 0.016) > 0;

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active) continue;

      const sp = this.worldToScreen(c.x, c.z);
      const dpr = window.devicePixelRatio || 1;
      const cw = this.canvas.width / dpr;
      const ch = this.canvas.height / dpr;

      if (sp.x < -20 || sp.x > cw + 20 || sp.y < -20 || sp.y > ch + 20) {
        continue;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = isRed ? '#ef4444' : '#2563eb';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.font = 'bold 9px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('POL', sp.x, sp.y);
      ctx.restore();
    }
  }

  /**
   * 繪製道路名稱
   */
  private renderRoadNames(ctx: CanvasRenderingContext2D, scale: number): void {
    ctx.font = `bold ${Math.max(10, Math.min(13, Math.round(11 * scale)))}px sans-serif`;
    ctx.fillStyle = '#cbd5e1';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const drawnRoads = new Set<string>();

    for (const road of this.roads) {
      if (!road.name || road.points.length < 2 || drawnRoads.has(road.name)) continue;

      const p1 = road.points[0];
      const p2 = road.points[road.points.length - 1];
      const mid = road.points[Math.floor(road.points.length / 2)];

      // 檢查是否在視窗內
      const dpr = window.devicePixelRatio || 1;
      const cw = this.canvas.width / dpr;
      const ch = this.canvas.height / dpr;
      const sp = this.worldToScreen(mid.x, mid.z);
      if (sp.x < -100 || sp.x > cw + 100 || sp.y < -100 || sp.y > ch + 100) {
        continue;
      }

      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      let angle = Math.atan2(dz, dx);
      if (angle > Math.PI * 0.5 || angle < -Math.PI * 0.5) {
        angle += Math.PI; // 避免文字倒懸
      }

      ctx.save();
      ctx.translate(mid.x * scale, mid.z * scale);
      ctx.rotate(angle);

      // 文字陰影光暈
      ctx.shadowColor = 'rgba(15, 23, 42, 0.9)';
      ctx.shadowBlur = 4;
      ctx.fillText(road.name, 0, -4);
      ctx.restore();

      drawnRoads.add(road.name);
    }
  }

  /**
   * 繪製 POI 標記並進行文字標籤無碰撞排版
   */
  private renderBlipsWithLabels(ctx: CanvasRenderingContext2D): void {
    const allBlips = this.blipManager.getAllBlips();
    const occupiedBoxes: { left: number; top: number; right: number; bottom: number }[] = [];

    const isBoxColliding = (b: { left: number; top: number; right: number; bottom: number }) => {
      for (const o of occupiedBoxes) {
        if (!(b.right < o.left || b.left > o.right || b.bottom < o.top || b.top > o.bottom)) {
          return true;
        }
      }
      return false;
    };

    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';

    for (const blip of allBlips) {
      if (!blip.visible || !this.blipManager.isCategoryVisible(blip.category)) continue;

      const sp = this.worldToScreen(blip.position.x, blip.position.z);
      // 視野裁切
      const dpr = window.devicePixelRatio || 1;
      const cw = this.canvas.width / dpr;
      const ch = this.canvas.height / dpr;
      if (sp.x < -30 || sp.x > cw + 30 || sp.y < -30 || sp.y > ch + 30) {
        continue;
      }

      // 繪製圖示 Sprite
      const spriteSize = blip.category === 'destination' ? 26 : 22;
      const sprite = this.blipManager.getIconSprite(blip.category, spriteSize);
      ctx.drawImage(sprite, sp.x - spriteSize * 0.5, sp.y - spriteSize * 0.5, spriteSize, spriteSize);

      // 較近縮放時 (scale >= 0.7) 顯示文字標籤
      if (this.scale >= 0.7 && blip.label) {
        const textWidth = ctx.measureText(blip.label).width;
        const box = {
          left: sp.x + 14,
          top: sp.y - 8,
          right: sp.x + 14 + textWidth + 8,
          bottom: sp.y + 10
        };

        if (!isBoxColliding(box)) {
          occupiedBoxes.push(box);

          // 標籤背景底框
          ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.beginPath();
          ctx.roundRect(box.left, box.top, textWidth + 8, 18, 4);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.lineWidth = 1;
          ctx.stroke();

          // 標籤文字
          ctx.fillStyle = '#f1f5f9';
          ctx.textAlign = 'left';
          ctx.fillText(blip.label, box.left + 4, sp.y + 1);
        }
      }
    }
  }

  /**
   * 繪製玩家自身標記與視角朝向錐
   */
  private renderPlayerMarker(ctx: CanvasRenderingContext2D): void {
    const sp = this.worldToScreen(this.playerPos.x, this.playerPos.z);

    ctx.save();
    ctx.translate(sp.x, sp.y);

    // 視野錐 (朝向 cameraYaw)
    // 遊戲中 cameraYaw = 0 為 -Z (北向)
    const angle = -this.cameraYaw - Math.PI * 0.5;
    ctx.rotate(angle);

    const fovHalf = 0.52;
    const fanLen = 42;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, fanLen, -fovHalf, fovHalf);
    ctx.closePath();
    ctx.fillStyle = CONFIG.MAP_PALETTE.playerCone;
    ctx.fill();

    // 玩家本體標記 (青色雙重光環與中心圓)
    ctx.beginPath();
    ctx.arc(0, 0, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = CONFIG.MAP_PALETTE.playerArrow;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    // 前端指針
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(6, -4);
    ctx.lineTo(6, 4);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.restore();
  }

  public onOpenStreetView(callback: (lat: number, lon: number) => void): void {
    this.onOpenStreetViewCallback = callback;
  }

  public onDestinationChange(callback: (pos: Point2D | null, route: NavigationRoute | null) => void): void {
    this.onDestinationChangeCallback = callback;
  }

  public onFlyTo(callback: (x: number, z: number) => void): void {
    this.onFlyToCallback = callback;
  }

  public dispose(): void {
    if (this.modal.parentElement) {
      this.modal.parentElement.removeChild(this.modal);
    }
  }
}
