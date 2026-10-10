/**
 * PedestrianSystem.ts - 行人生成、物件池、行為狀態機與空間避讓系統
 * 遵循 RULES.md：純邏輯與數學運算，不依賴 Three.js 渲染物件
 * 特點：
 * 1. 環形生成 (25m~110m) 與遠端回收 (>140m) 物件池 (上限預設 150 人)
 * 2. 空間雜湊網格 (Spatial Hash Grid) 高效行人相互分離避讓
 * 3. 玩家靠近自動側身避讓、建築邊界防穿牆
 * 4. 簡易交通號誌紅綠燈週期 (綠 15s、紅 20s) 控制過街
 * 5. 狀態機：WALKING, IDLE, WAITING_CROSSWALK, CROSSING, EVADING, PANIC
 * 6. 騎樓與店家進入暫留
 * 7. 事件匯流排預留接口 ('gunshot', 'carNearMiss', 'playerAttack')
 * 8. 時間切片分批更新，AI 耗時穩定控制在 0.5 ms 以內
 */

import { Point2D, BuildingCollisionData, RoadFeature, IntersectionFeature } from '../geo/OsmTypes.ts';
import {
  PedestrianNetworkData,
  PedestrianNode,
  PedestrianState,
  PedestrianSystemStats,
  PedestrianSamplingReport
} from '../geo/PedestrianTypes.ts';
import { CONFIG } from '../config.ts';
import { TrafficSignalSystem } from './traffic-signals/TrafficSignalSystem.ts';
import { PedestrianSignalInfo } from './traffic-signals/SignalController.ts';
import { DriverAppearance } from '../geo/TrafficTypes.ts';

export interface PedestrianAgent {
  id: number;
  active: boolean;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  speed: number;
  targetSpeed: number;
  state: PedestrianState;
  stateTimer: number;

  // 路網導航
  currentNodeId: number;
  targetNodeId: number;
  prevNodeId: number;
  pathProgress: number; // 0 ~ 1
  edgeLength: number;

  // 動態避讓速度
  avoidVx: number;
  avoidVz: number;

  // 動畫與姿態 (由 Renderer 讀取)
  walkPhase: number;
  idlePhase: number;
  gesture: number; // 0=正常, 1=手機, 2=提袋/毛巾, 3=驚恐揮手

  // 外觀配置
  skinColorHex: string;
  shirtColorHex: string;
  pantsColorHex: string;
  hairColorHex: string;
  heightScale: number;
  widthScale: number;
  accessoryType: 'none' | 'umbrella' | 'bag';

  // 暫留店家
  insideBuildingTimer: number;

  // 結伴同行組
  companionGroupId?: number;
  companionLeaderId?: number;
  companionOffsetSide?: number;

  // 遠程目標與起步延遲
  longTermGoalNodeId?: number;
  startDelayTimer?: number;

  // 等紅燈路緣站位
  curbWaitingSlotIndex?: number;
  curbWaitingOffsetX?: number;
  curbWaitingOffsetZ?: number;

  // 人行道兩側分流行走
  lateralOffset?: number;

  // 原地轉身狀態 (不倒退走)
  isTurningAround?: boolean;
  turnAroundTimer?: number;
  wrongFacingTimer?: number;

  // 斑馬線過街中心線限制
  currentCrossingGroupId?: number;

  // 違規行為
  isViolator?: boolean;
  violationType?: 'jaywalk_red_light' | 'cross_no_zebra' | 'walk_on_road_edge' | 'none';
  violationTimer?: number;

  // 碰撞、倒地、起身與脫困狀態
  pitch?: number;
  roll?: number;
  knockVx?: number;
  knockVy?: number;
  knockVz?: number;
  escapeTargetPoint?: Point2D;
  escapeStartTime?: number;
  escapeTimer?: number;
  isSpecialState?: boolean;
  outOfBoundsTimer?: number;
}

export class PedestrianSystem {
  private network: PedestrianNetworkData | null = null;
  private agents: PedestrianAgent[] = [];
  private maxCount = CONFIG.PEDESTRIAN.MAX_COUNT;

  // 道路與路口幾何資料 (用於可步行區域與車道邊界限制)
  public roads: RoadFeature[] = [];
  private intersections: IntersectionFeature[] = [];
  private trafficSystem: any = null;

  // 脫困與碰撞統計
  private leaveRoadSuccessCount = 0;
  private leaveRoadTotalDurationSec = 0;
  private leaveRoadFailCount = 0;
  private outOfBoundsEventsCount = 0;
  private totalKnockedDownCount = 0;

  // 空間雜湊網格 (Spatial Hash Grid)
  private cellSize = CONFIG.PEDESTRIAN.SPATIAL_GRID_SIZE; // 2.0m
  private grid: Map<string, number[]> = new Map();

  // 交通信號週期 (綠燈 15s，紅燈 20s)
  private trafficTimer = 0;
  private isCrosswalkGreen = true;
  private trafficSignalSystem: TrafficSignalSystem | null = null;
  private policeSystem: any = null;

  // 時間切片更新 (每幀更新 1/2)
  private sliceIndex = 0;
  private lastAiTimeMs = 0;

  // 事件監聽回呼清單
  private eventListeners: Map<string, ((origin: Point2D, radius: number) => void)[]> = new Map();

  // 結伴同行組計數器
  private nextCompanionGroupId = 1;

  // 違規、倒退走與過街統計
  private backwardsWalkCount = 0;
  private crossingsTotal = 0;
  private crossingsOnZebra = 0;
  private crossingsViolations = 0;
  private pedestrianViolationsStats = {
    jaywalkRed: 0,
    crossNoZebra: 0,
    walkRoadEdge: 0,
    total: 0
  };

  // 聚集度計算計時 (每秒計算一次)
  private crowdCheckTimer = 0;
  private crowdedCount = 0;
  private crowdedRatePercent = 0;

  // 60 秒行為抽樣
  private samplingActive = false;
  private samplingTimer = 0;
  private samplingInitialBackwards = 0;
  private samplingInitialCrossTotal = 0;
  private samplingInitialCrossZebra = 0;
  private samplingInitialCrossViolations = 0;
  private samplingInitialViolations = {
    jaywalkRed: 0,
    crossNoZebra: 0,
    walkRoadEdge: 0,
    total: 0
  };
  private samplingInitialLeaveRoadSuccess = 0;
  private samplingInitialLeaveRoadDuration = 0;
  private samplingInitialLeaveRoadFail = 0;
  private samplingInitialOutOfBounds = 0;
  private samplingInitialKnocked = 0;
  private samplingCrowdRateSum = 0;
  private samplingCrowdRateCount = 0;
  private samplingReport: PedestrianSamplingReport | null = null;

  constructor() {
    this.initPool();
  }

  private initPool(): void {
    this.agents = [];
    for (let i = 0; i < this.maxCount; i++) {
      this.agents.push({
        id: i,
        active: false,
        x: 0,
        y: 0,
        z: 0,
        rotationY: 0,
        speed: 0,
        targetSpeed: 1.3,
        state: PedestrianState.WALKING,
        stateTimer: 0,
        currentNodeId: -1,
        targetNodeId: -1,
        prevNodeId: -1,
        pathProgress: 0,
        edgeLength: 1,
        avoidVx: 0,
        avoidVz: 0,
        walkPhase: Math.random() * Math.PI * 2,
        idlePhase: Math.random() * Math.PI * 2,
        gesture: 0,
        skinColorHex: '#f8d5b8',
        shirtColorHex: '#38bdf8',
        pantsColorHex: '#1e293b',
        hairColorHex: '#1e1b18',
        heightScale: 1.0,
        widthScale: 1.0,
        accessoryType: 'none',
        insideBuildingTimer: 0,
        companionGroupId: undefined,
        companionLeaderId: undefined,
        companionOffsetSide: undefined,
        longTermGoalNodeId: undefined,
        startDelayTimer: 0,
        curbWaitingSlotIndex: undefined,
        curbWaitingOffsetX: 0,
        curbWaitingOffsetZ: 0,
        isTurningAround: false,
        turnAroundTimer: 0,
        wrongFacingTimer: 0,
        currentCrossingGroupId: undefined,
        isViolator: false,
        violationType: 'none',
        violationTimer: 0,
        pitch: 0,
        roll: 0,
        knockVx: 0,
        knockVy: 0,
        knockVz: 0,
        escapeTargetPoint: undefined,
        escapeStartTime: undefined,
        escapeTimer: 0,
        isSpecialState: false,
        outOfBoundsTimer: 0
      });
    }
  }

  public setNetwork(network: PedestrianNetworkData): void {
    this.network = network;
    // 重設所有行人
    for (const agent of this.agents) {
      agent.active = false;
    }
    this.grid.clear();
    console.log(`[PedestrianSystem] 已載入行人路網，節點數: ${network.nodes.length}`);
  }

  public setRoadsAndIntersections(roads: RoadFeature[], intersections: IntersectionFeature[]): void {
    this.roads = roads;
    this.intersections = intersections;
  }

  public setTrafficSystem(sys: any): void {
    this.trafficSystem = sys;
  }

  public getNetwork(): PedestrianNetworkData | null {
    return this.network;
  }

  public getActiveAgents(): PedestrianAgent[] {
    return this.agents.filter((a) => a.active);
  }

  public getAllAgents(): PedestrianAgent[] {
    return this.agents;
  }

  public setTrafficSignalSystem(sys: TrafficSignalSystem): void {
    this.trafficSignalSystem = sys;
  }

  /**
   * 查詢行人所在斑馬線對應的號誌狀態
   */
  private getAgentCrossingSignal(agent: PedestrianAgent): PedestrianSignalInfo | null {
    if (!this.trafficSignalSystem) return null;
    const inters = this.trafficSignalSystem.getIntersections();
    for (let i = 0; i < inters.length; i++) {
      const inter = inters[i];
      if (!inter.hasSignals) continue;
      const d = Math.hypot(inter.center.x - agent.x, inter.center.z - agent.z);
      if (d <= inter.radius + 8.0) {
        let bestDist = Infinity;
        let bestCrossId = '';
        for (const c of inter.crossings) {
          const cd = Math.hypot(c.center.x - agent.x, c.center.z - agent.z);
          if (cd < bestDist) {
            bestDist = cd;
            bestCrossId = c.id;
          }
        }
        if (bestCrossId) {
          return this.trafficSignalSystem.getPedestrianState(inter.id, bestCrossId);
        }
      }
    }
    return null;
  }

