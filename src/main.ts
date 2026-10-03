/**
 * main.ts - 遊戲主程式進入點與子系統串接整合
 * 依據 RULES.md，遵循分層架構，協調渲染、輸入、地理、世界與實體
 */

import { CONFIG, PRESET_LOCATIONS } from './config.ts';
import { GameEngine } from './core/GameEngine.ts';
import { InputManager } from './core/InputManager.ts';
import { CameraController } from './core/CameraController.ts';
import { GameLoop } from './core/GameLoop.ts';
import { CollisionSystem } from './systems/CollisionSystem.ts';
import { WorldManager } from './world/WorldManager.ts';
import { OsmFetcher } from './geo/OsmFetcher.ts';
import { RoadFeature } from './geo/OsmTypes.ts';
import { GeoProjection } from './geo/Projection.ts';
import { Player } from './entities/Player.ts';
import { HUD } from './ui/HUD.ts';
import { LoadingOverlay } from './ui/LoadingOverlay.ts';
import { LocationModal } from './ui/LocationModal.ts';
import { MapReferenceWindow } from './ui/MapReferenceWindow.ts';
import { MapillaryService } from './geo/MapillaryService.ts';
import { StreetViewWindow } from './ui/StreetViewWindow.ts';
import { BuildingCollisionData } from './world/BuildingGenerator.ts';

class GameApp {
  private engine: GameEngine;
  private input: InputManager;
  private collisionSystem: CollisionSystem;
  private cameraController: CameraController;
  private worldManager: WorldManager;
  private osmFetcher: OsmFetcher;
  private player: Player;
  private gameLoop: GameLoop;

  private hud: HUD;
  private loadingOverlay: LoadingOverlay;
  private locationModal: LocationModal;
  private mapReferenceWindow: MapReferenceWindow;
  private mapillaryService: MapillaryService;
  private streetViewWindow: StreetViewWindow;

  private currentProjection: GeoProjection | null = null;
  private isLocationLoading = false;
  private currentLocationName: string = '宜蘭礁溪溫泉市區';

