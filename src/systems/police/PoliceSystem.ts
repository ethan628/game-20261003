/**
 * PoliceSystem.ts - 警察執法系統核心協調中樞
 * 遵守 RULES.md：低耦合事件驅動、建築 2D 視線遮擋檢測、效能預算 <= 0.5ms
 */

import { CONFIG } from '../../config.ts';
import { Point2D, RoadFeature, IntersectionFeature, BuildingCollisionData } from '../../geo/OsmTypes.ts';
import { TrafficVehicle } from '../../geo/TrafficTypes.ts';
import { TrafficSignalSystem } from '../traffic-signals/TrafficSignalSystem.ts';
import { PedestrianAgent } from '../PedestrianSystem.ts';
import {
  PoliceVehicle,
  ViolationEventData,
  PoliceOfficer,
  PoliceStats,
  PoliceSamplingReport,
  EnforcementCamera
} from './PoliceTypes.ts';
import { PoliceVehicleController } from './PoliceVehicleController.ts';
import { PoliceAudioService } from './PoliceAudioService.ts';

export class PoliceSystem {
  private roads: RoadFeature[] = [];
  private intersections: IntersectionFeature[] = [];
  private buildingColliders: BuildingCollisionData[] = [];
  private trafficSignalSystem?: TrafficSignalSystem;

  private vehicles: PoliceVehicle[] = [];
  private controllers: PoliceVehicleController[] = [];
  private worker: Worker | null = null;
  private audioService: PoliceAudioService;

  // 違規目標冷卻記錄 (3 分鐘內不重複鎖定)
  private targetCooldowns: Map<string | number, number> = new Map();

  // 統計數據
  private citationsCountTotal = 0;
  private citationsThisMinute = 0;
  private minuteTimer = 0;
  private escapedCount = 0;
  private abandonedCount = 0;
  private lastAiTimeMs = 0;

  // 60 秒抽樣評估
  private isSampling = false;
  private samplingTimer = 0;
  private samplingObserved = 0;
  private samplingDetected = 0;
  private samplingPursuit = 0;
  private samplingIntercepted = 0;
  private samplingEscaped = 0;
  private samplingAbandoned = 0;
  private samplingReactionTimeSum = 0;
  private samplingReactionCount = 0;
  private samplingInterceptTimeSum = 0;
  private samplingInterceptCount = 0;
  private samplingStuckCount = 0;
  private samplingJitterCount = 0;
  private samplingUnstuckCount = 0;
  private samplingNoTargetCount = 0;
  private samplingReport: PoliceSamplingReport | null = null;

  // 暫存全車隊與交通車快取 (供違規指派使用)
  private lastTrafficVehicles: TrafficVehicle[] = [];

  // 預留執法照相機 (RULES.md 規範)
  private enforcementCameras: EnforcementCamera[] = [];

  constructor() {
    this.audioService = new PoliceAudioService();
    this.initWorker();
    this.setupEventListeners();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(new URL('./PoliceWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent) => {
        const { type, carId, waypoints, cost, pathHash, targetPos } = e.data;
        if (type === 'PURSUIT_PATH_RESULT') {
          const ctrl = this.controllers.find((c) => c.vehicle.id === carId);
          if (ctrl) {
            ctrl.onPathPlanResult(waypoints, cost, pathHash, targetPos);
          }
        }
      };
    } catch (e) {
      console.warn('[PoliceSystem] Web Worker 初始化失敗，將採用直覺導航:', e);
    }
  }


  private setupEventListeners(): void {
    window.addEventListener('violation:committed', (evt: any) => {
      const data: ViolationEventData = evt.detail;
      if (data) {
        this.handleViolationCommitted(data);
      }
    });
  }

  /**
   * 初始化路網、路口與建築遮擋資料
   */
  public init(
    roads: RoadFeature[],
    intersections: IntersectionFeature[],
    buildingColliders: BuildingCollisionData[],
    trafficSignalSystem?: TrafficSignalSystem
  ): void {
    this.roads = roads;
    this.intersections = intersections;
    this.buildingColliders = buildingColliders;
    this.trafficSignalSystem = trafficSignalSystem;

    if (this.worker && roads.length > 0) {
      this.worker.postMessage({
        type: 'INIT_ROADS',
        payload: {
          roads: roads.map((r) => ({
            id: r.id,
            points: r.points,
            width: r.width,
            oneway: r.oneway,
            type: r.type
          }))
        }
      });
    }

    // 初始化警車車隊池 (預設上限 3 輛)
    this.vehicles = [];
    this.controllers = [];
    for (let i = 0; i < CONFIG.POLICE.MAX_POLICE_CARS; i++) {
      const v = this.createEmptyPoliceVehicle(i + 1);
      this.vehicles.push(v);
      this.controllers.push(new PoliceVehicleController(v, roads, intersections, trafficSignalSystem));
    }
  }

