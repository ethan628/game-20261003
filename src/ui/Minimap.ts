/**
 * Minimap.ts - GTA 風格 2D Canvas 自繪小地圖系統
 * 支援功能：
 * 1. 視窗在畫面上任意移動位置（標題列拖曳把手，邊界防呆，雙擊回歸原位）
 * 2. 視窗尺寸縮放（8方向/邊角拖曳縮放手把 + 📐 尺寸快捷預設切換）
 * 3. 視野放大縮小（➕/➖ 按鈕 + 滑鼠滾輪縮放半徑 80m~1000m + 即時比例尺數值標籤）
 * 4. 畫布內部自由平移視野（拖曳畫布移動地圖檢視周邊，附 🎯 置中回玩家按鈕）
 * 5. 鏡頭旋轉跟隨 / 正北朝上切換 (🧭)、N 鍵與 Tab 鍵連動、最近路名與版權聲明
 */

import { Point2D, RoadFeature } from '../geo/OsmTypes.ts';
import { CONFIG } from '../config.ts';
import { BlipManager } from './BlipManager.ts';
import { MapTileRenderer } from './MapTileRenderer.ts';
import { NavigationSystem } from '../systems/NavigationSystem.ts';
import { InputManager } from '../core/InputManager.ts';
import { PedestrianSystem } from '../systems/PedestrianSystem.ts';

export type MinimapSizePreset = 'normal' | 'compact' | 'large' | 'xlarge' | 'custom';

export class Minimap {
  private pedSystem: PedestrianSystem | null = null;
  private policeSystem: any = null;
  private container: HTMLElement;
  private headerBar: HTMLElement;
  private canvasBox: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private streetBadge: HTMLElement;
  private zoomBadge: HTMLElement;
  private panIndicator: HTMLElement;

  private btnZoomIn: HTMLElement;
  private btnZoomOut: HTMLElement;
  private btnRecenter: HTMLElement;
  private btnCompass: HTMLElement;
  private btnSize: HTMLElement;
  private btnFullscreen: HTMLElement;

  private blipManager: BlipManager;
  private tileRenderer: MapTileRenderer;
  private navSystem: NavigationSystem;
  private inputManager: InputManager;

  private currentSizePreset: MinimapSizePreset = 'normal';
  private viewRadiusMeters: number = CONFIG.MINIMAP.DEFAULT_RADIUS_METERS; // 預設 250m
  private followPlayerYaw: boolean = CONFIG.MINIMAP.FOLLOW_PLAYER_YAW; // 預設隨視角旋轉
  private isVisible: boolean = true;

  // 玩家與世界狀態
  private playerPos: Point2D = { x: 0, z: 0 };
  private cameraYaw: number = 0;
  private roads: RoadFeature[] = [];
  private currentRoadName: string = '未知街道';
  private lastDrawTimeMs: number = 0;

  // 自由平移視野狀態 (Pan View inside Minimap)
  private isFreePanning: boolean = false;
  private viewOffsetX: number = 0; // 相對玩家之世界偏移 (m)
  private viewOffsetZ: number = 0;
  private isCanvasDragging: boolean = false;
  private canvasDragStartX: number = 0;
  private canvasDragStartY: number = 0;
  private initialOffsetX: number = 0;
  private initialOffsetZ: number = 0;
  private hasCanvasMoved: boolean = false;

  // 視窗拖曳移動狀態 (Window Dragging on Screen)
  private isWindowDragging: boolean = false;
  private winDragStartX: number = 0;
  private winDragStartY: number = 0;
  private winInitialLeft: number = 0;
  private winInitialTop: number = 0;

  // 視窗縮放狀態 (Window Resizing)
  private isWindowResizing: boolean = false;
  private resizeDir: string = '';
  private resizeStartX: number = 0;
  private resizeStartY: number = 0;
  private resizeStartW: number = 0;
  private resizeStartH: number = 0;

  private zoomBadgeTimer: any = null;
  private onFullscreenClickCallback?: () => void;

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

    // 1. 建立 DOM 結構
    this.container = document.createElement('div');
    this.container.id = 'gta-minimap-container';
    this.container.className = 'gta-minimap-wrapper';