  constructor() {
    const canvasContainer = document.getElementById('game-canvas-container')!;

    // 1. 初始化底層引擎與輸入
    this.engine = new GameEngine(canvasContainer);
    this.input = new InputManager(canvasContainer);
    this.collisionSystem = new CollisionSystem();
    this.cameraController = new CameraController(
      this.engine.camera,
      this.input,
      this.collisionSystem
    );

    // 2. 初始化世界與實體
    this.worldManager = new WorldManager(this.engine.scene);
    this.osmFetcher = new OsmFetcher();
    this.player = new Player(this.engine.scene, this.input, this.collisionSystem);

    // 3. 初始化 UI
    this.hud = new HUD();
    this.loadingOverlay = new LoadingOverlay();
    this.locationModal = new LocationModal();
    this.mapReferenceWindow = new MapReferenceWindow(this.input);
    this.mapReferenceWindow.onSplitChange(() => {
      this.engine.resize();
    });

    this.mapillaryService = new MapillaryService();
    this.streetViewWindow = new StreetViewWindow(this.input, this.mapillaryService);
    this.streetViewWindow.onSplitChange(() => {
      this.engine.resize();
    });

    // 若未設定 Mapillary Token，依規定隱藏 HUD 街景提示按鈕
    if (!this.mapillaryService.hasToken()) {
      this.hud.setStreetViewAvailable(false);
    }

    // 4. 初始化遊戲主迴圈
    this.gameLoop = new GameLoop(
      this.update.bind(this),
      this.render.bind(this),
      (fps) => this.hud.updateFps(fps)
    );

    // 5. 綁定事件與回呼
    this.setupEvents();

    // 6. 啟動遊戲迴圈
    this.gameLoop.start();
    (window as any).__game = this;

    // 7. 啟動檢測：若 URL 帶有 ?auto=1，自動進入世界並設定視角
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('auto')) {
      const locId = urlParams.get('loc') || 'jiaoxi';
      const target = PRESET_LOCATIONS.find((p) => p.id === locId) || PRESET_LOCATIONS[0];
      this.loadLocation(target.lat, target.lon, target.name, target.presetFile).then(() => {
        if (urlParams.get('view') === 'aerial') {
          this.cameraController.setViewPreset('aerial');
        } else {
          this.cameraController.setViewPreset('street');
        }
      });
    } else {
      // 啟動時顯示選單，預設選項為「礁溪鄉」
      this.locationModal.show();
    }
  }

  private setupEvents(): void {
    // 按 M 鍵切換地點選擇選單
    this.input.onToggleMenu = () => {
      if (this.isLocationLoading) return;
      if (this.locationModal.isVisible()) {
        this.locationModal.hide();
        this.input.requestPointerLock();
      } else {
        this.input.exitPointerLock();
        this.locationModal.show();
      }
    };

    // HUD 上的選單按鈕
    this.hud.onMenuButtonClick(() => {
      this.input.exitPointerLock();
      this.locationModal.show();
    });

    // 按 G 鍵切換 Mapillary 實境街景視窗
    this.input.onToggleStreetView = () => {
      if (!this.mapillaryService.hasToken()) {
        this.hud.showNotification('📷 街景功能未啟用：請先於 .env 設定 VITE_MAPILLARY_TOKEN');
        console.info('[Mapillary] 未設定 VITE_MAPILLARY_TOKEN，無法開啟街景視窗。請至 https://www.mapillary.com/dashboard/developers 取得免費 Token。');
        return;
      }
      this.streetViewWindow.toggle();
    };

    // 按 H 鍵切換街景 50/50 左右對照模式
    this.input.onToggleSplitMode = () => {
      if (!this.mapillaryService.hasToken()) {
        this.hud.showNotification('📷 街景功能未啟用：請先於 .env 設定 VITE_MAPILLARY_TOKEN');
        console.info('[Mapillary] 未設定 VITE_MAPILLARY_TOKEN，無法切換對照模式。');
        return;
      }
      this.streetViewWindow.toggleSplitMode();
    };

    // 按 N 鍵切換 2D 實境地圖雷達視窗
    this.input.onToggleMinimap = () => {
      this.mapReferenceWindow.toggle();
    };

    // 按 F3 鍵切換店家招牌除錯視覺化標記 (綠色=牆面, 黃色=立柱, 紅色=失敗)
    this.input.onToggleSignboardDebug = () => {
      const isVisible = this.worldManager.toggleSignboardDebug();
      const stats = this.worldManager.getSignboardStats();
      this.hud.showNotification(
        isVisible
          ? `🔍 招牌除錯標記開啟 (綠色=牆面, 黃色=立柱) [總數: ${stats?.generatedMeshes || 0}]`
          : '🔍 招牌除錯標記已關閉'
      );
    };

    // 按 F4 鍵或點擊 HUD 清除 IndexedDB 快取並重新抓取
    this.input.onClearCacheAndReload = async () => {
      this.hud.showNotification('🧹 正在清除本地 IndexedDB 快取並重新載入...');
      await this.osmFetcher.clearCache();
      if (this.currentProjection) {
        const orig = this.currentProjection.getOrigin();
        this.loadLocation(orig.lat, orig.lon, this.currentLocationName);
      }
    };

    // 按 F5 鍵切換建築輪廓線框 (綠色=已生成, 黃色=丟棄, 紅色=失敗)
    this.input.onToggleBuildingDebug = () => {
      const isVisible = this.worldManager.toggleBuildingDebug();
      const stats = this.worldManager.getBuildingStats();
      this.hud.showNotification(
        isVisible
          ? `🏢 建築輪廓線框開啟 (綠=已生成, 黃=丟棄, 紅=失敗) [總數: ${stats?.inSceneMeshes || 0}]`
          : '🏢 建築輪廓線框已關閉'
      );
    };

    // 點擊 HUD 快捷按鈕
    document.getElementById('btn-toggle-streetview')?.addEventListener('click', () => {
      if (!this.mapillaryService.hasToken()) {
        this.hud.showNotification('📷 街景功能未啟用：請先於 .env 設定 VITE_MAPILLARY_TOKEN');
        return;
      }
      this.streetViewWindow.toggle();
    });
    document.getElementById('btn-toggle-split')?.addEventListener('click', () => {
      if (!this.mapillaryService.hasToken()) {
        this.hud.showNotification('📷 街景功能未啟用：請先於 .env 設定 VITE_MAPILLARY_TOKEN');
        return;
      }
      this.streetViewWindow.toggleSplitMode();
    });
    document.getElementById('btn-toggle-map')?.addEventListener('click', () => {
      this.mapReferenceWindow.toggle();
    });
    this.hud.onSignboardDebugClick(() => {
      this.input.onToggleSignboardDebug?.();
    });
    this.hud.onClearCacheClick(() => {
      this.input.onClearCacheAndReload?.();
    });
    this.hud.onBuildingDebugClick(() => {
      this.input.onToggleBuildingDebug?.();
    });

    // 地點選擇確認事件
    this.locationModal.onSelectLocation((lat, lon, name, presetFile) => {
      this.loadLocation(lat, lon, name, presetFile);
    });

    // 點擊實境地圖任意地點：飛躍前往該地點
    this.mapReferenceWindow.onLocationClick((lat, lon) => {
      if (!this.currentProjection || this.isLocationLoading) return;

      const targetPt = this.currentProjection.project(lat, lon);
      const distFromOrigin = Math.hypot(targetPt.x, targetPt.z);

      // 若點擊位置在當前生成地圖半徑內（約 1100m 範圍）
      if (distFromOrigin > 1100) {
        this.hud.showNotification('⚠️ 點擊位置超出目前地圖載入範圍，按 M 鍵可切換地點');
        return;
      }

      // 檢查若點擊在建築物內部，微調至建築物外緣
      const safePt = this.adjustTargetPointIfInsideBuilding(targetPt.x, targetPt.z);

      // 顯示地圖目標圖釘與飛行通知
      this.mapReferenceWindow.showDestinationPin(lat, lon);
      this.hud.showNotification('✈️ 正在飛往標記地點...');

      // 執行玩家弧形高空飛行
      this.player.flyTo(safePt.x, safePt.z, () => {
        this.hud.showNotification('🛬 已抵達標記地點！');
        setTimeout(() => {
          this.mapReferenceWindow.removeDestinationPin();
        }, 1200);
      });
    });
  }

  /**
   * 載入指定地點之真實 OSM 世界
   */
  public async loadLocation(lat: number, lon: number, name: string, presetFile?: string): Promise<void> {
    if (this.isLocationLoading) return;
    this.isLocationLoading = true;

    this.input.exitPointerLock();
    this.locationModal.hide();
    this.loadingOverlay.show(`載入世界：${name}`, '正在取得周邊真實地理資料...');

    try {
      const data = await this.osmFetcher.fetchWorldData(
        lat,
        lon,
        name,
        (msg) => {
          this.loadingOverlay.updateMessage(`載入世界：${name}`, msg);
        },
        presetFile
      );

      // 建立投影器
      this.currentProjection = new GeoProjection(lat, lon);
      this.currentLocationName = name;

      // 清空舊世界並建構新世界
      this.worldManager.clear();
      await this.worldManager.buildWorld(data);

      // 更新 HUD 招牌即時數據
      const signboardStats = this.worldManager.getSignboardStats();
      if (signboardStats) {
        this.hud.updateSignboardStats(signboardStats);
      }

      // 更新 HUD 建築管線數據
      const bldgStats = this.worldManager.getBuildingStats();
      if (bldgStats) {
        const nearby = this.worldManager.getNearbyBuildingsCount(this.player.position, 100);
        this.hud.updateBuildingStats({
          total: bldgStats.polygonFormed,
          nearby,
          vertices: bldgStats.totalVertices,
          discarded: bldgStats.discarded.total
        });
      }

      // 計算安全重生點（道路/人行道上，避免卡在建物內）
      const spawn = this.findSafeSpawn(this.worldManager.getBuildingColliders(), data.roads);
      this.player.teleport(spawn.x, 0, spawn.z);

      // 重設鏡頭
      this.cameraController.reset(0, CONFIG.CAMERA.DEFAULT_PITCH);

      // 更新 HUD 地點資訊
      this.hud.setLocationName(name);

      // 右下角常駐顯示實境地圖雷達（開箱即用）
      this.mapReferenceWindow.show(lat, lon);

      // 若街景視窗開啟中，同步更新街景位置
      if (this.streetViewWindow.getIsVisible()) {
        this.streetViewWindow.updateLocation(lat, lon, 0, true);
      }

      // 完成載入
      this.loadingOverlay.hide();
      this.isLocationLoading = false;

      // 提示點擊畫面鎖定視角
      console.log(`[GameApp] 成功載入地點: ${name} (${lat}, ${lon})`);
    } catch (err: any) {
      console.error('[GameApp] 載入地點失敗', err);
      this.isLocationLoading = false;

      this.loadingOverlay.showError(
        err.message || '連線逾時或網路錯誤，請稍後重試。',
        () => {
          // 重試
          this.loadLocation(lat, lon, name);
        },
        () => {
          // 更換地點
          this.loadingOverlay.hide();
          this.locationModal.show();
        },
        async () => {
          // 載入展示街區 (離線備援)
          const fallbackData = this.osmFetcher.getProceduralFallback(lat, lon, name);
          this.currentProjection = new GeoProjection(lat, lon);
          this.worldManager.clear();
          await this.worldManager.buildWorld(fallbackData);
          const fallbackStats = this.worldManager.getSignboardStats();
          if (fallbackStats) {
            this.hud.updateSignboardStats(fallbackStats);
          }
          const fallbackBldgStats = this.worldManager.getBuildingStats();
          if (fallbackBldgStats) {
            this.hud.updateBuildingStats({
              total: fallbackBldgStats.polygonFormed,
              nearby: this.worldManager.getNearbyBuildingsCount(this.player.position, 100),
              vertices: fallbackBldgStats.totalVertices,
              discarded: fallbackBldgStats.discarded.total
            });
          }
          const spawn = this.findSafeSpawn(this.worldManager.getBuildingColliders(), fallbackData.roads);
          this.player.teleport(spawn.x, 0, spawn.z);
          this.cameraController.reset(0, CONFIG.CAMERA.DEFAULT_PITCH);
          this.hud.setLocationName(`${name} (展示備援)`);
          this.mapReferenceWindow.show(lat, lon);
          if (this.streetViewWindow.getIsVisible()) {
            this.streetViewWindow.updateLocation(lat, lon, 0, true);
          }
          this.loadingOverlay.hide();
        }
      );
    }
  }

  /**
   * 檢查點擊座標是否位於建築物內部，若是則安全推至建築外緣
   */
  private adjustTargetPointIfInsideBuilding(x: number, z: number): { x: number; z: number } {
    const colliders = this.worldManager.getBuildingColliders();
    for (const b of colliders) {
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) {
        const distLeft = Math.abs(x - b.minX);
        const distRight = Math.abs(x - b.maxX);
        const distTop = Math.abs(z - b.minZ);
        const distBottom = Math.abs(z - b.maxZ);
        const minDist = Math.min(distLeft, distRight, distTop, distBottom);

        if (minDist === distLeft) return { x: b.minX - 1.5, z };
        if (minDist === distRight) return { x: b.maxX + 1.5, z };
        if (minDist === distTop) return { x, z: b.minZ - 1.5 };
        return { x, z: b.maxZ + 1.5 };
      }
    }
    return { x, z };
  }

  /**
   * 尋找靠近世界中心且在道路/人行道上之安全初始重生點（不卡在建築物內）
   */
  private findSafeSpawn(colliders: BuildingCollisionData[], roads?: RoadFeature[]): { x: number; z: number } {
    if (roads && roads.length > 0) {
      let bestPt: { x: number; z: number } | null = null;
      let minDist = Infinity;

      for (const road of roads) {
        for (const pt of road.points) {
          const d = Math.hypot(pt.x, pt.z);
          if (d < minDist && d < 150) {
            let inside = false;
            for (const b of colliders) {
              if (
                pt.x >= b.minX - 0.5 &&
                pt.x <= b.maxX + 0.5 &&
                pt.z >= b.minZ - 0.5 &&
                pt.z <= b.maxZ + 0.5
              ) {
                inside = true;
                break;
              }
            }
            if (!inside) {
              minDist = d;
              bestPt = { x: pt.x, z: pt.z };
            }
          }
        }
      }

      if (bestPt) {
        return bestPt;
      }
    }

    const candidates = [
      { x: 0, z: 0 },
      { x: 5, z: 5 },
      { x: -5, z: -5 },
      { x: 10, z: 0 },
      { x: 0, z: 10 },
      { x: -10, z: 0 },
      { x: 0, z: -10 },
      { x: 15, z: 15 },
      { x: -15, z: 15 },
      { x: 20, z: -20 }
    ];

    for (const cand of candidates) {
      let inside = false;
      for (const b of colliders) {
        if (
          cand.x >= b.minX - 0.5 &&
          cand.x <= b.maxX + 0.5 &&
          cand.z >= b.minZ - 0.5 &&
          cand.z <= b.maxZ + 0.5
        ) {
          inside = true;
          break;
        }
      }
      if (!inside) {
        return cand;
      }
    }

    return { x: 0, z: 0 };
  }

  /**
   * 固定時間步長更新邏輯 (60Hz)
   */
  private update(fixedDelta: number): void {
    const colliders = this.worldManager.getBuildingColliders();
    const cameraYaw = this.cameraController.getYaw();

    // 更新玩家移動與物理碰撞
    this.player.update(fixedDelta, cameraYaw, colliders);

    // 逐幀更新環境：動態太陽陰影追隨玩家位置
    this.worldManager.updateEnvironment(this.player.position);

    // 更新鏡頭平滑跟隨與防穿牆射線檢測
    const buildingsMesh = this.worldManager.getBuildingsMesh();
    this.cameraController.update(this.player.position, buildingsMesh, fixedDelta);

    // 更新 HUD 座標顯示
    if (this.currentProjection) {
      const px = this.player.position.x;
      const pz = this.player.position.z;
      const real = this.currentProjection.unproject(px, pz);
      this.hud.updateCoordinates(px, pz, real.lat, real.lon);
    }

    // 同步 Mapillary 實境街景視窗（位置與真北朝向）
    this.streetViewWindow.update(this.player.position, cameraYaw, this.currentProjection);

    // 同步實境地圖對照視窗（位置與朝向視野錐）
    this.mapReferenceWindow.update(this.player.position, cameraYaw, this.currentProjection);

    // 逐幀計算相機視野錐 (Frustum) 內之招牌可見數量並更新 HUD
    this.worldManager.updateSignboardsFrustum(this.engine.camera);
    const sbStats = this.worldManager.getSignboardStats();
    if (sbStats) {
      this.hud.updateSignboardStats(sbStats);
    }

    // 更新 HUD 建築管線統計 (含 100m 內建物數)
    const bldgStats = this.worldManager.getBuildingStats();
    if (bldgStats) {
      const nearby = this.worldManager.getNearbyBuildingsCount(this.player.position, 100);
      this.hud.updateBuildingStats({
        total: bldgStats.polygonFormed,
        nearby,
        vertices: bldgStats.totalVertices,
        discarded: bldgStats.discarded.total
      });
    }
  }

  /**
   * 畫面渲染迴圈
   */
  private render(_alpha: number): void {
    this.engine.render();

    // 更新 Draw Calls 與三角形統計
    const renderStats = this.engine.getRenderInfo();
    this.hud.updateRenderStats(renderStats.calls, renderStats.triangles);
  }
}

// 啟動遊戲應用程式 (確保在 DOM ready 狀態下立即建構，避免 DOMContentLoaded 遺漏事件)
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    new GameApp();
  });
} else {
  new GameApp();
}
