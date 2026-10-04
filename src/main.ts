/**
 * main.ts - 遊戲主程式進入點與子系統串接整合
 * 依據 RULES.md，遵循分層架構，協調渲染、輸入、地理、世界與實體
 */

import * as THREE from 'three';
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
import { BlipManager } from './ui/BlipManager.ts';
import { MapTileRenderer } from './ui/MapTileRenderer.ts';
import { NavigationSystem } from './systems/NavigationSystem.ts';
import { NavigationGuide3D } from './world/NavigationGuide3D.ts';
import { Minimap } from './ui/Minimap.ts';
import { FullscreenMap } from './ui/FullscreenMap.ts';
import { MapillaryService } from './geo/MapillaryService.ts';
import { StreetViewWindow } from './ui/StreetViewWindow.ts';
import { BuildingCollisionData } from './world/BuildingGenerator.ts';
import { BuildingInspectorModal } from './ui/BuildingInspectorModal.ts';
import { BuildingInferenceService } from './geo/BuildingInferenceService.ts';
import { BuildingGeometryUtils } from './geo/BuildingGeometryUtils.ts';
import { PedestrianSystem } from './systems/PedestrianSystem.ts';
import { PedestrianRenderer } from './world/PedestrianRenderer.ts';
import { PedestrianDebugVisualizer } from './world/PedestrianDebugVisualizer.ts';
import { PedestrianNetworkBuilder } from './geo/PedestrianNetworkBuilder.ts';
import { PedestrianNetworkData } from './geo/PedestrianTypes.ts';
import { TrafficSignalSystem } from './systems/traffic-signals/TrafficSignalSystem.ts';
import { TrafficSignalRenderer } from './world/TrafficSignalRenderer.ts';
import { TrafficSignalDebugVisualizer } from './world/TrafficSignalDebugVisualizer.ts';

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
  private blipManager: BlipManager;
  private tileRenderer: MapTileRenderer;
  private navSystem: NavigationSystem;
  private navGuide3D: NavigationGuide3D;
  private minimap: Minimap;
  private fullscreenMap: FullscreenMap;
  private mapillaryService: MapillaryService;
  private streetViewWindow: StreetViewWindow;
  private buildingInspectorModal: BuildingInspectorModal;
  private pedestrianSystem: PedestrianSystem;
  private pedestrianRenderer: PedestrianRenderer;
  private pedestrianDebug: PedestrianDebugVisualizer;
  private trafficSignalSystem: TrafficSignalSystem;
  private trafficSignalRenderer: TrafficSignalRenderer;
  private trafficSignalDebug: TrafficSignalDebugVisualizer;

  private isInspectorMode = false;
  private raycaster = new THREE.Raycaster();
  private mouseVec = new THREE.Vector2();

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
    this.blipManager = new BlipManager();
    this.tileRenderer = new MapTileRenderer();
    this.navSystem = new NavigationSystem();
    this.navGuide3D = new NavigationGuide3D(this.engine.scene);
    this.minimap = new Minimap(this.blipManager, this.tileRenderer, this.navSystem, this.input);
    this.fullscreenMap = new FullscreenMap(this.blipManager, this.tileRenderer, this.navSystem, this.input);

    this.pedestrianSystem = new PedestrianSystem();
    this.pedestrianRenderer = new PedestrianRenderer(this.engine.scene);
    this.pedestrianDebug = new PedestrianDebugVisualizer(this.engine.scene);
    this.minimap.setPedestrianSystem(this.pedestrianSystem);

    this.trafficSignalSystem = new TrafficSignalSystem();
    this.trafficSignalRenderer = new TrafficSignalRenderer(this.engine.scene);
    this.trafficSignalDebug = new TrafficSignalDebugVisualizer(this.engine.scene);
    this.pedestrianSystem.setTrafficSignalSystem(this.trafficSignalSystem);

    this.mapillaryService = new MapillaryService();
    this.streetViewWindow = new StreetViewWindow(this.input, this.mapillaryService);
    this.streetViewWindow.onSplitChange(() => {
      this.engine.resize();
    });

    this.buildingInspectorModal = new BuildingInspectorModal();

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
    (window as any).THREE = THREE;

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

    // 按 Tab 鍵切換全螢幕導航地圖
    this.input.onToggleFullscreenMap = () => {
      this.fullscreenMap.toggle();
    };

    // 按 N 鍵切換小地圖大小
    this.input.onToggleMinimap = () => {
      this.minimap.cycleSizePreset();
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

    // 按 F6 鍵切換建築檢視校正模式 (開發者模式)
    const handleToggleInspector = () => {
      this.isInspectorMode = !this.isInspectorMode;
      if (this.isInspectorMode) {
        this.input.exitPointerLock();
        this.hud.showNotification('🎯 建築檢視校正模式已開啟 (點擊任意建築查看/編輯資料，按 F6 關閉)');
      } else {
        this.buildingInspectorModal.hide();
        this.hud.showNotification('🎯 建築檢視校正模式已關閉');
      }
    };
    this.input.onToggleBuildingInspector = handleToggleInspector;
    this.hud.onBuildingInspectorClick(handleToggleInspector);

    // 點擊畫面檢視建築 (當處於 F6 模式時)
    this.engine.renderer.domElement.addEventListener('click', (e: MouseEvent) => {
      if (!this.isInspectorMode) return;
      if (this.buildingInspectorModal.getIsVisible()) {
        const modalEl = document.getElementById('building-inspector-modal');
        if (modalEl && modalEl.contains(e.target as Node)) {
          return;
        }
      }

      const rect = this.engine.renderer.domElement.getBoundingClientRect();
      this.mouseVec.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouseVec.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.mouseVec, this.engine.camera);
      const buildingsMesh = this.worldManager.getBuildingsMesh();
      if (!buildingsMesh) return;

      const intersects = this.raycaster.intersectObject(buildingsMesh);
      if (intersects.length > 0) {
        const hit = intersects[0].point;
        const list = this.worldManager.getBuildingsList();
        let targetBldg = list.find((b) => BuildingGeometryUtils.pointInPolygon({ x: hit.x, z: hit.z }, b.footprint));

        if (!targetBldg) {
          let minD = Infinity;
          for (const b of list) {
            const d = Math.hypot(b.center.x - hit.x, b.center.z - hit.z);
            if (d < minD && d < 30.0) {
              minD = d;
              targetBldg = b;
            }
          }
        }

        if (targetBldg) {
          this.buildingInspectorModal.show(targetBldg);
          this.hud.showNotification(`🏢 選取建築：${targetBldg.name || targetBldg.id} (${targetBldg.levels}層, ${targetBldg.height}m)`);
        }
      }
    });

    // 建築校正即時預覽與儲存回呼
    this.buildingInspectorModal.onLivePreview = (updatedBldg) => {
      const list = this.worldManager.getBuildingsList();
      const idx = list.findIndex((b) => b.id === updatedBldg.id);
      if (idx !== -1) {
        list[idx] = updatedBldg;
        this.worldManager.rebuildBuildings([...list]);
      }
    };

    this.buildingInspectorModal.onSaveOverride = (updatedBldg) => {
      this.hud.showNotification(`💾 已儲存校正：${updatedBldg.name || updatedBldg.id} (${updatedBldg.levels}層)`);
    };

    // 按 F7 鍵切換 3D 浮動樓層數字標籤
    this.input.onToggleFloorLabels = () => {
      const isVisible = this.worldManager.toggleFloorLabels();
      this.hud.showNotification(
        isVisible ? '🏷️ 3D 浮動樓層數字標籤已開啟 (依資料來源顏色區分)' : '🏷️ 3D 浮動樓層數字標籤已關閉'
      );
    };
    this.hud.onFloorLabelsClick(() => {
      this.input.onToggleFloorLabels?.();
    });

    // 按 F8 鍵切換行人路網與狀態除錯視覺化
    const handleTogglePedDebug = () => {
      const isVisible = this.pedestrianDebug.toggle();
      this.hud.showNotification(
        isVisible ? '🚶 行人除錯開啟 (青=人行道, 黃=騎樓, 綠/紅=過街, 菱形=狀態)' : '🚶 行人除錯已關閉'
      );
    };
    this.input.onTogglePedestrianDebug = handleTogglePedDebug;
    this.hud.onPedestrianDebugClick(handleTogglePedDebug);

    // 按 F9 鍵切換交通號誌除錯視覺化 (綠色=OSM, 橘色=自動補齊, 白色=停止線)
    const handleToggleSignalDebug = () => {
      const isVisible = this.trafficSignalDebug.toggle();
      const stats = this.trafficSignalSystem.getStats({ x: this.player.position.x, z: this.player.position.z });
      this.hud.showNotification(
        isVisible
          ? `🚦 交通號誌除錯開啟 (綠=OSM, 橘=Auto, 白=停止線) [號誌路口: ${stats.signalizedCount}]`
          : '🚦 交通號誌除錯已關閉'
      );
    };
    this.input.onToggleTrafficSignalDebug = handleToggleSignalDebug;
    this.hud.onTrafficSignalDebugClick(handleToggleSignalDebug);

    // 匯出待校正推測建築清單 JSON
    this.hud.onExportEstimatedClick(() => {
      if (!this.currentProjection) return;
      const buildings = this.worldManager.getBuildingsList();
      const currentData = this.worldManager.getCurrentData();
      const roads = currentData?.roads || [];
      const jsonStr = BuildingInferenceService.generateEstimatedListJson(
        buildings,
        roads,
        (x, z) => this.currentProjection!.unproject(x, z)
      );
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jiaoxi_estimated_buildings.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this.hud.showNotification('📥 已匯出待校正推測建築清單：jiaoxi_estimated_buildings.json');
    });

    // 按 R 鍵切換濕潤路面 (雨後微光反光模式)
    const handleToggleWet = () => {
      const isWet = this.worldManager.toggleWetMode();
      this.hud.setWetModeActive(isWet);
      this.hud.showNotification(
        isWet ? '🌧️ 濕潤路面模式開啟 (反光增強、積水微光)' : '☀️ 晴天乾燥路面模式'
      );
    };
    this.input.onToggleWetMode = handleToggleWet;
    this.hud.onWetModeClick(handleToggleWet);

    // 按 T 鍵切換夜間霓虹氛圍
    const handleToggleNight = () => {
      const isNight = this.worldManager.toggleNightMode();
      this.trafficSignalSystem.setNightMode(isNight);
      this.hud.setNightModeActive(isNight);
      this.hud.showNotification(
        isNight ? '🌙 夜間霓虹模式開啟 (店家招牌 Bloom 增強、暖黃街燈、次要路口閃黃閃紅)' : '🌅 黃昏魔幻時刻 (黃金夕陽角度 24°)'
      );
    };
    this.input.onToggleNightMode = handleToggleNight;
    this.hud.onNightModeClick(handleToggleNight);

    // 點擊畫質切換按鈕 [高 / 中 / 低]
    this.hud.onQualityClick(() => {
      const nextQuality = this.engine.postProcessing.cycleQuality();
      const labels: Record<string, string> = { high: '高', medium: '中', low: '低' };
      this.hud.setQualityText(labels[nextQuality] || '高');
      this.hud.showNotification(`🎨 後處理畫質切換為：${labels[nextQuality] || nextQuality}`);
    });

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
    document.getElementById('btn-toggle-fullscreen-map')?.addEventListener('click', () => {
      this.fullscreenMap.toggle();
    });
    document.getElementById('btn-toggle-map')?.addEventListener('click', () => {
      this.minimap.cycleSizePreset();
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

    // 小地圖點擊全螢幕
    this.minimap.onFullscreenClick(() => {
      this.fullscreenMap.show();
    });

    // 全螢幕地圖連動實境街景
    this.fullscreenMap.onOpenStreetView((lat, lon) => {
      if (this.mapillaryService.hasToken()) {
        this.streetViewWindow.show(lat, lon);
      } else {
        this.hud.showNotification('📷 街景功能未啟用：請先於 .env 設定 VITE_MAPILLARY_TOKEN');
      }
    });

    // 全螢幕地圖目的地變更時更新導航引導線
    this.fullscreenMap.onDestinationChange((pos, route) => {
      if (pos && route) {
        this.navGuide3D.setRoute(route.points);
        this.hud.showNotification(`🎯 導航設定：${this.blipManager.getDestination()?.label || '目標地點'} (距離: ${route.totalDistanceMeters}m)`);
      } else {
        this.navGuide3D.clear();
      }
    });

    // 全螢幕地圖「飛躍前往此處」
    this.fullscreenMap.onFlyTo((x, z) => {
      const safePt = this.adjustTargetPointIfInsideBuilding(x, z);
      this.hud.showNotification('✈️ 正在飛往標記地點...');
      this.player.flyTo(safePt.x, safePt.z, () => {
        this.hud.showNotification('🛬 已抵達標記地點！');
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
          discarded: bldgStats.discarded.total,
          sourceStats: bldgStats.sourceStats
        });
      }

      // 計算安全重生點（道路/人行道上，避免卡在建物內）
      const spawn = this.findSafeSpawn(this.worldManager.getBuildingColliders(), data.roads);
      this.player.teleport(spawn.x, 0, spawn.z);

      // 重設鏡頭
      this.cameraController.reset(0, CONFIG.CAMERA.DEFAULT_PITCH);

      // 更新 HUD 地點資訊
      this.hud.setLocationName(name);

      // 更新自繪地圖資料與導航系統
      this.tileRenderer.setData(data);
      this.blipManager.populateFromShops(data.shops || []);
      this.navSystem.buildGraph(data.roads);
      this.navGuide3D.clear();
      this.minimap.setRoads(data.roads);
      this.fullscreenMap.setData(data.roads, data.shops || [], this.currentProjection);

      // 構建行人路網與拓撲圖 (支援 Web Worker 背景多線程加速與逾時主線程備援)
      let pedNetwork = data.pedestrianNetwork;
      if (!pedNetwork) {
        pedNetwork = await this.buildPedestrianNetworkAsync(data.roads, data.buildings, data.shops || []);
        data.pedestrianNetwork = pedNetwork;
      }
      this.pedestrianSystem.setNetwork(pedNetwork);
      this.pedestrianDebug.setNetwork(pedNetwork);

      // 初始化交通號誌系統、GPU 實例渲染器與除錯視覺化
      const intersections = data.intersections || [];
      this.trafficSignalSystem.setIntersections(intersections);
      this.trafficSignalRenderer.buildSceneSignals(intersections);
      this.trafficSignalDebug.setIntersections(intersections);
      this.blipManager.populateTrafficSignals(intersections);

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
              discarded: fallbackBldgStats.discarded.total,
              sourceStats: fallbackBldgStats.sourceStats
            });
          }
          const spawn = this.findSafeSpawn(this.worldManager.getBuildingColliders(), fallbackData.roads);
          this.player.teleport(spawn.x, 0, spawn.z);
          this.cameraController.reset(0, CONFIG.CAMERA.DEFAULT_PITCH);
          this.hud.setLocationName(`${name} (展示備援)`);
          // 更新自繪地圖資料與導航系統
          this.tileRenderer.setData(fallbackData);
          this.blipManager.populateFromShops(fallbackData.shops || []);
          this.navSystem.buildGraph(fallbackData.roads);
          this.navGuide3D.clear();
          this.minimap.setRoads(fallbackData.roads);
          this.fullscreenMap.setData(fallbackData.roads, fallbackData.shops || [], this.currentProjection);

          // 構建備援展示行人路網
          let fallbackPedNetwork = fallbackData.pedestrianNetwork;
          if (!fallbackPedNetwork) {
            fallbackPedNetwork = PedestrianNetworkBuilder.buildNetwork(fallbackData.roads, fallbackData.buildings, fallbackData.shops || []);
            fallbackData.pedestrianNetwork = fallbackPedNetwork;
          }
          this.pedestrianSystem.setNetwork(fallbackPedNetwork);
          this.pedestrianDebug.setNetwork(fallbackPedNetwork);

          // 構建備援展示交通號誌
          const fallbackInters = fallbackData.intersections || [];
          this.trafficSignalSystem.setIntersections(fallbackInters);
          this.trafficSignalRenderer.buildSceneSignals(fallbackInters);
          this.trafficSignalDebug.setIntersections(fallbackInters);
          this.blipManager.populateTrafficSignals(fallbackInters);

          if (this.streetViewWindow.getIsVisible()) {
            this.streetViewWindow.updateLocation(lat, lon, 0, true);
          }
          this.loadingOverlay.hide();
        }
      );
    }
  }

  /**
   * 背景 Web Worker 構建行人路網 (附逾時備援)
   */
  private buildPedestrianNetworkAsync(roads: RoadFeature[], buildings: any[], shops: any[]): Promise<PedestrianNetworkData> {
    return new Promise((resolve) => {
      try {
        const worker = new Worker(new URL('./geo/PedWorker.ts', import.meta.url), { type: 'module' });
        const timer = setTimeout(() => {
          worker.terminate();
          resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops));
        }, 3000);

        worker.onmessage = (e) => {
          clearTimeout(timer);
          worker.terminate();
          if (e.data && e.data.type === 'NETWORK_READY') {
            resolve(e.data.data);
          } else {
            resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops));
          }
        };

        worker.onerror = () => {
          clearTimeout(timer);
          worker.terminate();
          resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops));
        };

        worker.postMessage({
          type: 'BUILD_NETWORK',
          payload: { roads, buildings, shops }
        });
      } catch {
        resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops));
      }
    });
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

    // 逐幀更新環境：動態太陽陰影追隨玩家位置、微粒動態
    this.worldManager.updateEnvironment(this.player.position, fixedDelta);

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

    // 同步自繪小地圖與全螢幕地圖
    const playerPos = { x: this.player.position.x, z: this.player.position.z };
    this.minimap.update(playerPos, cameraYaw);
    this.fullscreenMap.updatePlayer(playerPos, cameraYaw);
    this.hud.updateMapStats(this.minimap.getDrawTimeMs(), this.blipManager.getAllBlips().length);

    // 導航即時檢測：抵達目的地 (5m) 與偏離路徑重新尋路 (20m)
    if (this.navSystem.getCurrentRoute()) {
      if (this.navSystem.checkArrival(playerPos)) {
        this.hud.showNotification('🎉 抵達導航目的地！');
        this.fullscreenMap.clearDestination();
        this.navGuide3D.clear();
      } else if (this.navSystem.checkDeviation(playerPos, 20)) {
        const dest = this.navSystem.getDestination();
        if (dest) {
          this.navSystem.findRoute(playerPos, dest).then(newRoute => {
            if (newRoute) {
              this.navGuide3D.setRoute(newRoute.points);
            }
          });
        }
      }
    }

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
        discarded: bldgStats.discarded.total,
        sourceStats: bldgStats.sourceStats
      });
    }

    // 更新行人模擬系統 (生成、狀態機、空間避讓、交通信號)
    const isRaining = this.worldManager.getIsWet();
    this.pedestrianSystem.update(
      fixedDelta,
      playerPos,
      cameraYaw,
      colliders,
      isRaining
    );

    // 更新 GPU 行人批次渲染器與除錯視覺化
    this.pedestrianRenderer.update(this.pedestrianSystem.getAllAgents(), this.player.position);
    this.pedestrianDebug.update(this.pedestrianSystem.getAllAgents(), this.pedestrianSystem.getIsCrosswalkGreen());

    // 更新 HUD 行人即時統計 (總人數、狀態分布、AI 耗時、Draw Calls)
    this.hud.updatePedestrianStats(this.pedestrianSystem.getStats(this.pedestrianRenderer.getDrawCallsCount()));

    // 更新交通號誌全域邏輯 (相位狀態機、小綠人閃爍與倒數計時)
    this.trafficSignalSystem.update(fixedDelta);

    // 更新交通號誌 GPU 批次渲染器與除錯視覺化 (僅更新 200m 內，Draw Calls 嚴格為 6)
    this.trafficSignalRenderer.update(
      this.trafficSignalSystem,
      playerPos,
      performance.now() * 0.001
    );
    this.trafficSignalDebug.update(this.trafficSignalSystem);

    // 更新 HUD 交通號誌統計 (路口數、OSM/Auto 比、邏輯耗時、Draw Calls)
    const sigStats = this.trafficSignalSystem.getStats(
      playerPos,
      this.trafficSignalRenderer.getDrawCallsCount()
    );
    this.hud.updateTrafficSignalStats(sigStats);
  }

  /**
   * 畫面渲染迴圈
   */
  private render(_alpha: number, delta: number = 0.016): void {
    this.engine.render(delta);

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