  /**
   * 固定時間步長更新 (60Hz)
   */
  public update(
    fixedDelta: number,
    playerPos: Point2D,
    cameraYaw: number,
    buildingColliders: BuildingCollisionData[] = [],
    isRaining = false
  ): void {
    if (!CONFIG.PEDESTRIAN.ENABLED || !this.network || this.network.nodes.length === 0) {
      return;
    }

    const tStart = performance.now();

    // 1. 更新全域交通信號 (綠燈 15s，紅燈 20s)
    const cycleLen = CONFIG.PEDESTRIAN.CROSSWALK_GREEN_SEC + CONFIG.PEDESTRIAN.CROSSWALK_RED_SEC;
    this.trafficTimer = (this.trafficTimer + fixedDelta) % cycleLen;
    this.isCrosswalkGreen = this.trafficTimer < CONFIG.PEDESTRIAN.CROSSWALK_GREEN_SEC;

    // 2. 構建空間雜湊網格
    this.buildSpatialGrid();

    // 3. 生成與回收
    this.manageLifecycle(playerPos, cameraYaw, isRaining);

    // 4. 行人 AI 決策與狀態機更新 (時間切片：每幀更新一半行人的行為選擇)
    const activeList = this.agents.filter((a) => a.active);
    const half = Math.ceil(activeList.length / CONFIG.PEDESTRIAN.TIME_SLICED_UPDATES);
    const startIdx = (this.sliceIndex % CONFIG.PEDESTRIAN.TIME_SLICED_UPDATES) * half;
    const endIdx = Math.min(activeList.length, startIdx + half);
    this.sliceIndex++;

    for (let i = startIdx; i < endIdx; i++) {
      this.updateAgentAI(activeList[i], fixedDelta, isRaining);
    }

    // 5. 行人物理移動、避讓與動畫相位 (所有有效行人每幀執行，確保動作平滑)
    for (let i = 0; i < activeList.length; i++) {
      const agent = activeList[i];
      this.updateAgentPhysicsAndAnimation(agent, fixedDelta, playerPos, buildingColliders);
    }

    // 6. 每秒計算一次聚集比例 (統計 1.2m 內有 2 位以上非同伴人數 / 總人數，目標 < 3%)
    this.crowdCheckTimer += fixedDelta;
    if (this.crowdCheckTimer >= 1.0) {
      this.crowdCheckTimer = 0;
      let count = 0;
      const total = activeList.length;
      for (let i = 0; i < total; i++) {
        const a1 = activeList[i];
        if (a1.state === PedestrianState.WAITING_CROSSWALK) continue;
        let nearCount = 0;
        for (let j = 0; j < total; j++) {
          if (i === j) continue;
          const a2 = activeList[j];
          if (a2.state === PedestrianState.WAITING_CROSSWALK) continue;
          if (a1.companionGroupId && a2.companionGroupId && a1.companionGroupId === a2.companionGroupId) continue;
          const dSq = (a1.x - a2.x) * (a1.x - a2.x) + (a1.z - a2.z) * (a1.z - a2.z);
          if (dSq < 1.44) {
            nearCount++;
            if (nearCount >= 2) break;
          }
        }
        if (nearCount >= 2) {
          count++;
        }
      }
      this.crowdedCount = count;
      this.crowdedRatePercent = total > 0 ? (count / total) * 100 : 0;
    }

    // 7. 60 秒行為抽樣更新
    if (this.samplingActive) {
      this.samplingTimer -= fixedDelta;
      this.samplingCrowdRateSum += this.crowdedRatePercent;
      this.samplingCrowdRateCount++;

      if (this.samplingTimer <= 0) {
        this.samplingActive = false;
        const deltaBackwards = this.backwardsWalkCount - this.samplingInitialBackwards;
        const deltaCrossTotal = this.crossingsTotal - this.samplingInitialCrossTotal;
        const deltaCrossZebra = this.crossingsOnZebra - this.samplingInitialCrossZebra;
        const deltaCrossViolations = this.crossingsViolations - this.samplingInitialCrossViolations;
        const deltaViolations = {
          jaywalkRed: this.pedestrianViolationsStats.jaywalkRed - this.samplingInitialViolations.jaywalkRed,
          crossNoZebra: this.pedestrianViolationsStats.crossNoZebra - this.samplingInitialViolations.crossNoZebra,
          walkRoadEdge: this.pedestrianViolationsStats.walkRoadEdge - this.samplingInitialViolations.walkRoadEdge,
          total: this.pedestrianViolationsStats.total - this.samplingInitialViolations.total
        };

        const totalActive = Math.max(1, activeList.length);
        const avgCrowdRate = this.samplingCrowdRateCount > 0
          ? this.samplingCrowdRateSum / this.samplingCrowdRateCount
          : this.crowdedRatePercent;
        const zebraCompliance = deltaCrossTotal > 0
          ? ((deltaCrossZebra / deltaCrossTotal) * 100)
          : 100.0;
        const vRate = (deltaViolations.total / totalActive) * 100;

        const deltaSuccess = this.leaveRoadSuccessCount - this.samplingInitialLeaveRoadSuccess;
        const deltaDuration = this.leaveRoadTotalDurationSec - this.samplingInitialLeaveRoadDuration;
        const deltaFail = this.leaveRoadFailCount - this.samplingInitialLeaveRoadFail;
        const deltaOob = this.outOfBoundsEventsCount - this.samplingInitialOutOfBounds;
        const deltaKnocked = this.totalKnockedDownCount - this.samplingInitialKnocked;
        const avgLeaveDuration = deltaSuccess > 0 ? (deltaDuration / deltaSuccess) : 0;
        const returnRatio = deltaKnocked > 0
          ? Math.min(100, Math.round((deltaSuccess / deltaKnocked) * 100))
          : 100;

        let specialCount = 0;
        for (const a of activeList) {
          if (
            a.state === PedestrianState.KNOCKED_FLYING ||
            a.state === PedestrianState.FALLEN ||
            a.state === PedestrianState.GETTING_UP ||
            a.state === PedestrianState.LEAVING_ROAD
          ) {
            specialCount++;
          }
        }

        this.samplingReport = {
          samplingDurationSec: 60.0,
          totalPedestriansSampled: totalActive,
          specialStatePedestriansCount: specialCount,
          leaveRoadSuccessCount: deltaSuccess,
          leaveRoadAvgDurationSec: Math.round(avgLeaveDuration * 10) / 10,
          leaveRoadFailCount: deltaFail,
          returnToSidewalkRatioPercent: returnRatio,
          outOfBoundsEventsCount: deltaOob,
          backwardsCount: deltaBackwards,
          crowdedRatePercent: Math.round(avgCrowdRate * 10) / 10,
          crowdedEventsCount: Math.round((avgCrowdRate * totalActive) / 100),
          zebraComplianceRatePercent: Math.round(zebraCompliance * 10) / 10,
          crossingsTotal: deltaCrossTotal,
          crossingsOnZebra: deltaCrossZebra,
          crossingsViolations: deltaCrossViolations,
          violationsCount: deltaViolations,
          violationRatePercent: Math.round(vRate * 10) / 10,
          isCompliant: deltaBackwards === 0 && avgCrowdRate <= 3.0 && deltaViolations.crossNoZebra === 0 && deltaOob === 0 && deltaFail === 0
        };
        console.log('[PedestrianSystem] 60 秒行人行為抽樣完成:', this.samplingReport);
      }
    }

    this.lastAiTimeMs = performance.now() - tStart;
  }

  /**
   * 構建空間雜湊網格以供快速鄰近查詢
   */
  private buildSpatialGrid(): void {
    this.grid.clear();
    const inv = 1.0 / this.cellSize;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active || a.insideBuildingTimer > 0) continue;

      const gx = Math.floor(a.x * inv);
      const gz = Math.floor(a.z * inv);
      const key = `${gx}_${gz}`;

