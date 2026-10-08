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
import { TimeSystem } from './systems/time/TimeSystem.ts';
import { WeatherSystem } from './systems/weather/WeatherSystem.ts';
import { WeatherRenderer } from './world/WeatherRenderer.ts';
import { WeatherAudioManager } from './core/WeatherAudioManager.ts';
import { WeatherModal } from './ui/WeatherModal.ts';
import { NightLightingSystem } from './world/NightLightingSystem.ts';
import { NightSceneAnalyzer } from './systems/weather/NightSceneAnalyzer.ts';
import { TrafficSystem } from './systems/traffic/TrafficSystem.ts';
import { TrafficVehicleRenderer } from './world/TrafficVehicleRenderer.ts';
import { TrafficDebugVisualizer } from './world/TrafficDebugVisualizer.ts';
import { TrafficVehicle, TrafficSystemStats } from './geo/TrafficTypes.ts';
import { PoliceSystem } from './systems/police/PoliceSystem.ts';
import { PoliceRenderer } from './world/PoliceRenderer.ts';
import { PoliceDebugVisualizer } from './world/PoliceDebugVisualizer.ts';

class GameApp {
  public engine: GameEngine;
  public input: InputManager;
  public collisionSystem: CollisionSystem;
  public cameraController: CameraController;
  public worldManager: WorldManager;
  public osmFetcher: OsmFetcher;
  public player: Player;
  public gameLoop: GameLoop;

  public hud: HUD;
  public loadingOverlay: LoadingOverlay;
  public locationModal: LocationModal;
  public blipManager: BlipManager;
  public tileRenderer: MapTileRenderer;
  public navSystem: NavigationSystem;
  public navGuide3D: NavigationGuide3D;
  public minimap: Minimap;
  public fullscreenMap: FullscreenMap;
  public mapillaryService: MapillaryService;
  public streetViewWindow: StreetViewWindow;
  public buildingInspectorModal: BuildingInspectorModal;
  public pedestrianSystem: PedestrianSystem;
  public pedestrianRenderer: PedestrianRenderer;
  public pedestrianDebug: PedestrianDebugVisualizer;
  public trafficSignalSystem: TrafficSignalSystem;
  public trafficSignalRenderer: TrafficSignalRenderer;
  public trafficSignalDebug: TrafficSignalDebugVisualizer;

  // NPC 交通車流與駕駛系統
  public trafficSystem: TrafficSystem;
  public trafficVehicleRenderer: TrafficVehicleRenderer;
  public trafficDebugVisualizer: TrafficDebugVisualizer;

  // 警察執法系統
  public policeSystem: PoliceSystem;
  public policeRenderer: PoliceRenderer;
  public policeDebugVisualizer: PoliceDebugVisualizer;

  // 天氣、時間與夜景假光系統
  public timeSystem: TimeSystem;
  public weatherSystem: WeatherSystem;
  public weatherRenderer: WeatherRenderer;
  public weatherAudio: WeatherAudioManager;
  public nightLightingSystem: NightLightingSystem;
  public weatherModal: WeatherModal;
  public nightSceneAnalyzer: NightSceneAnalyzer;
  public totalGameTimeSec = 0;

  private isInspectorMode = false;
  private raycaster = new THREE.Raycaster();
  private mouseVec = new THREE.Vector2();

  private currentProjection: GeoProjection | null = null;
  private isLocationLoading = false;
  private currentLocationName: string = '宜蘭礁溪溫泉市區';
  private signalTeleportIndex = 0;
  private lowFpsCounter = 0;
  private lowFpsUnder30Counter = 0;
  private isNpcDowngraded = false;
  private perfStats = {
    pedestrianMs: 0,
    trafficSignalMs: 0,
    trafficMs: 0,
    mapMs: 0,
    weatherMs: 0,
    nightLightingMs: 0
  };

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

    this.trafficSystem = new TrafficSystem();
    this.trafficVehicleRenderer = new TrafficVehicleRenderer(this.engine.scene);
    this.trafficDebugVisualizer = new TrafficDebugVisualizer(this.engine.scene);
    this.trafficSystem.setTrafficSignalSystem(this.trafficSignalSystem);
    this.trafficSystem.setPedestrianSystem(this.pedestrianSystem);

    this.policeSystem = new PoliceSystem();
    this.policeRenderer = new PoliceRenderer(this.engine.scene);
    this.policeDebugVisualizer = new PoliceDebugVisualizer(
      this.engine.scene,
      this.policeSystem,
      this.trafficSystem,
      this.pedestrianSystem
    );
    this.trafficSystem.setPoliceSystem(this.policeSystem);
    this.pedestrianSystem.setPoliceSystem(this.policeSystem);
    this.minimap.setPoliceSystem(this.policeSystem);
    this.fullscreenMap.setPoliceSystem(this.policeSystem);

    this.mapillaryService = new MapillaryService();
    this.streetViewWindow = new StreetViewWindow(this.input, this.mapillaryService);
    this.streetViewWindow.onSplitChange(() => {
      this.engine.resize();
    });

    this.buildingInspectorModal = new BuildingInspectorModal();

    // 3.5 初始化天氣、時間、夜間假光與音訊子系統
    this.timeSystem = new TimeSystem();
    this.weatherSystem = new WeatherSystem();
    this.weatherAudio = new WeatherAudioManager();
    this.weatherRenderer = new WeatherRenderer(
      this.engine.scene,
      this.timeSystem,
      this.weatherSystem,
      this.worldManager.getRoadGenerator(),
      this.engine.renderer
    );
    this.weatherRenderer.setTerrainFeatureGenerator(this.worldManager.getTerrainFeatureGenerator());
    this.nightLightingSystem = new NightLightingSystem(
      this.engine.scene,
      this.worldManager.getPropGenerator(),
      this.worldManager.getSignboardGenerator(),
      this.trafficSignalSystem,
      this.worldManager.getBuildingGenerator(),
      this.worldManager.getRoadGenerator()
    );
    this.nightLightingSystem.setTerrainFeatureGenerator(this.worldManager.getTerrainFeatureGenerator());
    this.nightLightingSystem.setEnvironmentGenerator(this.worldManager.getEnvironmentGenerator());
    this.weatherModal = new WeatherModal(
      this.timeSystem,
      this.weatherSystem,
      this.weatherAudio,
      this.nightLightingSystem,
      this.weatherRenderer
    );
    this.nightSceneAnalyzer = new NightSceneAnalyzer(
      this.timeSystem,
      this.weatherSystem,
      this.weatherRenderer,
      this.nightLightingSystem,
      this.engine.renderer
    );