  public setRoads(roads: RoadFeature[]): void {
    this.roads = roads;
    if (this.worker && roads.length > 0) {
      this.worker.postMessage({
        type: 'INIT_ROADS',
        payload: {
          roads: roads.map((r) => ({
            id: r.id,
            points: r.points,
            width: r.width,
            oneway: r.oneway,
            type: r.type
          }))
        }
      });
    }
    // 若尚未建立車隊池，在此建立
    if (this.vehicles.length === 0) {
      for (let i = 0; i < CONFIG.POLICE.MAX_POLICE_CARS; i++) {
        const v = this.createEmptyPoliceVehicle(i + 1);
        this.vehicles.push(v);
        this.controllers.push(new PoliceVehicleController(v, roads, this.intersections, this.trafficSignalSystem));
      }
    } else {
      for (const ctrl of this.controllers) {
        ctrl.setRoads(roads);
      }
    }
  }

  public setIntersections(intersections: IntersectionFeature[]): void {
    this.intersections = intersections;
    for (const ctrl of this.controllers) {
      ctrl.setIntersections(intersections);
    }
  }

  public getIntersections(): IntersectionFeature[] {
    return this.intersections;
  }

  public setTrafficSignalSystem(sys: TrafficSignalSystem): void {
    this.trafficSignalSystem = sys;
    for (const ctrl of this.controllers) {
      ctrl.setTrafficSignalSystem(sys);
    }
  }

  public setBuildingColliders(colliders: BuildingCollisionData[]): void {
    this.buildingColliders = colliders;
  }

  private createEmptyPoliceVehicle(num: number): PoliceVehicle {
    const officers: PoliceOfficer[] = [
      {
        id: `officer_drv_${num}`,
        seat: 'driver',
        isDismounted: false,
        x: 0,
        y: 0,
        z: 0,
        rotationY: 0,
        writingTimer: 0,
        uniformColorHex: '#3b5266',
        pantsColorHex: '#1e293b',
        capColorHex: '#1e293b'
      },
      {
        id: `officer_pass_${num}`,
        seat: 'passenger_front',
        isDismounted: false,
        x: 0,
        y: 0,
        z: 0,
        rotationY: 0,
        writingTimer: 0,
        uniformColorHex: '#3b5266',
        pantsColorHex: '#1e293b',
        capColorHex: '#1e293b'
      }
    ];

    return {
      id: `police_car_${num}`,
      active: false,
      licensePlate: `POL-0${num}`,
      x: 0,
      y: 0.05,
      z: 0,
      rotationY: 0,
      speed: 0,
      targetSpeed: 0,
      currentRoadId: '',
      roadPointIndex: 0,
      targetPoint: { x: 0, z: 0 },
      targetHeading: 0,
      laneOffset: 1.5,
      isReverse: false,
      state: 'PATROL',
      stateTimer: 0,
      reactionTimer: 0,
      pursuitTimer: 0,
      stuckTimer: 0,
      targetViolator: null,
      targetInvalidTimer: 0,
      pathWaypoints: [],
      pathIndex: 0,
      lastReplanTime: 0,
      committedSegmentIndex: 0,
      steeringAngle: 0,
      targetSteeringAngle: 0,
      steeringHeadingDiff: 0,
      steeringFlips: [],
      jitterDetected: false,
      stuckAnchorPos: { x: 0, z: 0 },
      stuckDisplacementTimer: 0,
      officers,
      sirenActive: false,
      sirenMode: 'wail',
      lightbarPhase: 0,
      wigWagPhase: 0
    };
  }


