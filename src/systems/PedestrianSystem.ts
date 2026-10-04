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

import { Point2D, BuildingCollisionData } from '../geo/OsmTypes.ts';
import {
  PedestrianNetworkData,
  PedestrianNode,
  PedestrianState,
  PedestrianSystemStats
} from '../geo/PedestrianTypes.ts';
import { CONFIG } from '../config.ts';
import { TrafficSignalSystem } from './traffic-signals/TrafficSignalSystem.ts';
import { PedestrianSignalInfo } from './traffic-signals/SignalController.ts';

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
}

export class PedestrianSystem {
  private network: PedestrianNetworkData | null = null;
  private agents: PedestrianAgent[] = [];
  private maxCount = CONFIG.PEDESTRIAN.MAX_COUNT;

  // 空間雜湊網格 (Spatial Hash Grid)
  private cellSize = CONFIG.PEDESTRIAN.SPATIAL_GRID_SIZE; // 2.0m
  private grid: Map<string, number[]> = new Map();

  // 交通信號週期 (綠燈 15s，紅燈 20s)
  private trafficTimer = 0;
  private isCrosswalkGreen = true;
  private trafficSignalSystem: TrafficSignalSystem | null = null;

  // 時間切片更新 (每幀更新 1/2)
  private sliceIndex = 0;
  private lastAiTimeMs = 0;