    // 閃電事件連動程序雷聲
    this.weatherSystem.onLightning((_intensity, delay) => {
      this.weatherAudio.triggerThunder(delay);
    });

    // 天文暮光日夜切換連動 (號誌深夜離峰閃黃、招牌自發光)
    this.weatherRenderer.setNightModeChangeCallback((isNight) => {
      this.trafficSignalSystem.setNightMode(isNight);
      this.worldManager.getSignboardGenerator().setNightMode(isNight);
      this.hud.setNightModeActive(isNight);
    });

    this.weatherModal.setOnToggleVisibility((visible) => {
      if (visible) {
        this.input.exitPointerLock();
      }
    });

    // 若未設定 Mapillary Token，依規定隱藏 HUD 街景提示按鈕
    if (!this.mapillaryService.hasToken()) {
      this.hud.setStreetViewAvailable(false);
    }

    // 4. 初始化遊戲主迴圈
    this.gameLoop = new GameLoop(
      this.update.bind(this),
      this.render.bind(this),
      (fps) => {
        this.hud.updateFps(fps);
        this.checkAutoQualityDowngrade(fps);
      }
    );

    // 5. 綁定事件與回呼
    this.setupEvents();

    // 6. 啟動遊戲迴圈
    this.gameLoop.start();
    (window as any).__game = this;
    (window as any).game = this;
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
      const isPanelVisible = this.hud.togglePedestrianDebug();
      if (isPanelVisible) {
        this.updatePedestrianDebugPanel();
      }
      this.hud.showNotification(
        isVisible ? '🚶 行人除錯開啟 (青=人行道, 黃=騎樓, 綠/紅=過街, 菱形=狀態)' : '🚶 行人除錯已關閉'
      );
    };
    this.input.onTogglePedestrianDebug = handleTogglePedDebug;
    this.hud.onPedestrianDebugClick(handleTogglePedDebug);

    this.hud.onPedSamplingClick(() => {
      this.pedestrianSystem.startPedestrianSampling();
      this.hud.showNotification('⏱️ 已啟動行人 60 秒行為抽樣評估！');
      this.updatePedestrianDebugPanel();
    });

    this.hud.onPedRefreshClick(() => {
      this.updatePedestrianDebugPanel();
    });

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

    // 按 F10 鍵循環傳送玩家到各號誌路口 (邊緣 15m 面向路口中心)
    const handleCycleSignalTeleport = () => {
      const intersections = this.trafficSignalSystem.getIntersections().filter((i) => i.hasSignals);
      if (intersections.length === 0) {
        this.hud.showNotification('⚠️ 目前地圖無交通號誌路口');
        return;
      }

      const target = intersections[this.signalTeleportIndex % intersections.length];
      this.signalTeleportIndex++;

      // 選取該路口第 1 條 approach 作為視點
      const app = target.approaches[0];
      const az = app ? app.azimuthRad : 0;

      // 傳送到路口邊緣約 16 公尺處、面向路口中心
      const dist = Math.max(16.0, target.radius + 4.0);
      const posX = target.center.x - Math.sin(az) * dist;
      const posZ = target.center.z - Math.cos(az) * dist;

      this.player.teleport(posX, 0, posZ);
      this.cameraController.reset(az + Math.PI, 14 * (Math.PI / 180));

      const ctrl = this.trafficSignalSystem.getController(target.id);
      const vStateA = ctrl ? ctrl.getGroupVehicleState('A') : { state: 'red', remainingSec: 0 };
      const countdownA = ctrl ? ctrl.getCountdownSec('A').seconds : 0;
      const poleCount = target.poles.length;
      let headCount = 0;
      for (const p of target.poles) {
        headCount += p.hasSecondaryHead ? 3 : 2;
      }

      const srcName = target.source === 'osm' ? 'OSM實測' : '自動補齊';
      this.hud.showNotification(
        `🚦 [${target.id}] ${srcName} | 相位A: ${vStateA.state.toUpperCase()} (${countdownA}s) | 燈桿:${poleCount}支 燈頭:${headCount}組`
      );
    };
    this.input.onCycleTrafficSignalTeleport = handleCycleSignalTeleport;
    this.hud.onTrafficSignalTeleportClick(handleCycleSignalTeleport);

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

    // 按 K 鍵或點擊 HUD 開啟天氣與時間控制面板
    const handleToggleWeatherModal = () => {
      this.weatherModal.toggle();
    };
    this.input.onToggleWeatherModal = handleToggleWeatherModal;
    this.hud.onWeatherModalClick(handleToggleWeatherModal);

    // 按 F11 鍵切換天氣與日月診斷覆蓋層
    const handleToggleWeatherDebug = () => {
      const isVisible = this.hud.toggleWeatherDebug();
      this.hud.showNotification(
        isVisible ? '🌦️ 天氣與時間除錯診斷開啟 (F11)' : '🌦️ 天氣與時間除錯診斷已關閉'
      );
    };
    this.input.onToggleWeatherDebug = handleToggleWeatherDebug;
    this.hud.onWeatherDebugClick(handleToggleWeatherDebug);

    // 按 F12 鍵切換夜景分區亮度分析面板
    const handleToggleNightAnalysis = () => {
      const isVisible = this.hud.toggleNightAnalysis();
      if (isVisible) {
        const metrics = this.nightSceneAnalyzer.analyze();
        this.hud.updateNightAnalysis(this.nightSceneAnalyzer.generateReportHtml(metrics));
      }
      this.hud.showNotification(
        isVisible ? '🌙 夜景分區亮度分析開啟 (F12)' : '🌙 夜景分區亮度分析已關閉'
      );
    };
    this.input.onToggleNightAnalysis = handleToggleNightAnalysis;
    this.hud.onNightAnalysisClick(handleToggleNightAnalysis);

    // 按 F13 鍵或點擊 HUD 切換車輛與駕駛除錯視覺化
    const handleToggleTrafficDebug = () => {
      const isVisible = this.trafficDebugVisualizer.toggle();
      this.hud.toggleTrafficDebug();
      this.hud.showNotification(
        isVisible ? '🚗 駕駛除錯已開啟 (3D標籤: 個性/心情/狀態/喇叭聲波)' : '🚗 駕駛除錯已關閉'
      );
    };
    this.input.onToggleTrafficDebug = handleToggleTrafficDebug;
    this.hud.onTrafficDebugClick(handleToggleTrafficDebug);

    this.hud.onTrafficSamplingClick(() => {
      this.trafficSystem.startVehicleSampling();
      this.hud.showNotification('⏱️ 已啟動車輛 60 秒行為抽樣評估！');
      const activeVehicles = this.trafficSystem.getActiveVehicles();
      const trafficStats = this.trafficSystem.getStats(this.trafficVehicleRenderer.getDrawCalls());
      this.updateTrafficDebugPanel(trafficStats, activeVehicles);
    });

    this.hud.onTrafficRefreshClick(() => {
      const activeVehicles = this.trafficSystem.getActiveVehicles();
      const trafficStats = this.trafficSystem.getStats(this.trafficVehicleRenderer.getDrawCalls());
      this.updateTrafficDebugPanel(trafficStats, activeVehicles);
    });

    // 測試操作：強制鳴笛
    this.hud.onForceHonkClick(() => {
      const ok = this.trafficSystem.forceHonkNearby({
        x: this.player.position.x,
        z: this.player.position.z
      });
      this.hud.showNotification(ok ? '📢 已強制附近車輛按喇叭！' : '⚠️ 附近無活躍車輛');
    });

    // 測試操作：強制煩躁生氣
    this.hud.onForceAnnoyClick(() => {
      const ok = this.trafficSystem.forceAnnoyNearby({
        x: this.player.position.x,
        z: this.player.position.z
      });
      this.hud.showNotification(ok ? '💢 已強制附近駕駛生氣咆哮！' : '⚠️ 附近無活躍車輛');
    });

    // 測試操作：彈出駕駛 (轉交行人系統逃跑)
    this.hud.onEjectDriverClick(() => {
      const ok = this.trafficSystem.ejectNearestDriver({
        x: this.player.position.x,
        z: this.player.position.z
      });
      this.hud.showNotification(ok ? '🏃 已將最近車輛駕駛彈出為受驚逃跑行人！' : '⚠️ 附近無活躍車輛');
    });

    // 按 F14 / Shift+F2 或點擊 HUD 切換停止線停等量測面板
    const handleToggleStopLineMeasurement = () => {
      const isVisible = this.hud.toggleStopLineMeasurement();
      if (isVisible) {
        this.hud.updateStopLineMeasurement(this.trafficSystem.getStopLineMeasurements(), this.trafficSystem.isAllRed());
      }
      this.hud.showNotification(
        isVisible ? '📏 停止線停等量測面板開啟 (F14 / Shift+F2)' : '📏 停止線停等量測面板已關閉'
      );
    };
    this.input.onToggleStopLineMeasurement = handleToggleStopLineMeasurement;
    this.hud.onStopLineMeasurementClick(handleToggleStopLineMeasurement);

    this.hud.onStopLineToggleAllRedClick(() => {
      const next = !this.trafficSystem.isAllRed();
      this.trafficSystem.triggerAllRed(next);
      this.hud.updateStopLineMeasurement(this.trafficSystem.getStopLineMeasurements(), this.trafficSystem.isAllRed());
      this.hud.showNotification(next ? '🚨 已啟動全城紅燈 (車輛將減速停等停止線)' : '🟢 已恢復正常交通號誌週期');
    });

    this.hud.onStopLineRefreshClick(() => {
      this.hud.updateStopLineMeasurement(this.trafficSystem.getStopLineMeasurements(), this.trafficSystem.isAllRed());
      this.hud.showNotification('🔄 已重新整理停止線量測數據');
    });

    // 按 F15 / Shift+` 或點擊 HUD 切換警察執法除錯面板
    const handleTogglePoliceDebug = () => {
      const isVisible = this.policeDebugVisualizer.toggle();
      this.hud.showNotification(
        isVisible ? '🚔 警察執法除錯面板開啟 (F15 / Shift+\`)' : '🚔 警察執法除錯面板已關閉'
      );
    };
    this.input.onTogglePoliceDebug = handleTogglePoliceDebug;
    this.hud.onPoliceDebugClick(handleTogglePoliceDebug);

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
      if (this.timeSystem.getMode() === 'virtual') {
        this.timeSystem.setVirtualHour(isNight ? 0.0 : 12.0);
      }
      this.hud.showNotification(
        isNight ? '🌙 夜間霓虹模式開啟 (店家招牌 Bloom 增強、暖黃街燈、次要路口閃黃閃紅)' : '🌅 恢復白天/黃昏時段'
      );
    };
    this.input.onToggleNightMode = handleToggleNight;
    this.hud.onNightModeClick(handleToggleNight);

    // 點擊畫質切換按鈕 [高 / 中 / 低]
    this.hud.onQualityClick(() => {
      const nextQuality = this.engine.postProcessing.cycleQuality();
      this.weatherRenderer.setQuality(nextQuality);
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

    (window as any).__game = this;
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
      this.nightLightingSystem.rebuildLampCache();

      // 同步天氣與時間系統經緯度
      this.timeSystem.setCoordinates(lat, lon);
      this.weatherSystem.setCoordinates(lat, lon);
      this.weatherRenderer.setRoadGenerator(this.worldManager.getRoadGenerator());
      this.weatherRenderer.setTerrainFeatureGenerator(this.worldManager.getTerrainFeatureGenerator());
      this.nightLightingSystem.setTerrainFeatureGenerator(this.worldManager.getTerrainFeatureGenerator());
      this.nightLightingSystem.setEnvironmentGenerator(this.worldManager.getEnvironmentGenerator());

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

      // 初始化交通號誌與路口資料
      const intersections = data.intersections || [];

      // 構建行人路網與拓撲圖 (支援 Web Worker 背景多線程加速與逾時主線程備援)
      let pedNetwork = data.pedestrianNetwork;
      if (!pedNetwork) {
        pedNetwork = await this.buildPedestrianNetworkAsync(data.roads, data.buildings, data.shops || [], intersections);
        data.pedestrianNetwork = pedNetwork;
      }
      this.pedestrianSystem.setNetwork(pedNetwork);
      this.pedestrianDebug.setNetwork(pedNetwork);

      // 初始化交通號誌系統、GPU 實例渲染器與除錯視覺化
      this.trafficSignalSystem.setIntersections(intersections);
      this.trafficSignalRenderer.buildSceneSignals(intersections);
      this.trafficSignalDebug.setIntersections(intersections);
      this.trafficDebugVisualizer.setIntersections(intersections);
      this.blipManager.populateTrafficSignals(intersections);

      // 初始化 NPC 交通車流與駕駛系統
      this.trafficSystem.setRoadsAndIntersections(data.roads, intersections);

      // 初始化警察執法系統
      this.policeSystem.setRoads(data.roads);
      this.policeSystem.setIntersections(intersections);
      this.policeSystem.setTrafficSignalSystem(this.trafficSignalSystem);
      this.policeSystem.setBuildingColliders(this.worldManager.getBuildingColliders());

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
          this.nightLightingSystem.rebuildLampCache();
          this.timeSystem.setCoordinates(lat, lon);
          this.weatherSystem.setCoordinates(lat, lon);
          this.weatherRenderer.setRoadGenerator(this.worldManager.getRoadGenerator());
          this.weatherRenderer.setTerrainFeatureGenerator(this.worldManager.getTerrainFeatureGenerator());
          this.nightLightingSystem.setTerrainFeatureGenerator(this.worldManager.getTerrainFeatureGenerator());
          this.nightLightingSystem.setEnvironmentGenerator(this.worldManager.getEnvironmentGenerator());
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

          // 構建備援展示交通號誌與行人路網
          const fallbackInters = fallbackData.intersections || [];
          this.trafficSignalSystem.setIntersections(fallbackInters);
          this.trafficSignalRenderer.buildSceneSignals(fallbackInters);
          this.trafficSignalDebug.setIntersections(fallbackInters);
          this.trafficDebugVisualizer.setIntersections(fallbackInters);
          this.blipManager.populateTrafficSignals(fallbackInters);
          this.trafficSystem.setRoadsAndIntersections(fallbackData.roads, fallbackInters);
          this.policeSystem.setRoads(fallbackData.roads);
          this.policeSystem.setIntersections(fallbackInters);
          this.policeSystem.setTrafficSignalSystem(this.trafficSignalSystem);
          this.policeSystem.setBuildingColliders(this.worldManager.getBuildingColliders());

          let fallbackPedNetwork = fallbackData.pedestrianNetwork;
          if (!fallbackPedNetwork) {
            fallbackPedNetwork = PedestrianNetworkBuilder.buildNetwork(fallbackData.roads, fallbackData.buildings, fallbackData.shops || [], fallbackInters);
            fallbackData.pedestrianNetwork = fallbackPedNetwork;
          }
          this.pedestrianSystem.setNetwork(fallbackPedNetwork);
          this.pedestrianDebug.setNetwork(fallbackPedNetwork);

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
  private buildPedestrianNetworkAsync(roads: RoadFeature[], buildings: any[], shops: any[], intersections: any[] = []): Promise<PedestrianNetworkData> {
    return new Promise((resolve) => {
      try {
        const worker = new Worker(new URL('./geo/PedWorker.ts', import.meta.url), { type: 'module' });
        const timer = setTimeout(() => {
          worker.terminate();
          resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops, intersections));
        }, 3000);

        worker.onmessage = (e) => {
          clearTimeout(timer);
          worker.terminate();
          if (e.data && e.data.type === 'NETWORK_READY') {
            resolve(e.data.data);
          } else {
            resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops, intersections));
          }
        };

        worker.onerror = () => {
          clearTimeout(timer);
          worker.terminate();
          resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops, intersections));
        };

        worker.postMessage({
          type: 'BUILD_NETWORK',
          payload: { roads, buildings, shops, intersections }
        });
      } catch {
        resolve(PedestrianNetworkBuilder.buildNetwork(roads, buildings, shops, intersections));
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

    // 逐幀更新天氣與時間系統 (天空穹頂、日月軌跡、GPU 雨絲與水花)
    const tWeather0 = performance.now();
    this.totalGameTimeSec += fixedDelta;
    this.timeSystem.update(fixedDelta);
    this.weatherSystem.update(fixedDelta);
    this.weatherRenderer.update(this.player.position, this.totalGameTimeSec);

    // 騎樓/近屋低通濾波判定 (Web Audio 遮蔽)
    const px = this.player.position.x;
    const pz = this.player.position.z;
    let isNearBuilding = false;
    for (let i = 0; i < colliders.length; i++) {
      const b = colliders[i];
      if (px >= b.minX - 1.2 && px <= b.maxX + 1.2 && pz >= b.minZ - 1.2 && pz <= b.maxZ + 1.2) {
        isNearBuilding = true;
        break;
      }
    }
    this.weatherAudio.setOcclusion(isNearBuilding);
    const rainInt = this.weatherSystem.getRainIntensity();
    const visParams = this.weatherSystem.getVisualParams();
    const sunMoon = this.timeSystem.getSunMoonInfo();
    this.weatherAudio.update(rainInt, visParams.windSpeedMps, sunMoon.isNight);
    this.perfStats.weatherMs = performance.now() - tWeather0;

    // 逐幀更新夜間假光與氛圍系統 (路燈地面光斑、燈頭光暈、店家溢光、號誌地面光斑、雨天倒影、窗戶隨機亮暗)
    const tNight0 = performance.now();
    const sunAltDeg = sunMoon.sun.altitudeDeg;
    const nightFactor = Math.max(0, Math.min(1, (-sunAltDeg - 2.0) / 10.0));
    const timeInfo = this.timeSystem.getTimeOfDay();
    this.nightLightingSystem.update(
      this.player.position,
      this.engine.camera,
      nightFactor,
      visParams.wetness,
      visParams.rainIntensity,
      timeInfo.hourFraction,
      this.totalGameTimeSec
    );
    this.perfStats.nightLightingMs = performance.now() - tNight0;

    // 更新行人模擬系統 (生成、狀態機、空間避讓、交通信號)
    const tPed0 = performance.now();
    const isRaining = rainInt > 0.05 || this.worldManager.getIsWet();
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
    this.perfStats.pedestrianMs = performance.now() - tPed0;

    // 更新 HUD 行人即時統計 (總人數、狀態分布、AI 耗時、Draw Calls)
    this.hud.updatePedestrianStats(this.pedestrianSystem.getStats(this.pedestrianRenderer.getDrawCallsCount()));

    // 若開啟 F8 行人除錯面板，更新除錯內容
    if (this.hud.isPedDebugVisible) {
      this.updatePedestrianDebugPanel();
    }

    // 更新交通號誌全域邏輯 (相位狀態機、小綠人閃爍與倒數計時)
    const tSig0 = performance.now();
    this.trafficSignalSystem.update(fixedDelta);

    // 更新交通號誌 GPU 批次渲染器與除錯視覺化 (僅更新 300m 內，Draw Calls 嚴格為 6)
    this.trafficSignalRenderer.update(
      this.trafficSignalSystem,
      playerPos,
      performance.now() * 0.001
    );
    this.trafficSignalDebug.update(this.trafficSignalSystem);
    this.perfStats.trafficSignalMs = performance.now() - tSig0;

    // 更新 HUD 交通號誌統計 (路口數、OSM/Auto 比、邏輯耗時、Draw Calls)
    const sigStats = this.trafficSignalSystem.getStats(
      playerPos,
      this.trafficSignalRenderer.getDrawCallsCount()
    );
    this.hud.updateTrafficSignalStats(sigStats);

    // 更新 NPC 交通系統 (車流路網、AI 駕駛行為、個性、心情、號誌反應、計程車載客)
    const tTraffic0 = performance.now();
    this.trafficSystem.update(fixedDelta, playerPos, isRaining);

    // 更新 GPU 車輛與駕駛批次渲染器與除錯視覺化
    const activeVehicles = this.trafficSystem.getActiveVehicles();
    this.trafficVehicleRenderer.update(activeVehicles, this.engine.camera.position);
    this.trafficDebugVisualizer.update(activeVehicles, this.engine.camera.position);
    this.perfStats.trafficMs = performance.now() - tTraffic0;

    // 更新 HUD 交通統計
    const trafficStats = this.trafficSystem.getStats(this.trafficVehicleRenderer.getDrawCalls());
    this.hud.updateTrafficStats(trafficStats);

    // 若開啟 F13 面板，更新除錯內容
    if (this.hud.isTrafficDebugVisible) {
      this.updateTrafficDebugPanel(trafficStats, activeVehicles);
    }

    // 若開啟 F14 停止線量測面板，更新量測數據
    if (this.hud.isStopLineMeasurementVisible) {
      this.hud.updateStopLineMeasurement(this.trafficSystem.getStopLineMeasurements(), this.trafficSystem.isAllRed());
    }

    // 更新警察執法系統 (巡邏、偵測違規、追捕、攔截、開罰)
    const activePedestrians = this.pedestrianSystem.getAllAgents().filter((a) => a.active);
    this.policeSystem.update(
      fixedDelta,
      activeVehicles,
      activePedestrians,
      playerPos,
      isRaining,
      timeInfo.hourFraction
    );
    this.policeRenderer.update(this.policeSystem.getVehicles(), fixedDelta);
    this.policeDebugVisualizer.update(fixedDelta, playerPos);
    this.hud.updatePoliceStats(this.policeSystem.getStats(), 4);

    this.perfStats.mapMs = this.minimap.getDrawTimeMs();

    // 更新 HUD 天氣與時間小組件
    const weatherData = this.weatherSystem.getWeatherData();
    const weatherIcons: Record<string, string> = {
      clear: '☀️',
      cloudy: '⛅',
      overcast: '☁️',
      fog: '🌫️',
      light_rain: '🌦️',
      heavy_rain: '🌧️',
      thunderstorm: '⛈️',
      typhoon: '🌀'
    };
    const weatherNames: Record<string, string> = {
      clear: '晴天',
      cloudy: '多雲',
      overcast: '陰天',
      fog: '大霧',
      light_rain: '小雨',
      heavy_rain: '大雨',
      thunderstorm: '雷雨',
      typhoon: '颱風'
    };
    const srcTag =
      this.weatherSystem.getMode() === 'real'
        ? weatherData.source === 'cache'
          ? '離線快取'
          : '即時'
        : '虛擬';

    const transInfo = this.weatherSystem.getTransitionInfo();
    const tTarget = transInfo.targetParams;
    const isTrans = transInfo.isTransitioning;
    const transPercent = Math.round(transInfo.progress * 100);
    const weatherBadge = isTrans ? `${srcTag} 🔄${transPercent}%` : srcTag;

    this.hud.updateWeatherTime(
      timeInfo.timeString,
      weatherIcons[weatherData.weatherState] || '🌤️',
      weatherNames[weatherData.weatherState] || weatherData.weatherState,
      weatherData.temperature,
      weatherBadge
    );

    // 更新 F11 天氣除錯覆蓋層
    const nightStats = this.nightLightingSystem.getStats();
    const cacheAgeStr = weatherData.cacheAgeSec !== undefined ? `${weatherData.cacheAgeSec}s` : '無';
    const httpStatusStr = weatherData.diagnostics?.lastHttpStatus ? `HTTP ${weatherData.diagnostics.lastHttpStatus}` : '連線中/未知';
    const transBar = isTrans
      ? `<div style="margin: 4px 0 2px 0; background: rgba(255,255,255,0.15); height: 6px; border-radius: 3px; overflow: hidden;">
           <div style="background: #38bdf8; height: 100%; width: ${transPercent}%;"></div>
         </div>
         <div style="font-size: 10px; color: #38bdf8; margin-bottom: 4px;">過渡進度：${transPercent}% (${transInfo.elapsedSec.toFixed(1)}s / ${transInfo.totalSec.toFixed(1)}s)</div>`
      : `<div style="font-size: 10px; color: #4ade80; margin-bottom: 2px;">天候狀態：穩定 (無過渡)</div>`;

    const debugHtml = `
      <div><b>時間模式</b>：[${this.timeSystem.getMode()}] | <b>天候模式</b>：[${this.weatherSystem.getMode()}]</div>
      <div><b>天氣 API 狀態</b>：${httpStatusStr} | 快取年齡: ${cacheAgeStr} | 來源標記: [${srcTag}]</div>
      ${transBar}
      <div><b>太陽方位</b>：仰角 ${sunMoon.sun.altitudeDeg.toFixed(1)}° | 方位 ${sunMoon.sun.azimuthDeg.toFixed(1)}°</div>
      <div><b>月球方位</b>：仰角 ${sunMoon.moon.altitudeDeg.toFixed(1)}° | 方位 ${sunMoon.moon.azimuthDeg.toFixed(1)}°</div>
      <div><b>月相照度</b>：${(sunMoon.moonIllumination * 100).toFixed(0)}% (相值 ${(sunMoon.moonPhase).toFixed(2)})</div>
      <div><b>暮光時段</b>：${sunMoon.twilightPhase.toUpperCase()} | <b>夜景係數</b>：${(nightFactor * 100).toFixed(0)}%</div>
      <div><b>降雨強度</b>：目前 ${(visParams.rainIntensity * 100).toFixed(0)}% → 目標 ${(tTarget.rainIntensity * 100).toFixed(0)}%</div>
      <div><b>路面濕潤</b>：目前 ${(visParams.wetness * 100).toFixed(0)}% → 目標 ${(tTarget.wetnessTarget * 100).toFixed(0)}%</div>
      <div><b>雲層覆蓋</b>：目前 ${(visParams.cloudCover * 100).toFixed(0)}% → 目標 ${(tTarget.cloudCover * 100).toFixed(0)}%</div>
      <div><b>濃霧倍率</b>：目前 ${visParams.fogDensity.toFixed(2)}x → 目標 ${tTarget.fogDensity.toFixed(2)}x</div>
      <div><b>風速風向</b>：目前 ${visParams.windSpeedMps.toFixed(1)} m/s → 目標 ${tTarget.windSpeedMps.toFixed(1)} m/s (${((visParams.windAngleRad * 180) / Math.PI).toFixed(0)}°)</div>
      <div><b>天氣 Draw Calls</b>：${this.weatherRenderer.getDrawCallsCount()} (穹頂+雨絲+水花) | 邏輯: ${this.perfStats.weatherMs.toFixed(2)}ms</div>
      <div><b>夜景假光貼花</b>：${nightStats.activeDecals} 個 | Draw Calls: ${nightStats.drawCalls} (預算≤8) | 耗時: ${this.perfStats.nightLightingMs.toFixed(2)}ms</div>
      <div><b>音訊狀態</b>：${this.weatherAudio.getIsOccluded() ? '騎樓低通 (550Hz)' : '開闊街區 (正常)'}</div>
    `;
    this.hud.updateWeatherDebug(debugHtml);

    // 更新 F12 夜景分區亮度分析面板 (若開啟)
    if (this.hud.isNightAnalysisVisible) {
      const metrics = this.nightSceneAnalyzer.analyze();
      this.hud.updateNightAnalysis(this.nightSceneAnalyzer.generateReportHtml(metrics));
    }
  }

  /**
   * 後處理低幀率自動降級機制 (偵測到持續 < 45 FPS 時自動降級)
   */
  private checkAutoQualityDowngrade(fps: number): void {
    if (fps > 0 && fps < 45) {
      this.lowFpsCounter++;
      // 連續 3 次取樣 (約 1.5 秒) 低於 45 FPS
      if (this.lowFpsCounter >= 3) {
        this.lowFpsCounter = 0;
        const currentQ = this.engine.postProcessing.getQuality();
        if (currentQ === 'high') {
          this.engine.postProcessing.setQuality('medium');
          this.weatherRenderer.setQuality('medium');
          this.hud.setQualityText('中');
          this.hud.showNotification('⚡ 偵測到 FPS 低於 45，已自動降級後處理效果至 [中] 以維持流暢度');
          console.warn('[Performance] FPS < 45，自動降級後處理品質至 medium');
        } else if (currentQ === 'medium') {
          this.engine.postProcessing.setQuality('low');
          this.weatherRenderer.setQuality('low');
          this.hud.setQualityText('低');
          this.hud.showNotification('⚡ 偵測到 FPS 低於 45，已自動降級後處理效果至 [低] 以維持流暢度');
          console.warn('[Performance] FPS < 45，自動降級後處理品質至 low');
        }
      }
    } else {
      this.lowFpsCounter = 0;
    }

    // 若連續 3 秒 (6 次取樣) FPS < 30，自動降低行人與車輛更新頻率或數量
    if (fps > 0 && fps < 30) {
      this.lowFpsUnder30Counter++;
      if (this.lowFpsUnder30Counter >= 6 && !this.isNpcDowngraded) {
        this.isNpcDowngraded = true;
        CONFIG.PEDESTRIAN.MAX_COUNT = Math.max(50, Math.floor(CONFIG.PEDESTRIAN.MAX_COUNT * 0.7));
        CONFIG.TRAFFIC.MAX_VEHICLES = Math.max(25, Math.floor(CONFIG.TRAFFIC.MAX_VEHICLES * 0.7));
        this.hud.showNotification('⚡ 連續 3 秒 FPS < 30，已自動降低 NPC 行人與車輛負載以確保流暢度');
        console.warn('[Performance] 連續 3 秒 FPS < 30，自動降低 NPC 行人與車輛上限至:', {
          ped: CONFIG.PEDESTRIAN.MAX_COUNT,
          traffic: CONFIG.TRAFFIC.MAX_VEHICLES
        });
      }
    } else {
      this.lowFpsUnder30Counter = Math.max(0, this.lowFpsUnder30Counter - 1);
    }
  }

  /**
   * 取得各主要系統即時效能耗時 (供除錯與診斷回報)
   */
  public getPerformanceStats() {
    const timing = this.engine.getTimingInfo();
    return {
      baseRenderMs: Number(timing.baseRenderMs.toFixed(2)),
      postProcessingMs: Number(timing.postProcessingMs.toFixed(2)),
      pedestrianMs: Number(this.perfStats.pedestrianMs.toFixed(2)),
      trafficSignalMs: Number(this.perfStats.trafficSignalMs.toFixed(2)),
      trafficMs: Number(this.perfStats.trafficMs.toFixed(2)),
      mapMs: Number(this.perfStats.mapMs.toFixed(2)),
      weatherMs: Number(this.perfStats.weatherMs.toFixed(2)),
      nightLightingMs: Number(this.perfStats.nightLightingMs.toFixed(2))
    };
  }

  /**
   * 更新 F13 駕駛除錯面板 HTML 內容
   */
  /**
   * 更新 F8 行人除錯面板 HTML 內容
   */
  private updatePedestrianDebugPanel(): void {
    const stats = this.pedestrianSystem.getStats(this.pedestrianRenderer.getDrawCallsCount());
    const playerPos = { x: this.player.position.x, z: this.player.position.z };

    // 抽樣報告即時更新
    this.hud.updatePedestrianSamplingReport(
      this.pedestrianSystem.getPedestrianSamplingReport(),
      this.pedestrianSystem.getSamplingRemainingSec(),
      this.pedestrianSystem.isSamplingActive()
    );

    const activeAgents = this.pedestrianSystem.getAllAgents().filter((a) => a.active);
    const nearbyAgents = [...activeAgents]
      .sort(
        (a, b) =>
          Math.hypot(a.x - playerPos.x, a.z - playerPos.z) -
          Math.hypot(b.x - playerPos.x, b.z - playerPos.z)
      )
      .slice(0, 5);

    let listHtml = '';
    for (const a of nearbyAgents) {
      const dist = Math.hypot(a.x - playerPos.x, a.z - playerPos.z).toFixed(1);
      const spd = (a.speed * 3.6).toFixed(1);
      const violTag = a.isViolator
        ? ` <span style="color:#ff6600;font-weight:bold;">[違規: ${a.violationType || '未明'}]</span>`
        : '';
      const compTag = a.companionGroupId ? ` <span style="color:#a78bfa;">[同行組#${a.companionGroupId}]</span>` : '';
      const borderCol = a.isViolator ? '#ff6600' : '#f472b6';

      listHtml += `
        <div style="background: rgba(30,41,59,0.7); padding: 4px 6px; border-radius: 4px; margin-bottom: 4px; border-left: 3px solid ${borderCol}; font-size: 11px;">
          <div style="display:flex; justify-content:space-between;">
            <b>行人 [${a.id}]${compTag}</b>
            <span style="color:#94a3b8;">${dist}m | ${spd} km/h</span>
          </div>
          <div>狀態: <b>${a.state}</b>${violTag}</div>
        </div>
      `;
    }

    const crossZebraRate = stats.crossingsTotal > 0
      ? ((stats.crossingsOnZebra / stats.crossingsTotal) * 100).toFixed(1)
      : '100.0';

    const html = `
      <div style="margin-bottom: 4px;"><b>活躍行人</b>：${stats.total}人 (走:${stats.walking} 停:${stats.idle} 等:${stats.waiting} 渡:${stats.crossing} 避:${stats.evading})</div>
      <div style="margin-bottom: 4px;"><b>聚集比例</b>：<span style="color:${stats.crowdedRatePercent < 3.0 ? '#4ade80' : '#f59e0b'}; font-weight:bold;">${stats.crowdedRatePercent.toFixed(1)}%</span> (目標 &lt; 3%)</div>
      <div style="margin-bottom: 4px;"><b>守規斑馬線率</b>：<span style="color:#4ade80; font-weight:bold;">${crossZebraRate}%</span> (目標 100%)</div>
      <div style="margin-bottom: 4px;"><b>倒退走事件</b>：<span style="color:${stats.backwardsWalkCount === 0 ? '#4ade80' : '#ef4444'}; font-weight:bold;">${stats.backwardsWalkCount}次</span> (目標 0)</div>
      <div style="margin-bottom: 4px;"><b>違規統計</b>：${stats.violationsCount.total}次 (${stats.violationRatePercent.toFixed(1)}%) (紅燈:${stats.violationsCount.jaywalkRed}, 無斑馬線:${stats.violationsCount.crossNoZebra}, 貼車道:${stats.violationsCount.walkRoadEdge})</div>
      <div style="margin-bottom: 6px;"><b>AI 邏輯耗時</b>：${stats.aiTimeMs.toFixed(2)}ms (預算≤0.3ms) | <b>Draw Calls</b>：${stats.drawCalls}</div>
      <div style="font-weight:700; color:#f472b6; margin-bottom:4px; border-top:1px solid rgba(148,163,184,0.2); padding-top:4px;">附近行人 (最近 5 人)：</div>
      ${listHtml || '<div style="color:#94a3b8;">附近無行人</div>'}
    `;

    this.hud.updatePedestrianDebugContent(html);
  }

  /**
   * 更新 F13 駕駛除錯面板 HTML 內容
   */
  private updateTrafficDebugPanel(stats: TrafficSystemStats, vehicles: TrafficVehicle[]): void {
    const playerPos = { x: this.player.position.x, z: this.player.position.z };

    // 抽樣報告即時更新
    this.hud.updateTrafficSamplingReport(
      this.trafficSystem.getVehicleSamplingReport(),
      this.trafficSystem.getSamplingRemainingSec(),
      this.trafficSystem.isSamplingActive()
    );

    const nearbyVehicles = [...vehicles]
      .sort(
        (a, b) =>
          Math.hypot(a.x - playerPos.x, a.z - playerPos.z) -
          Math.hypot(b.x - playerPos.x, b.z - playerPos.z)
      )
      .slice(0, 5);

    let listHtml = '';
    for (const v of nearbyVehicles) {
      const dist = Math.hypot(v.x - playerPos.x, v.z - playerPos.z).toFixed(1);
      const p = v.driver.personality;
      const pZh =
        p === 'cautious'
          ? '謹慎'
          : p === 'normal'
          ? '一般'
          : p === 'hurried'
          ? '趕時間'
          : p === 'slow'
          ? '慢吞吞'
          : '計程車';
      const m = v.driver.mood;
      const mZh = m === 'calm' ? '平靜 🟢' : m === 'annoyed' ? '煩躁 🟡' : '生氣 🔴';
      const typeZh = v.type === 'taxi' ? '計程車' : v.type === 'scooter' ? '機車' : '轎車';
      const passCount = v.driver.passengers.length;
      const spd = (v.speed * 3.6).toFixed(0);
      const honkTag = v.driver.isHonking
        ? ' <span style="color:#ef4444;font-weight:bold;">[叭!]</span>'
        : '';
      const speechTag = v.driver.speechBubbleText
        ? `<div style="color:#fde047;font-size:10px;">💬 "${v.driver.speechBubbleText}"</div>`
        : '';
      const taxiTag =
        v.type === 'taxi'
          ? ` (頂燈:${v.roofLightOn ? '亮' : '滅'}, 狀態:${v.taxiState})`
          : '';
      const violTag = v.isViolator
        ? ` <span style="color:#ff6600;font-weight:bold;">[違規: ${v.violationType || '未明'}]</span>`
        : '';

      const borderCol = v.isViolator
        ? '#ff6600'
        : p === 'hurried'
        ? '#ef4444'
        : p === 'cautious'
        ? '#38bdf8'
        : p === 'taxi'
        ? '#facc15'
        : '#22c55e';

      listHtml += `
        <div style="background: rgba(30,41,59,0.7); padding: 4px 6px; border-radius: 4px; margin-bottom: 4px; border-left: 3px solid ${borderCol}; font-size: 11px;">
          <div style="display:flex; justify-content:space-between;">
            <b>${typeZh} [${v.id}]</b>
            <span style="color:#94a3b8;">${dist}m | ${spd} km/h</span>
          </div>
          <div>個性: ${pZh} | 心情: ${mZh} (${v.driver.moodScore.toFixed(0)}分)${honkTag}${violTag}</div>
          <div>狀態: ${v.state} | 乘客: ${passCount}人${taxiTag}</div>
          ${speechTag}
        </div>
      `;
    }

    const html = `
      <div style="margin-bottom: 4px;"><b>活躍車輛</b>：${stats.totalVehicles}輛 (轎:${stats.sedans} 計:${stats.taxis} 機:${stats.scooters}) | <b>乘客</b>：${stats.passengersCount}人</div>
      <div style="margin-bottom: 4px;"><b>個性分佈</b>：謹慎:${stats.cautiousCount} 一般:${stats.normalCount} 趕時間:${stats.hurriedCount} 慢吞吞:${stats.slowCount} 計程車:${stats.taxiDriverCount}</div>
      <div style="margin-bottom: 4px;"><b>心情指數</b>：平靜:${stats.calmMoodCount} 煩躁:${stats.annoyedMoodCount} 生氣:${stats.angryMoodCount} | <b>總鳴笛</b>：${stats.totalHonks}次</div>
      <div style="margin-bottom: 4px;"><b>逆向事件</b>：<span style="color:${stats.wrongWayEvents === 0 ? '#4ade80' : '#ef4444'}; font-weight:bold;">${stats.wrongWayEvents}次</span> (目標 0) | <b>車頭反向</b>：<span style="color:${stats.headOppositeSpeedEvents === 0 ? '#4ade80' : '#ef4444'}; font-weight:bold;">${stats.headOppositeSpeedEvents}次</span> (目標 0)</div>
      <div style="margin-bottom: 4px;"><b>違規統計</b>：${stats.violationsCount.total}次 (${stats.violationRatePercent.toFixed(1)}%) (搶燈:${stats.violationsCount.earlyRedRun}, 超速:${stats.violationsCount.speeding}, 壓線:${stats.violationsCount.pressCrosswalk}, 人行道:${stats.violationsCount.scooterSidewalk})</div>
      <div style="margin-bottom: 6px;"><b>AI 邏輯耗時</b>：${stats.aiTimeMs.toFixed(2)}ms (預算≤0.3ms) | <b>Draw Calls</b>：${stats.drawCalls} (人物≤4)</div>
      <div style="font-weight:700; color:#38bdf8; margin-bottom:4px; border-top:1px solid rgba(148,163,184,0.2); padding-top:4px;">附近車輛 (最近 5 輛)：</div>
      ${listHtml || '<div style="color:#94a3b8;">附近無車輛</div>'}
    `;
    this.hud.updateTrafficDebugContent(html);
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