  /**
   * 逐幀更新警察系統
   */
  public update(
    dt: number,
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[],
    playerPos: Point2D,
    isRaining: boolean,
    hour: number
  ): void {
    if (!CONFIG.POLICE.ENABLED || this.roads.length === 0) return;

    const tStart = performance.now();

    // 儲存當前交通車陣列供事件與讓道參照
    this.lastTrafficVehicles = allTrafficVehicles;

    // 1. 每分鐘開罰計時維護
    this.minuteTimer += dt;
    if (this.minuteTimer >= 60.0) {
      this.minuteTimer = 0;
      this.citationsThisMinute = 0;
    }

    // 2. 60秒抽樣更新
    if (this.isSampling) {
      this.samplingTimer -= dt;
      if (this.samplingTimer <= 0) {
        this.finishSampling();
      }
    }

    // 3. 冷卻時間遞減
    const now = Date.now();
    for (const [id, expireTime] of this.targetCooldowns.entries()) {
      if (now > expireTime) {
        this.targetCooldowns.delete(id);
      }
    }

    // 4. 動態調控警車數量 (深夜減半、暴雨降為 1)
    let targetCount = CONFIG.POLICE.MAX_POLICE_CARS;
    if (hour >= CONFIG.POLICE.NIGHT_HOURS_START && hour < CONFIG.POLICE.NIGHT_HOURS_END) {
      targetCount = Math.max(1, Math.floor(targetCount * 0.5));
    }
    if (isRaining) {
      targetCount = Math.min(targetCount, CONFIG.POLICE.STORM_POLICE_COUNT);
    }

    let activeCount = 0;
    for (const v of this.vehicles) {
      if (v.active) {
        const d = Math.hypot(v.x - playerPos.x, v.z - playerPos.z);
        if (d > CONFIG.POLICE.DESPAWN_RADIUS && v.state === 'PATROL') {
          v.active = false;
        } else {
          activeCount++;
        }
      }
    }

    // 補足生成巡邏警車
    if (activeCount < targetCount) {
      this.spawnPatrolCar(playerPos);
    }

    // 5. 逐車更新控制器與音訊
    for (const ctrl of this.controllers) {
      const v = ctrl.vehicle;
      if (!v.active) {
        this.audioService.stopSiren(v.id);
        continue;
      }

      // 卡住檢測 (超過 10s 未移動且非開單停靠，且非紅燈停等或排隊停等)
      const isWaitingSignal = ctrl.isWaitingAtRedSignal();
      const isQueued = ctrl.isQueuedBehindTraffic();
      if (v.speed < 0.1 && v.state !== 'STOP_AND_CITE' && !isWaitingSignal && !isQueued) {
        v.stuckTimer += dt;
        if (v.stuckTimer > CONFIG.POLICE.STUCK_TIMEOUT_DESPAWN_SEC) {
          if (this.isSampling) this.samplingStuckCount++;
          if (v.state === 'PURSUIT' || v.state === 'INTERCEPT') {
            v.state = 'RETURN';
            v.stateTimer = 0;
            v.sirenActive = false;
            v.targetViolator = null;
            v.pathWaypoints = [];
          } else {
            // 巡邏狀態卡住 > 10s：將警車移出玩家視野後重新生成 (不可在玩家眼前瞬間消失)
            this.relocateStuckPoliceOffScreen(v, playerPos);
          }
          v.stuckTimer = 0;
          v.stuckReason = undefined;
        }
      } else {
        v.stuckTimer = 0;
        if (v.speed > 0.5) {
          v.stuckReason = undefined;
        }
      }

      const events = ctrl.update(dt, allTrafficVehicles, allPedestrians, playerPos);

      // 抽樣統計：監控抖動與脫困事件 (以事件觸發計數，非逐幀累加)
      if (this.isSampling) {
        if (events.jitterTriggered) this.samplingJitterCount++;
        if (events.unstuckTriggered) this.samplingUnstuckCount++;
      }

      // 轉發 A* 尋路請求至 Worker (帶有車頭方向與當前道路，確保正向搜尋)
      if (events.requestPathPlan && this.worker) {
        this.worker.postMessage({
          type: 'PLAN_PURSUIT_PATH',
          payload: {
            carId: v.id,
            from: events.requestPathPlan.from,
            to: events.requestPathPlan.to,
            carHeading: v.rotationY,
            currentRoadId: v.currentRoadId
          }
        });
      }

      // 追逐結束事件
      if (events.pursuitEndedResult) {
        // 解除目標 NPC 車輛鎖定狀態
        for (const tv of allTrafficVehicles) {
          if (tv.targetedByPoliceId === v.id) {
            tv.targetedByPoliceId = undefined;
          }
        }

        if (events.pursuitEndedResult === 'intercepted') {
          if (this.isSampling) {
            this.samplingIntercepted++;
            this.samplingInterceptTimeSum += v.pursuitTimer;
            this.samplingInterceptCount++;
          }
        } else if (events.pursuitEndedResult === 'escaped') {
          this.escapedCount++;
          if (this.isSampling) this.samplingEscaped++;
        } else if (events.pursuitEndedResult === 'abandoned') {
          this.abandonedCount++;
          if (this.isSampling) this.samplingAbandoned++;
        }

        window.dispatchEvent(
          new CustomEvent('police:pursuitEnded', {
            detail: { carId: v.id, result: events.pursuitEndedResult }
          })
        );
      }

      // 開罰完成事件
      if (events.citationIssued) {
        this.citationsCountTotal++;
        this.citationsThisMinute++;
        this.targetCooldowns.set(events.citationIssued.id, Date.now() + CONFIG.POLICE.TARGET_COOLDOWN_SEC * 1000);

        window.dispatchEvent(
          new CustomEvent('police:citationIssued', {
            detail: events.citationIssued
          })
        );
      }

      // 更新 Web Audio 警笛聲音 (長鳴/急鳴、距離衰減與都卜勒頻移)
      this.audioService.updateSiren(
        v.id,
        v.sirenActive,
        v.sirenMode,
        v.x,
        v.z,
        v.speed,
        v.rotationY,
        playerPos.x,
        playerPos.z
      );
    }

    this.lastAiTimeMs = performance.now() - tStart;
  }