  // 事件監聽回呼清單
  private eventListeners: Map<string, ((origin: Point2D, radius: number) => void)[]> = new Map();

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
        insideBuildingTimer: 0
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
        // 避免在同一個節點 2.5m 內密集堆疊生成
        if (!this.isPositionCrowded(candNode.x, candNode.z, 2.5)) {
          this.spawnAgentAtNode(candNode, isRaining);
        }
      }
    }
  }

  /**
   * 檢查某個座標點附近是否已有有效行人
   */
  private isPositionCrowded(x: number, z: number, minDist: number): boolean {
    for (let i = 0; i < this.agents.length; i++) {
      const a = this.agents[i];
      if (a.active && Math.hypot(a.x - x, a.z - z) < minDist) {
        return true;
      }
    }
    return false;
  }

  /**
   * 在特定節點激活生成行人
   */
  private spawnAgentAtNode(node: PedestrianNode, isRaining: boolean): void {
    const inactiveAgent = this.agents.find((a) => !a.active);
    if (!inactiveAgent) return;

    const colors = CONFIG.PEDESTRIAN.COLORS;
    const speeds = CONFIG.PEDESTRIAN;

    const targetEdge = node.edges[Math.floor(Math.random() * node.edges.length)];
    const targetNode = this.network!.nodes[targetEdge.target];

    // 初次生成時隨機分配在該路段進度 (0.0 ~ 0.95)，使行人自然均勻散佈於街道各處，而非全聚集在端點
    const progress = Math.random() * 0.95;
    const dx = targetNode.x - node.x;
    const dz = targetNode.z - node.z;

    inactiveAgent.active = true;
    inactiveAgent.x = node.x + dx * progress;
    inactiveAgent.z = node.z + dz * progress;
    const currY = (node.isArcade || !node.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    const targetY = (targetNode.isArcade || !targetNode.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    inactiveAgent.y = currY + (targetY - currY) * progress;

    inactiveAgent.currentNodeId = node.id;
    inactiveAgent.targetNodeId = targetEdge.target;
    inactiveAgent.prevNodeId = -1;
    inactiveAgent.pathProgress = progress;
    inactiveAgent.edgeLength = targetEdge.distance;
    inactiveAgent.rotationY = Math.atan2(dx, dz);

    const baseSpeed = speeds.MIN_SPEED_MPS + Math.random() * (speeds.MAX_SPEED_MPS - speeds.MIN_SPEED_MPS);
    inactiveAgent.targetSpeed = baseSpeed;
    inactiveAgent.speed = baseSpeed;
    inactiveAgent.state = PedestrianState.WALKING;
    inactiveAgent.stateTimer = 0;
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
    if (agent.insideBuildingTimer > 0) {
      agent.insideBuildingTimer -= dt;
      return;
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

    // 速度平滑過渡
    agent.speed += (agent.targetSpeed - agent.speed) * Math.min(1.0, dt * 5.0);

    const nodes = this.network!.nodes;
    const currNode = nodes[agent.currentNodeId];
    const targetNode = nodes[agent.targetNodeId];

    if (!currNode || !targetNode) {
      agent.active = false;
      return;
    }

    // 1. 空間避讓 (行人相互排斥力)
    this.calculateSeparation(agent, dt);

    // 2. 避讓玩家 (當距離小於門檻時向兩側側移讓路)
    const toPlayerX = playerPos.x - agent.x;
    const toPlayerZ = playerPos.z - agent.z;
    const distToPlayer = Math.hypot(toPlayerX, toPlayerZ);

    if (distToPlayer < CONFIG.PEDESTRIAN.AVOID_PLAYER_RADIUS && distToPlayer > 0.1) {
      const avoidStrength = (CONFIG.PEDESTRIAN.AVOID_PLAYER_RADIUS - distToPlayer) * 3.5;
      // 沿法線外推
      agent.avoidVx -= (toPlayerX / distToPlayer) * avoidStrength;
      agent.avoidVz -= (toPlayerZ / distToPlayer) * avoidStrength;
      agent.state = PedestrianState.EVADING;
      agent.stateTimer = 0.8;
    }

    // 3. 沿路網前進
    const segDx = targetNode.x - currNode.x;
    const segDz = targetNode.z - currNode.z;
    const segLen = agent.edgeLength || Math.hypot(segDx, segDz) || 1;

    const moveDist = agent.speed * dt;
    agent.pathProgress += moveDist / segLen;

    // 線性插值計算位置與路面/人行道高程 + 疊加避讓位移
    let nextX = currNode.x + segDx * Math.min(1.0, agent.pathProgress) + agent.avoidVx * dt;
    let nextZ = currNode.z + segDz * Math.min(1.0, agent.pathProgress) + agent.avoidVz * dt;

    const currY = (currNode.isArcade || !currNode.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    const targetY = (targetNode.isArcade || !targetNode.isCrosswalk) ? CONFIG.ROADS.ELEVATION.SIDEWALK : (CONFIG.ROADS.ELEVATION.ROAD + 0.01);
    agent.y = currY + (targetY - currY) * Math.min(1.0, agent.pathProgress);

    // 衰減避讓速度
    agent.avoidVx *= Math.max(0, 1.0 - dt * 6.0);
    agent.avoidVz *= Math.max(0, 1.0 - dt * 6.0);

    // 4. 防穿牆碰撞檢測 (若即將踏入建築物，推向建築外緣)
    for (let bIdx = 0; bIdx < buildingColliders.length; bIdx++) {
      const b = buildingColliders[bIdx];
      if (nextX >= b.minX - 0.3 && nextX <= b.maxX + 0.3 && nextZ >= b.minZ - 0.3 && nextZ <= b.maxZ + 0.3) {
        // 修正回邊緣
        const dLeft = Math.abs(nextX - b.minX);
        const dRight = Math.abs(nextX - b.maxX);
        const dTop = Math.abs(nextZ - b.minZ);
        const dBottom = Math.abs(nextZ - b.maxZ);
        const minD = Math.min(dLeft, dRight, dTop, dBottom);
        if (minD === dLeft) nextX = b.minX - 0.5;
        else if (minD === dRight) nextX = b.maxX + 0.5;
        else if (minD === dTop) nextZ = b.minZ - 0.5;
        else nextZ = b.maxZ + 0.5;
        break;
      }
    }

    // 朝向平滑旋轉
    if (agent.speed > 0.1) {
      const targetAngle = Math.atan2(segDx, segDz);
      let angleDiff = targetAngle - agent.rotationY;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      agent.rotationY += angleDiff * Math.min(1.0, dt * 10.0);
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
      // 尋找斑馬線過街邊
      const crosswalkEdge = arrivedNode.edges.find((e) => e.isCrosswalk);
      if (crosswalkEdge) {
        const sig = this.getAgentCrossingSignal(agent);
        const neededSec = (crosswalkEdge.distance || 10.0) / 1.35;
        const canCross = sig
          ? (sig.state === 'walk' && sig.remainingSec >= neededSec)
          : this.isCrosswalkGreen;

        if (!canCross && Math.random() >= CONFIG.PEDESTRIAN.CROSSWALK_JAYWALK_CHANCE) {
          agent.state = PedestrianState.WAITING_CROSSWALK;
          agent.targetSpeed = 0;
          agent.targetNodeId = crosswalkEdge.target;
          agent.edgeLength = crosswalkEdge.distance;
          return;
        } else {
          agent.state = PedestrianState.CROSSING;
          agent.targetSpeed = 1.35;
          agent.targetNodeId = crosswalkEdge.target;
          agent.edgeLength = crosswalkEdge.distance;
          return;
        }
      }
    }

    // 隨機停駐機率 (12% 停留看手機/看店家/聊天 3~10秒)
    if (agent.state === PedestrianState.WALKING && Math.random() < CONFIG.PEDESTRIAN.IDLE_CHANCE_AT_INTERSECTION) {
      agent.state = PedestrianState.IDLE;
      agent.stateTimer = 3.0 + Math.random() * 8.0;
      agent.gesture = Math.random() < 0.5 ? 1 : 0; // 看手機
    }

    // 進入店家機率 (8% 機率走進店家)
    if (arrivedNode.isArcade && Math.random() < CONFIG.PEDESTRIAN.ENTER_SHOP_CHANCE) {
      agent.insideBuildingTimer = 8.0 + Math.random() * 16.0;
    }

    // 選擇下一個目標邊 (避免立刻 180 度原路折返，除非無其他出路)
    const validEdges = arrivedNode.edges.filter((e) => e.target !== agent.prevNodeId);
    const chosenEdge = validEdges.length > 0
      ? validEdges[Math.floor(Math.random() * validEdges.length)]
      : (arrivedNode.edges[0] || null);

    if (chosenEdge) {
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
   * 空間雜湊網格分離排斥計算 (避免行人重疊)
   */
  private calculateSeparation(agent: PedestrianAgent, _dt: number): void {
    const inv = 1.0 / this.cellSize;
    const gx = Math.floor(agent.x * inv);
    const gz = Math.floor(agent.z * inv);
    const avoidDist = CONFIG.PEDESTRIAN.AVOID_PEDESTRIAN_RADIUS; // 0.8m

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

          const dx = agent.x - other.x;
          const dz = agent.z - other.z;
          const dist = Math.hypot(dx, dz);

          if (dist < avoidDist && dist > 0.05) {
            const force = (avoidDist - dist) * 1.8;
            agent.avoidVx += (dx / dist) * force;
            agent.avoidVz += (dz / dist) * force;
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
    }

    return {
      total,
      walking,
      idle,
      waiting,
      crossing,
      evading,
      panic,
      aiTimeMs: this.lastAiTimeMs,
      drawCalls
    };
  }

  public getIsCrosswalkGreen(): boolean {
    return this.isCrosswalkGreen;
  }
}
