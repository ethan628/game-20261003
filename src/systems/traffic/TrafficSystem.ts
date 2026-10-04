/**
 * TrafficSystem.ts - NPC 交通車流、AI 車輛控制器與駕駛/乘客全域管理系統
 * 遵循 RULES.md：
 * 1. 純邏輯運算與狀態機，不依賴 Three.js 渲染物件
 * 2. 嚴格效能預算：CPU 耗時每幀 <= 0.3 ms (僅對 90m 內駕駛做細節反應)
 * 3. 整合交通號誌系統公開介面 (getVehicleState) 判定綠/黃/紅燈
 * 4. 整合行人系統：禮讓行人、計程車叫車/載客/下車、駕駛彈出轉為逃跑行人
 */

import { Point2D, RoadFeature, IntersectionFeature, IntersectionApproach, StopLine } from '../../geo/OsmTypes.ts';
import {
  VehicleType,
  DriverPersonalityType,
  DriverAppearance,
  DriverNPC,
  PassengerNPC,
  TrafficVehicle,
  TrafficSystemStats,
  StopLineMeasurement,
  StopLineStats,
  VehicleSamplingReport
} from '../../geo/TrafficTypes.ts';
import { CONFIG } from '../../config.ts';
import { TrafficSignalSystem } from '../traffic-signals/TrafficSignalSystem.ts';
import { PedestrianSystem } from '../PedestrianSystem.ts';

type TrafficEventCallback = (payload: any) => void;

export class TrafficSystem {
  private roads: RoadFeature[] = [];
  private intersections: IntersectionFeature[] = [];
  private vehicles: TrafficVehicle[] = [];
  private maxVehicles = CONFIG.TRAFFIC.MAX_VEHICLES;

  private trafficSignalSystem: TrafficSignalSystem | null = null;
  private pedestrianSystem: PedestrianSystem | null = null;

  private eventListeners: Map<string, Set<TrafficEventCallback>> = new Map();

  private lastAiTimeMs = 0;
  private honksThisFrame = 0;
  private totalHonks = 0;
  private idCounter = 1;

  // 逆向與違規統計 (RULES.md / config.npcBehavior)
  private wrongWayEvents = 0;
  private headOppositeSpeedEvents = 0;
  private vehicleViolationsStats = {
    earlyRedRun: 0,
    speeding: 0,
    pressCrosswalk: 0,
    scooterSidewalk: 0,
    total: 0
  };

  // 60 秒行為抽樣
  private vehicleSamplingActive = false;
  private vehicleSamplingTimer = 0;
  private vehicleSamplingSpeedSum = 0;
  private vehicleSamplingSpeedSeconds = 0;
  private vehicleSamplingInitialWrongWay = 0;
  private vehicleSamplingInitialOpposite = 0;
  private vehicleSamplingInitialViolations = {
    earlyRedRun: 0,
    speeding: 0,
    pressCrosswalk: 0,
    scooterSidewalk: 0,
    total: 0
  };
  private vehicleSamplingReport: VehicleSamplingReport | null = null;

  constructor() {
    this.initPool();
  }

  private initPool(): void {
    this.vehicles = [];
    for (let i = 0; i < this.maxVehicles; i++) {
      this.vehicles.push(this.createEmptyVehicle(i));
    }
  }

  private createEmptyVehicle(idNum: number): TrafficVehicle {
    const id = `veh_${idNum}`;
    const driver: DriverNPC = {
      id: `driver_${idNum}`,
      appearance: {
        skinColorHex: '#f8d5b8',
        shirtColorHex: '#38bdf8',
        hairColorHex: '#1e1b18',
        hatType: 'none',
        helmetColorHex: '#ffffff',
        hasMask: false,
        hasRaincoat: false,
        raincoatColorHex: '#fef08a'
      },
      personality: 'normal',
      mood: 'calm',
      moodScore: 10,
      vehicleId: id,
      seat: 'driver',
      passengers: [],
      isEjected: false,
      honkCooldown: 0,
      honkCountTotal: 0,
      waitTimer: 0,
      isHonking: false,
      honkSoundTimer: 0,
      steeringAngle: 0,
      headTurnAngle: 0,
      lookPhoneTimer: 0,
      leanAngle: 0,
      footDown: false
    };

    return {
      id,
      type: 'sedan',
      active: false,
      x: 0,
      y: 0.1,
      z: 0,
      rotationY: 0,
      speed: 0,
      targetSpeed: 0,
      currentRoadId: '',
      roadPointIndex: 0,
      targetPoint: { x: 0, z: 0 },
      targetHeading: 0,
      laneOffset: 1.5,
      laneIndex: 0,
      isReverse: false,
      state: 'DRIVING',
      stateTimer: 0,
      blockedTimer: 0,
      taxiState: 'EMPTY_CRUISING',
      tripTimer: 0,
      roofLightOn: true,
      brakeLightsOn: false,
      headlightsOn: true,
      highBeamsOn: false,
      turnSignal: 'none',
      turnSignalTimer: 0,
      driver,
      bodyColorHex: '#38bdf8'
    };
  }

  public setRoadsAndIntersections(roads: RoadFeature[], intersections: IntersectionFeature[]): void {
    // 篩選可通行車輛之道路 (排除鐵路與過窄步道)
    this.roads = roads.filter((r) => !r.isRailway && r.points.length >= 2 && r.width >= 3.0);
    this.intersections = intersections;

    // 清空現有車輛
    for (const v of this.vehicles) {
      v.active = false;
    }
  }

  public setTrafficSignalSystem(sys: TrafficSignalSystem): void {
    this.trafficSignalSystem = sys;
  }

  public setPedestrianSystem(sys: PedestrianSystem): void {
    this.pedestrianSystem = sys;
  }

  public getVehicles(): TrafficVehicle[] {
    return this.vehicles;
  }

  public getActiveVehicles(): TrafficVehicle[] {
    return this.vehicles.filter((v) => v.active);
  }