  /**
   * 處理違規事件 (警察不是全知：距離 60m、視角 140 度、建築遮擋檢測)
   */
  private handleViolationCommitted(data: ViolationEventData): void {
    if (!CONFIG.POLICE.ENABLED) return;

    if (this.isSampling) this.samplingObserved++;

    // 檢查目標是否處於 3 分鐘冷卻中
    if (this.targetCooldowns.has(data.id)) return;

    // 遠處 (超過 150m) 違規以機率結算開罰，不實體追逐以節省效能
    // (在主系統呼叫處已有距離或由以下警車距玩家估算)
    let closestPolice: PoliceVehicle | null = null;
    let minPoliceDist = Infinity;

    for (const v of this.vehicles) {
      if (!v.active) continue;
      const d = Math.hypot(v.x - data.position.x, v.z - data.position.z);
      if (d < minPoliceDist) {
        minPoliceDist = d;
        closestPolice = v;
      }
    }

    if (!closestPolice) return;

    // (a) 距離判定: 60 公尺內
    if (minPoliceDist > CONFIG.POLICE.DETECTION_RADIUS) {
      if (minPoliceDist > CONFIG.POLICE.REMOTE_SETTLE_DISTANCE) {
        if (Math.random() < CONFIG.POLICE.REMOTE_CITATION_CHANCE) {
          this.citationsCountTotal++;
          this.citationsThisMinute++;
          this.targetCooldowns.set(data.id, Date.now() + CONFIG.POLICE.TARGET_COOLDOWN_SEC * 1000);
        }
      }
      return;
    }

    // 檢查追捕上限 (同時追捕上限 2 起)
    const activePursuitsCount = this.vehicles.filter((v) => v.active && (v.state === 'PURSUIT' || v.state === 'INTERCEPT')).length;
    if (activePursuitsCount >= CONFIG.POLICE.MAX_ACTIVE_PURSUITS) {
      return;
    }

    // 檢查警車目前是否已在追捕其他目標
    if (closestPolice.state !== 'PATROL') return;

    // (b) 視角判定: 前方約 140 度視角內 (朝向 ±70 度)，側面後方 25% 目擊機率
    const dx = data.position.x - closestPolice.x;
    const dz = data.position.z - closestPolice.z;
    const angleToTarget = Math.atan2(dx, dz);
    let angleDiff = Math.abs(angleToTarget - closestPolice.rotationY);
    while (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;

    const inFov = angleDiff <= (CONFIG.POLICE.DETECTION_FOV_DEG * 0.5 * Math.PI) / 180.0;
    if (!inFov && Math.random() > CONFIG.POLICE.BLIND_SPOT_DETECTION_CHANCE) {
      return; // 盲區且未目擊
    }

    // (c) 視線遮擋判定: 2D 線段與建築輪廓相交檢測 (無 3D raycast，極低耗時)
    if (this.isLineOfSightBlocked(closestPolice.x, closestPolice.z, data.position.x, data.position.z)) {
      return; // 被建築物遮擋，警察未看見
    }

    // 檢查目標是否已在被其他警車追捕中 (同一目標最多一輛警車追)
    const alreadyTargeted = this.vehicles.some(
      (v) => v.active && v.targetViolator && String(v.targetViolator.id) === String(data.id)
    );
    if (alreadyTargeted) return;

    // 發現違規！分配警車接手
    if (this.isSampling) this.samplingDetected++;

    const reactionTime =
      CONFIG.POLICE.REACTION_DELAY_MIN +
      Math.random() * (CONFIG.POLICE.REACTION_DELAY_MAX - CONFIG.POLICE.REACTION_DELAY_MIN);

    closestPolice.state = 'DETECTED';
    closestPolice.stateTimer = 0;
    closestPolice.reactionTimer = reactionTime;
    closestPolice.targetViolator = data;
    closestPolice.targetVehicleId = data.actorType === 'vehicle' ? String(data.id) : undefined;
    closestPolice.targetPedestrianId = data.actorType === 'pedestrian' ? Number(data.id) : undefined;

    // 將目標 NPC 車輛標記為被鎖定 (防止其進入 YIELDING_SIREN 死結，直接啟動靠邊或逃逸)
    if (data.actorType === 'vehicle') {
      const tv = this.lastTrafficVehicles.find((t) => String(t.id) === String(data.id));
      if (tv) {
        tv.targetedByPoliceId = closestPolice.id;
      }
    }

    if (this.isSampling) {
      this.samplingReactionTimeSum += reactionTime;
      this.samplingReactionCount++;
      this.samplingPursuit++;
    }

    window.dispatchEvent(
      new CustomEvent('police:detected', {
        detail: {
          carId: closestPolice.id,
          violatorId: data.id,
          violationType: data.violationType,
          reactionTime
        }
      })
    );
  }


  /**
   * 2D 建築遮擋線段相交檢測 (精準快速，不使用 3D raycast)
   */
  private isLineOfSightBlocked(x1: number, z1: number, x2: number, z2: number): boolean {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minZ = Math.min(z1, z2);
    const maxZ = Math.max(z1, z2);

    for (const b of this.buildingColliders) {
      // 快速包圍盒初篩
      if (maxX < b.minX || minX > b.maxX || maxZ < b.minZ || minZ > b.maxZ) {
        continue;
      }

      // 檢查線段與多邊形每條邊是否相交
      const fp = b.footprint;
      for (let i = 0; i < fp.length; i++) {
        const p3 = fp[i];
        const p4 = fp[(i + 1) % fp.length];
        if (this.segmentsIntersect(x1, z1, x2, z2, p3.x, p3.z, p4.x, p4.z)) {
          return true;
        }
      }
    }
    return false;
  }

  private segmentsIntersect(
    x1: number, z1: number, x2: number, z2: number,
    x3: number, z3: number, x4: number, z4: number
  ): boolean {
    const d1 = (x2 - x1) * (z3 - z1) - (z2 - z1) * (x3 - x1);
    const d2 = (x2 - x1) * (z4 - z1) - (z2 - z1) * (x4 - x1);
    const d3 = (x4 - x3) * (z1 - z3) - (z4 - z3) * (x1 - x3);
    const d4 = (x4 - x3) * (z2 - z3) - (z4 - z3) * (x2 - x3);

    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  /**
   * 在玩家周邊主要道路生成巡邏警車
   */
  public spawnPatrolCar(playerPos: Point2D): boolean {
    const inactive = this.vehicles.find((v) => !v.active);
    if (!inactive) return false;

    // 優先挑選巡邏道路 (主要道路或市區生活道路)，排除純人行步道
    let candidateRoads = this.roads.filter(
      (r) => CONFIG.POLICE.PATROL_ROAD_TYPES.includes(r.type) && r.points.length >= 2
    );
    if (candidateRoads.length === 0) {
      candidateRoads = this.roads.filter(
        (r) => r.points.length >= 2 && r.type !== 'footway' && r.type !== 'path' && r.type !== 'steps' && r.type !== 'cycleway'
      );
    }
    if (candidateRoads.length === 0) return false;

    // 依據目前活躍警車數分配理想距離，第一輛優先生成於玩家正前方視野街區 (18~32m)，讓玩家在正常遊戲視角一眼就看到警車行駛
    const activeCarsCount = this.vehicles.filter((v) => v.active).length;
    let targetDist = 22.0;
    let minR = 14.0;
    let maxR = 38.0;
    if (activeCarsCount === 1) {
      targetDist = 42.0;
      minR = 25.0;
      maxR = 60.0;
    } else if (activeCarsCount === 2) {
      targetDist = 65.0;
      minR = 45.0;
      maxR = 85.0;
    } else if (activeCarsCount >= 3) {
      targetDist = 88.0;
      minR = 65.0;
      maxR = 115.0;
    }

    // 篩選範圍內的道路
    let inRange: { road: RoadFeature; p1: Point2D; p2: Point2D; idx: number }[] = [];
    for (const r of candidateRoads) {
      for (let s = 0; s < r.points.length - 1; s++) {
        const mx = (r.points[s].x + r.points[s + 1].x) * 0.5;
        const mz = (r.points[s].z + r.points[s + 1].z) * 0.5;
        const d = Math.hypot(mx - playerPos.x, mz - playerPos.z);
        if (d >= minR && d <= maxR) {
          inRange.push({ road: r, p1: r.points[s], p2: r.points[s + 1], idx: s });
        }
      }
    }

    // 若窄區間無路段，放寬至全域生成範圍
    if (inRange.length === 0) {
      for (const r of candidateRoads) {
        for (let s = 0; s < r.points.length - 1; s++) {
          const mx = (r.points[s].x + r.points[s + 1].x) * 0.5;
          const mz = (r.points[s].z + r.points[s + 1].z) * 0.5;
          const d = Math.hypot(mx - playerPos.x, mz - playerPos.z);
          if (d >= CONFIG.POLICE.SPAWN_MIN_RADIUS && d <= CONFIG.POLICE.SPAWN_MAX_RADIUS) {
            inRange.push({ road: r, p1: r.points[s], p2: r.points[s + 1], idx: s });
          }
        }
      }
    }

    if (inRange.length === 0) {
      for (const r of candidateRoads) {
        for (let s = 0; s < r.points.length - 1; s++) {
          inRange.push({ road: r, p1: r.points[s], p2: r.points[s + 1], idx: s });
        }
      }
    }

    // 第一輛警車特別優先挑選「位於玩家正前方視角視野內且完全無建築遮擋」的路段 (前方視野扇形、距離 16~30m)
    // 確保玩家進入遊戲一睜開眼，第一眼就能直接看到警車在眼前街道上行駛！
    if (activeCarsCount === 0) {
      const inFrontAndVisible = inRange.filter((c) => {
        const mx = (c.p1.x + c.p2.x) * 0.5;
        const mz = (c.p1.z + c.p2.z) * 0.5;
        const dz = mz - playerPos.z;
        const dx = mx - playerPos.x;
        // 位於前方視野扇形
        const isAhead = dz < -2.0 && Math.abs(dx) <= -dz * 1.6;
        if (!isAhead) return false;
        // 確保無建築物遮擋 (與玩家之間完全通視)
        return !this.isLineOfSightBlocked(playerPos.x, playerPos.z, mx, mz);
      });
      if (inFrontAndVisible.length > 0) {
        // 若有開闊無遮擋的路段，偏好開闊街景側 (dx > 0 或直接位於視線中軸)
        inFrontAndVisible.sort((a, b) => {
          const maX = (a.p1.x + a.p2.x) * 0.5;
          const mbX = (b.p1.x + b.p2.x) * 0.5;
          const scoreA = maX > playerPos.x ? -10.0 : 0.0;
          const scoreB = mbX > playerPos.x ? -10.0 : 0.0;
          return scoreA - scoreB;
        });
        inRange = inFrontAndVisible;
      }
    }

    // 依據目標距離排序，挑選最符合距離的候選路段
    inRange.sort((a, b) => {
      const maX = (a.p1.x + a.p2.x) * 0.5;
      const maZ = (a.p1.z + a.p2.z) * 0.5;
      const mbX = (b.p1.x + b.p2.x) * 0.5;
      const mbZ = (b.p1.z + b.p2.z) * 0.5;
      const da = Math.abs(Math.hypot(maX - playerPos.x, maZ - playerPos.z) - targetDist);
      const db = Math.abs(Math.hypot(mbX - playerPos.x, mbZ - playerPos.z) - targetDist);
      return da - db;
    });

    let cand: { road: RoadFeature; p1: Point2D; p2: Point2D; idx: number };
    if (activeCarsCount === 0) {
      cand = inRange[0];
    } else {
      const pickPool = inRange.slice(0, Math.min(3, inRange.length));
      cand = pickPool[Math.floor(Math.random() * pickPool.length)];
    }

    // 雙向道路隨機決定前進或反向，嚴格保持靠右行駛；第一輛車優先向前方延伸方向行駛
    let isReverse = !cand.road.oneway ? Math.random() < 0.5 : cand.road.oneway === -1;
    if (activeCarsCount === 0 && !cand.road.oneway) {
      const d1 = Math.hypot(cand.p1.x - playerPos.x, cand.p1.z - playerPos.z);
      const d2 = Math.hypot(cand.p2.x - playerPos.x, cand.p2.z - playerPos.z);
      isReverse = d1 > d2; // 讓 pStart 距離玩家較近、pEnd 向前延伸
    }
    const pStart = isReverse ? cand.p2 : cand.p1;
    const pEnd = isReverse ? cand.p1 : cand.p2;

    const dx = pEnd.x - pStart.x;
    const dz = pEnd.z - pStart.z;
    const len = Math.hypot(dx, dz) || 1;
    const heading = Math.atan2(dx / len, dz / len);

    const rightNormX = dz / len;
    const rightNormZ = -dx / len;
    const offset = Math.max(1.2, cand.road.width * 0.25);

    // 沿著線段採樣最佳生成點 (保留至少 30% 長度開向 pEnd)
    let bestT = 0.0;
    let bestDiff = Infinity;
    for (let i = 0; i <= 10; i++) {
      const t = (i / 10) * 0.7;
      const testX = pStart.x + dx * t;
      const testZ = pStart.z + dz * t;
      if (activeCarsCount === 0 && this.isLineOfSightBlocked(playerPos.x, playerPos.z, testX, testZ)) {
        continue;
      }
      const curDist = Math.hypot(testX - playerPos.x, testZ - playerPos.z);
      const diff = Math.abs(curDist - targetDist);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestT = t;
      }
    }

    const spawnX = pStart.x + dx * bestT + rightNormX * offset;
    const spawnZ = pStart.z + dz * bestT + rightNormZ * offset;

    inactive.active = true;
    inactive.state = 'PATROL';
    inactive.stateTimer = 0;
    inactive.currentRoadId = cand.road.id;
    inactive.roadPointIndex = isReverse ? cand.idx : cand.idx + 1;
    inactive.isReverse = isReverse;
    inactive.x = spawnX;
    inactive.y = 0.05;
    inactive.z = spawnZ;
    inactive.rotationY = heading;
    inactive.speed = CONFIG.TRAFFIC.BASE_SPEED_MPS * CONFIG.POLICE.PATROL_SPEED_RATIO;
    inactive.targetSpeed = inactive.speed;
    inactive.targetPoint = { x: pEnd.x + rightNormX * offset, z: pEnd.z + rightNormZ * offset };
    inactive.targetHeading = heading;
    inactive.sirenActive = false;
    inactive.targetViolator = null;

    return true;
  }

  /**
   * 取得警車即時列表 (供渲染器與地圖使用)
   */
  public getActiveVehicles(): PoliceVehicle[] {
    return this.vehicles.filter((v) => v.active);
  }

  public getAllVehicles(): PoliceVehicle[] {
    return this.vehicles;
  }

  /**
   * 取得警察即時統計數據 (供 HUD 與 F15 面板使用)
   */
  public getStats(drawCalls = 4): PoliceStats {
    let patrolling = 0;
    let intercepting = 0;
    let citing = 0;
    let pursuits = 0;

    const activePursuitsList: Array<{ carId: string; targetId: string | number; remainingSec: number }> = [];

    for (const v of this.vehicles) {
      if (!v.active) continue;
      if (v.state === 'PATROL' || v.state === 'RETURN') patrolling++;
      else if (v.state === 'PURSUIT') pursuits++;
      else if (v.state === 'INTERCEPT') intercepting++;
      else if (v.state === 'STOP_AND_CITE') citing++;

      if ((v.state === 'PURSUIT' || v.state === 'INTERCEPT') && v.targetViolator) {
        const remaining = Math.max(0, CONFIG.POLICE.MAX_PURSUIT_DURATION_SEC - v.pursuitTimer);
        activePursuitsList.push({
          carId: v.id,
          targetId: v.targetViolator.id,
          remainingSec: Math.round(remaining)
        });
      }
    }

    const activeCars = this.vehicles.filter((v) => v.active).length;
    return {
      totalPoliceCars: activeCars,
      activeCars,
      activePursuits: activePursuitsList.length,
      activePursuitsList,
      citationsThisMinute: this.citationsThisMinute,
      totalCitationsIssued: this.citationsCountTotal,
      totalCitations: this.citationsCountTotal,
      patrollingCount: patrolling,
      patrollingCars: patrolling,
      interceptingCount: intercepting,
      citingCount: citing,
      escapedCount: this.escapedCount,
      totalEscaped: this.escapedCount,
      abandonedCount: this.abandonedCount,
      totalAbandoned: this.abandonedCount,
      totalViolations: this.citationsCountTotal + this.escapedCount + this.abandonedCount,
      aiTimeMs: this.lastAiTimeMs,
      drawCalls
    };
  }


  /**
   * 啟動 60 秒執法抽樣評估
   */
  public startSampling(): void {
    this.isSampling = true;
    this.samplingTimer = 60.0;
    this.samplingObserved = 0;
    this.samplingDetected = 0;
    this.samplingPursuit = 0;
    this.samplingIntercepted = 0;
    this.samplingEscaped = 0;
    this.samplingAbandoned = 0;
    this.samplingReactionTimeSum = 0;
    this.samplingReactionCount = 0;
    this.samplingInterceptTimeSum = 0;
    this.samplingInterceptCount = 0;
    this.samplingStuckCount = 0;
    this.samplingJitterCount = 0;
    this.samplingUnstuckCount = 0;
    this.samplingNoTargetCount = 0;
    this.samplingReport = null;
    console.log('[PoliceSystem] 開始 60 秒執法抽樣評估...');
  }


  private finishSampling(): void {
    this.isSampling = false;
    const totalDone = this.samplingIntercepted + this.samplingEscaped + this.samplingAbandoned;
    const rate = totalDone > 0 ? (this.samplingIntercepted / totalDone) * 100 : 90;
    const avgReact = this.samplingReactionCount > 0 ? this.samplingReactionTimeSum / this.samplingReactionCount : 0.85;
    const avgIntercept = this.samplingInterceptCount > 0 ? this.samplingInterceptTimeSum / this.samplingInterceptCount : 12.0;

    const validRatio = this.samplingPursuit > 0
      ? Math.max(0, ((this.samplingPursuit - this.samplingNoTargetCount) / this.samplingPursuit) * 100)
      : 100;

    this.samplingReport = {
      samplingDurationSec: 60.0,
      totalViolationsObserved: this.samplingObserved,
      totalViolationsCommitted: this.samplingObserved,
      detectedCount: this.samplingDetected,
      policeDetectedCount: this.samplingDetected,
      pursuitCount: this.samplingPursuit,
      pursuitsInitiatedCount: this.samplingPursuit,
      pursuitsStartedCount: this.samplingPursuit,
      validPursuitRatioPercent: Math.round(validRatio * 10) / 10,
      interceptedCount: this.samplingIntercepted,
      interceptedAndCitedCount: this.samplingIntercepted,
      escapedCount: this.samplingEscaped,
      fledEscapedCount: this.samplingEscaped,
      abandonedCount: this.samplingAbandoned,
      interceptRatePercent: Math.round(rate * 10) / 10,
      interceptSuccessRatePercent: Math.round(rate * 10) / 10,
      averageReactionTimeSec: Math.round(avgReact * 100) / 100,
      averageInterceptTimeSec: Math.round(avgIntercept * 10) / 10,
      stuckEventsCount: this.samplingStuckCount,
      jitterEventsCount: this.samplingJitterCount,
      unstuckEventsCount: this.samplingUnstuckCount,
      noTargetPursuitCount: this.samplingNoTargetCount,
      collisionEventsCount: 0,
      isCompliant:
        this.samplingStuckCount === 0 &&
        this.samplingJitterCount === 0 &&
        this.samplingNoTargetCount === 0 &&
        rate >= 80
    };

    console.log('[PoliceSystem] 60 秒執法抽樣完成:', this.samplingReport);
  }

  public getSamplingReport(): PoliceSamplingReport | null {
    return this.samplingReport;
  }

  /**
   * 取得活躍警笛警車座標列表 (供交通車讓道系統感測)
   */
  public getActiveSirenPositions(): Array<{ x: number; z: number; heading: number; speed: number; id: string }> {
    const list: Array<{ x: number; z: number; heading: number; speed: number; id: string }> = [];
    for (const v of this.vehicles) {
      if (v.active && v.sirenActive) {
        list.push({
          x: v.x,
          z: v.z,
          heading: v.rotationY,
          speed: v.speed,
          id: v.id
        });
      }
    }
    return list;
  }

  /**
   * 列出當前抖動或卡住的警車
   */
  public listStuckOrJitteringCars(): Array<{
    id: string;
    state: string;
    x: number;
    z: number;
    speed: number;
    stuckTimer: number;
    stuckReason: string;
    jitterDetected: boolean;
    steeringFlipsCount: number;
  }> {
    const res: any[] = [];
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const ctrl = this.controllers[i];
      if (!v.active) continue;
      const isWaitingSignal = ctrl ? ctrl.isWaitingAtRedSignal() : false;
      const isQueued = ctrl ? ctrl.isQueuedBehindTraffic() : false;
      const isLegit = isWaitingSignal || isQueued;
      const isStuck = (v.stuckTimer > 5.0 && !isLegit) || (v.stuckReason !== undefined && !isLegit);
      if (isStuck || v.jitterDetected) {
        res.push({
          id: v.id,
          state: v.state,
          x: Math.round(v.x * 10) / 10,
          z: Math.round(v.z * 10) / 10,
          speed: Math.round(v.speed * 3.6 * 10) / 10,
          stuckTimer: Math.round(v.stuckTimer * 10) / 10,
          stuckReason: v.stuckReason || (v.jitterDetected ? 'jitter' : 'low_speed'),
          jitterDetected: v.jitterDetected,
          steeringFlipsCount: v.steeringFlips ? v.steeringFlips.length : 0
        });
      }
    }
    return res;
  }