    this.container.innerHTML = `
      <div class="minimap-header-bar" id="mm-header-bar" title="按住拖曳移動視窗位置，雙擊恢復左下角預設位置">
        <div class="minimap-title-bar">
          <span class="mm-drag-handle">⠿</span>
          <span class="mm-title-text">地圖</span>
        </div>
        <div class="minimap-controls">
          <button id="btn-mm-zoom-in" class="mm-btn" title="放大視野 (+)">➕</button>
          <button id="btn-mm-zoom-out" class="mm-btn" title="縮小視野 (-)">➖</button>
          <button id="btn-mm-recenter" class="mm-btn hidden highlight" title="置中回玩家位置 (空白鍵)">🎯</button>
          <button id="btn-mm-compass" class="mm-btn" title="切換 視角跟隨 / 正北朝上">🧭</button>
          <button id="btn-mm-size" class="mm-btn" title="切換視窗大小 (N)">📐</button>
          <button id="btn-mm-fullscreen" class="mm-btn" title="全螢幕地圖 (Tab)">⛶</button>
        </div>
      </div>
      <div class="minimap-canvas-wrapper" id="mm-canvas-box" title="按住拖曳平移地圖，點擊全螢幕">
        <canvas id="gta-minimap-canvas"></canvas>
        <div class="mm-zoom-level-badge" id="mm-zoom-badge">${CONFIG.MINIMAP.DEFAULT_RADIUS_METERS}m</div>
        <div class="mm-pan-indicator hidden" id="mm-pan-indicator">自由視野</div>
      </div>
      <div class="minimap-street-badge" id="mm-street-name">
        <span class="street-pin-icon">📍</span>
        <span class="street-name-text">載入中...</span>
      </div>
      <div class="minimap-attribution">${CONFIG.MINIMAP.ATTRIBUTION}</div>
      <div class="mm-resize-handle mm-resize-br" data-dir="br" title="拖曳縮放地圖尺寸"></div>
      <div class="mm-resize-handle mm-resize-tr" data-dir="tr" title="拖曳縮放地圖尺寸"></div>
      <div class="mm-resize-handle mm-resize-r" data-dir="r"></div>
      <div class="mm-resize-handle mm-resize-b" data-dir="b"></div>
    `;

    document.body.appendChild(this.container);

    this.headerBar = this.container.querySelector('#mm-header-bar')!;
    this.canvasBox = this.container.querySelector('#mm-canvas-box')!;
    this.canvas = this.container.querySelector('#gta-minimap-canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.streetBadge = this.container.querySelector('#mm-street-name .street-name-text')!;
    this.zoomBadge = this.container.querySelector('#mm-zoom-badge')!;
    this.panIndicator = this.container.querySelector('#mm-pan-indicator')!;

    this.btnZoomIn = this.container.querySelector('#btn-mm-zoom-in')!;
    this.btnZoomOut = this.container.querySelector('#btn-mm-zoom-out')!;
    this.btnRecenter = this.container.querySelector('#btn-mm-recenter')!;
    this.btnCompass = this.container.querySelector('#btn-mm-compass')!;
    this.btnSize = this.container.querySelector('#btn-mm-size')!;
    this.btnFullscreen = this.container.querySelector('#btn-mm-fullscreen')!;

    // 2. 綁定按鈕與互動事件
    this.setupInteractions();

    // 3. 套用預設尺寸
    this.applySizePreset('normal');
  }