      let list = this.grid.get(key);
      if (!list) {
        list = [];
        this.grid.set(key, list);
      }
      list.push(i);
    }
  }

  /**
   * 行人生成與回收管理
   */
  private manageLifecycle(playerPos: Point2D, cameraYaw: number, isRaining: boolean): void {
    const cfg = CONFIG.PEDESTRIAN;

    let activeCount = 0;

    // 回收遠處行人
    for (const a of this.agents) {
      if (!a.active) continue;
      const d = Math.hypot(a.x - playerPos.x, a.z - playerPos.z);
      if (d > cfg.DESPAWN_RADIUS) {
        a.active = false;
      } else {
        activeCount++;
      }
    }

    // 當行人數不足上限時，加權生成新行人 (初期快速補充至上限)
    const needed = Math.min(activeCount < 60 ? 24 : 6, cfg.MAX_COUNT - activeCount);
    if (needed <= 0) return;

    for (let k = 0; k < needed; k++) {
      let angle: number;
      let radius: number;

      if (activeCount < 55) {
        // 初期世界加載：全方位 360 度均勻覆蓋近身街道，使眼前與身旁立即有人走動
        angle = Math.random() * Math.PI * 2;
        radius = 4.0 + Math.random() * 45.0;
      } else if (Math.random() < 0.50) {
        // 50% 在前方街道遠處生成，自然向玩家走來
        const fovCenterAngle = -cameraYaw - Math.PI * 0.5;
        angle = fovCenterAngle + (Math.random() - 0.5) * 1.3;
        radius = 8.0 + Math.random() * (cfg.SPAWN_MAX_RADIUS - 8.0);
      } else {
        // 50% 在視野兩側與視野外路段生成
        const fovCenterAngle = -cameraYaw - Math.PI * 0.5;
        angle = fovCenterAngle + Math.PI + (Math.random() - 0.5) * (Math.PI * 1.4);
        radius = 6.0 + Math.random() * (cfg.SPAWN_MAX_RADIUS - 6.0);
      }

      const sampleX = playerPos.x + Math.cos(angle) * radius;
      const sampleZ = playerPos.z + Math.sin(angle) * radius;

      // 尋找最近之候選節點 (18m 範圍內，防止吸附到太遠的節點)
      const candNode = this.findNearestNodeWeighted(sampleX, sampleZ, 18.0);
      if (candNode !== null && candNode.edges.length > 0) {
        // 依據 Poisson-disk 6m 最小間距與 10x10m 密度上限判斷是否可生成
        if (!this.isPositionCrowded(candNode.x, candNode.z, candNode)) {
          this.spawnAgentAtNode(candNode, isRaining);
        }
      }
    }
  }

  /**
   * 檢查某個座標點附近是否已有有效行人 (Poisson-disk 6m 最小間距 + 10x10m 密度上限 4人/熱點 8人)
   */
  private isPositionCrowded(x: number, z: number, node: PedestrianNode): boolean {
    const minSpacing = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.MIN_SPAWN_SPACING; // 6.0m
    const isHotspot = (node.densityWeight || 1.0) >= 1.8;
    const cellLimit = isHotspot
      ? CONFIG.NPC_BEHAVIOR.PEDESTRIAN.GRID_DENSITY_LIMIT_HOTSPOT // 8 人
      : CONFIG.NPC_BEHAVIOR.PEDESTRIAN.GRID_DENSITY_LIMIT_NORMAL; // 4 人

    const gx = Math.floor(x / 10.0);
    const gz = Math.floor(z / 10.0);
    let cellCount = 0;

    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (!a.active) continue;

      const dist = Math.hypot(a.x - x, a.z - z);
      if (dist < minSpacing) {
        return true;
      }

      const agx = Math.floor(a.x / 10.0);
      const agz = Math.floor(a.z / 10.0);
      if (agx === gx && agz === gz) {
        cellCount++;
        if (cellCount >= cellLimit) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 在特定節點激活生成行人
   */
  private spawnAgentAtNode(node: PedestrianNode, isRaining: boolean): void {
    if (node.isCrosswalk) return; // 絕不直接在斑馬線/車道中央生成行人
    const inactiveAgent = this.agents.find((a) => !a.active);
    if (!inactiveAgent) return;

    const colors = CONFIG.PEDESTRIAN.COLORS;
    const speeds = CONFIG.PEDESTRIAN;

    const validEdges = node.edges.filter(
      (e) => !e.isCrosswalk && e.type !== 'crosswalk' && !this.network!.nodes[e.target]?.isCrosswalk
    );
    if (validEdges.length === 0) return;
    const targetEdge = validEdges[Math.floor(Math.random() * validEdges.length)];
    const targetNode = this.network!.nodes[targetEdge.target];

    // 初次生成時隨機分配在該路段進度 (0.0 ~ 0.95)，使行人自然均勻散佈於街道各處，而非全聚集在端點
    const progress = Math.random() * 0.95;
    const dx = targetNode.x - node.x;
    const dz = targetNode.z - node.z;
    const segLen = Math.hypot(dx, dz) || 1.0;
    const normX = -dz / segLen;
    const normZ = dx / segLen;
    const latOffset = (Math.random() > 0.5 ? 1 : -1) * (0.35 + Math.random() * 0.35);
    const spawnX = node.x + dx * progress + normX * latOffset;
    const spawnZ = node.z + dz * progress + normZ * latOffset;

    if (this.isPointOnRoadway(spawnX, spawnZ)) return;
    if (this.isPositionCrowded(spawnX, spawnZ, node)) return;

    inactiveAgent.active = true;
    inactiveAgent.x = spawnX;
    inactiveAgent.z = spawnZ;
    inactiveAgent.lateralOffset = latOffset;
    const currY = (node.isArcade || !node.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    const targetY = (targetNode.isArcade || !targetNode.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    inactiveAgent.y = currY + (targetY - currY) * progress;

    inactiveAgent.currentNodeId = node.id;
    inactiveAgent.targetNodeId = targetEdge.target;
    inactiveAgent.prevNodeId = -1;
    inactiveAgent.pathProgress = progress;
    inactiveAgent.edgeLength = targetEdge.distance;
    inactiveAgent.rotationY = Math.atan2(dx, dz);

    // 速度隨機差異 ±20%
    const speedVariation = 1.0 + (Math.random() * 2 - 1) * CONFIG.NPC_BEHAVIOR.PEDESTRIAN.SPEED_VARIATION;
    const baseSpeed = (speeds.MIN_SPEED_MPS + Math.random() * (speeds.MAX_SPEED_MPS - speeds.MIN_SPEED_MPS)) * speedVariation;
    inactiveAgent.targetSpeed = baseSpeed;
    inactiveAgent.speed = baseSpeed;

    // 起步隨機延遲 (0~3 秒，避免同步啟動)
    inactiveAgent.startDelayTimer = Math.random() * CONFIG.NPC_BEHAVIOR.PEDESTRIAN.START_DELAY_MAX;

    // 隨機遠程目標節點 (80~200m，避免所有人朝同一方向走)
    const distantNodes = this.network!.nodes.filter((n) => {
      const d = Math.hypot(n.x - node.x, n.z - node.z);
      return d >= 80.0 && d <= 200.0;
    });
    if (distantNodes.length > 0) {
      inactiveAgent.longTermGoalNodeId = distantNodes[Math.floor(Math.random() * distantNodes.length)].id;
    } else {
      inactiveAgent.longTermGoalNodeId = undefined;
    }

    // 重設轉向與站位狀態
    inactiveAgent.isTurningAround = false;
    inactiveAgent.turnAroundTimer = 0;
    inactiveAgent.wrongFacingTimer = 0;
    inactiveAgent.curbWaitingSlotIndex = undefined;
    inactiveAgent.curbWaitingOffsetX = 0;
    inactiveAgent.curbWaitingOffsetZ = 0;
    inactiveAgent.currentCrossingGroupId = undefined;

    // 違規行為初始化 (約 6% 機率，安全避讓不相撞)
    inactiveAgent.isViolator = false;
    inactiveAgent.violationType = 'none';
    inactiveAgent.violationTimer = 0;
    if (CONFIG.NPC_BEHAVIOR.violationsEnabled && Math.random() < CONFIG.NPC_BEHAVIOR.VIOLATIONS.pedestrian.totalRate) {
      inactiveAgent.isViolator = true;
      const vRoll = Math.random();
      if (vRoll < 0.50) {
        inactiveAgent.violationType = 'jaywalk_red_light';
      } else if (vRoll < 0.83) {
        inactiveAgent.violationType = 'cross_no_zebra';
      } else {
        inactiveAgent.violationType = 'walk_on_road_edge';
      }
    }

    // 結伴同行組初始化 (約 8% 機率)
    inactiveAgent.companionGroupId = undefined;
    inactiveAgent.companionLeaderId = undefined;
    inactiveAgent.companionOffsetSide = undefined;

    if (Math.random() < CONFIG.NPC_BEHAVIOR.PEDESTRIAN.COMPANION_GROUP_CHANCE) {
      const companionGroupId = this.nextCompanionGroupId++;
      inactiveAgent.companionGroupId = companionGroupId;
      inactiveAgent.companionOffsetSide = 0;

      // 生成同伴 (雙人組或三人組)
      const groupSize = Math.random() < 0.8 ? 2 : 3;
      for (let g = 1; g < groupSize; g++) {
        const partner = this.agents.find((a) => !a.active);
        if (partner) {
          const sideOffset = (g === 1 ? 1 : -1) * (CONFIG.NPC_BEHAVIOR.PEDESTRIAN.COMPANION_SPACING_MIN + Math.random() * (CONFIG.NPC_BEHAVIOR.PEDESTRIAN.COMPANION_SPACING_MAX - CONFIG.NPC_BEHAVIOR.PEDESTRIAN.COMPANION_SPACING_MIN));
          this.spawnCompanion(partner, inactiveAgent, companionGroupId, sideOffset, isRaining);
        }
      }
    }

    // 約 2% 行人進入路邊叫車狀態
    if (!node.isCrosswalk && Math.random() < 0.02) {
      inactiveAgent.state = PedestrianState.HAILING_TAXI;
      inactiveAgent.stateTimer = 20.0 + Math.random() * 25.0;
      inactiveAgent.targetSpeed = 0;
      inactiveAgent.speed = 0;
    } else {
      inactiveAgent.state = PedestrianState.WALKING;
      inactiveAgent.stateTimer = 0;
    }
    inactiveAgent.insideBuildingTimer = 0;

    // 隨機外觀配置
    inactiveAgent.skinColorHex = colors.SKINS[Math.floor(Math.random() * colors.SKINS.length)];
    inactiveAgent.hairColorHex = colors.HAIRS[Math.floor(Math.random() * colors.HAIRS.length)];
    inactiveAgent.pantsColorHex = colors.PANTS[Math.floor(Math.random() * colors.PANTS.length)];

    // 溫泉區服飾機率 (若該節點密度權重 >= 1.8，30% 機率穿溫泉浴衣/淺色襯衫)
    if (node.densityWeight >= 1.8 && Math.random() < 0.35) {
      inactiveAgent.shirtColorHex = colors.HOT_SPRING_SHIRTS[Math.floor(Math.random() * colors.HOT_SPRING_SHIRTS.length)];
      inactiveAgent.accessoryType = 'bag'; // 拿毛巾手提袋
      inactiveAgent.gesture = 2;
    } else {
      inactiveAgent.shirtColorHex = colors.SHIRTS[Math.floor(Math.random() * colors.SHIRTS.length)];
      if (isRaining) {
        inactiveAgent.accessoryType = Math.random() < 0.75 ? 'umbrella' : 'none';
        inactiveAgent.gesture = inactiveAgent.accessoryType === 'umbrella' ? 2 : 0;
      } else {
        const randAcc = Math.random();
        if (randAcc < 0.15) {
          inactiveAgent.accessoryType = 'bag';
          inactiveAgent.gesture = 2;
        } else if (randAcc < 0.28) {
          inactiveAgent.accessoryType = 'none';
          inactiveAgent.gesture = 1; // 拿手機看螢幕姿勢
        } else {
          inactiveAgent.accessoryType = 'none';
          inactiveAgent.gesture = 0;
        }
      }
    }

    inactiveAgent.heightScale = 0.94 + Math.random() * 0.12;
    inactiveAgent.widthScale = 0.94 + Math.random() * 0.12;
    inactiveAgent.walkPhase = Math.random() * Math.PI * 2;
    inactiveAgent.idlePhase = Math.random() * Math.PI * 2;
  }

  /**
   * 生成結伴同行夥伴 (保持 0.8~1.2m 並排同速同向)
   */
  private spawnCompanion(
    partner: PedestrianAgent,
    leader: PedestrianAgent,
    companionGroupId: number,
    sideOffset: number,
    isRaining: boolean
  ): void {
    const colors = CONFIG.PEDESTRIAN.COLORS;
    partner.active = true;
    partner.companionGroupId = companionGroupId;
    partner.companionLeaderId = leader.id;
    partner.companionOffsetSide = sideOffset;

    // 沿領頭人前進方向之側向偏移
    const fwdX = Math.sin(leader.rotationY);
    const fwdZ = Math.cos(leader.rotationY);
    const rightX = fwdZ;
    const rightZ = -fwdX;

    partner.x = leader.x + rightX * sideOffset;
    partner.y = leader.y;
    partner.z = leader.z + rightZ * sideOffset;
    partner.rotationY = leader.rotationY;
    partner.currentNodeId = leader.currentNodeId;
    partner.targetNodeId = leader.targetNodeId;
    partner.prevNodeId = leader.prevNodeId;
    partner.pathProgress = leader.pathProgress;
    partner.edgeLength = leader.edgeLength;
    partner.speed = leader.speed;
    partner.targetSpeed = leader.targetSpeed;
    partner.startDelayTimer = leader.startDelayTimer;
    partner.state = leader.state;
    partner.stateTimer = leader.stateTimer;
    partner.insideBuildingTimer = 0;
    partner.longTermGoalNodeId = leader.longTermGoalNodeId;
    partner.isViolator = leader.isViolator;
    partner.violationType = leader.violationType;
    partner.violationTimer = 0;

    partner.skinColorHex = colors.SKINS[Math.floor(Math.random() * colors.SKINS.length)];
    partner.hairColorHex = colors.HAIRS[Math.floor(Math.random() * colors.HAIRS.length)];
    partner.pantsColorHex = colors.PANTS[Math.floor(Math.random() * colors.PANTS.length)];
    partner.shirtColorHex = colors.SHIRTS[Math.floor(Math.random() * colors.SHIRTS.length)];
    partner.accessoryType = isRaining ? (Math.random() < 0.75 ? 'umbrella' : 'none') : 'none';
    partner.gesture = partner.accessoryType === 'umbrella' ? 2 : 0;
    partner.heightScale = 0.94 + Math.random() * 0.12;
    partner.widthScale = 0.94 + Math.random() * 0.12;
    partner.walkPhase = leader.walkPhase;
    partner.idlePhase = leader.idlePhase;
  }

  /**
   * 搜尋加權最近節點 (結合密度權重)
   */
  private findNearestNodeWeighted(x: number, z: number, maxDist: number): PedestrianNode | null {
    const nodes = this.network!.nodes;
    let bestScore = -Infinity;
    let bestNode: PedestrianNode | null = null;

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.edges.length === 0) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d <= maxDist) {
        // 分數 = 密度權重 / (距離 + 1)
        const score = (n.densityWeight || 1.0) / (d + 1.0);
        if (score > bestScore) {
          bestScore = score;
          bestNode = n;
        }
      }
    }

    return bestNode;
  }

  /**
   * 行人 AI 決策更新
   */
  private updateAgentAI(agent: PedestrianAgent, dt: number, isRaining: boolean): void {
    if (
      agent.state === PedestrianState.KNOCKED_FLYING ||
      agent.state === PedestrianState.FALLEN ||
      agent.state === PedestrianState.GETTING_UP ||
      agent.state === PedestrianState.LEAVING_ROAD
    ) {
      return;
    }

    if (agent.insideBuildingTimer > 0) {
      agent.insideBuildingTimer -= dt;
      return;
    }

    // 警車鳴笛讓道反應 (過街加快腳步通過，不可停在馬路中央；人行道停步張望)
    if (this.policeSystem) {
      const sirens = this.policeSystem.getActiveSirenPositions?.() || [];
      for (const s of sirens) {
        const dSiren = Math.hypot(agent.x - s.x, agent.z - s.z);
        if (dSiren < CONFIG.POLICE.YIELD_SIREN_DISTANCE) {
          if (agent.state === PedestrianState.CROSSING) {
            agent.targetSpeed = 2.2; // 加快腳步通過
            return;
          } else if (agent.state === PedestrianState.WALKING) {
            agent.targetSpeed = 0;
            agent.state = PedestrianState.IDLE;
            agent.stateTimer = 2.0;
            const dx = s.x - agent.x;
            const dz = s.z - agent.z;
            agent.rotationY = Math.atan2(dx, dz);
            return;
          }
        }
      }
    }

    // 狀態機邏輯
    switch (agent.state) {
      case PedestrianState.WALKING: {
        agent.targetSpeed = isRaining ? 1.55 : 1.3;
        break;
      }

      case PedestrianState.IDLE: {
        agent.targetSpeed = 0;
        agent.stateTimer -= dt;
        if (agent.stateTimer <= 0) {
          agent.state = PedestrianState.WALKING;
          agent.gesture = agent.accessoryType === 'umbrella' ? 2 : 0;
        }
        break;
      }

      case PedestrianState.WAITING_CROSSWALK: {
        agent.targetSpeed = 0;
        const sig = this.getAgentCrossingSignal(agent);
        if (sig) {
          const neededSec = (agent.edgeLength || 10.0) / 1.35;
          // 綠燈且剩餘時間充足才開始過街
          if (sig.state === 'walk' && sig.remainingSec >= neededSec) {
            agent.state = PedestrianState.CROSSING;
            agent.targetSpeed = 1.35;
          }
        } else {
          // 無號誌路口備援
          if (this.isCrosswalkGreen || Math.random() < CONFIG.PEDESTRIAN.CROSSWALK_JAYWALK_CHANCE) {
            agent.state = PedestrianState.CROSSING;
            agent.targetSpeed = 1.35;
          }
        }
        break;
      }

      case PedestrianState.CROSSING: {
        const sig = this.getAgentCrossingSignal(agent);
        if (sig && sig.state === 'flashing') {
          // 閃爍時正在過街的行人加快腳步 (提速 1.4 倍)
          agent.targetSpeed = 1.35 * 1.4;
        } else {
          agent.targetSpeed = 1.35;
        }
        break;
      }

      case PedestrianState.PANIC: {
        agent.targetSpeed = CONFIG.PEDESTRIAN.PANIC_SPEED_MPS; // 3.5m/s
        agent.gesture = 3; // 驚慌揮手
        agent.stateTimer -= dt;
        if (agent.stateTimer <= 0) {
          agent.state = PedestrianState.WALKING;
          agent.gesture = 0;
        }
        break;
      }

      case PedestrianState.EVADING: {
        // 短暫避讓後自然恢復行走
        agent.stateTimer -= dt;
        if (agent.stateTimer <= 0) {
          agent.state = PedestrianState.WALKING;
        }
        break;
      }

      case PedestrianState.HAILING_TAXI: {
        agent.targetSpeed = 0;
        agent.gesture = 3; // 揮手叫車動作
        agent.stateTimer -= dt;
        if (agent.stateTimer <= 0) {
          agent.state = PedestrianState.WALKING;
          agent.gesture = 0;
        }
        break;
      }
    }
  }

  /**
   * 行人物理位移、避讓與路網前進
   */
  private updateAgentPhysicsAndAnimation(
    agent: PedestrianAgent,
    dt: number,
    playerPos: Point2D,
    buildingColliders: BuildingCollisionData[]
  ): void {
    if (agent.insideBuildingTimer > 0) {
      return; // 處於室內/店家時跳過
    }

    // 特殊狀態處理 (被撞飛、倒地、起身、離開車道脫困)
    if (this.handleSpecialAgentState(agent, dt, playerPos)) {
      return;
    }

    // 起步隨機延遲 (0~3 秒，避免像連體嬰一樣同步啟動)
    if (agent.startDelayTimer && agent.startDelayTimer > 0) {
      agent.startDelayTimer -= dt;
      agent.idlePhase += dt * 2.5;
      return;
    }

    const nodes = this.network!.nodes;
    const currNode = nodes[agent.currentNodeId];
    const targetNode = nodes[agent.targetNodeId];

    if (!currNode || !targetNode) {
      agent.active = false;
      return;
    }

    const segDx = targetNode.x - currNode.x;
    const segDz = targetNode.z - currNode.z;
    const targetAngle = Math.atan2(segDx, segDz);

    // 原地轉身狀態處理 (夾角大或折返時，先原地轉身 0.3~0.6s 再走，絕不倒退走)
    if (agent.isTurningAround) {
      agent.turnAroundTimer = (agent.turnAroundTimer || 0) - dt;
      agent.speed = 0;
      agent.avoidVx = 0;
      agent.avoidVz = 0;
      let angleDiff = targetAngle - agent.rotationY;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      const maxTurnStep = (CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.MAX_TURN_RATE_DEG_PER_SEC * Math.PI / 180) * dt;
      const turnStep = Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), maxTurnStep);
      agent.rotationY += turnStep;
      agent.idlePhase += dt * 2.5;
      if (Math.abs(angleDiff) < 0.15 && (agent.turnAroundTimer === undefined || agent.turnAroundTimer <= 0)) {
        agent.isTurningAround = false;
      }
      return;
    }

    // 夾角超過門檻時速度降為 0 先原地轉身
    let headingDiff = targetAngle - agent.rotationY;
    while (headingDiff > Math.PI) headingDiff -= Math.PI * 2;
    while (headingDiff < -Math.PI) headingDiff += Math.PI * 2;
    if (Math.abs(headingDiff) > (CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.REVERSE_ANGLE_THRESHOLD_DEG * Math.PI / 180)) {
      agent.isTurningAround = true;
      agent.turnAroundTimer = CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.TURN_AROUND_TIME_MIN + Math.random() * (CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.TURN_AROUND_TIME_MAX - CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.TURN_AROUND_TIME_MIN);
      agent.speed = 0;
      agent.avoidVx = 0;
      agent.avoidVz = 0;
      return;
    }

    // 速度平滑過渡
    agent.speed += (agent.targetSpeed - agent.speed) * Math.min(1.0, dt * 5.0);

    // 1. 空間避讓 (0.7m 個人空間排斥力)
    this.calculateSeparation(agent, dt);

    // 2. 避讓玩家 (當距離小於門檻時向兩側側移讓路)
    const toPlayerX = playerPos.x - agent.x;
    const toPlayerZ = playerPos.z - agent.z;
    const distToPlayer = Math.hypot(toPlayerX, toPlayerZ);

    if (distToPlayer < CONFIG.PEDESTRIAN.AVOID_PLAYER_RADIUS && distToPlayer > 0.1) {
      const avoidStrength = (CONFIG.PEDESTRIAN.AVOID_PLAYER_RADIUS - distToPlayer) * 3.5;
      agent.avoidVx -= (toPlayerX / distToPlayer) * avoidStrength;
      agent.avoidVz -= (toPlayerZ / distToPlayer) * avoidStrength;
      agent.state = PedestrianState.EVADING;
      agent.stateTimer = 0.8;
    }

    // 避讓速度不得向後推動行人 (防止避讓導致倒退走)
    const fwdX = Math.sin(agent.rotationY);
    const fwdZ = Math.cos(agent.rotationY);
    const avoidDot = agent.avoidVx * fwdX + agent.avoidVz * fwdZ;
    if (avoidDot < 0) {
      agent.avoidVx -= avoidDot * fwdX;
      agent.avoidVz -= avoidDot * fwdZ;
    }

    // 3. 沿路網前進
    const segLen = agent.edgeLength || Math.hypot(segDx, segDz) || 1;
    const moveDist = agent.speed * dt;
    agent.pathProgress += moveDist / segLen;

    const normX = -segDz / segLen;
    const normZ = segDx / segLen;

    // 沿當前朝向方向前進 + 避讓向量 (保證絕對不產生倒退分量)
    const fwdStep = agent.speed * dt;
    let nextX = agent.x + fwdX * fwdStep + agent.avoidVx * dt;
    let nextZ = agent.z + fwdZ * fwdStep + agent.avoidVz * dt;

    // 斑馬線中心線限制：橫向偏移 <= 0.8m，偏離 > 1.0m 自動拉回
    if (agent.state === PedestrianState.CROSSING && currNode.isCrosswalk && targetNode.isCrosswalk) {
      const cNormX = normX;
      const cNormZ = normZ;
      const toCurX = nextX - currNode.x;
      const toCurZ = nextZ - currNode.z;
      const latDist = toCurX * cNormX + toCurZ * cNormZ;
      if (Math.abs(latDist) > CONFIG.NPC_BEHAVIOR.CROSSWALK.MAX_DRIFT_PULLBACK) {
        const clampOffset = Math.sign(latDist) * CONFIG.NPC_BEHAVIOR.CROSSWALK.MAX_LATERAL_OFFSET;
        nextX -= cNormX * (latDist - clampOffset);
        nextZ -= cNormZ * (latDist - clampOffset);
      } else if (Math.abs(latDist) > CONFIG.NPC_BEHAVIOR.CROSSWALK.MAX_LATERAL_OFFSET) {
        nextX -= cNormX * (latDist - Math.sign(latDist) * 0.8) * Math.min(1.0, dt * 5.0);
        nextZ -= cNormZ * (latDist - Math.sign(latDist) * 0.8) * Math.min(1.0, dt * 5.0);
      }
    }

    // 限制在可步行區域：人行道推擠、避讓玩家等不得將行人推進車道
    const clamped = this.clampToWalkableArea(agent, nextX, nextZ);
    nextX = clamped.x;
    nextZ = clamped.z;

    // 檢查越界事件 (一般狀態之行人若踏上車道且非斑馬線，計入越界並推回)
    if (
      !agent.isSpecialState &&
      agent.state !== PedestrianState.CROSSING &&
      agent.state !== PedestrianState.WAITING_CROSSWALK &&
      agent.state !== PedestrianState.LEAVING_ROAD
    ) {
      if (this.isPointOnRoadway(nextX, nextZ)) {
        agent.outOfBoundsTimer = (agent.outOfBoundsTimer || 0) + dt;
        if (agent.outOfBoundsTimer > 0.5) {
          this.outOfBoundsEventsCount++;
          agent.outOfBoundsTimer = 0;
          const safePt = this.findNearestWalkablePoint(nextX, nextZ);
          nextX = safePt.x;
          nextZ = safePt.z;
        }
      } else {
        agent.outOfBoundsTimer = 0;
      }
    } else {
      agent.outOfBoundsTimer = 0;
    }

    // 車輛與行人碰撞檢測 (若未處於特殊狀態且被移動中的車輛撞上)
    if (this.trafficSystem && !agent.isSpecialState && agent.state !== PedestrianState.LEAVING_ROAD) {
      // 只有在車道上或斑馬線上的行人才會被車輛碰撞，人行道上行人不受車輛碰撞
      if (this.isPointOnRoadway(agent.x, agent.z) || this.isPointInCrosswalk(agent.x, agent.z)) {
        const vehicles = this.trafficSystem.getActiveVehicles();
        for (let vi = 0; vi < vehicles.length; vi++) {
          const v = vehicles[vi];
          if (v.speed < 1.0) continue;
          const vdx = agent.x - v.x;
          const vdz = agent.z - v.z;
          if (Math.hypot(vdx, vdz) < 4.5) {
            const cosV = Math.cos(v.heading || 0);
            const sinV = Math.sin(v.heading || 0);
            const locX = vdx * cosV - vdz * sinV;
            const locZ = vdx * sinV + vdz * cosV;
            const hw = ((v.width || 1.8) * 0.5) + 0.35;
            const hl = ((v.length || 4.2) * 0.5) + 0.35;
            if (Math.abs(locX) <= hw && Math.abs(locZ) <= hl) {
              this.knockDownAgent(agent, v.speed, v.heading || 0, v.x, v.z);
              v.state = 'STOPPED_PEDESTRIAN';
              v.speed = 0;
              v.targetSpeed = 0;
              break;
            }
          }
        }
      }
    }

    const currY = (currNode.isArcade || !currNode.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    const targetY = (targetNode.isArcade || !targetNode.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    agent.y = currY + (targetY - currY) * Math.min(1.0, agent.pathProgress);

    // 衰減避讓速度
    agent.avoidVx *= Math.max(0, 1.0 - dt * 6.0);
    agent.avoidVz *= Math.max(0, 1.0 - dt * 6.0);

    // 4. 防穿牆碰撞檢測 (若即將踏入建築物，阻擋其向牆內的位移，嚴禁向後推動)
    for (let bIdx = 0; bIdx < buildingColliders.length; bIdx++) {
      const b = buildingColliders[bIdx];
      const margin = 0.2;
      if (nextX >= b.minX - margin && nextX <= b.maxX + margin && nextZ >= b.minZ - margin && nextZ <= b.maxZ + margin) {
        if (agent.x < b.minX - margin) nextX = Math.min(nextX, b.minX - margin);
        else if (agent.x > b.maxX + margin) nextX = Math.max(nextX, b.maxX + margin);
        if (agent.z < b.minZ - margin) nextZ = Math.min(nextZ, b.minZ - margin);
        else if (agent.z > b.maxZ + margin) nextZ = Math.max(nextZ, b.maxZ + margin);

        if (nextX >= b.minX - margin && nextX <= b.maxX + margin && nextZ >= b.minZ - margin && nextZ <= b.maxZ + margin) {
          nextX = agent.x;
          nextZ = agent.z;
          agent.isTurningAround = true;
          agent.turnAroundTimer = 0.4;
          agent.speed = 0;
        }
        break;
      }
    }

    // 朝向平滑旋轉與倒退走每幀檢查
    if (agent.speed > 0.05) {
      let angleDiff = targetAngle - agent.rotationY;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      const maxTurnStep = (CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.MAX_TURN_RATE_DEG_PER_SEC * Math.PI / 180) * dt;
      agent.rotationY += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), maxTurnStep);

      // dot(面向, 速度) < 0 超過 0.3s 強制修正轉向
      const curFwdX = Math.sin(agent.rotationY);
      const curFwdZ = Math.cos(agent.rotationY);
      const dispX = nextX - agent.x;
      const dispZ = nextZ - agent.z;
      const dispLen = Math.hypot(dispX, dispZ);
      if (dispLen > 0.01) {
        const dispDot = curFwdX * (dispX / dispLen) + curFwdZ * (dispZ / dispLen);
        if (dispDot < -0.05) {
          agent.wrongFacingTimer = (agent.wrongFacingTimer || 0) + dt;
          if (agent.wrongFacingTimer > CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.WRONG_FACING_TIMEOUT_SEC) {
            agent.rotationY = Math.atan2(dispX, dispZ);
            this.backwardsWalkCount++;
            agent.wrongFacingTimer = 0;
          }
        } else {
          agent.wrongFacingTimer = 0;
        }
      } else {
        agent.wrongFacingTimer = 0;
      }
    }

    agent.x = nextX;
    agent.z = nextZ;

    // 5. 動畫相位累加
    if (agent.speed > 0.1) {
      agent.walkPhase += agent.speed * dt * 4.2;
    } else {
      agent.idlePhase += dt * 2.5;
    }

    // 6. 到達路徑節點，選擇下一步路徑
    if (agent.pathProgress >= 1.0) {
      this.advanceToNextNode(agent, targetNode);
    }
  }

  /**
   * 行人到達節點後的尋路決策
   */
  private advanceToNextNode(agent: PedestrianAgent, arrivedNode: PedestrianNode): void {
    agent.pathProgress = 0;
    agent.prevNodeId = agent.currentNodeId;
    agent.currentNodeId = arrivedNode.id;
    agent.y = (arrivedNode.isArcade || !arrivedNode.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);

    // 檢查是否為斑馬線路口
    if (arrivedNode.isCrosswalk && agent.state !== PedestrianState.CROSSING) {
      const crosswalkEdge = arrivedNode.edges.find((e) => e.isCrosswalk);
      if (crosswalkEdge) {
        const sig = this.getAgentCrossingSignal(agent);
        const neededSec = (crosswalkEdge.distance || 10.0) / 1.35;
        const canCross = sig
          ? (sig.state === 'walk' && sig.remainingSec >= neededSec)
          : this.isCrosswalkGreen;

        if (canCross) {
          agent.state = PedestrianState.CROSSING;
          agent.targetSpeed = 1.35;
          agent.targetNodeId = crosswalkEdge.target;
          agent.edgeLength = crosswalkEdge.distance;
          this.crossingsTotal++;
          this.crossingsOnZebra++;
          return;
        } else if (agent.isViolator && agent.violationType === 'jaywalk_red_light') {
          // 違規闖紅燈過街
          agent.state = PedestrianState.CROSSING;
          agent.targetSpeed = 1.35;
          agent.targetNodeId = crosswalkEdge.target;
          agent.edgeLength = crosswalkEdge.distance;
          this.crossingsTotal++;
          this.crossingsOnZebra++;
          this.crossingsViolations++;
          if (agent.violationTimer === 0) {
            agent.violationTimer = 1;
            this.pedestrianViolationsStats.jaywalkRed++;
            this.pedestrianViolationsStats.total++;
            window.dispatchEvent(new CustomEvent('violation:committed', {
              detail: { actorType: 'pedestrian', id: agent.id, violationType: 'jaywalk_red_light', position: { x: agent.x, z: agent.z }, timestamp: Date.now() }
            }));
          }
          return;
        } else {
          // 守規等紅燈：沿路緣分散站位 (相距 0.8m，最多 6 個站位，不可堆在同一點)
          agent.state = PedestrianState.WAITING_CROSSWALK;
          agent.targetSpeed = 0;
          agent.targetNodeId = crosswalkEdge.target;
          agent.edgeLength = crosswalkEdge.distance;

          let slotIdx = 0;
          for (const other of this.agents) {
            if (other.active && other.id !== agent.id && other.state === PedestrianState.WAITING_CROSSWALK && other.currentNodeId === arrivedNode.id) {
              slotIdx++;
            }
          }
          slotIdx = slotIdx % CONFIG.NPC_BEHAVIOR.PEDESTRIAN.MAX_WAITING_SLOTS;
          agent.curbWaitingSlotIndex = slotIdx;

          const cTarget = this.network!.nodes[crosswalkEdge.target];
          const cDx = cTarget.x - arrivedNode.x;
          const cDz = cTarget.z - arrivedNode.z;
          const cLen = Math.hypot(cDx, cDz) || 1.0;
          const curbTangentX = -cDz / cLen;
          const curbTangentZ = cDx / cLen;
          const slotOffset = (slotIdx - 2.5) * CONFIG.NPC_BEHAVIOR.PEDESTRIAN.CURB_WAITING_SLOT_SPACING;
          agent.curbWaitingOffsetX = curbTangentX * slotOffset;
          agent.curbWaitingOffsetZ = curbTangentZ * slotOffset;
          agent.x = arrivedNode.x + agent.curbWaitingOffsetX;
          agent.z = arrivedNode.z + agent.curbWaitingOffsetZ;
          return;
        }
      }
    }

    // 隨機停駐機率 (12% 停留看手機/看店家/聊天 3~10秒)
    if (agent.state === PedestrianState.WALKING && Math.random() < CONFIG.PEDESTRIAN.IDLE_CHANCE_AT_INTERSECTION) {
      agent.state = PedestrianState.IDLE;
      agent.stateTimer = 3.0 + Math.random() * 8.0;
      agent.gesture = Math.random() < 0.5 ? 1 : 0;
    }

    // 進入店家機率 (8% 機率走進店家)
    if (arrivedNode.isArcade && Math.random() < CONFIG.PEDESTRIAN.ENTER_SHOP_CHANCE) {
      agent.insideBuildingTimer = 8.0 + Math.random() * 16.0;
    }

    // 選擇下一個目標邊：導航向遠程目標節點，避開擁擠節點
    const validEdges = arrivedNode.edges.filter((e) => e.target !== agent.prevNodeId);
    let candidateEdges = validEdges.length > 0 ? [...validEdges] : [...arrivedNode.edges];

    if (agent.longTermGoalNodeId !== undefined && candidateEdges.length > 0) {
      const goalNode = this.network!.nodes[agent.longTermGoalNodeId];
      if (goalNode) {
        candidateEdges.sort((a, b) => {
          const na = this.network!.nodes[a.target];
          const nb = this.network!.nodes[b.target];
          const da = Math.hypot(na.x - goalNode.x, na.z - goalNode.z);
          const db = Math.hypot(nb.x - goalNode.x, nb.z - goalNode.z);
          return da - db;
        });
      }
    }

    const chosenEdge = candidateEdges[0] || null;

    if (chosenEdge) {
      const nextTargetNode = this.network!.nodes[chosenEdge.target];
      const newDx = nextTargetNode.x - arrivedNode.x;
      const newDz = nextTargetNode.z - arrivedNode.z;
      const newAngle = Math.atan2(newDx, newDz);

      let diff = newAngle - agent.rotationY;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;

      // 若夾角超過門檻或折返，先原地轉身再走
      if (Math.abs(diff) > (CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.REVERSE_ANGLE_THRESHOLD_DEG * Math.PI / 180)) {
        agent.isTurningAround = true;
        agent.turnAroundTimer = CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.TURN_AROUND_TIME_MIN + Math.random() * (CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.TURN_AROUND_TIME_MAX - CONFIG.NPC_BEHAVIOR.NO_WALK_BACKWARDS.TURN_AROUND_TIME_MIN);
        agent.speed = 0;
        agent.avoidVx = 0;
        agent.avoidVz = 0;
      }

      agent.targetNodeId = chosenEdge.target;
      agent.edgeLength = chosenEdge.distance;
      if (chosenEdge.isCrosswalk) {
        agent.state = PedestrianState.CROSSING;
      } else if (agent.state === PedestrianState.CROSSING) {
        agent.state = PedestrianState.WALKING;
      }
    } else {
      agent.active = false;
    }
  }

  /**
   * 空間雜湊網格分離排斥計算 (0.7m 個人空間，保證身體不重疊，結伴同行組除外)
   */
  private calculateSeparation(agent: PedestrianAgent, _dt: number): void {
    const inv = 1.0 / this.cellSize;
    const gx = Math.floor(agent.x * inv);
    const gz = Math.floor(agent.z * inv);
    const avoidDist = 1.35; // 1.35m 個人空間排斥 (確保非同伴不進入 1.2m 聚集判定門檻)
    const sepForce = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.SEPARATION_FORCE; // 5.0

    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const key = `${gx + ox}_${gz + oz}`;
        const neighborIndices = this.grid.get(key);
        if (!neighborIndices) continue;

        for (let k = 0; k < neighborIndices.length; k++) {
          const otherIdx = neighborIndices[k];
          if (otherIdx === agent.id) continue;
          const other = this.agents[otherIdx];
          if (!other || !other.active) continue;

          // 結伴同行組成員保持同伴間距，不施加激烈排斥力
          if (agent.companionGroupId !== undefined && agent.companionGroupId === other.companionGroupId) {
            continue;
          }

          const dx = agent.x - other.x;
          const dz = agent.z - other.z;
          const dist = Math.hypot(dx, dz);

          if (dist < avoidDist && dist > 0.05) {
            const force = (avoidDist - dist) * sepForce;
            agent.avoidVx += (dx / dist) * force;
            agent.avoidVz += (dz / dist) * force;
            if (agent.lateralOffset !== undefined) {
              agent.lateralOffset += Math.sign(dx) * force * _dt * 0.25;
              agent.lateralOffset = Math.max(-0.85, Math.min(0.85, agent.lateralOffset));
            }
          }
        }
      }
    }
  }

  /**
   * 事件匯流排預留接口 ('gunshot' | 'carNearMiss' | 'playerAttack')
   */
  public triggerEvent(eventType: 'gunshot' | 'carNearMiss' | 'playerAttack', origin: Point2D, radius = 25.0): void {
    console.log(`[PedestrianSystem] 收到事件: ${eventType} (半徑: ${radius}m)`);
    for (const a of this.agents) {
      if (!a.active) continue;
      const d = Math.hypot(a.x - origin.x, a.z - origin.z);
      if (d <= radius) {
        a.state = PedestrianState.PANIC;
        a.stateTimer = 6.0 + Math.random() * 4.0;
        // 背向危險源逃跑
        a.avoidVx = (a.x - origin.x) * 2.0;
        a.avoidVz = (a.z - origin.z) * 2.0;
      }
    }

    const listeners = this.eventListeners.get(eventType);
    if (listeners) {
      for (const cb of listeners) cb(origin, radius);
    }
  }

  public subscribeEvent(eventType: string, callback: (origin: Point2D, radius: number) => void): void {
    let list = this.eventListeners.get(eventType);
    if (!list) {
      list = [];
      this.eventListeners.set(eventType, list);
    }
    list.push(callback);
  }

  public getStats(drawCalls = 3): PedestrianSystemStats {
    let walking = 0;
    let idle = 0;
    let waiting = 0;
    let crossing = 0;
    let evading = 0;
    let panic = 0;
    let hailing = 0;
    let specialStateCount = 0;
    let total = 0;

    for (const a of this.agents) {
      if (!a.active || a.insideBuildingTimer > 0) continue;
      total++;
      if (a.state === PedestrianState.WALKING) walking++;
      else if (a.state === PedestrianState.IDLE) idle++;
      else if (a.state === PedestrianState.WAITING_CROSSWALK) waiting++;
      else if (a.state === PedestrianState.CROSSING) crossing++;
      else if (a.state === PedestrianState.EVADING) evading++;
      else if (a.state === PedestrianState.PANIC) panic++;
      else if (a.state === PedestrianState.HAILING_TAXI) hailing++;
      else if (
        a.state === PedestrianState.KNOCKED_FLYING ||
        a.state === PedestrianState.FALLEN ||
        a.state === PedestrianState.GETTING_UP ||
        a.state === PedestrianState.LEAVING_ROAD
      ) {
        specialStateCount++;
      }
    }

    const totalActive = Math.max(1, total);
    const vRate = (this.pedestrianViolationsStats.total / totalActive) * 100;
    const avgLeaveDuration = this.leaveRoadSuccessCount > 0
      ? this.leaveRoadTotalDurationSec / this.leaveRoadSuccessCount
      : 0;
    const returnRatio = this.totalKnockedDownCount > 0
      ? Math.min(100, Math.round((this.leaveRoadSuccessCount / this.totalKnockedDownCount) * 100))
      : 100;

    return {
      total,
      walking,
      idle,
      waiting,
      crossing,
      evading,
      panic,
      hailing,
      specialStateCount,
      leaveRoadSuccessCount: this.leaveRoadSuccessCount,
      leaveRoadAvgDurationSec: Math.round(avgLeaveDuration * 10) / 10,
      leaveRoadFailCount: this.leaveRoadFailCount,
      returnToSidewalkRatioPercent: returnRatio,
      outOfBoundsEventsCount: this.outOfBoundsEventsCount,
      crowdedCount: this.crowdedCount,
      crowdedRatePercent: Math.round(this.crowdedRatePercent * 10) / 10,
      crossingsTotal: this.crossingsTotal,
      crossingsOnZebra: this.crossingsOnZebra,
      crossingsViolations: this.crossingsViolations,
      backwardsWalkCount: this.backwardsWalkCount,
      violationsCount: { ...this.pedestrianViolationsStats },
      violationRatePercent: Math.round(vRate * 10) / 10,
      aiTimeMs: this.lastAiTimeMs,
      drawCalls
    };
  }

  /**
   * 啟動 60 秒行人行為抽樣 (供 F8 與自動測試腳本使用)
   */
  public startPedestrianSampling(): void {
    this.samplingActive = true;
    this.samplingTimer = 60.0;
    this.samplingInitialBackwards = this.backwardsWalkCount;
    this.samplingInitialCrossTotal = this.crossingsTotal;
    this.samplingInitialCrossZebra = this.crossingsOnZebra;
    this.samplingInitialCrossViolations = this.crossingsViolations;
    this.samplingInitialViolations = { ...this.pedestrianViolationsStats };
    this.samplingInitialLeaveRoadSuccess = this.leaveRoadSuccessCount;
    this.samplingInitialLeaveRoadDuration = this.leaveRoadTotalDurationSec;
    this.samplingInitialLeaveRoadFail = this.leaveRoadFailCount;
    this.samplingInitialOutOfBounds = this.outOfBoundsEventsCount;
    this.samplingInitialKnocked = this.totalKnockedDownCount;
    this.samplingCrowdRateSum = 0;
    this.samplingCrowdRateCount = 0;
    this.samplingReport = null;
    console.log('[PedestrianSystem] 開始 60 秒行人行為抽樣評估...');
  }

  public isSamplingActive(): boolean {
    return this.samplingActive;
  }

  public getSamplingRemainingSec(): number {
    return Math.max(0, this.samplingTimer);
  }

  /**
   * 取得 60 秒行為抽樣報告
   */
  public getPedestrianSamplingReport(): PedestrianSamplingReport | null {
    return this.samplingReport;
  }

  /**
   * 尋找指定半徑內叫車 (HAILING_TAXI) 的行人
   */
  public findHailingPedestrian(nearPos: Point2D, radius: number): PedestrianAgent | null {
    let bestDistSq = radius * radius;
    let bestAgent: PedestrianAgent | null = null;
    for (const a of this.agents) {
      if (!a.active || a.state !== PedestrianState.HAILING_TAXI) continue;
      const dSq = (a.x - nearPos.x) * (a.x - nearPos.x) + (a.z - nearPos.z) * (a.z - nearPos.z);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestAgent = a;
      }
    }
    return bestAgent;
  }

  /**
   * 行人上計程車：將行人從地圖隱藏停用，並回傳外觀以顯示在計程車後座
   */
  public boardTaxi(agentId: number): DriverAppearance {
    const agent = this.agents.find((a) => a.id === agentId);
    if (agent && agent.active) {
      agent.active = false;
      return {
        skinColorHex: agent.skinColorHex,
        shirtColorHex: agent.shirtColorHex,
        hairColorHex: agent.hairColorHex,
        hatType: 'none',
        helmetColorHex: '#ffffff',
        hasMask: Math.random() < CONFIG.DRIVERS.ACCESSORIES.MASK_CHANCE,
        hasRaincoat: false,
        raincoatColorHex: CONFIG.DRIVERS.ACCESSORIES.RAINCOAT_COLORS[0]
      };
    }
    return {
      skinColorHex: '#f8d5b8',
      shirtColorHex: '#38bdf8',
      hairColorHex: '#1e1b18',
      hatType: 'none',
      helmetColorHex: '#ffffff',
      hasMask: false,
      hasRaincoat: false,
      raincoatColorHex: '#fef08a'
    };
  }

  /**
   * 計程車乘客到站下車：在人行道上重新生成為一般步行行人
   */
  public spawnDropoffPassenger(x: number, z: number, appearance: DriverAppearance): void {
    if (!this.network || this.network.nodes.length === 0) return;
    const inactiveAgent = this.agents.find((a) => !a.active);
    if (!inactiveAgent) return;
    const node = this.findNearestNodeWeighted(x, z, 35.0) || this.network.nodes[0];
    if (!node || node.edges.length === 0) return;
    const edge = node.edges[Math.floor(Math.random() * node.edges.length)];
    inactiveAgent.active = true;
    inactiveAgent.x = node.x;
    inactiveAgent.y = CONFIG.ROADS.SIDEWALK_HEIGHT;
    inactiveAgent.z = node.z;
    inactiveAgent.currentNodeId = node.id;
    inactiveAgent.targetNodeId = edge.target;
    inactiveAgent.prevNodeId = -1;
    inactiveAgent.pathProgress = 0;
    inactiveAgent.edgeLength = edge.distance;
    inactiveAgent.speed = 1.3;
    inactiveAgent.targetSpeed = 1.3;
    inactiveAgent.state = PedestrianState.WALKING;
    inactiveAgent.stateTimer = 0;
    inactiveAgent.insideBuildingTimer = 0;
    inactiveAgent.skinColorHex = appearance.skinColorHex;
    inactiveAgent.shirtColorHex = appearance.shirtColorHex;
    inactiveAgent.hairColorHex = appearance.hairColorHex;
    inactiveAgent.pantsColorHex = '#334155';
    inactiveAgent.heightScale = 1.0;
    inactiveAgent.widthScale = 1.0;
    inactiveAgent.accessoryType = 'none';
    inactiveAgent.gesture = 0;
  }

  /**
   * 彈出駕駛 (玩家搶車/車禍)：將駕駛從車輛移出並轉交給行人系統進入 PANIC (受驚逃跑) 狀態
   */
  public spawnEjectedDriver(x: number, z: number, appearance: DriverAppearance): number {
    if (!this.network || this.network.nodes.length === 0) return -1;
    const inactiveAgent = this.agents.find((a) => !a.active);
    if (!inactiveAgent) return -1;
    const node = this.findNearestNodeWeighted(x, z, 40.0) || this.network.nodes[0];
    if (!node || node.edges.length === 0) return -1;
    const edge = node.edges[0];
    inactiveAgent.active = true;
    inactiveAgent.x = x;
    inactiveAgent.y = CONFIG.ROADS.SIDEWALK_HEIGHT;
    inactiveAgent.z = z;
    inactiveAgent.currentNodeId = node.id;
    inactiveAgent.targetNodeId = edge.target;
    inactiveAgent.prevNodeId = -1;
    inactiveAgent.pathProgress = 0;
    inactiveAgent.edgeLength = edge.distance;
    inactiveAgent.speed = CONFIG.PEDESTRIAN.PANIC_SPEED_MPS;
    inactiveAgent.targetSpeed = CONFIG.PEDESTRIAN.PANIC_SPEED_MPS;
    inactiveAgent.state = PedestrianState.PANIC;
    inactiveAgent.stateTimer = 12.0; // 驚慌逃跑 12 秒
    inactiveAgent.gesture = 3; // 驚恐揮手
    inactiveAgent.skinColorHex = appearance.skinColorHex;
    inactiveAgent.shirtColorHex = appearance.shirtColorHex;
    inactiveAgent.hairColorHex = appearance.hairColorHex;
    inactiveAgent.pantsColorHex = '#1e293b';
    inactiveAgent.heightScale = 1.0;
    inactiveAgent.widthScale = 1.0;
    inactiveAgent.accessoryType = 'none';
    return inactiveAgent.id;
  }

  public getIsCrosswalkGreen(): boolean {
    return this.isCrosswalkGreen;
  }

  public setPoliceSystem(sys: any): void {
    this.policeSystem = sys;
  }

  /**
   * 強制最近行人違規闖紅燈/過街 (F15 測試按鈕)
   */
  public forceNearestPedJaywalk(playerPos: Point2D): boolean {
    const activeAgents = this.agents.filter((a) => a.active);
    let bestDist = Infinity;
    let target: PedestrianAgent | null = null;
    for (const a of activeAgents) {
      const d = Math.hypot(a.x - playerPos.x, a.z - playerPos.z);
      if (d < bestDist && d < 100.0) {
        bestDist = d;
        target = a;
      }
    }
    if (!target) return false;

    target.isViolator = true;
    target.violationType = 'jaywalk_red_light';
    target.violationTimer = 1;
    target.state = PedestrianState.CROSSING;
    target.targetSpeed = 1.35;
    this.pedestrianViolationsStats.jaywalkRed++;
    this.pedestrianViolationsStats.total++;

    window.dispatchEvent(
      new CustomEvent('violation:committed', {
        detail: {
          actorType: 'pedestrian',
          id: target.id,
          violationType: 'jaywalk_red_light',
          position: { x: target.x, z: target.z },
          timestamp: Date.now()
        }
      })
    );
    return true;
  }

  /**
   * 特殊狀態處理 (被撞飛、倒地、起身、離開車道脫困)
   */
  private handleSpecialAgentState(agent: PedestrianAgent, dt: number, playerPos: Point2D): boolean {
    const isSpecial =
      agent.state === PedestrianState.KNOCKED_FLYING ||
      agent.state === PedestrianState.FALLEN ||
      agent.state === PedestrianState.GETTING_UP ||
      agent.state === PedestrianState.LEAVING_ROAD;

    if (!isSpecial) {
      agent.isSpecialState = false;
      return false;
    }

    agent.isSpecialState = true;
    const roadElevation = CONFIG.ROADS.ELEVATION.ROAD;
    const sidewalkElevation = CONFIG.ROADS.ELEVATION.SIDEWALK;

    switch (agent.state) {
      case PedestrianState.KNOCKED_FLYING: {
        agent.stateTimer -= dt;
        agent.x += (agent.knockVx || 0) * dt;
        agent.z += (agent.knockVz || 0) * dt;
        agent.knockVy = (agent.knockVy || 0) - 18.0 * dt;
        agent.y = Math.max(roadElevation + 0.15, agent.y + agent.knockVy * dt);

        // 翻滾姿態
        agent.pitch = (agent.pitch || 0) + 7.0 * dt;
        agent.roll = (agent.roll || 0) + 4.5 * dt;

        if (agent.stateTimer <= 0 || agent.y <= roadElevation + 0.16) {
          agent.state = PedestrianState.FALLEN;
          agent.stateTimer = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.FALLEN_DURATION_SEC;
          agent.pitch = -Math.PI / 2;
          agent.roll = 0;
          agent.y = roadElevation + 0.15;
          agent.speed = 0;
          agent.targetSpeed = 0;
          agent.knockVx = 0;
          agent.knockVy = 0;
          agent.knockVz = 0;
        }
        return true;
      }

      case PedestrianState.FALLEN: {
        agent.stateTimer -= dt;
        agent.speed = 0;
        agent.targetSpeed = 0;
        agent.pitch = -Math.PI / 2;
        agent.roll = 0;
        agent.y = roadElevation + 0.15;

        if (agent.stateTimer <= 0) {
          agent.state = PedestrianState.GETTING_UP;
          agent.stateTimer = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.GETTING_UP_DURATION_SEC;
        }
        return true;
      }

      case PedestrianState.GETTING_UP: {
        agent.stateTimer -= dt;
        agent.speed = 0;
        agent.targetSpeed = 0;
        const totalDuration = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.GETTING_UP_DURATION_SEC || 1.2;
        const p = Math.max(0, Math.min(1, 1.0 - agent.stateTimer / totalDuration));
        agent.pitch = (-Math.PI / 2) * (1.0 - p);
        agent.roll = 0;
        agent.y = roadElevation + 0.15 + p * (sidewalkElevation - roadElevation - 0.15);

        if (agent.stateTimer <= 0) {
          agent.pitch = 0;
          agent.roll = 0;
          const onRoad = this.isPointOnRoadway(agent.x, agent.z);
          if (onRoad) {
            agent.state = PedestrianState.LEAVING_ROAD;
            agent.isSpecialState = true;
            agent.escapeTargetPoint = this.findNearestWalkablePoint(agent.x, agent.z);
            agent.escapeStartTime = performance.now();
            agent.escapeTimer = 0;
            const boost = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.LEAVING_ROAD_SPEED_BOOST || 1.2;
            agent.targetSpeed = (CONFIG.PEDESTRIAN.MIN_SPEED_MPS || 1.3) * boost;
            agent.speed = agent.targetSpeed;
          } else {
            agent.state = PedestrianState.WALKING;
            agent.isSpecialState = false;
            agent.outOfBoundsTimer = 0;
            this.leaveRoadSuccessCount++;
            this.reconnectAgentToNetwork(agent);
          }
        }
        return true;
      }

      case PedestrianState.LEAVING_ROAD: {
        agent.isSpecialState = true;
        agent.escapeTimer = (agent.escapeTimer || 0) + dt;
        const timeout = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.ESCAPE_TIMEOUT_SEC || 15.0;

        // 若超時 15 秒：在玩家視野外傳送到最近人行道，視野內維持繼續嘗試
        if (agent.escapeTimer > timeout) {
          const distToPlayer = Math.hypot(agent.x - playerPos.x, agent.z - playerPos.z);
          if (distToPlayer > 35.0) {
            const targetPt = agent.escapeTargetPoint || this.findNearestWalkablePoint(agent.x, agent.z);
            agent.x = targetPt.x;
            agent.z = targetPt.z;
            agent.y = sidewalkElevation;
            agent.state = PedestrianState.WALKING;
            agent.isSpecialState = false;
            agent.outOfBoundsTimer = 0;
            this.leaveRoadFailCount++;
            this.reconnectAgentToNetwork(agent);
            return true;
          }
        }

        const targetPt = agent.escapeTargetPoint || this.findNearestWalkablePoint(agent.x, agent.z);
        const dx = targetPt.x - agent.x;
        const dz = targetPt.z - agent.z;
        const dist = Math.hypot(dx, dz);

        // 判定是否已成功抵達可步行區域 (已不在車道上，或與目標點距離 < 0.6m)
        const isOffRoad = !this.isPointOnRoadway(agent.x, agent.z);
        if (isOffRoad || dist < 0.6) {
          agent.state = PedestrianState.WALKING;
          agent.isSpecialState = false;
          agent.outOfBoundsTimer = 0;
          agent.y = sidewalkElevation;
          this.leaveRoadSuccessCount++;
          const durationSec = (performance.now() - (agent.escapeStartTime || performance.now())) / 1000;
          this.leaveRoadTotalDurationSec += durationSec;
          this.reconnectAgentToNetwork(agent);
          return true;
        }

        const moveAngle = Math.atan2(dx, dz);
        agent.rotationY = moveAngle;
        const boost = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.LEAVING_ROAD_SPEED_BOOST || 1.2;
        const speed = (CONFIG.PEDESTRIAN.MIN_SPEED_MPS || 1.3) * boost;
        agent.speed = speed;
        agent.targetSpeed = speed;

        // 計算平滑前進步長 (直接沿連線方向邁步，限制在剩餘距離內以避免原地振盪)
        const stepDist = Math.min(dist, speed * dt);
        let vx = (dist > 0.001 ? (dx / dist) : 0) * (stepDist / dt);
        let vz = (dist > 0.001 ? (dz / dist) : 0) * (stepDist / dt);

        // 避開移動中之車輛 OBB (靜止禮讓車不施加推斥力，允許行人從車頭前順利通過)
        if (this.trafficSystem) {
          const vehicles = this.trafficSystem.getActiveVehicles();
          for (let vi = 0; vi < vehicles.length; vi++) {
            const v = vehicles[vi];
            if (v.speed < 1.0 || v.state.startsWith('STOPPED')) continue;
            const vdx = agent.x - v.x;
            const vdz = agent.z - v.z;
            if (Math.hypot(vdx, vdz) < 6.0) {
              const cosV = Math.cos(v.heading || 0);
              const sinV = Math.sin(v.heading || 0);
              const locX = vdx * cosV - vdz * sinV;
              const locZ = vdx * sinV + vdz * cosV;
              const hw = ((v.width || 1.8) * 0.5) + (CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.OBB_AVOID_MARGIN || 0.8);
              const hl = ((v.length || 4.2) * 0.5) + (CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.OBB_AVOID_MARGIN || 0.8);
              if (Math.abs(locX) < hw && Math.abs(locZ) < hl) {
                const pushDir = locX >= 0 ? 1 : -1;
                const pushX = pushDir * (hw - Math.abs(locX)) * 3.5;
                vx += (pushX * cosV);
                vz += (-pushX * sinV);
              }
            }
          }
        }

        agent.x += vx * dt;
        agent.z += vz * dt;
        agent.y = roadElevation + 0.01;
        agent.walkPhase += speed * dt * 4.2;
        return true;
      }
    }

    return false;
  }

  /**
   * 限制位移在可步行區域 (防止推擠進車道)
   */
  private clampToWalkableArea(
    agent: PedestrianAgent,
    nextX: number,
    nextZ: number
  ): { x: number; z: number } {
    if (
      agent.isSpecialState ||
      agent.state === PedestrianState.CROSSING ||
      agent.state === PedestrianState.WAITING_CROSSWALK ||
      agent.state === PedestrianState.LEAVING_ROAD
    ) {
      return { x: nextX, z: nextZ };
    }

    if (!this.isPointOnRoadway(nextX, nextZ)) {
      return { x: nextX, z: nextZ };
    }

    // 若原先位置不在車道上，阻止踩進車道
    if (!this.isPointOnRoadway(agent.x, agent.z)) {
      return { x: agent.x, z: agent.z };
    }

    return this.findNearestWalkablePoint(nextX, nextZ);
  }

  /**
   * 脫困後重新接入最近之路網節點
   */
  private reconnectAgentToNetwork(agent: PedestrianAgent): void {
    if (!this.network || this.network.nodes.length === 0) return;
    // 優先尋找最近之人行道/騎樓節點
    const sidewalkNodes = this.network.nodes.filter(
      (n) => (!n.isCrosswalk || n.isArcade) && !this.isPointOnRoadway(n.x, n.z) && n.edges.length > 0
    );
    let nearestNode: PedestrianNode | null = null;
    let bestDistSq = Infinity;
    for (let i = 0; i < sidewalkNodes.length; i++) {
      const n = sidewalkNodes[i];
      const dSq = (n.x - agent.x) * (n.x - agent.x) + (n.z - agent.z) * (n.z - agent.z);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        nearestNode = n;
      }
    }

    if (!nearestNode) {
      nearestNode = this.findNearestNodeWeighted(agent.x, agent.z, 50.0);
    }

    if (nearestNode && nearestNode.edges.length > 0) {
      agent.currentNodeId = nearestNode.id;
      const nonCrosswalkEdges = nearestNode.edges.filter((e) => !e.isCrosswalk);
      const edge = nonCrosswalkEdges.length > 0
        ? nonCrosswalkEdges[Math.floor(Math.random() * nonCrosswalkEdges.length)]
        : nearestNode.edges[Math.floor(Math.random() * nearestNode.edges.length)];
      agent.targetNodeId = edge.target;
      agent.edgeLength = edge.distance;
      agent.pathProgress = 0;
      agent.prevNodeId = -1;
    }
  }

  /**
   * 判定座標是否在斑馬線內
   */
  public isPointInCrosswalk(x: number, z: number): boolean {
    for (let i = 0; i < this.intersections.length; i++) {
      const inter = this.intersections[i];
      const dInter = Math.hypot(inter.center.x - x, inter.center.z - z);
      if (dInter > inter.radius + 10.0) continue;
      const crossings = inter.crossings || [];
      for (let c = 0; c < crossings.length; c++) {
        const cross = crossings[c];
        const dx = cross.p2.x - cross.p1.x;
        const dz = cross.p2.z - cross.p1.z;
        const lenSq = dx * dx + dz * dz;
        if (lenSq < 0.001) continue;
        const t = ((x - cross.p1.x) * dx + (z - cross.p1.z) * dz) / lenSq;
        if (t >= -0.15 && t <= 1.15) {
          const projX = cross.p1.x + t * dx;
          const projZ = cross.p1.z + t * dz;
          const distSq = (x - projX) * (x - projX) + (z - projZ) * (z - projZ);
          const halfW = ((cross.width || 4.0) * 0.5) + 0.6;
          if (distSq <= halfW * halfW) {
            return true;
          }
        }
      }
    }

    if (this.network && this.network.crosswalkGroups) {
      for (const cg of this.network.crosswalkGroups) {
        if (cg.p1 && cg.p2) {
          const dx = cg.p2.x - cg.p1.x;
          const dz = cg.p2.z - cg.p1.z;
          const lenSq = dx * dx + dz * dz;
          if (lenSq > 0.001) {
            const t = ((x - cg.p1.x) * dx + (z - cg.p1.z) * dz) / lenSq;
            if (t >= -0.15 && t <= 1.15) {
              const projX = cg.p1.x + t * dx;
              const projZ = cg.p1.z + t * dz;
              const distSq = (x - projX) * (x - projX) + (z - projZ) * (z - projZ);
              const halfW = ((cg.width || 4.0) * 0.5) + 0.6;
              if (distSq <= halfW * halfW) {
                return true;
              }
            }
          }
        }
      }
    }

    return false;
  }

  /**
   * 判定座標是否在車道上 (非斑馬線)
   */
  public isPointOnRoadway(x: number, z: number): boolean {
    if (this.isPointInCrosswalk(x, z)) {
      return false;
    }

    for (let r = 0; r < this.roads.length; r++) {
      const road = this.roads[r];
      // 排除鐵路與純行人步道
      if (
        road.isRailway ||
        ['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'living_street'].includes(road.type) ||
        (road.width && road.width < 3.0)
      ) {
        continue;
      }

      const pts = road.points;
      const curbDist = (road.width || 6.0) * 0.5;
      const roadDrivewayHalfW = Math.max(1.8, curbDist - 0.35);

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const segDx = p2.x - p1.x;
        const segDz = p2.z - p1.z;
        const lenSq = segDx * segDx + segDz * segDz;
        if (lenSq < 0.0001) continue;
        const t = ((x - p1.x) * segDx + (z - p1.z) * segDz) / lenSq;
        if (t >= 0.0 && t <= 1.0) {
          const projX = p1.x + t * segDx;
          const projZ = p1.z + t * segDz;
          const distSq = (x - projX) * (x - projX) + (z - projZ) * (z - projZ);
          if (distSq < roadDrivewayHalfW * roadDrivewayHalfW) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * 尋找最近的可步行點 (人行道/騎樓/斑馬線邊緣)
   */
  public findNearestWalkablePoint(x: number, z: number): Point2D {
    let bestPt: Point2D = { x, z };
    let bestDistSq = Infinity;

    // 1. 沿所在道路向兩側路緣石外推至人行道 (最精確之垂直逃生方向，確保不在車道上)
    for (let r = 0; r < this.roads.length; r++) {
      const road = this.roads[r];
      if (
        road.isRailway ||
        ['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'living_street'].includes(road.type) ||
        (road.width && road.width < 3.0)
      ) {
        continue;
      }
      const pts = road.points;
      const curbDist = (road.width || 6.0) * 0.5;
      const sidewalkOffset = curbDist + Math.max(1.2, (road.sidewalkWidth || 1.4) * 0.6);

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const segDx = p2.x - p1.x;
        const segDz = p2.z - p1.z;
        const lenSq = segDx * segDx + segDz * segDz;
        if (lenSq < 0.0001) continue;
        const t = Math.max(0, Math.min(1, ((x - p1.x) * segDx + (z - p1.z) * segDz) / lenSq));
        const projX = p1.x + t * segDx;
        const projZ = p1.z + t * segDz;
        const segLen = Math.sqrt(lenSq);
        const normX = -segDz / segLen;
        const normZ = segDx / segLen;
        const toPtX = x - projX;
        const toPtZ = z - projZ;
        const preferredSide = (toPtX * normX + toPtZ * normZ) >= 0 ? 1 : -1;

        // 優先檢查較近側，若較近側仍為車道則檢查對向側
        for (const side of [preferredSide, -preferredSide]) {
          const curbX = projX + normX * (side * sidewalkOffset);
          const curbZ = projZ + normZ * (side * sidewalkOffset);

          // 必須真正為非車道區域 (避免交叉路口處推算到橫向車道中央)
          if (this.isPointOnRoadway(curbX, curbZ)) {
            continue;
          }

          const dSq = (curbX - x) * (curbX - x) + (curbZ - z) * (curbZ - z);
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestPt = { x: curbX, z: curbZ };
          }
          break; // 若較近側已成功且非車道，無需再檢查遠端側
        }
      }
    }

    // 2. 備用與人行道節點校驗：尋找行人路網中最近且不在車道上的節點 (人行道/騎樓/斑馬線端點)
    if (this.network && this.network.nodes) {
      for (let i = 0; i < this.network.nodes.length; i++) {
        const n = this.network.nodes[i];
        if (n.isCrosswalk && !n.isArcade) continue;
        if (this.isPointOnRoadway(n.x, n.z)) continue;
        const dSq = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          bestPt = { x: n.x, z: n.z };
        }
      }
    }

    return bestPt;
  }

  /**
   * 被車輛撞飛
   */
  public knockDownAgent(
    agent: PedestrianAgent,
    speed: number,
    heading: number,
    _sourceX: number,
    _sourceZ: number
  ): void {
    agent.state = PedestrianState.KNOCKED_FLYING;
    agent.stateTimer = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.FLYING_DURATION_SEC;
    agent.isSpecialState = true;
    agent.speed = 0;
    agent.targetSpeed = 0;
    this.totalKnockedDownCount++;

    const fwdX = Math.sin(heading);
    const fwdZ = Math.cos(heading);
    const knockSpeed = Math.max(3.5, speed * 0.7);
    agent.knockVx = fwdX * knockSpeed;
    agent.knockVz = fwdZ * knockSpeed;
    agent.knockVy = 3.2;
    agent.pitch = 0;
    agent.roll = 0;

    console.log(`[PedestrianSystem] 行人 (id: ${agent.id}) 被撞飛！`);
  }

  /**
   * 強制將最近行人擊倒在車道上 (除錯按鈕)
   */
  public forceKnockNearestPedestrianOnRoad(playerPos: Point2D): boolean {
    const activeAgents = this.agents.filter((a) => a.active);
    let bestDist = Infinity;
    let target: PedestrianAgent | null = null;
    for (const a of activeAgents) {
      const d = Math.hypot(a.x - playerPos.x, a.z - playerPos.z);
      if (d < bestDist && d < 60.0) {
        bestDist = d;
        target = a;
      }
    }
    if (!target) return false;

    // 尋找最近的道路車道點 (必須為真正的機動車道，非斑馬線、非純步道)
    let nearestRoadPt: Point2D | null = null;
    let minDistToRoad = Infinity;
    for (const road of this.roads) {
      if (
        road.isRailway ||
        ['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'living_street'].includes(road.type) ||
        (road.width && road.width < 3.0)
      ) {
        continue;
      }
      const pts = road.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const segDx = p2.x - p1.x;
        const segDz = p2.z - p1.z;
        const lenSq = segDx * segDx + segDz * segDz;
        if (lenSq < 0.0001) continue;
        const t = Math.max(0.1, Math.min(0.9, ((target.x - p1.x) * segDx + (target.z - p1.z) * segDz) / lenSq));
        const projX = p1.x + t * segDx;
        const projZ = p1.z + t * segDz;
        if (!this.isPointInCrosswalk(projX, projZ) && this.isPointOnRoadway(projX, projZ)) {
          const d = Math.hypot(target.x - projX, target.z - projZ);
          if (d < minDistToRoad) {
            minDistToRoad = d;
            nearestRoadPt = { x: projX, z: projZ };
          }
        }
      }
    }

    if (nearestRoadPt) {
      target.x = nearestRoadPt.x;
      target.z = nearestRoadPt.z;
    }
    target.y = CONFIG.ROADS.ELEVATION.ROAD + 0.15;
    target.state = PedestrianState.FALLEN;
    target.stateTimer = CONFIG.NPC_BEHAVIOR.PEDESTRIAN.KNOCKDOWN.FALLEN_DURATION_SEC;
    target.pitch = -Math.PI / 2;
    target.roll = 0;
    target.speed = 0;
    target.targetSpeed = 0;
    target.isSpecialState = true;
    target.knockVx = 0;
    target.knockVy = 0;
    target.knockVz = 0;
    target.outOfBoundsTimer = 0;
    this.totalKnockedDownCount++;

    console.log(`[PedestrianSystem] 已強制將最近行人 (id: ${target.id}) 擊倒在車道上 (位置: ${target.x.toFixed(1)}, ${target.z.toFixed(1)})`);
    return true;
  }
}