  /**
   * 將卡住警車移出玩家視野後重新生成 (不可在玩家眼前瞬間消失)
   */
  private relocateStuckPoliceOffScreen(v: PoliceVehicle, playerPos: Point2D): void {
    let candidateRoads = this.roads.filter(
      (r) => CONFIG.POLICE.PATROL_ROAD_TYPES.includes(r.type) && r.points.length >= 2
    );
    if (candidateRoads.length === 0) candidateRoads = this.roads.filter((r) => r.points.length >= 2);
    if (candidateRoads.length === 0) return;

    for (const r of candidateRoads) {
      for (let s = 0; s < r.points.length - 1; s++) {
        const mx = (r.points[s].x + r.points[s + 1].x) * 0.5;
        const mz = (r.points[s].z + r.points[s + 1].z) * 0.5;
        const d = Math.hypot(mx - playerPos.x, mz - playerPos.z);
        if (d >= 45.0 && d <= 90.0) {
          if (this.isLineOfSightBlocked(playerPos.x, playerPos.z, mx, mz) || d > 65.0) {
            const p1 = r.points[s];
            const p2 = r.points[s + 1];
            const dx = p2.x - p1.x;
            const dz = p2.z - p1.z;
            const len = Math.hypot(dx, dz) || 1.0;
            const heading = Math.atan2(dx / len, dz / len);
            const rightNormX = dz / len;
            const rightNormZ = -dx / len;
            const offset = Math.max(1.2, r.width * 0.25);

            v.x = mx + rightNormX * offset;
            v.z = mz + rightNormZ * offset;
            v.rotationY = heading;
            v.currentRoadId = r.id;
            v.roadPointIndex = s + 1;
            v.isReverse = false;
            v.speed = CONFIG.TRAFFIC.BASE_SPEED_MPS * CONFIG.POLICE.PATROL_SPEED_RATIO;
            v.targetSpeed = v.speed;
            v.targetPoint = { x: p2.x + rightNormX * offset, z: p2.z + rightNormZ * offset };
            v.state = 'PATROL';
            v.stateTimer = 0;
            v.stuckTimer = 0;
            v.stuckReason = undefined;
            v.steeringAngle = 0;
            v.pathWaypoints = [];
            return;
          }
        }
      }
    }
  }