  private setupInteractions(): void {
    // 放大視野
    this.btnZoomIn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.zoomBy(0.75);
    });

    // 縮小視野
    this.btnZoomOut.addEventListener('click', (e) => {
      e.stopPropagation();
      this.zoomBy(1.33);
    });

    // 置中回玩家
    this.btnRecenter.addEventListener('click', (e) => {
      e.stopPropagation();
      this.recenter();
    });

    // 視角朝向切換
    this.btnCompass.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleCompassMode();
    });

    // 視窗尺寸切換按鈕 (N 鍵)
    this.btnSize.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cycleSizePreset();
    });

    // 全螢幕按鈕
    this.btnFullscreen.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onFullscreenClickCallback?.();
    });

    // 滑鼠滾輪縮放半徑 (80m ~ 1000m)
    this.container.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const zoomFactor = e.deltaY < 0 ? 0.85 : 1.18;
      this.zoomBy(zoomFactor);
    }, { passive: false });

    // 滑鼠游標進入小地圖時暫停遊戲按鍵移動
    this.container.addEventListener('mouseenter', () => {
      this.inputManager.suspendKeyboard();
    });
    this.container.addEventListener('mouseleave', () => {
      this.inputManager.resumeKeyboard();
    });

    // ==========================================
    // 視窗拖曳移動位置 (Window Position Dragging)
    // ==========================================
    this.headerBar.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;

      this.isWindowDragging = true;
      this.winDragStartX = e.clientX;
      this.winDragStartY = e.clientY;

      const rect = this.container.getBoundingClientRect();
      this.winInitialLeft = rect.left;
      this.winInitialTop = rect.top;

      this.container.style.left = `${rect.left}px`;
      this.container.style.top = `${rect.top}px`;
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
      this.container.classList.add('is-dragging-win');

      e.preventDefault();
      e.stopPropagation();
    });

    // 雙擊標題列重設至左下角預設位置
    this.headerBar.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.resetWindowPosition();
    });

    // ==========================================
    // 畫布內部地圖平移 (Pan Map View)
    // ==========================================
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.isCanvasDragging = true;
        this.canvasDragStartX = e.clientX;
        this.canvasDragStartY = e.clientY;
        this.initialOffsetX = this.viewOffsetX;
        this.initialOffsetZ = this.viewOffsetZ;
        this.hasCanvasMoved = false;
        this.canvasBox.classList.add('is-panning');
        e.preventDefault();
      }
    });

    // ==========================================
    // 視窗邊緣縮放手把 (Window Resizing)
    // ==========================================
    const handles = this.container.querySelectorAll('.mm-resize-handle');
    handles.forEach((h) => {
      h.addEventListener('mousedown', (e) => {
        const mouseEvent = e as MouseEvent;
        this.isWindowResizing = true;
        this.resizeDir = (h as HTMLElement).dataset.dir || 'br';
        this.resizeStartX = mouseEvent.clientX;
        this.resizeStartY = mouseEvent.clientY;
        this.resizeStartW = this.container.offsetWidth;
        this.resizeStartH = this.canvasBox.offsetHeight;
        mouseEvent.preventDefault();
        mouseEvent.stopPropagation();
      });
    });

    // 全域滑鼠移動處理 (視窗拖曳 / 畫布平移 / 視窗縮放)
    window.addEventListener('mousemove', (e) => {
      // 1. 移動視窗位置
      if (this.isWindowDragging) {
        const dx = e.clientX - this.winDragStartX;
        const dy = e.clientY - this.winDragStartY;
        const w = this.container.offsetWidth;
        const h = this.container.offsetHeight;
        const newX = Math.max(8, Math.min(window.innerWidth - w - 8, this.winInitialLeft + dx));
        const newY = Math.max(8, Math.min(window.innerHeight - h - 8, this.winInitialTop + dy));
        this.container.style.left = `${newX}px`;
        this.container.style.top = `${newY}px`;
        return;
      }

      // 2. 視窗縮放
      if (this.isWindowResizing) {
        const dx = e.clientX - this.resizeStartX;
        const dy = e.clientY - this.resizeStartY;
        let newW = this.resizeStartW;
        let newH = this.resizeStartH;

        if (this.resizeDir.includes('r')) newW += dx;
        if (this.resizeDir.includes('b')) newH += dy;
        if (this.resizeDir.includes('tr')) {
          newW += dx;
          newH -= dy;
        }

        const size = Math.max(160, Math.min(500, Math.round((newW + newH) * 0.5)));
        this.applyCustomSize(size, size);
        return;
      }

      // 3. 畫布內部地圖平移
      if (this.isCanvasDragging) {
        const dx = e.clientX - this.canvasDragStartX;
        const dy = e.clientY - this.canvasDragStartY;

        if (Math.hypot(dx, dy) > 4) {
          this.hasCanvasMoved = true;
          this.isFreePanning = true;
          this.btnRecenter.classList.remove('hidden');
          this.panIndicator.classList.remove('hidden');

          const dpr = window.devicePixelRatio || 1;
          const logicalW = this.canvas.width / dpr;
          const logicalH = this.canvas.height / dpr;
          const scale = (Math.min(logicalW, logicalH) * 0.5) / this.viewRadiusMeters;

          // 考慮相機旋轉角度換算為世界位移
          let wx = -dx / scale;
          let wz = -dy / scale;

          if (this.followPlayerYaw) {
            const cos = Math.cos(-this.cameraYaw);
            const sin = Math.sin(-this.cameraYaw);
            const rx = wx * cos - wz * sin;
            const rz = wx * sin + wz * cos;
            wx = rx;
            wz = rz;
          }

          this.viewOffsetX = this.initialOffsetX + wx;
          this.viewOffsetZ = this.initialOffsetZ + wz;
          this.render();
        }
      }
    });

    window.addEventListener('mouseup', () => {
      if (this.isWindowDragging) {
        this.isWindowDragging = false;
        this.container.classList.remove('is-dragging-win');
      }

      if (this.isWindowResizing) {
        this.isWindowResizing = false;
      }

      if (this.isCanvasDragging) {
        this.isCanvasDragging = false;
        this.canvasBox.classList.remove('is-panning');
        if (!this.hasCanvasMoved) {
          // 純點擊（未拖曳）：開啟全螢幕地圖
          this.onFullscreenClickCallback?.();
        }
      }
    });
  }

  /**
   * 縮放視野半徑 (放大 / 縮小)
   */
  public zoomBy(factor: number): void {
    const minR = CONFIG.MINIMAP.MIN_RADIUS_METERS;
    const maxR = CONFIG.MINIMAP.MAX_RADIUS_METERS;
    this.viewRadiusMeters = Math.max(minR, Math.min(maxR, Math.round(this.viewRadiusMeters * factor)));
    this.showZoomBadge();
    this.render();
  }

  private showZoomBadge(): void {
    if (this.zoomBadge) {
      this.zoomBadge.textContent = `${Math.round(this.viewRadiusMeters)}m`;
      this.zoomBadge.style.opacity = '1';
      clearTimeout(this.zoomBadgeTimer);
      this.zoomBadgeTimer = setTimeout(() => {
        if (this.zoomBadge) this.zoomBadge.style.opacity = '0.7';
      }, 1600);
    }
  }

  /**
   * 置中重設視野回玩家自身
   */
  public recenter(): void {
    this.viewOffsetX = 0;
    this.viewOffsetZ = 0;
    this.isFreePanning = false;
    this.btnRecenter.classList.add('hidden');
    this.panIndicator.classList.add('hidden');
    this.render();
  }

  /**
   * 重設視窗位置至左下角預設
   */
  public resetWindowPosition(): void {
    this.container.style.left = '24px';
    this.container.style.bottom = '24px';
    this.container.style.top = 'auto';
    this.container.style.right = 'auto';
  }

  /**
   * 設定道路清單用於即時路名檢索
   */
  public setRoads(roads: RoadFeature[]): void {
    this.roads = roads;
  }

  /**
   * 切換小地圖大小預設 (N 鍵觸發：標準 230px -> 大型 300px -> 特大 380px -> 精簡 170px)
   */
  public cycleSizePreset(): void {
    if (this.currentSizePreset === 'normal') {
      this.applySizePreset('large');
    } else if (this.currentSizePreset === 'large') {
      this.applySizePreset('xlarge');
    } else if (this.currentSizePreset === 'xlarge') {
      this.applySizePreset('compact');
    } else {
      this.applySizePreset('normal');
    }
  }

  public applySizePreset(preset: MinimapSizePreset): void {
    if (preset === 'custom') return;
    this.currentSizePreset = preset;
    const configSize = (CONFIG.MINIMAP.SIZES as any)[preset] || { width: 230, height: 230 };
    this.applyCustomSize(configSize.width, configSize.height);

    const labelMap: Record<string, string> = {
      normal: '📐 標準',
      compact: '📐 小',
      large: '📐 大',
      xlarge: '📐 特大'
    };
    this.btnSize.textContent = labelMap[preset] || '📐';
  }

  public applyCustomSize(width: number, height: number): void {
    const clampedW = Math.max(160, Math.min(500, Math.round(width)));
    const clampedH = Math.max(160, Math.min(500, Math.round(height)));

    this.container.style.width = `${clampedW}px`;
    this.canvasBox.style.width = `${clampedW}px`;
    this.canvasBox.style.height = `${clampedH}px`;

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(clampedW * dpr);
    this.canvas.height = Math.round(clampedH * dpr);
    this.canvas.style.width = `${clampedW}px`;
    this.canvas.style.height = `${clampedH}px`;

    this.btnSize.textContent = `${clampedW}px`;
    this.render();
  }

  /**
   * 切換視角跟隨 / 正北朝上
   */
  public toggleCompassMode(): void {
    this.followPlayerYaw = !this.followPlayerYaw;
    this.btnCompass.textContent = this.followPlayerYaw ? '🧭 視角' : '🧭 正北';
    this.render();
  }

  public onFullscreenClick(callback: () => void): void {
    this.onFullscreenClickCallback = callback;
  }

  /**
   * 逐幀由遊戲迴圈更新渲染小地圖
   */
  public update(playerPos: Point2D, cameraYaw: number): void {
    if (!this.isVisible) return;

    const tStart = performance.now();
    this.playerPos = playerPos;
    this.cameraYaw = cameraYaw;

    // 1. 計算視野中心點的世界座標
    const centerWorldX = this.isFreePanning ? this.playerPos.x + this.viewOffsetX : this.playerPos.x;
    const centerWorldZ = this.isFreePanning ? this.playerPos.z + this.viewOffsetZ : this.playerPos.z;

    // 2. 更新視野中心對應之最近路名
    this.updateNearestRoadName({ x: centerWorldX, z: centerWorldZ });

    // 3. 繪製小地圖畫面
    this.render();

    this.lastDrawTimeMs = performance.now() - tStart;
  }

  private updateNearestRoadName(pos: Point2D): void {
    if (this.roads.length === 0) return;

    let closestDist = Infinity;
    let closestName = '';

    for (const road of this.roads) {
      if (!road.name) continue;
      for (let i = 0; i < road.points.length - 1; i++) {
        const p1 = road.points[i];
        const p2 = road.points[i + 1];
        const d = this.distToSegment(pos, p1, p2);
        if (d < closestDist) {
          closestDist = d;
          closestName = road.name;
        }
      }
    }

    if (closestDist < 45 && closestName) {
      if (this.currentRoadName !== closestName) {
        this.currentRoadName = closestName;
        this.streetBadge.textContent = closestName;
      }
    } else {
      if (this.currentRoadName !== '開放街區') {
        this.currentRoadName = '開放街區';
        this.streetBadge.textContent = '開放街區';
      }
    }
  }

  private distToSegment(p: Point2D, v: Point2D, w: Point2D): number {
    const l2 = (w.x - v.x) ** 2 + (w.z - v.z) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.z - v.z);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.z - v.z) * (w.z - v.z)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.z - (v.z + t * (w.z - v.z)));
  }

  /**
   * 核心 Canvas 渲染 (目標 < 1 ms)
   */
  public render(): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return;

    const logicalW = w / dpr;
    const logicalH = h / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // 1. 建立剪裁區域 (圓角矩形或圓形)
    ctx.beginPath();
    const rBorder = CONFIG.MINIMAP.BORDER_RADIUS;
    if (CONFIG.MINIMAP.SHAPE === 'round') {
      const radius = Math.min(logicalW, logicalH) * 0.5 - 2;
      ctx.arc(logicalW * 0.5, logicalH * 0.5, radius, 0, Math.PI * 2);
    } else {
      ctx.roundRect(2, 2, logicalW - 4, logicalH - 4, rBorder);
    }
    ctx.clip();

    // 2. 底色填充
    ctx.fillStyle = CONFIG.MAP_PALETTE.background;
    ctx.fillRect(0, 0, logicalW, logicalH);

    const cx = logicalW * 0.5;
    const cy = logicalH * 0.5;
    const viewRadius = this.viewRadiusMeters;
    const scale = (Math.min(logicalW, logicalH) * 0.5) / viewRadius; // px / meter

    // 決定視野中心世界座標
    const centerWorldX = this.isFreePanning ? this.playerPos.x + this.viewOffsetX : this.playerPos.x;
    const centerWorldZ = this.isFreePanning ? this.playerPos.z + this.viewOffsetZ : this.playerPos.z;

    // 3. 靜態底圖圖塊快取拼貼 (drawImage)
    ctx.save();
    ctx.translate(cx, cy);

    // 若隨玩家鏡頭視角旋轉：地圖反向旋轉 cameraYaw，使玩家朝向永遠向上
    if (this.followPlayerYaw) {
      ctx.rotate(this.cameraYaw);
    }

    ctx.translate(-centerWorldX * scale, -centerWorldZ * scale);

    // 計算視野涵蓋之圖塊範圍
    const tileSize = this.tileRenderer.getTileSizeMeters();
    const minX = centerWorldX - viewRadius * 1.5;
    const maxX = centerWorldX + viewRadius * 1.5;
    const minZ = centerWorldZ - viewRadius * 1.5;
    const maxZ = centerWorldZ + viewRadius * 1.5;

    const minTX = Math.floor(minX / tileSize);
    const maxTX = Math.floor(maxX / tileSize);
    const minTZ = Math.floor(minZ / tileSize);
    const maxTZ = Math.floor(maxZ / tileSize);

    for (let tx = minTX; tx <= maxTX; tx++) {
      for (let tz = minTZ; tz <= maxTZ; tz++) {
        const tileCanvas = this.tileRenderer.getTile(tx, tz, 'high');
        const worldX = tx * tileSize;
        const worldZ = tz * tileSize;
        ctx.drawImage(
          tileCanvas,
          worldX * scale,
          worldZ * scale,
          tileSize * scale,
          tileSize * scale
        );
      }
    }

    // 4. 繪製導航路線 (若有導航)
    const route = this.navSystem.getCurrentRoute();
    if (route && route.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(route.points[0].x * scale, route.points[0].z * scale);
      for (let i = 1; i < route.points.length; i++) {
        ctx.lineTo(route.points[i].x * scale, route.points[i].z * scale);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 光暈底層
      ctx.lineWidth = Math.max(5, 7 * scale);
      ctx.strokeStyle = CONFIG.MAP_PALETTE.routeGlow;
      ctx.stroke();

      // 核心亮線
      ctx.lineWidth = Math.max(3, 4.5 * scale);
      ctx.strokeStyle = CONFIG.MAP_PALETTE.route;
      ctx.stroke();
    }

    ctx.restore(); // 恢復世界座標轉換

    // 4.5 繪製行人標記 (淡粉色小圓點，按 config 開關)
    if (CONFIG.PEDESTRIAN.SHOW_ON_MINIMAP && this.pedSystem) {
      this.renderPedestrians(ctx, cx, cy, logicalW, logicalH, scale, centerWorldX, centerWorldZ);
    }

    // 4.6 繪製警車標記 (藍紅交替閃爍圖示，按 config 開關)
    if (CONFIG.POLICE.SHOW_ON_MAP && this.policeSystem) {
      this.renderPoliceCars(ctx, cx, cy, logicalW, logicalH, scale, centerWorldX, centerWorldZ);
    }

    // 5. 繪製 POI 標記 (相對於 centerWorld)
    this.renderBlips(ctx, cx, cy, logicalW, logicalH, scale, centerWorldX, centerWorldZ);

    // 6. 繪製玩家標記 (若平移時玩家不在中心，正確計算相對位置或貼邊)
    this.renderPlayer(ctx, cx, cy, logicalW, logicalH, scale, centerWorldX, centerWorldZ);

    // 7. 繪製北方標記 (N)
    this.renderNorthIndicator(ctx, cx, cy, logicalW, logicalH);

    ctx.restore(); // 恢復剪裁
  }

  public setPedestrianSystem(pedSystem: PedestrianSystem): void {
    this.pedSystem = pedSystem;
  }

  public setPoliceSystem(policeSystem: any): void {
    this.policeSystem = policeSystem;
  }

  /**
   * 繪製警車標記 (藍紅交替閃爍圖示)
   */
  private renderPoliceCars(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
    scale: number,
    centerX: number,
    centerZ: number
  ): void {
    if (!this.policeSystem) return;
    const cars = this.policeSystem.getVehicles();
    const maxRadiusPx = Math.min(w, h) * 0.46;
    const isRed = Math.sin(performance.now() * 0.016) > 0;

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      if (!c.active) continue;

      const dx = c.x - centerX;
      const dz = c.z - centerZ;

      let screenX = dx;
      let screenY = dz;

      if (this.followPlayerYaw) {
        const cos = Math.cos(this.cameraYaw);
        const sin = Math.sin(this.cameraYaw);
        screenX = dx * cos - dz * sin;
        screenY = dx * sin + dz * cos;
      }

      screenX *= scale;
      screenY *= scale;

      const distFromCenter = Math.hypot(screenX, screenY);
      if (distFromCenter > maxRadiusPx) continue;

      const px = cx + screenX;
      const py = cy + screenY;

      // 繪製藍紅交替閃爍警車圓形圖標
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = isRed ? '#ef4444' : '#2563eb';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // 小 P 字標記
      ctx.font = 'bold 7px sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('P', px, py);
    }
  }

  /**
   * 繪製行人標記 (淡粉色圓點)
   */
  private renderPedestrians(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
    scale: number,
    centerX: number,
    centerZ: number
  ): void {
    if (!this.pedSystem) return;
    const agents = this.pedSystem.getActiveAgents();
    const maxRadiusPx = Math.min(w, h) * 0.46;

    ctx.fillStyle = 'rgba(244, 114, 182, 0.8)';

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.insideBuildingTimer > 0) continue;

      const dx = a.x - centerX;
      const dz = a.z - centerZ;

      let screenX = dx;
      let screenY = dz;

      if (this.followPlayerYaw) {
        const cos = Math.cos(this.cameraYaw);
        const sin = Math.sin(this.cameraYaw);
        screenX = dx * cos - dz * sin;
        screenY = dx * sin + dz * cos;
      }

      screenX *= scale;
      screenY *= scale;

      const distPx = Math.hypot(screenX, screenY);
      if (distPx < maxRadiusPx) {
        ctx.beginPath();
        ctx.arc(cx + screenX, cy + screenY, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * 繪製 POI 標記 (距離內正常繪製，超出距離且為目的地則貼在邊緣)
   */
  private renderBlips(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
    scale: number,
    centerX: number,
    centerZ: number
  ): void {
    const blips = this.blipManager.getMinimapBlips({ x: centerX, z: centerZ }, this.viewRadiusMeters);
    const maxRadiusPx = Math.min(w, h) * 0.46;

    for (const blip of blips) {
      const dx = blip.position.x - centerX;
      const dz = blip.position.z - centerZ;

      let screenX = dx;
      let screenY = dz;

      if (this.followPlayerYaw) {
        const cos = Math.cos(this.cameraYaw);
        const sin = Math.sin(this.cameraYaw);
        screenX = dx * cos - dz * sin;
        screenY = dx * sin + dz * cos;
      }

      screenX *= scale;
      screenY *= scale;

      const distPx = Math.hypot(screenX, screenY);
      const isOffscreen = distPx > maxRadiusPx - 10;

      if (!isOffscreen) {
        const sprite = this.blipManager.getIconSprite(blip.category, 20);
        ctx.drawImage(sprite, cx + screenX - 10, cy + screenY - 10, 20, 20);
      } else if (blip.category === 'destination') {
        const angle = Math.atan2(screenY, screenX);
        const clampDist = maxRadiusPx - 12;
        const clampX = cx + Math.cos(angle) * clampDist;
        const clampY = cy + Math.sin(angle) * clampDist;

        ctx.save();
        ctx.translate(clampX, clampY);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(-4, -5);
        ctx.lineTo(-4, 5);
        ctx.closePath();
        ctx.fillStyle = CONFIG.MAP_PALETTE.destination;
        ctx.fill();
        ctx.restore();

        const sprite = this.blipManager.getIconSprite('destination', 22);
        ctx.drawImage(sprite, clampX - 11, clampY - 11, 22, 22);
      }
    }
  }

  /**
   * 繪製玩家箭頭與視野扇形 (支援自由平移時偏移顯示)
   */
  private renderPlayer(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number,
    scale: number,
    centerX: number,
    centerZ: number
  ): void {
    const dx = this.playerPos.x - centerX;
    const dz = this.playerPos.z - centerZ;

    let screenX = dx;
    let screenY = dz;

    if (this.followPlayerYaw) {
      const cos = Math.cos(this.cameraYaw);
      const sin = Math.sin(this.cameraYaw);
      screenX = dx * cos - dz * sin;
      screenY = dx * sin + dz * cos;
    }

    screenX *= scale;
    screenY *= scale;

    const maxRadiusPx = Math.min(w, h) * 0.46;
    const distPx = Math.hypot(screenX, screenY);
    const isPlayerOffscreen = distPx > maxRadiusPx - 12;

    if (isPlayerOffscreen) {
      // 玩家超出小地圖視野：貼邊指示玩家位置
      const angle = Math.atan2(screenY, screenX);
      const clampDist = maxRadiusPx - 10;
      const clampX = cx + Math.cos(angle) * clampDist;
      const clampY = cy + Math.sin(angle) * clampDist;

      ctx.save();
      ctx.translate(clampX, clampY);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(8, 0);
      ctx.lineTo(-5, -5);
      ctx.lineTo(-5, 5);
      ctx.closePath();
      ctx.fillStyle = CONFIG.MAP_PALETTE.playerArrow;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
      return;
    }

    const drawX = cx + screenX;
    const drawY = cy + screenY;

    ctx.save();
    ctx.translate(drawX, drawY);

    const arrowAngle = this.followPlayerYaw ? -Math.PI * 0.5 : -this.cameraYaw - Math.PI * 0.5;
    ctx.rotate(arrowAngle);

    // 視野扇形 (FOV 約 55度)
    const fovHalf = 0.48;
    const fanRadius = 36;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, fanRadius, -fovHalf, fovHalf);
    ctx.closePath();
    ctx.fillStyle = CONFIG.MAP_PALETTE.playerCone;
    ctx.fill();

    // GTA 風格科技箭頭
    ctx.beginPath();
    ctx.moveTo(11, 0);       // 箭頭頂點
    ctx.lineTo(-7, -7);     // 左後翼
    ctx.lineTo(-3, 0);      // 凹陷腰身
    ctx.lineTo(-7, 7);      // 右後翼
    ctx.closePath();

    ctx.fillStyle = CONFIG.MAP_PALETTE.playerArrow;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.restore();
  }

  /**
   * 繪製邊緣北方標記 (N)
   */
  private renderNorthIndicator(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    w: number,
    h: number
  ): void {
    if (!CONFIG.MINIMAP.SHOW_NORTH_INDICATOR) return;

    const northAngle = this.followPlayerYaw ? this.cameraYaw - Math.PI * 0.5 : -Math.PI * 0.5;
    const r = Math.min(w, h) * 0.45;
    const nx = cx + Math.cos(northAngle) * r;
    const ny = cy + Math.sin(northAngle) * r;

    ctx.save();
    ctx.beginPath();
    ctx.arc(nx, ny, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
    ctx.stroke();

    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = CONFIG.MAP_PALETTE.northMark;
    ctx.fillText('N', nx, ny);
    ctx.restore();
  }

  public getDrawTimeMs(): number {
    return this.lastDrawTimeMs;
  }

  public setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.container.classList.toggle('hidden', !visible);
  }

  public getVisible(): boolean {
    return this.isVisible;
  }

  public dispose(): void {
    if (this.container.parentElement) {
      this.container.parentElement.removeChild(this.container);
    }
  }
}