  /**
   * 事件訂閱
   */
  public on(event: string, cb: TrafficEventCallback): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(cb);
  }

  public emit(event: string, payload: any): void {
    const list = this.eventListeners.get(event);
    if (list) {
      for (const cb of list) cb(payload);
    }
  }

  /**
   * 抽選駕駛個性 (依 config.ts 權重)
   */
  private pickPersonality(vType: VehicleType): DriverPersonalityType {
    if (vType === 'taxi') return 'taxi';
    const rand = Math.random();
    if (rand < 0.25) return 'cautious'; // 25%
    if (rand < 0.65) return 'normal';   // 40%
    if (rand < 0.80) return 'hurried';  // 15%
    if (rand < 0.90) return 'slow';     // 10%
    return 'normal';
  }

  /**
   * 隨機生成外觀
   */
  private generateAppearance(vType: VehicleType, isDriver: boolean, isRaining: boolean): DriverAppearance {
    const colors = CONFIG.PEDESTRIAN.COLORS;
    const skin = colors.SKINS[Math.floor(Math.random() * colors.SKINS.length)];
    const hair = colors.HAIRS[Math.floor(Math.random() * colors.HAIRS.length)];
    const shirt = colors.SHIRTS[Math.floor(Math.random() * colors.SHIRTS.length)];

    let hatType: DriverAppearance['hatType'] = 'none';
    let helmetColor = '#ffffff';
    let hasRaincoat = false;
    let raincoatColor = CONFIG.DRIVERS.ACCESSORIES.RAINCOAT_COLORS[0];

    if (vType === 'scooter') {
      // 機車騎士與乘客：安全帽隨機 (半罩、全罩、工程帽造型各一種)
      const hRand = Math.random();
      if (hRand < 0.40) hatType = 'helmet_half';
      else if (hRand < 0.75) hatType = 'helmet_full';
      else hatType = 'helmet_worker';
      helmetColor = CONFIG.DRIVERS.ACCESSORIES.HELMET_COLORS[
        Math.floor(Math.random() * CONFIG.DRIVERS.ACCESSORIES.HELMET_COLORS.length)
      ];

      // 雨衣：雨天大幅提高 (75%)，晴天 10%
      const rainChance = isRaining
        ? CONFIG.DRIVERS.ACCESSORIES.RAINCOAT_RAIN_CHANCE
        : CONFIG.DRIVERS.ACCESSORIES.RAINCOAT_CLEAR_CHANCE;
      if (Math.random() < rainChance) {
        hasRaincoat = true;
        raincoatColor = CONFIG.DRIVERS.ACCESSORIES.RAINCOAT_COLORS[
          Math.floor(Math.random() * CONFIG.DRIVERS.ACCESSORIES.RAINCOAT_COLORS.length)
        ];
      }
    } else if (vType === 'taxi' && isDriver) {
      // 計程車司機可戴鴨舌帽
      if (Math.random() < 0.45) hatType = 'cap';
    }

    const hasMask = Math.random() < CONFIG.DRIVERS.ACCESSORIES.MASK_CHANCE;

    return {
      skinColorHex: skin,
      shirtColorHex: shirt,
      hairColorHex: hair,
      hatType,
      helmetColorHex: helmetColor,
      hasMask,
      hasRaincoat,
      raincoatColorHex: raincoatColor
    };
  }

  /**
   * 生成乘客名單
   */
  private generatePassengers(vType: VehicleType, isRaining: boolean): PassengerNPC[] {
    const passengers: PassengerNPC[] = [];

    if (vType === 'sedan') {
      const rand = Math.random();
      let count = 1;
      if (rand < 0.60) count = 1;
      else if (rand < 0.85) count = 2;
      else if (rand < 0.95) count = 3;
      else count = 4;

      const roles: PassengerNPC['seat'][] = [
        'passenger_front',
        'passenger_rear_left',
        'passenger_rear_right'
      ];

      for (let i = 1; i < count; i++) {
        passengers.push({
          id: `pass_${this.idCounter++}`,
          seat: roles[i - 1],
          appearance: this.generateAppearance(vType, false, isRaining),
          headTurnAngle: 0
        });
      }
    } else if (vType === 'scooter') {
      // 1人 55%, 2人 45%
      if (Math.random() < 0.45) {
        passengers.push({
          id: `pass_${this.idCounter++}`,
          seat: 'passenger_rear',
          appearance: this.generateAppearance(vType, false, isRaining),
          headTurnAngle: 0,
          isHoldingRider: true
        });
      }
    } else if (vType === 'taxi') {
      // 計程車初始載客機率約 40%
      if (Math.random() < CONFIG.DRIVERS.OCCUPANCY.TAXI_INITIAL_PASSENGER_CHANCE) {
        passengers.push({
          id: `pass_${this.idCounter++}`,
          seat: 'passenger_rear_right',
          appearance: this.generateAppearance(vType, false, isRaining),
          headTurnAngle: 0
        });
      }
    }

    return passengers;
  }

  /**
   * 計算道路在特定行進方向上的可用車道數
   */
  public getRoadLaneCount(road: RoadFeature): number {
    if (road.oneway) {
      if (road.width >= 9.5) return 3; // 寬主幹道 3 車道 (例如礁溪路五段 11m)
      if (road.width >= 6.5) return 2; // 標準雙車道
      return 1;
    } else {
      if (road.width >= 9.5) return 2; // 雙向四線道，每方向 2 車道
      return 1;                        // 標準雙向雙線道，每方向 1 車道
    }
  }

  /**
   * 計算特定車道編號的橫向偏移量 (米)
   * 相對於行進方向的右側法線向量 (dirZ, -dirX)
   */
  public getLaneOffset(road: RoadFeature, laneIndex: number, vType: VehicleType): number {
    const W = road.width;
    const laneCount = this.getRoadLaneCount(road);
    const clampedLane = Math.max(0, Math.min(laneCount - 1, laneIndex));

    if (road.oneway) {
      // 單向道路：中心線兩側皆為同向車流
      if (laneCount === 3) {
        if (clampedLane === 0) return -W * 0.28;
        if (clampedLane === 1) return 0.0;
        return vType === 'scooter' ? W * 0.33 : W * 0.28;
      } else if (laneCount === 2) {
        if (clampedLane === 0) return -W * 0.22;
        return vType === 'scooter' ? W * 0.28 : W * 0.22;
      } else {
        return vType === 'scooter' ? 0.35 : 0.0;
      }
    } else {
      // 雙向道路：前進方向皆偏向中心線右側 (+RightNorm)
      if (laneCount === 2) {
        if (clampedLane === 0) return W * 0.16;
        return vType === 'scooter' ? W * 0.36 : W * 0.32;
      } else {
        return vType === 'scooter' ? Math.max(1.4, W * 0.30) : Math.max(1.2, W * 0.25);
      }
    }
  }

  /**
   * 在玩家周邊道路生成新車輛 (保證各車道均勻分流、雙向車道正反兩向皆有車流)
   */
  private spawnVehicle(playerPos: Point2D, isRaining: boolean): boolean {
    if (this.roads.length === 0) return false;
    const inactiveVeh = this.vehicles.find((v) => !v.active);
    if (!inactiveVeh) return false;

    // 1. 篩選玩家 18m ~ 110m 範圍內的候選道路線段
    const candidateSegments: Array<{ road: RoadFeature; segIdx: number; p1: Point2D; p2: Point2D; midX: number; midZ: number }> = [];

    for (const r of this.roads) {
      if (r.points.length < 2) continue;
      for (let s = 0; s < r.points.length - 1; s++) {
        const pt1 = r.points[s];
        const pt2 = r.points[s + 1];
        const mx = (pt1.x + pt2.x) * 0.5;
        const mz = (pt1.z + pt2.z) * 0.5;
        const d = Math.hypot(mx - playerPos.x, mz - playerPos.z);
        if (d >= CONFIG.TRAFFIC.SPAWN_MIN_RADIUS && d <= CONFIG.TRAFFIC.SPAWN_MAX_RADIUS) {
          candidateSegments.push({ road: r, segIdx: s, p1: pt1, p2: pt2, midX: mx, midZ: mz });
        }
      }
    }

    if (candidateSegments.length === 0) return false;

    // 隨機選取一個候選線段
    const cand = candidateSegments[Math.floor(Math.random() * candidateSegments.length)];
    const road = cand.road;
    const segIdx = cand.segIdx;
    const p1 = cand.p1;
    const p2 = cand.p2;

    // 2. 統計該道路目前現存的車輛方向與車道佔用
    let fwdCount = 0;
    let revCount = 0;
    const activeOnRoad = this.vehicles.filter((v) => v.active && v.currentRoadId === road.id);
    for (const v of activeOnRoad) {
      if (v.isReverse) revCount++;
      else fwdCount++;
    }

    // 3. 決定方向 (isReverse)：雙向道路強制平衡正向與反向車流，絕不允許單邊空置！
    let isRev = false;
    if (road.oneway === true) {
      isRev = false;
    } else if (road.oneway === -1) {
      isRev = true;
    } else {
      // 雙向道路：正向多就生反向，反向多就生正向，相等時 50/50
      if (fwdCount > revCount) isRev = true;
      else if (revCount > fwdCount) isRev = false;
      else isRev = Math.random() < 0.5;
    }

    // 4. 車種抽選：轎車 50%、機車 35%、計程車 15%
    const randType = Math.random();
    let vType: VehicleType = 'sedan';
    if (randType < 0.50) vType = 'sedan';
    else if (randType < 0.85) vType = 'scooter';
    else vType = 'taxi';

    // 5. 決定車道 (laneIndex)：多車道道路平均分流，各車道皆有車！
    const laneCount = this.getRoadLaneCount(road);
    let chosenLane = 0;
    if (laneCount > 1) {
      // 統計同方向下各車道的車輛數
      const laneUsage = new Array(laneCount).fill(0);
      for (const v of activeOnRoad) {
        if (v.isReverse === isRev) {
          const lIdx = v.laneIndex ?? 0;
          if (lIdx >= 0 && lIdx < laneCount) laneUsage[lIdx]++;
        }
      }

      if (vType === 'scooter') {
        // 機車偏好外側車道 (laneCount - 1)
        chosenLane = laneCount - 1;
      } else {
        // 汽車優先選擇車輛較少的車道
        let minUsage = Infinity;
        const minLanes: number[] = [];
        for (let l = 0; l < laneCount; l++) {
          if (laneUsage[l] < minUsage) {
            minUsage = laneUsage[l];
            minLanes.length = 0;
            minLanes.push(l);
          } else if (laneUsage[l] === minUsage) {
            minLanes.push(l);
          }
        }
        chosenLane = minLanes[Math.floor(Math.random() * minLanes.length)];
      }
    }

    // 6. 計算車道橫向偏移量
    const laneOffsetDist = this.getLaneOffset(road, chosenLane, vType);

    const fromPt = isRev ? p2 : p1;
    const toPt = isRev ? p1 : p2;

    const dx = toPt.x - fromPt.x;
    const dz = toPt.z - fromPt.z;
    const len = Math.hypot(dx, dz);
    if (len < 1.0) return false;

    const dirX = dx / len;
    const dirZ = dz / len;
    const rightNormX = dirZ;
    const rightNormZ = -dirX;

    const startX = fromPt.x + rightNormX * laneOffsetDist;
    const startZ = fromPt.z + rightNormZ * laneOffsetDist;

    // 檢查同方向且同車道 8m 內是否有車 (不同車道與對向車道不衝突)
    for (const v of activeOnRoad) {
      if (v.isReverse === isRev && (v.laneIndex ?? 0) === chosenLane) {
        if (Math.hypot(v.x - startX, v.z - startZ) < 8.0) {
          return false;
        }
      }
    }

    const heading = Math.atan2(dirX, dirZ);

    inactiveVeh.active = true;
    inactiveVeh.type = vType;
    inactiveVeh.currentRoadId = road.id;
    inactiveVeh.roadPointIndex = isRev ? segIdx + 1 : segIdx;
    inactiveVeh.isReverse = isRev;
    inactiveVeh.laneIndex = chosenLane;
    inactiveVeh.laneOffset = laneOffsetDist;
    inactiveVeh.x = startX;
    inactiveVeh.y = 0.05;
    inactiveVeh.z = startZ;
    inactiveVeh.rotationY = heading;
    inactiveVeh.targetPoint = { x: toPt.x + rightNormX * laneOffsetDist, z: toPt.z + rightNormZ * laneOffsetDist };
    inactiveVeh.targetHeading = heading;

    // 違規行為初始化 (全域約 5% 機率，安全避讓不相撞)
    inactiveVeh.isViolator = false;
    inactiveVeh.violationType = 'none';
    inactiveVeh.violationTimer = 0;
    inactiveVeh.wrongWayTimer = 0;

    if (CONFIG.NPC_BEHAVIOR.violationsEnabled && Math.random() < CONFIG.NPC_BEHAVIOR.VIOLATIONS.vehicle.totalRate) {
      inactiveVeh.isViolator = true;
      const vRoll = Math.random();
      if (vRoll < 0.40) {
        inactiveVeh.violationType = 'early_red_run';
      } else if (vRoll < 0.80) {
        inactiveVeh.violationType = 'speeding';
      } else if (vRoll < 0.90) {
        inactiveVeh.violationType = 'press_crosswalk';
      } else {
        inactiveVeh.violationType = vType === 'scooter' ? 'scooter_sidewalk' : 'speeding';
      }
    }

    // 速度配置
    const baseSpeed = road.type === 'primary' ? CONFIG.TRAFFIC.MAX_SPEED_MPS : CONFIG.TRAFFIC.BASE_SPEED_MPS;
    inactiveVeh.speed = baseSpeed * 0.85;
    inactiveVeh.targetSpeed = baseSpeed;
    inactiveVeh.state = 'DRIVING';
    inactiveVeh.stateTimer = 0;
    inactiveVeh.blockedTimer = 0;

    // 車身顏色
    const sedanColors = ['#e2e8f0', '#1e293b', '#0284c7', '#dc2626', '#475569', '#3b82f6', '#f8fafc'];
    const scooterColors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#64748b', '#1e1b18'];
    if (vType === 'taxi') {
      inactiveVeh.bodyColorHex = '#facc15'; // 台灣計程車亮黃
      inactiveVeh.roofLightOn = true;
    } else if (vType === 'scooter') {
      inactiveVeh.bodyColorHex = scooterColors[Math.floor(Math.random() * scooterColors.length)];
      inactiveVeh.roofLightOn = false;
    } else {
      inactiveVeh.bodyColorHex = sedanColors[Math.floor(Math.random() * sedanColors.length)];
      inactiveVeh.roofLightOn = false;
    }

    // 駕駛與個性初始化
    const personality = this.pickPersonality(vType);
    const driverApp = this.generateAppearance(vType, true, isRaining);
    const passengers = this.generatePassengers(vType, isRaining);

    inactiveVeh.driver.appearance = driverApp;
    inactiveVeh.driver.personality = personality;
    inactiveVeh.driver.mood = 'calm';
    inactiveVeh.driver.moodScore = 15;
    inactiveVeh.driver.passengers = passengers;
    inactiveVeh.driver.isEjected = false;
    inactiveVeh.driver.honkCooldown = 0;
    inactiveVeh.driver.waitTimer = 0;
    inactiveVeh.driver.steeringAngle = 0;
    inactiveVeh.driver.headTurnAngle = 0;
    inactiveVeh.driver.lookPhoneTimer = 0;
    inactiveVeh.driver.leanAngle = 0;
    inactiveVeh.driver.footDown = false;
    inactiveVeh.driver.speechBubbleTimer = 0;
    inactiveVeh.driver.speechBubbleText = undefined;

    // 計程車專用狀態
    if (vType === 'taxi') {
      if (passengers.length > 0) {
        inactiveVeh.taxiState = 'OCCUPIED_DRIVING';
        inactiveVeh.roofLightOn = false; // 載客熄燈
        inactiveVeh.tripTimer = 15.0 + Math.random() * 20.0;
      } else {
        inactiveVeh.taxiState = 'EMPTY_CRUISING';
        inactiveVeh.roofLightOn = true; // 空車亮燈
        inactiveVeh.tripTimer = 0;
      }
    }

    return true;
  }

  /**
   * 逐幀更新車流、駕駛反應與計程車載客 (固定步長 60Hz)
   */
  public update(dt: number, playerPos: Point2D, isRaining: boolean): void {
    if (!CONFIG.TRAFFIC.ENABLED || this.roads.length === 0) return;

    const tStart = performance.now();
    this.honksThisFrame = 0;

    let activeCount = 0;

    // 1. 維護活躍車輛池，動態生成與回收
    for (const v of this.vehicles) {
      if (v.active) {
        const distToPlayer = Math.hypot(v.x - playerPos.x, v.z - playerPos.z);
        if (distToPlayer > CONFIG.TRAFFIC.DESPAWN_RADIUS) {
          // 超出 140m 回收
          v.active = false;
        } else {
          activeCount++;
        }
      }
    }

    // 若未滿上限，嘗試補足生成 (數量低時提高每幀嘗試次數以加速補滿)
    if (activeCount < this.maxVehicles) {
      const attempts = activeCount < 15 ? 6 : (activeCount < 25 ? 4 : 2);
      for (let s = 0; s < attempts; s++) {
        if (this.spawnVehicle(playerPos, isRaining)) {
          activeCount++;
          if (activeCount >= this.maxVehicles) break;
        }
      }
    }

    // 2. 逐車更新行為與物理位移
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      if (!v.active) continue;

      const distToPlayer = Math.hypot(v.x - playerPos.x, v.z - playerPos.z);
      const isNearPlayer = distToPlayer <= CONFIG.TRAFFIC.LOGIC_UPDATE_RADIUS; // <= 90m

      // 駕駛在車上才執行駕駛邏輯，無人車輛直接煞停
      if (v.state === 'UNMANNED') {
        v.speed = Math.max(0, v.speed - dt * 9.0);
        v.brakeLightsOn = true;
        continue;
      }

      if (isNearPlayer) {
        this.updateDriverDetailedLogic(v, dt, playerPos);
      } else {
        this.updateDriverSimplifiedLogic(v, dt);
      }

      // 車輛路徑導航推進
      this.updateVehicleMovement(v, dt);

      // 計程車載客業務狀態機
      if (v.type === 'taxi') {
        this.updateTaxiLifecycle(v, dt, isRaining);
      }
    }

    // 60 秒行為抽樣更新
    if (this.vehicleSamplingActive) {
      this.vehicleSamplingTimer -= dt;

      // 累計平均速度
      let spdSum = 0;
      let spdCount = 0;
      for (let i = 0; i < this.vehicles.length; i++) {
        const v = this.vehicles[i];
        if (v.active) {
          spdSum += v.speed;
          spdCount++;
        }
      }
      if (spdCount > 0) {
        this.vehicleSamplingSpeedSum += (spdSum / spdCount) * dt;
        this.vehicleSamplingSpeedSeconds += dt;
      }

      if (this.vehicleSamplingTimer <= 0) {
        this.vehicleSamplingActive = false;
        const deltaWrong = this.wrongWayEvents - this.vehicleSamplingInitialWrongWay;
        const deltaOpposite = this.headOppositeSpeedEvents - this.vehicleSamplingInitialOpposite;
        const deltaViolations = {
          earlyRedRun: this.vehicleViolationsStats.earlyRedRun - this.vehicleSamplingInitialViolations.earlyRedRun,
          speeding: this.vehicleViolationsStats.speeding - this.vehicleSamplingInitialViolations.speeding,
          pressCrosswalk: this.vehicleViolationsStats.pressCrosswalk - this.vehicleSamplingInitialViolations.pressCrosswalk,
          scooterSidewalk: this.vehicleViolationsStats.scooterSidewalk - this.vehicleSamplingInitialViolations.scooterSidewalk,
          total: this.vehicleViolationsStats.total - this.vehicleSamplingInitialViolations.total
        };
        const activeNow = Math.max(1, this.getActiveVehicles().length);
        const rate = (deltaViolations.total / activeNow) * 100;
        const avgKmh = this.vehicleSamplingSpeedSeconds > 0
          ? (this.vehicleSamplingSpeedSum / this.vehicleSamplingSpeedSeconds) * 3.6
          : 0;
        this.vehicleSamplingReport = {
          samplingDurationSec: 60.0,
          totalVehiclesSampled: activeNow,
          averageSpeedKmh: Math.round(avgKmh * 10) / 10,
          wrongWayCount: deltaWrong,
          headOppositeSpeedCount: deltaOpposite,
          violationsCount: deltaViolations,
          violationRatePercent: Math.round(rate * 10) / 10,
          isCompliant: deltaWrong === 0 && deltaOpposite === 0
        };
        console.log('[TrafficSystem] 60 秒車輛行為抽樣完成:', this.vehicleSamplingReport);
      }
    }

    this.lastAiTimeMs = performance.now() - tStart;
  }

  /**
   * 90m 內精確駕駛個性、號誌、避障、心情與喇叭邏輯
   */
  private updateDriverDetailedLogic(v: TrafficVehicle, dt: number, playerPos: Point2D): void {
    const d = v.driver;
    const pCfg = CONFIG.DRIVERS.PERSONALITIES[d.personality] || CONFIG.DRIVERS.PERSONALITIES.normal;

    // 心情恢復或冷卻
    if (d.honkCooldown > 0) d.honkCooldown -= dt;
    if (d.honkSoundTimer > 0) {
      d.honkSoundTimer -= dt;
      if (d.honkSoundTimer <= 0) d.isHonking = false;
    }
    if (d.highBeamTimer && d.highBeamTimer > 0) {
      d.highBeamTimer -= dt;
      v.highBeamsOn = Math.sin(d.highBeamTimer * 28.0) > 0;
    } else {
      v.highBeamsOn = false;
    }
    if (d.speechBubbleTimer && d.speechBubbleTimer > 0) {
      d.speechBubbleTimer -= dt;
      if (d.speechBubbleTimer <= 0) d.speechBubbleText = undefined;
    }

    // 初始化隨機停等間隙 (0.5m~1.0m，排隊 1.5m~2.5m)
    if (v.desiredStopGap === undefined) {
      v.desiredStopGap = CONFIG.TRAFFIC.BRAKING.STOP_MARGIN_MIN + Math.random() * (CONFIG.TRAFFIC.BRAKING.STOP_MARGIN_MAX - CONFIG.TRAFFIC.BRAKING.STOP_MARGIN_MIN);
    }
    if (v.desiredQueueGap === undefined) {
      v.desiredQueueGap = CONFIG.TRAFFIC.BRAKING.QUEUE_GAP_MIN + Math.random() * (CONFIG.TRAFFIC.BRAKING.QUEUE_GAP_MAX - CONFIG.TRAFFIC.BRAKING.QUEUE_GAP_MIN);
    }

    // 1. 單一資料來源：尋找車輛面對之號誌進路與停止線
    const targetInfo = this.findTargetApproachAndStopLine(v);
    let mustStopAtSignal = false;
    let distToStopLine = Infinity;

    if (targetInfo) {
      const { intersection: inter, approach: app, stopLine, longitudinalDist } = targetInfo;
      v.targetStopLine = stopLine;
      v.frontBumperDistanceToLine = longitudinalDist;
      distToStopLine = longitudinalDist;

      const sigInfo = this.trafficSignalSystem!.getVehicleState(inter.id, app.id);
      const state = sigInfo.state;

      const aComf = CONFIG.TRAFFIC.BRAKING.COMFORTABLE_DECEL; // 3.0 m/s^2
      const stopNeedDist = (v.speed * v.speed) / (2 * aComf);

      if (state === 'red') {
        // 違規：搶紅燈 (紅燈初期 1.5s 內搶過)
        if (v.isViolator && v.violationType === 'early_red_run') {
          // 紅燈初期搶過
          const isEarlyRed = sigInfo.remainingSec >= 28.5 || sigInfo.remainingSec <= 1.5;
          if (isEarlyRed) {
            mustStopAtSignal = false;
            if (v.violationTimer === 0) {
              v.violationTimer = 1;
              this.vehicleViolationsStats.earlyRedRun++;
              this.vehicleViolationsStats.total++;
              window.dispatchEvent(new CustomEvent('violation:committed', {
                detail: { actorType: 'vehicle', id: v.id, violationType: 'early_red_run', position: { x: v.x, z: v.z }, timestamp: Date.now() }
              }));
            }
          } else {
            mustStopAtSignal = true;
          }
        } else {
          mustStopAtSignal = true;
        }
      } else if (state === 'yellow') {
        // 黃燈兩難判定：以舒適減速度能在停止線前停下則停，否則通過
        if (longitudinalDist > stopNeedDist + 2.0) {
          mustStopAtSignal = true;
        } else {
          // 搶黃燈機率判定 (只有趕時間型在最後 0.5 秒內且斑馬線無人時才搶)
          const countdown = this.trafficSignalSystem!.getCountdownSec(inter.id, app.signalGroup);
          const pedsCrossing = this.checkPedestriansOnCrossing(inter, app);

          if (pCfg.id === 'hurried' && !pedsCrossing && countdown.seconds <= 0.5 && Math.random() < CONFIG.TRAFFIC.BRAKING.YELLOW_RUN_CHANCE_HURRIED) {
            mustStopAtSignal = false;
          } else if (longitudinalDist <= stopNeedDist + 1.0) {
            mustStopAtSignal = false; // 已進入兩難區，平穩通過
          } else {
            mustStopAtSignal = true;
          }
        }
      } else if (state === 'green') {
        // 路口清空規則 (Don't Block the Box)：出口無空間則不可進入路口
        const hasExitSpace = this.checkIntersectionExitSpace(v, inter, app);
        if (!hasExitSpace && longitudinalDist > 0 && longitudinalDist < 12.0) {
          mustStopAtSignal = true;
        } else {
          mustStopAtSignal = false;
        }
      }

      // 違規：壓斑馬線 (停等時壓線 0.5m)
      if (v.isViolator && v.violationType === 'press_crosswalk' && mustStopAtSignal) {
        v.desiredStopGap = -0.5;
        if (v.violationTimer === 0 && distToStopLine < 2.0) {
          v.violationTimer = 1;
          this.vehicleViolationsStats.pressCrosswalk++;
          this.vehicleViolationsStats.total++;
          window.dispatchEvent(new CustomEvent('violation:committed', {
            detail: { actorType: 'vehicle', id: v.id, violationType: 'press_crosswalk', position: { x: v.x, z: v.z }, timestamp: Date.now() }
          }));
        }
      }
    } else {
      v.targetStopLine = undefined;
      v.frontBumperDistanceToLine = undefined;
    }

    // 2. 檢查前方障礙物 (前車排隊、行人、玩家)
    const vHalfLen = v.type === 'scooter' ? CONFIG.TRAFFIC.DIMENSIONS.SCOOTER_HALF_LEN : CONFIG.TRAFFIC.DIMENSIONS.SEDAN_HALF_LEN;
    let closestLeadVehicle: TrafficVehicle | null = null;
    let closestLeadBumperGap = Infinity;

    // 違規：機車騎上人行道短暫繞行
    if (v.type === 'scooter' && v.isViolator && v.violationType === 'scooter_sidewalk') {
      v.laneOffset = Math.abs(v.laneOffset) + 1.0;
      if (v.violationTimer === 0) {
        v.violationTimer = 1;
        this.vehicleViolationsStats.scooterSidewalk++;
        this.vehicleViolationsStats.total++;
        window.dispatchEvent(new CustomEvent('violation:committed', {
          detail: { actorType: 'vehicle', id: v.id, violationType: 'scooter_sidewalk', position: { x: v.x, z: v.z }, timestamp: Date.now() }
        }));
      }
    }

    // 前車檢測
    for (const other of this.vehicles) {
      if (!other.active || other.id === v.id) continue;

      // 1. 同道路對向車輛 (迎面交會車流) 絕不視為前車！
      if (other.currentRoadId === v.currentRoadId && other.isReverse !== v.isReverse) {
        continue;
      }

      // 2. 航向檢測：若兩車朝向夾角大於 70 度或相反 (dot < 0.35)，不視為同向跟車
      const headingDot = Math.sin(v.rotationY) * Math.sin(other.rotationY) + Math.cos(v.rotationY) * Math.cos(other.rotationY);
      if (headingDot < 0.35) {
        continue;
      }

      const fwdDist = this.getForwardDistance(v, other.x, other.z);
      if (fwdDist > 0 && fwdDist < 30.0) {
        const latDist = Math.abs(this.getLateralDistance(v, other.x, other.z));

        // 3. 多車道分流：同道路若在不同車道且橫向差距超過 1.3m，不視為跟車對象
        if (other.currentRoadId === v.currentRoadId && (v.laneIndex ?? 0) !== (other.laneIndex ?? 0) && latDist > 1.3) {
          continue;
        }

        // 機車鑽車縫判斷：遇慢速或停等車隊，沿右側縫隙鑽向前
        if (v.type === 'scooter' && other.speed < 1.5) {
          if (latDist < 1.2) {
            // 向右移至車道邊緣鑽縫隙
            v.laneOffset = Math.abs(v.laneOffset) + 0.6;
          }
          if (latDist > 1.0) continue; // 右側有足夠縫隙，機車直接鑽車前進
        }

        if (latDist < 1.4) {
          const otherHalfLen = other.type === 'scooter' ? CONFIG.TRAFFIC.DIMENSIONS.SCOOTER_HALF_LEN : CONFIG.TRAFFIC.DIMENSIONS.SEDAN_HALF_LEN;
          const bumperGap = fwdDist - vHalfLen - otherHalfLen;
          if (bumperGap < closestLeadBumperGap) {
            closestLeadBumperGap = bumperGap;
            closestLeadVehicle = other;
          }
        }
      }
    }

    // 玩家擋車檢測
    let isBlockedByPedestrian = false;
    let distToObstacle = Infinity;

    const fwdDistPlayer = this.getForwardDistance(v, playerPos.x, playerPos.z);
    if (fwdDistPlayer > 0 && fwdDistPlayer < 10.0) {
      const latPlayer = Math.abs(this.getLateralDistance(v, playerPos.x, playerPos.z));
      if (latPlayer < 2.2) {
        distToObstacle = Math.min(distToObstacle, fwdDistPlayer);
        isBlockedByPedestrian = true;
      }
    }

    // 行人檢測 (斑馬線或行人靠近)
    if (this.pedestrianSystem && (pCfg.stopForPedNear || mustStopAtSignal)) {
      const peds = this.pedestrianSystem.getActiveAgents();
      for (let p = 0; p < peds.length; p++) {
        const ped = peds[p];
        const fwdPed = this.getForwardDistance(v, ped.x, ped.z);
        if (fwdPed > 0 && fwdPed < 8.0) {
          const latPed = Math.abs(this.getLateralDistance(v, ped.x, ped.z));
          if (latPed < 2.5) {
            distToObstacle = Math.min(distToObstacle, fwdPed);
            isBlockedByPedestrian = true;
            break;
          }
        }
      }
    }

    // 3. 舒適煞車、停等與排隊決策
    const aComf = CONFIG.TRAFFIC.BRAKING.COMFORTABLE_DECEL; // 3.0 m/s^2
    let cruiseSpeed = CONFIG.TRAFFIC.BASE_SPEED_MPS * pCfg.speedMult;

    // 違規：超速 15~25%
    if (v.isViolator && v.violationType === 'speeding') {
      cruiseSpeed *= 1.25;
      if (v.violationTimer === 0) {
        v.violationTimer = 1;
        this.vehicleViolationsStats.speeding++;
        this.vehicleViolationsStats.total++;
        window.dispatchEvent(new CustomEvent('violation:committed', {
          detail: { actorType: 'vehicle', id: v.id, violationType: 'speeding', position: { x: v.x, z: v.z }, timestamp: Date.now() }
        }));
      }
    }

    // 判斷是否需要排隊停在前車車尾後 1.5~2.5m
    let mustQueueBehindLead = false;
    let distToQueueTarget = Infinity;

    if (closestLeadVehicle) {
      const isLeadSlowOrStopped = closestLeadVehicle.speed < 2.0 || closestLeadVehicle.state.startsWith('STOPPED');
      const safeFollow = CONFIG.TRAFFIC.SAFE_DISTANCE_BASE * pCfg.followDistMult;

      if (isLeadSlowOrStopped || closestLeadBumperGap < safeFollow) {
        const queueStopRemain = closestLeadBumperGap - v.desiredQueueGap;
        // 如果排隊煞停點比號誌停止線更近，優先在排隊點煞停
        if (queueStopRemain < (distToStopLine - v.desiredStopGap)) {
          mustQueueBehindLead = true;
          distToQueueTarget = queueStopRemain;
        }
      }
    }

    if (isBlockedByPedestrian && distToObstacle < 6.0) {
      // 禮讓行人煞停
      v.state = 'STOPPED_PEDESTRIAN';
      v.targetSpeed = 0;
      v.speed = Math.max(0, v.speed - dt * 6.0);
      v.brakeLightsOn = true;
      d.waitTimer += dt;
      if (v.type === 'scooter') d.footDown = true;
    } else if (mustQueueBehindLead) {
      // 排隊停在前車車尾後 1.5~2.5m
      v.isLeadStoppedVehicle = false;
      v.queueLeadVehicleId = closestLeadVehicle!.id;
      v.distanceToLeadVehicle = closestLeadBumperGap;

      if (distToQueueTarget <= 0.04) {
        v.speed = 0;
        v.targetSpeed = 0;
        v.state = 'STOPPED_OBSTACLE';
        v.brakeLightsOn = true;
        d.waitTimer += dt;
        if (v.type === 'scooter') d.footDown = true;
      } else {
        const vKinematic = Math.sqrt(2 * aComf * Math.max(0, distToQueueTarget));
        v.targetSpeed = Math.min(cruiseSpeed, vKinematic);
        v.state = 'STOPPED_OBSTACLE';
        v.brakeLightsOn = true;
        if (distToQueueTarget < 0.25 && v.speed < 0.3) {
          v.speed = 0;
          v.targetSpeed = 0;
        }
      }

      // 被擋住心情與喇叭邏輯
      d.moodScore = Math.min(100, d.moodScore + CONFIG.DRIVERS.MOOD.WAIT_ANGER_RATE * dt);
      if (d.waitTimer > CONFIG.TRAFFIC.HONK_BLOCKED_TIME_THRESHOLD && d.honkCooldown <= 0) {
        const moodMult = d.mood === 'angry' ? 2.0 : (d.mood === 'annoyed' ? 1.4 : 1.0);
        if (Math.random() < pCfg.honkBaseChance * moodMult) {
          this.triggerDriverHonk(v, '前車停滯');
        }
      }
    } else if (mustStopAtSignal && distToStopLine !== Infinity) {
      // 停等紅燈：以車頭對齊停止線前 0.5~1.0m (絕對不可壓線)
      v.isLeadStoppedVehicle = true;
      v.queueLeadVehicleId = undefined;
      const distToLineTarget = distToStopLine - v.desiredStopGap;

      if (distToLineTarget <= 0.04) {
        v.speed = 0;
        v.targetSpeed = 0;
        v.state = 'STOPPED_SIGNAL';
        v.brakeLightsOn = true;
        d.waitTimer += dt;
        d.lookPhoneTimer += dt;
        if (v.type === 'scooter') d.footDown = true;
      } else {
        const vKinematic = Math.sqrt(2 * aComf * Math.max(0, distToLineTarget));
        v.targetSpeed = Math.min(cruiseSpeed, vKinematic);
        v.state = 'STOPPED_SIGNAL';
        v.brakeLightsOn = true;
        if (distToLineTarget < 0.25 && v.speed < 0.3) {
          v.speed = 0;
          v.targetSpeed = 0;
        }
      }
    } else {
      // 正常順暢行駛
      v.state = 'DRIVING';
      v.isLeadStoppedVehicle = false;
      v.targetSpeed = cruiseSpeed;
      v.brakeLightsOn = false;
      d.waitTimer = Math.max(0, d.waitTimer - dt * 2.0);
      d.footDown = false;
      d.moodScore = Math.max(0, d.moodScore - CONFIG.DRIVERS.MOOD.ANNOYED_DECAY_RATE * dt);
    }

    // 心情門檻切換
    if (d.moodScore <= CONFIG.DRIVERS.MOOD.CALM_MAX) {
      d.mood = 'calm';
    } else if (d.moodScore <= CONFIG.DRIVERS.MOOD.ANNOYED_MAX) {
      d.mood = 'annoyed';
    } else {
      if (d.mood !== 'angry') {
        this.emit('driver:angry', { driverId: d.id, vehicleId: v.id });
      }
      d.mood = 'angry';
    }

    // 4. 動態動作更新 (轉向角、頭部擺動)
    this.updateDriverPose(v, dt);
  }

  /**
   * 90m 外簡化駕駛推進邏輯
   */
  private updateDriverSimplifiedLogic(v: TrafficVehicle, _dt: number): void {
    const pCfg = CONFIG.DRIVERS.PERSONALITIES[v.driver.personality] || CONFIG.DRIVERS.PERSONALITIES.normal;
    v.targetSpeed = CONFIG.TRAFFIC.BASE_SPEED_MPS * pCfg.speedMult;
    v.state = 'DRIVING';
    v.brakeLightsOn = false;
    v.driver.footDown = false;
    v.driver.steeringAngle = 0;
    v.driver.headTurnAngle = 0;
    v.driver.leanAngle = 0;
  }

  /**
   * 觸發駕駛按喇叭
   */
  public triggerDriverHonk(v: TrafficVehicle, reason: string): void {
    const d = v.driver;
    d.honkCooldown = 5.0 + Math.random() * 4.0;
    d.honkCountTotal++;
    d.isHonking = true;
    d.honkSoundTimer = 0.9;
    this.honksThisFrame++;
    this.totalHonks++;

    this.emit('driver:honk', {
      driverId: d.id,
      vehicleId: v.id,
      personality: d.personality,
      reason
    });
  }

  /**
   * 更新駕駛肢體動作 (轉彎雙手握方向盤、頭朝轉向角20~35度、機車身傾斜)
   */
  private updateDriverPose(v: TrafficVehicle, dt: number): void {
    const d = v.driver;
    const steerDiff = v.targetHeading - v.rotationY;

    // 將角度正規化至 -PI ~ PI
    let normSteer = Math.atan2(Math.sin(steerDiff), Math.cos(steerDiff));
    normSteer = Math.max(-0.6, Math.min(0.6, normSteer));

    // 汽車：方向盤轉動與頭部向轉彎方向偏轉 20~35 度 (約 0.35~0.6 rad)
    d.steeringAngle += (normSteer * 2.2 - d.steeringAngle) * Math.min(1.0, dt * 8.0);
    const targetHead = normSteer * 0.75;
    d.headTurnAngle += (targetHead - d.headTurnAngle) * Math.min(1.0, dt * 6.0);

    // 機車：身體與車身傾斜
    if (v.type === 'scooter') {
      const targetLean = normSteer * (v.speed / CONFIG.TRAFFIC.BASE_SPEED_MPS) * 0.45;
      d.leanAngle += (targetLean - d.leanAngle) * Math.min(1.0, dt * 7.0);
    }

    // 乘客微幅擺頭
    for (const p of d.passengers) {
      p.headTurnAngle = Math.sin(performance.now() * 0.0015 + parseInt(p.id.replace(/\D/g, '') || '0')) * 0.15;
    }
  }

  /**
   * 車輛在路網上的前進與路口轉向
   */
  private updateVehicleMovement(v: TrafficVehicle, dt: number): void {
    // 速度加速度平滑
    const accel = v.targetSpeed > v.speed ? 4.5 : 8.5;
    v.speed += (v.targetSpeed - v.speed) * Math.min(1.0, dt * accel);

    if (v.speed <= 0.01) {
      v.speed = 0;
      return;
    }

    // 關鍵停止線保護：車頭若已逼近停止線 (或合規停等點)，強制禁止前溜壓線
    if (v.state === 'STOPPED_SIGNAL' && v.targetStopLine && v.desiredStopGap !== undefined) {
      const vHalfLen = v.type === 'scooter' ? CONFIG.TRAFFIC.DIMENSIONS.SCOOTER_HALF_LEN : CONFIG.TRAFFIC.DIMENSIONS.SEDAN_HALF_LEN;
      const frontX = v.x + Math.sin(v.rotationY) * vHalfLen;
      const frontZ = v.z + Math.cos(v.rotationY) * vHalfLen;
      const targetPos = (v.type === 'scooter' && v.targetStopLine.hasScooterWaitingBox && v.targetStopLine.scooterStopWorldPosition)
        ? v.targetStopLine.scooterStopWorldPosition
        : v.targetStopLine.worldPosition;

      const fwdX = Math.sin(v.targetStopLine.azimuthRad);
      const fwdZ = Math.cos(v.targetStopLine.azimuthRad);
      const curDistToLine = (targetPos.x - frontX) * fwdX + (targetPos.z - frontZ) * fwdZ;

      if (curDistToLine <= v.desiredStopGap + 0.02) {
        v.speed = 0;
        return;
      }
    }

    // 向目標點移動
    const dx = v.targetPoint.x - v.x;
    const dz = v.targetPoint.z - v.z;
    const distToTarget = Math.hypot(dx, dz);

    // 嚴格禁止倒車與每幀逆向檢測防護
    v.speed = Math.max(0, v.speed);
    const fwdX = Math.sin(v.rotationY);
    const fwdZ = Math.cos(v.rotationY);

    if (distToTarget > 0.1 && v.speed > 0.1) {
      const dirX = dx / distToTarget;
      const dirZ = dz / distToTarget;
      const dot = fwdX * dirX + fwdZ * dirZ;
      if (dot < 0) {
        v.wrongWayTimer = (v.wrongWayTimer || 0) + dt;
        if (v.wrongWayTimer > CONFIG.NPC_BEHAVIOR.VEHICLE.WRONG_WAY_MAX_SEC) {
          this.wrongWayEvents++;
          this.headOppositeSpeedEvents++;
          v.active = false;
          return;
        }
      } else {
        v.wrongWayTimer = Math.max(0, (v.wrongWayTimer || 0) - dt * 2.0);
      }
    }

    // 檢測是否在 oneway 逆向車道行駛
    const curRoad = this.roads.find((r) => r.id === v.currentRoadId);
    if (curRoad) {
      const isWrongWay = (curRoad.oneway === true && v.isReverse) || (curRoad.oneway === -1 && !v.isReverse);
      if (isWrongWay) {
        this.wrongWayEvents++;
        v.active = false;
        return;
      }
    }

    if (distToTarget < 1.5) {
      // 到達目前線段終點，尋找下一個路網節點或下一條路
      this.advanceToNextRoadSegment(v);
    } else {
      const dirX = dx / distToTarget;
      const dirZ = dz / distToTarget;
      v.x += dirX * v.speed * dt;
      v.z += dirZ * v.speed * dt;

      // 旋轉角平滑對齊前進方向
      const targetRot = Math.atan2(dirX, dirZ);
      let rotDiff = targetRot - v.rotationY;
      while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
      while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
      v.rotationY += rotDiff * Math.min(1.0, dt * 6.0);
    }
  }

  /**
   * 前進至下一個道路線段或銜接相鄰道路
   */
  private advanceToNextRoadSegment(v: TrafficVehicle): void {
    const road = this.roads.find((r) => r.id === v.currentRoadId);
    if (!road) {
      v.active = false;
      return;
    }

    const nextIdx = v.isReverse ? v.roadPointIndex - 1 : v.roadPointIndex + 1;
    if (nextIdx >= 0 && nextIdx < road.points.length) {
      // 沿當前道路繼續前進
      v.roadPointIndex = nextIdx;
      const pt = road.points[nextIdx];
      const prevPt = road.points[v.isReverse ? nextIdx + 1 : nextIdx - 1];
      const dx = pt.x - prevPt.x;
      const dz = pt.z - prevPt.z;
      const len = Math.hypot(dx, dz) || 1.0;
      const dirX = dx / len;
      const dirZ = dz / len;
      // 台灣靠右行駛：前進方向右側法線為 (dirZ, -dirX)
      const rightNormX = dirZ;
      const rightNormZ = -dirX;
      const laneCount = this.getRoadLaneCount(road);
      const laneIdx = Math.min(v.laneIndex ?? 0, laneCount - 1);
      v.laneIndex = laneIdx;
      const laneOffsetDist = this.getLaneOffset(road, laneIdx, v.type);
      v.laneOffset = laneOffsetDist;

      v.targetPoint = { x: pt.x + rightNormX * laneOffsetDist, z: pt.z + rightNormZ * laneOffsetDist };
      v.targetHeading = Math.atan2(dirX, dirZ);
    } else {
      // 到達道路末端，尋找能合法接續行駛的相鄰道路 (嚴格遵守 oneway)
      const lastPt = road.points[v.roadPointIndex];
      const connectingRoads: Array<{ road: RoadFeature; isRev: boolean }> = [];

      for (const r of this.roads) {
        if (r.id === road.id || r.points.length < 2) continue;
        const dStart = Math.hypot(r.points[0].x - lastPt.x, r.points[0].z - lastPt.z);
        const dEnd = Math.hypot(r.points[r.points.length - 1].x - lastPt.x, r.points[r.points.length - 1].z - lastPt.z);

        if (dStart < 14.0 && r.oneway !== -1) {
          // 接起點：正向行駛 (合法)
          connectingRoads.push({ road: r, isRev: false });
        }
        if (dEnd < 14.0 && (!r.oneway || r.oneway === -1)) {
          // 接終點：反向行駛 (雙向道路或反向單向道允許)
          connectingRoads.push({ road: r, isRev: true });
        }
      }

      if (connectingRoads.length > 0) {
        const choice = connectingRoads[Math.floor(Math.random() * connectingRoads.length)];
        const nextRoad = choice.road;
        const isRev = choice.isRev;
        v.currentRoadId = nextRoad.id;
        v.isReverse = isRev;
        v.roadPointIndex = isRev ? nextRoad.points.length - 1 : 0;
        const targetPt = isRev ? nextRoad.points[nextRoad.points.length - 2] : nextRoad.points[1];
        const fromPt = nextRoad.points[isRev ? nextRoad.points.length - 1 : 0];
        const ndx = targetPt.x - fromPt.x;
        const ndz = targetPt.z - fromPt.z;
        const nlen = Math.hypot(ndx, ndz) || 1.0;
        const nRightNormX = ndz / nlen;
        const nRightNormZ = -ndx / nlen;
        const nextLaneCount = this.getRoadLaneCount(nextRoad);
        const nextLaneIdx = Math.min(v.laneIndex ?? 0, nextLaneCount - 1);
        v.laneIndex = nextLaneIdx;
        const nextLaneOffset = this.getLaneOffset(nextRoad, nextLaneIdx, v.type);
        v.laneOffset = nextLaneOffset;
        v.targetPoint = { x: targetPt.x + nRightNormX * nextLaneOffset, z: targetPt.z + nRightNormZ * nextLaneOffset };
        v.targetHeading = Math.atan2(ndx, ndz);
      } else {
        // 無銜接道路：若為雙向道則掉頭，若為單向道則重新生成以避免逆向
        if (!road.oneway) {
          v.isReverse = !v.isReverse;
          v.roadPointIndex = v.isReverse ? road.points.length - 1 : 0;
          const laneCount = this.getRoadLaneCount(road);
          const laneIdx = Math.min(v.laneIndex ?? 0, laneCount - 1);
          v.laneIndex = laneIdx;
          v.laneOffset = this.getLaneOffset(road, laneIdx, v.type);
        } else {
          v.active = false; // 單向道末端安全回收重新生成
        }
      }
    }
  }

  /**
   * 計程車生命週期與載客/下車狀態機
   */
  private updateTaxiLifecycle(v: TrafficVehicle, dt: number, _isRaining: boolean): void {
    if (!this.pedestrianSystem) return;

    switch (v.taxiState) {
      case 'EMPTY_CRUISING': {
        v.roofLightOn = true; // 空車頂燈亮
        // 尋找沿路叫車行人
        const hailPed = this.pedestrianSystem.findHailingPedestrian({ x: v.x, z: v.z }, CONFIG.TRAFFIC.TAXI_HAIL_RADIUS);
        if (hailPed) {
          v.targetPedestrianId = hailPed.id;
          v.taxiState = 'DECELERATING_PICKUP';
          v.turnSignal = 'right'; // 打方向燈靠邊停
        }
        break;
      }

      case 'DECELERATING_PICKUP': {
        v.targetSpeed = 1.8;
        if (v.targetPedestrianId !== undefined) {
          const ped = this.pedestrianSystem.getActiveAgents().find((a) => a.id === v.targetPedestrianId);
          if (ped) {
            const distToPed = Math.hypot(ped.x - v.x, ped.z - v.z);
            if (distToPed < 4.0) {
              v.targetSpeed = 0;
              v.state = 'PICKING_UP';
              v.taxiState = 'PASSENGER_BOARDING';
              v.stateTimer = 2.0; // 上車等待時間
            }
          } else {
            v.taxiState = 'EMPTY_CRUISING';
          }
        }
        break;
      }

      case 'PASSENGER_BOARDING': {
        v.targetSpeed = 0;
        v.stateTimer -= dt;
        if (v.stateTimer <= 0) {
          // 行人上車：從地圖移除行人，外觀出現在計程車後座
          if (v.targetPedestrianId !== undefined) {
            const passApp = this.pedestrianSystem.boardTaxi(v.targetPedestrianId);
            v.driver.passengers = [
              {
                id: `taxi_pass_${this.idCounter++}`,
                seat: 'passenger_rear_right',
                appearance: passApp,
                headTurnAngle: 0
              }
            ];
          }
          v.roofLightOn = false; // 載客熄燈
          v.taxiState = 'OCCUPIED_DRIVING';
          v.tripTimer = CONFIG.TRAFFIC.TAXI_RIDE_DURATION_SEC;
          v.turnSignal = 'none';
          v.state = 'DRIVING';
        }
        break;
      }

      case 'OCCUPIED_DRIVING': {
        v.roofLightOn = false;
        v.tripTimer -= dt;
        if (v.tripTimer <= 0) {
          // 抵達目的地，靠邊讓乘客下車
          v.taxiState = 'DROPPING_OFF';
          v.stateTimer = 2.5;
          v.targetSpeed = 0;
          v.turnSignal = 'right';
        }
        break;
      }

      case 'DROPPING_OFF': {
        v.targetSpeed = 0;
        v.stateTimer -= dt;
        if (v.stateTimer <= 0) {
          // 乘客下車：在人行道上生成為一般步行行人
          if (v.driver.passengers.length > 0) {
            const pass = v.driver.passengers[0];
            this.pedestrianSystem.spawnDropoffPassenger(v.x, v.z, pass.appearance);
            v.driver.passengers = [];
          }
          v.roofLightOn = true; // 頂燈重新亮起
          v.taxiState = 'EMPTY_CRUISING';
          v.state = 'DRIVING';
          v.turnSignal = 'none';
        }
        break;
      }
    }
  }

  /**
   * 彈出駕駛 (玩家搶車/車禍)：將駕駛從車輛移出並轉交給行人系統進入 PANIC (受驚逃跑) 狀態
   */
  public ejectDriver(vehicleId: string): boolean {
    const v = this.vehicles.find((veh) => veh.id === vehicleId && veh.active);
    if (!v || v.driver.isEjected) return false;

    v.driver.isEjected = true;
    v.state = 'UNMANNED';
    v.speed = 0;
    v.targetSpeed = 0;
    v.brakeLightsOn = true;

    if (this.pedestrianSystem) {
      const pedId = this.pedestrianSystem.spawnEjectedDriver(v.x, v.z, v.driver.appearance);
      v.driver.pedestrianAgentId = pedId;
    }

    this.emit('driver:exitedVehicle', {
      vehicleId: v.id,
      driverId: v.driver.id,
      reason: 'ejected'
    });

    return true;
  }

  /**
   * 測試操作：強制最近車輛按喇叭
   */
  public forceHonkNearby(playerPos: Point2D): boolean {
    const v = this.findNearestVehicle(playerPos.x, playerPos.z);
    if (v) {
      this.triggerDriverHonk(v, '測試強制');
      return true;
    }
    return false;
  }

  /**
   * 測試操作：強制最近車輛煩躁/生氣
   */
  public forceAnnoyNearby(playerPos: Point2D): boolean {
    const v = this.findNearestVehicle(playerPos.x, playerPos.z);
    if (v) {
      v.driver.moodScore = 85;
      v.driver.mood = 'angry';
      v.driver.speechBubbleText = '走開！不要擋路！';
      v.driver.speechBubbleTimer = 3.0;
      this.emit('driver:angry', { driverId: v.driver.id, vehicleId: v.id });
      return true;
    }
    return false;
  }

  /**
   * 測試操作：彈出最近車輛駕駛
   */
  public ejectNearestDriver(playerPos: Point2D): boolean {
    const v = this.findNearestVehicle(playerPos.x, playerPos.z);
    if (v) {
      return this.ejectDriver(v.id);
    }
    return false;
  }

  private findNearestVehicle(x: number, z: number): TrafficVehicle | null {
    let bestDistSq = Infinity;
    let bestVeh: TrafficVehicle | null = null;
    for (const v of this.vehicles) {
      if (!v.active || v.state === 'UNMANNED') continue;
      const dSq = (v.x - x) * (v.x - x) + (v.z - z) * (v.z - z);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestVeh = v;
      }
    }
    return bestVeh;
  }

  private getForwardDistance(v: TrafficVehicle, tx: number, tz: number): number {
    const dx = tx - v.x;
    const dz = tz - v.z;
    const fwdX = Math.sin(v.rotationY);
    const fwdZ = Math.cos(v.rotationY);
    return dx * fwdX + dz * fwdZ;
  }

  private getLateralDistance(v: TrafficVehicle, tx: number, tz: number): number {
    const dx = tx - v.x;
    const dz = tz - v.z;
    const rightX = Math.cos(v.rotationY);
    const rightZ = -Math.sin(v.rotationY);
    return dx * rightX + dz * rightZ;
  }

  /**
   * 取得即時統計數據 (供 HUD 與 F13 面板使用)
   */
  public getStats(drawCalls = 4): TrafficSystemStats {
    let sedans = 0;
    let taxis = 0;
    let scooters = 0;
    let passengersCount = 0;
    let cautiousCount = 0;
    let normalCount = 0;
    let hurriedCount = 0;
    let slowCount = 0;
    let taxiDriverCount = 0;
    let calmMoodCount = 0;
    let annoyedMoodCount = 0;
    let angryMoodCount = 0;
    let activeVehiclesCount = 0;

    for (const v of this.vehicles) {
      if (!v.active) continue;
      activeVehiclesCount++;
      if (v.type === 'sedan') sedans++;
      else if (v.type === 'taxi') taxis++;
      else if (v.type === 'scooter') scooters++;

      passengersCount += v.driver.passengers.length;

      const p = v.driver.personality;
      if (p === 'cautious') cautiousCount++;
      else if (p === 'normal') normalCount++;
      else if (p === 'hurried') hurriedCount++;
      else if (p === 'slow') slowCount++;
      else if (p === 'taxi') taxiDriverCount++;

      const m = v.driver.mood;
      if (m === 'calm') calmMoodCount++;
      else if (m === 'annoyed') annoyedMoodCount++;
      else if (m === 'angry') angryMoodCount++;
    }

    const totalActive = Math.max(1, activeVehiclesCount);
    const vRate = (this.vehicleViolationsStats.total / totalActive) * 100;

    return {
      totalVehicles: activeVehiclesCount,
      totalDrivers: activeVehiclesCount,
      sedans,
      taxis,
      scooters,
      passengersCount,
      cautiousCount,
      normalCount,
      hurriedCount,
      slowCount,
      taxiDriverCount,
      calmMoodCount,
      annoyedMoodCount,
      angryMoodCount,
      honksThisFrame: this.honksThisFrame,
      totalHonks: this.totalHonks,
      wrongWayEvents: this.wrongWayEvents,
      headOppositeSpeedEvents: this.headOppositeSpeedEvents,
      violationsCount: { ...this.vehicleViolationsStats },
      violationRatePercent: Math.round(vRate * 10) / 10,
      aiTimeMs: this.lastAiTimeMs,
      drawCalls
    };
  }

  /**
   * 啟動 60 秒車輛行為抽樣 (供 F13 與自動測試腳本使用)
   */
  public startVehicleSampling(): void {
    this.vehicleSamplingActive = true;
    this.vehicleSamplingTimer = 60.0;
    this.vehicleSamplingSpeedSum = 0;
    this.vehicleSamplingSpeedSeconds = 0;
    this.vehicleSamplingInitialWrongWay = this.wrongWayEvents;
    this.vehicleSamplingInitialOpposite = this.headOppositeSpeedEvents;
    this.vehicleSamplingInitialViolations = { ...this.vehicleViolationsStats };
    this.vehicleSamplingReport = null;
    console.log('[TrafficSystem] 開始 60 秒車輛行為抽樣評估...');
  }

  public isSamplingActive(): boolean {
    return this.vehicleSamplingActive;
  }

  public getSamplingRemainingSec(): number {
    return Math.max(0, this.vehicleSamplingTimer);
  }

  /**
   * 取得 60 秒行為抽樣報告
   */
  public getVehicleSamplingReport(): VehicleSamplingReport | null {
    return this.vehicleSamplingReport;
  }

  /**
   * 精確匹配車輛面對之號誌進路與單一資料來源停止線
   */
  public findTargetApproachAndStopLine(v: TrafficVehicle): {
    intersection: IntersectionFeature;
    approach: IntersectionApproach;
    stopLine: StopLine;
    longitudinalDist: number;
    targetStopPos: Point2D;
  } | null {
    if (!this.trafficSignalSystem) return null;

    const vHalfLen = v.type === 'scooter' ? CONFIG.TRAFFIC.DIMENSIONS.SCOOTER_HALF_LEN : CONFIG.TRAFFIC.DIMENSIONS.SEDAN_HALF_LEN;
    const frontX = v.x + Math.sin(v.rotationY) * vHalfLen;
    const frontZ = v.z + Math.cos(v.rotationY) * vHalfLen;

    let bestDist = 60.0;
    let bestResult: {
      intersection: IntersectionFeature;
      approach: IntersectionApproach;
      stopLine: StopLine;
      longitudinalDist: number;
      targetStopPos: Point2D;
    } | null = null;

    for (const inter of this.intersections) {
      if (!inter.hasSignals) continue;
      const dToInter = Math.hypot(inter.center.x - v.x, inter.center.z - v.z);
      if (dToInter > inter.radius + 65.0) continue;

      for (const app of inter.approaches) {
        const stopLine = app.stopLine;
        if (!stopLine) continue;

        // 1. 航向角比對：車輛前進方向必須與進路前進方向夾角 < 48 度
        let diff = Math.abs(v.rotationY - app.azimuthRad);
        while (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff > 0.84) continue;

        // 2. 目標停止線位置 (機車停等區 vs 汽車停止線)
        const isScooter = v.type === 'scooter';
        const targetStopPos = (isScooter && stopLine.hasScooterWaitingBox && stopLine.scooterStopWorldPosition)
          ? stopLine.scooterStopWorldPosition
          : stopLine.worldPosition;

        // 3. 沿進路方位角的前向投影 (車頭距停止線的前向淨距)
        const forwardX = Math.sin(app.azimuthRad);
        const forwardZ = Math.cos(app.azimuthRad);
        const rightX = Math.cos(app.azimuthRad);
        const rightZ = -Math.sin(app.azimuthRad);

        const dx = targetStopPos.x - frontX;
        const dz = targetStopPos.z - frontZ;

        const longDist = dx * forwardX + dz * forwardZ;
        const latDist = Math.abs(dx * rightX + dz * rightZ);

        // 側向距離必須在車道涵蓋範圍內
        const maxLat = Math.max(3.8, app.width * 0.7);
        if (latDist > maxLat) continue;

        if (longDist >= -1.5 && longDist <= bestDist) {
          bestDist = longDist;
          bestResult = {
            intersection: inter,
            approach: app,
            stopLine,
            longitudinalDist: longDist,
            targetStopPos
          };
        }
      }
    }

    return bestResult;
  }

  /**
   * 路口清空規則 (Don't Block the Box)
   */
  private checkIntersectionExitSpace(v: TrafficVehicle, inter: IntersectionFeature, app: IntersectionApproach): boolean {
    const requiredSpace = CONFIG.TRAFFIC.BRAKING.CLEARANCE_SPACE_REQUIRED; // 6.5m
    const forwardX = Math.sin(app.azimuthRad);
    const forwardZ = Math.cos(app.azimuthRad);

    const exitX = inter.center.x + forwardX * (inter.radius + 2.0);
    const exitZ = inter.center.z + forwardZ * (inter.radius + 2.0);

    for (const other of this.vehicles) {
      if (!other.active || other.id === v.id) continue;
      const dToExit = Math.hypot(other.x - exitX, other.z - exitZ);
      const dToCenter = Math.hypot(other.x - inter.center.x, other.z - inter.center.z);

      if ((dToExit < requiredSpace || dToCenter < inter.radius * 0.6) && other.speed < 1.0) {
        return false;
      }
    }
    return true;
  }

  /**
   * 行人穿越道佔用檢測
   */
  private checkPedestriansOnCrossing(inter: IntersectionFeature, app: IntersectionApproach): boolean {
    if (!this.pedestrianSystem || !app.pedestrianCrossingId) return false;
    const cross = inter.crossings.find((c) => c.id === app.pedestrianCrossingId);
    if (!cross) return false;

    const peds = this.pedestrianSystem.getActiveAgents();
    for (const ped of peds) {
      const dToCross = Math.hypot(ped.x - cross.center.x, ped.z - cross.center.z);
      if (dToCross <= (cross.width * 0.5 + 1.5)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 【公開介面】停止線量測工具 (供 F14 面板與自動化測試腳本使用)
   */
  public getStopLineMeasurements(): StopLineStats {
    const measurements: StopLineMeasurement[] = [];
    let leadStoppedCount = 0;
    let compliantCount = 0;
    let tooCloseCount = 0;
    let pressedCount = 0;
    let totalDistSum = 0;

    for (const v of this.vehicles) {
      if (!v.active) continue;

      const isStopped = v.speed < 0.25;
      const targetInfo = this.findTargetApproachAndStopLine(v);

      if (targetInfo && (isStopped || v.state === 'STOPPED_SIGNAL' || v.state === 'STOPPED_OBSTACLE')) {
        const dLine = targetInfo.longitudinalDist;
        const isScooterBox = v.type === 'scooter' && targetInfo.stopLine.hasScooterWaitingBox;
        const lineType: 'car_stop_line' | 'scooter_box_line' = isScooterBox ? 'scooter_box_line' : 'car_stop_line';

        let status: 'compliant' | 'too_close' | 'line_pressed' | 'queueing' = 'queueing';
        const isLead = v.isLeadStoppedVehicle || (!v.queueLeadVehicleId && dLine < 3.0);

        if (dLine < 0) {
          status = 'line_pressed';
          pressedCount++;
        } else if (dLine < 0.5) {
          status = 'too_close';
          tooCloseCount++;
        } else if (dLine <= 1.05) {
          status = 'compliant';
          compliantCount++;
        } else {
          status = 'queueing';
        }

        if (isLead) {
          leadStoppedCount++;
          totalDistSum += Math.max(0, dLine);
        }

        measurements.push({
          vehicleId: v.id,
          vehicleType: v.type,
          intersectionId: targetInfo.intersection.id,
          approachId: targetInfo.approach.id,
          isLeadVehicle: isLead,
          frontBumperDistanceToStopLine: dLine,
          targetStopLineType: lineType,
          status,
          queueGapToLead: v.distanceToLeadVehicle
        });
      }
    }

    const totalStopped = measurements.length;
    const avgDist = leadStoppedCount > 0 ? (totalDistSum / leadStoppedCount) : 0;
    const compliantRate = leadStoppedCount > 0 ? (compliantCount / leadStoppedCount) * 100 : 100;
    const pressedRate = totalStopped > 0 ? (pressedCount / totalStopped) * 100 : 0;

    return {
      totalStopped,
      leadStoppedCount,
      compliantCount,
      compliantRate,
      tooCloseCount,
      pressedCount,
      pressedRate,
      averageDistanceToLine: avgDist,
      measurements
    };
  }

  public triggerAllRed(enable: boolean): void {
    if (this.trafficSignalSystem) {
      this.trafficSignalSystem.setForceAllRed(enable);
    }
  }

  public isAllRed(): boolean {
    return this.trafficSignalSystem ? this.trafficSignalSystem.getIsAllRed() : false;
  }
}