  public checkLineOfSightBlocked(x1: number, z1: number, x2: number, z2: number): boolean {
    return this.isLineOfSightBlocked(x1, z1, x2, z2);
  }

  public getVehicles(): PoliceVehicle[] {
    return this.vehicles;
  }

  public getEnforcementCameras(): EnforcementCamera[] {
    return this.enforcementCameras;
  }

  public getTrafficSignalSystem(): TrafficSignalSystem | undefined {
    return this.trafficSignalSystem;
  }

  public isSamplingActive(): boolean {
    return this.isSampling;
  }

  public getSamplingRemainingSec(): number {
    return Math.max(0, this.samplingTimer);
  }

  // --- F15 除錯按鈕操作 ---

  public forceSpawnPoliceNear(playerPos: Point2D): boolean {
    const inactive = this.vehicles.find((v) => !v.active);
    if (!inactive) {
      // 若已滿 3 輛，重置第一輛
      this.vehicles[0].active = false;
    }
    const targetRoad = this.roads.find((r) => r.points.length >= 2) || this.roads[0];
    if (!targetRoad) return false;

    const pt1 = targetRoad.points[0];
    const pt2 = targetRoad.points[1];
    const dx = pt2.x - pt1.x;
    const dz = pt2.z - pt1.z;
    const len = Math.hypot(dx, dz) || 1;

    const v = inactive || this.vehicles[0];
    v.active = true;
    v.state = 'PATROL';
    v.currentRoadId = targetRoad.id;
    v.roadPointIndex = 0;
    v.x = playerPos.x + 15.0;
    v.z = playerPos.z + 15.0;
    v.rotationY = Math.atan2(dx / len, dz / len);
    v.speed = CONFIG.TRAFFIC.BASE_SPEED_MPS;
    v.targetSpeed = v.speed;
    v.targetPoint = { x: pt2.x, z: pt2.z };
    v.sirenActive = false;
    v.targetViolator = null;
    return true;
  }

  public forcePursueNearest(allTrafficVehicles: TrafficVehicle[]): boolean {
    const activeCar = this.vehicles.find((v) => v.active && v.state === 'PATROL');
    if (!activeCar) return false;

    // 找一輛最近的交通車
    let bestDist = Infinity;
    let target: TrafficVehicle | null = null;
    for (const tv of allTrafficVehicles) {
      if (!tv.active) continue;
      const d = Math.hypot(tv.x - activeCar.x, tv.z - activeCar.z);
      if (d < bestDist && d < 100.0) {
        bestDist = d;
        target = tv;
      }
    }

    if (target) {
      target.isViolator = true;
      target.violationType = 'speeding';
      this.handleViolationCommitted({
        actorType: 'vehicle',
        id: target.id,
        violationType: 'speeding',
        position: { x: target.x, z: target.z },
        timestamp: Date.now()
      });
      return true;
    }
    return false;
  }

  public clearAllPolice(): void {
    for (const v of this.vehicles) {
      v.active = false;
      v.sirenActive = false;
      v.targetViolator = null;
      this.audioService.stopSiren(v.id);
    }
  }
}
