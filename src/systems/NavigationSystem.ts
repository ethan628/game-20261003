/**
 * NavigationSystem.ts - 導航路網與 A* 尋路系統
 * 負責將 OSM 道路轉為連通圖、計算最短路線、偏離路徑重新規劃與到達檢測
 * 支援 Web Worker 非同步計算與主線程備援
 */

import { Point2D, RoadFeature } from '../geo/OsmTypes.ts';
import { CONFIG } from '../config.ts';

export interface NavigationRoute {
  points: Point2D[];
  totalDistanceMeters: number;
  estimatedWalkTimeSec: number;
  estimatedDriveTimeSec: number;
}

interface GraphNode {
  id: number;
  x: number;
  z: number;
  edges: GraphEdge[];
}

interface GraphEdge {
  target: number;
  distance: number;
  cost: number;
  roadName?: string;
  points: Point2D[];
}

export class NavigationSystem {
  private nodes: GraphNode[] = [];
  private roads: RoadFeature[] = [];
  private worker: Worker | null = null;
  private isWorkerReady = false;
  private currentRoute: NavigationRoute | null = null;
  private destinationPoint: Point2D | null = null;
  private pendingResolve: ((route: NavigationRoute | null) => void) | null = null;

  constructor() {
    this.initWorker();
  }

  private initWorker(): void {
    try {
      this.worker = new Worker(new URL('./NavWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent) => {
        const { type, route } = e.data;
        if (type === 'GRAPH_READY') {
          this.isWorkerReady = true;
        } else if (type === 'PATH_RESULT') {
          if (this.pendingResolve) {
            if (route) {
              const fullRoute: NavigationRoute = {
                points: route.points,
                totalDistanceMeters: route.totalDistanceMeters,
                estimatedWalkTimeSec: Math.round(route.totalDistanceMeters / CONFIG.NAVIGATION.WALK_SPEED_MPS),
                estimatedDriveTimeSec: Math.round(route.totalDistanceMeters / CONFIG.NAVIGATION.DRIVE_SPEED_MPS)
              };
              this.currentRoute = fullRoute;
              this.pendingResolve(fullRoute);
            } else {
              this.currentRoute = null;
              this.pendingResolve(null);
            }
            this.pendingResolve = null;
          }
        }
      };
    } catch (err) {
      console.warn('[NavigationSystem] 無法啟動 Web Worker，將使用主線程尋路', err);
      this.worker = null;
    }
  }

  /**
   * 根據 OSM 道路資料建立路網連通圖 (考慮單行道與道路權重)
   */
  public buildGraph(roads: RoadFeature[]): void {
    this.roads = roads.filter((r) => !r.isRailway); // 排除鐵路
    this.nodes = [];
    this.currentRoute = null;
    this.destinationPoint = null;

    // 空間網格用於頂點吸附 (容差 1.5 公尺內視為同一個路口交叉點)
    const SNAP_TOLERANCE = 1.5;
    const grid = new Map<string, number>();

    const getOrAddNode = (pt: Point2D): number => {
      const gx = Math.round(pt.x / SNAP_TOLERANCE);
      const gz = Math.round(pt.z / SNAP_TOLERANCE);
      const key = `${gx}_${gz}`;

      const existingId = grid.get(key);
      if (existingId !== undefined) {
        return existingId;
      }

      const id = this.nodes.length;
      this.nodes.push({ id, x: pt.x, z: pt.z, edges: [] });
      grid.set(key, id);
      return id;
    };

    // 道路種類成本權重 (幹道速度較快 -> 成本權重較低)
    const TYPE_WEIGHTS: Record<string, number> = {
      motorway: 0.6,
      trunk: 0.7,
      primary: 0.8,
      secondary: 0.9,
      tertiary: 1.0,
      residential: 1.2,
      service: 1.3,
      living_street: 1.4,
      pedestrian: 1.2,
      footway: 1.5,
      path: 1.5
    };

    for (const road of this.roads) {
      if (road.points.length < 2) continue;

      const weight = TYPE_WEIGHTS[road.type] || 1.1;

      for (let i = 0; i < road.points.length - 1; i++) {
        const p1 = road.points[i];
        const p2 = road.points[i + 1];
        const u = getOrAddNode(p1);
        const v = getOrAddNode(p2);

        if (u === v) continue;

        const dist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
        const cost = dist * weight;

        // 正向邊
        this.nodes[u].edges.push({
          target: v,
          distance: dist,
          cost,
          roadName: road.name,
          points: [p1, p2]
        });

        // 若非單行道，加入雙向反向邊
        if (!road.oneway) {
          this.nodes[v].edges.push({
            target: u,
            distance: dist,
            cost,
            roadName: road.name,
            points: [p2, p1]
          });
        }
      }
    }

    // 同步路網至 Web Worker
    if (this.worker) {
      const serializableNodes = this.nodes.map((n) => ({
        id: n.id,
        x: n.x,
        z: n.z,
        edges: n.edges.map((e) => ({
          target: e.target,
          distance: e.distance,
          cost: e.cost,
          points: e.points
        }))
      }));
      this.worker.postMessage({ type: 'INIT_GRAPH', payload: { nodes: serializableNodes } });
    }

    console.log(`[NavigationSystem] 路網建構完成：節點數 ${this.nodes.length} 個，道路數 ${this.roads.length} 條`);
  }

  /**
   * 計算從玩家位置到目標位置之 A* 最短路線
   */
  public async findRoute(start: Point2D, end: Point2D): Promise<NavigationRoute | null> {
    if (this.nodes.length === 0) return null;
    this.destinationPoint = end;

    // 尋找最近的道路吸附點
    const startSnap = this.findNearestRoadPoint(start);
    const endSnap = this.findNearestRoadPoint(end);

    if (!startSnap || !endSnap) {
      // 找不到道路時，使用直線連通
      return this.createDirectRoute(start, end);
    }

    // 若 Web Worker 可用且已準備完成，優先交由背景計算
    if (this.worker && this.isWorkerReady) {
      return new Promise<NavigationRoute | null>((resolve) => {
        this.pendingResolve = resolve;
        this.worker!.postMessage({
          type: 'FIND_PATH',
          payload: {
            startNodeId: startSnap.nodeId,
            endNodeId: endSnap.nodeId,
            startPt: start,
            endPt: end
          }
        });

        // 300ms 超時防呆備援 (若 Worker 無回應則立即走主線程)
        setTimeout(() => {
          if (this.pendingResolve === resolve) {
            console.warn('[NavigationSystem] Worker 尋路超時，切換至主線程');
            this.pendingResolve = null;
            resolve(this.solveRouteMainThread(start, end, startSnap.nodeId, endSnap.nodeId));
          }
        }, 300);
      });
    }

    // 主線程即時計算備援
    return this.solveRouteMainThread(start, end, startSnap.nodeId, endSnap.nodeId);
  }

  private solveRouteMainThread(start: Point2D, end: Point2D, startNodeId: number, endNodeId: number): NavigationRoute | null {
    const path = this.aStarMainThread(startNodeId, endNodeId);
    if (!path) {
      return this.createDirectRoute(start, end);
    }

    const points: Point2D[] = [{ x: start.x, z: start.z }];
    let totalDist = 0;

    for (let i = 0; i < path.length - 1; i++) {
      const u = this.nodes[path[i]];
      const vId = path[i + 1];
      const edge = u.edges.find((e) => e.target === vId);
      if (edge && edge.points) {
        for (const p of edge.points) {
          points.push({ x: p.x, z: p.z });
        }
        totalDist += edge.distance;
      } else {
        const v = this.nodes[vId];
        points.push({ x: v.x, z: v.z });
        totalDist += Math.hypot(v.x - u.x, v.z - u.z);
      }
    }
    points.push({ x: end.x, z: end.z });

    const route: NavigationRoute = {
      points,
      totalDistanceMeters: Math.round(totalDist),
      estimatedWalkTimeSec: Math.round(totalDist / CONFIG.NAVIGATION.WALK_SPEED_MPS),
      estimatedDriveTimeSec: Math.round(totalDist / CONFIG.NAVIGATION.DRIVE_SPEED_MPS)
    };
    this.currentRoute = route;
    return route;
  }

  private aStarMainThread(startId: number, goalId: number): number[] | null {
    if (!this.nodes[startId] || !this.nodes[goalId]) return null;

    const goalNode = this.nodes[goalId];
    const gScore = new Map<number, number>();
    const fScore = new Map<number, number>();
    const cameFrom = new Map<number, number>();

    const openSet: number[] = [startId];
    gScore.set(startId, 0);
    fScore.set(startId, Math.hypot(goalNode.x - this.nodes[startId].x, goalNode.z - this.nodes[startId].z));

    let iterations = 0;
    while (openSet.length > 0 && iterations++ < 5000) {
      let lowestIdx = 0;
      let lowestF = fScore.get(openSet[0]) ?? Infinity;
      for (let i = 1; i < openSet.length; i++) {
        const f = fScore.get(openSet[i]) ?? Infinity;
        if (f < lowestF) {
          lowestF = f;
          lowestIdx = i;
        }
      }

      const currentId = openSet[lowestIdx];
      if (currentId === goalId) {
        const path = [currentId];
        let curr = currentId;
        while (cameFrom.has(curr)) {
          curr = cameFrom.get(curr)!;
          path.unshift(curr);
        }
        return path;
      }

      openSet.splice(lowestIdx, 1);
      const currNode = this.nodes[currentId];
      if (!currNode) continue;
      const currentG = gScore.get(currentId) ?? Infinity;

      for (const edge of currNode.edges) {
        const neighborId = edge.target;
        const neighborNode = this.nodes[neighborId];
        if (!neighborNode) continue;

        const tentativeG = currentG + edge.cost;
        if (tentativeG < (gScore.get(neighborId) ?? Infinity)) {
          cameFrom.set(neighborId, currentId);
          gScore.set(neighborId, tentativeG);
          const h = Math.hypot(goalNode.x - neighborNode.x, goalNode.z - neighborNode.z);
          fScore.set(neighborId, tentativeG + h);

          if (!openSet.includes(neighborId)) {
            openSet.push(neighborId);
          }
        }
      }
    }

    return null;
  }

  /**
   * 搜尋最近的道路點與節點
   */
  private findNearestRoadPoint(pt: Point2D): { nodeId: number; point: Point2D; dist: number } | null {
    let bestDist = Infinity;
    let bestNodeId = -1;
    let bestPt = pt;

    for (const node of this.nodes) {
      const d = Math.hypot(node.x - pt.x, node.z - pt.z);
      if (d < bestDist) {
        bestDist = d;
        bestNodeId = node.id;
        bestPt = { x: node.x, z: node.z };
      }
    }

    if (bestNodeId === -1) return null;
    return { nodeId: bestNodeId, point: bestPt, dist: bestDist };
  }

  private createDirectRoute(start: Point2D, end: Point2D): NavigationRoute {
    const dist = Math.hypot(end.x - start.x, end.z - start.z);
    const route: NavigationRoute = {
      points: [start, end],
      totalDistanceMeters: Math.round(dist),
      estimatedWalkTimeSec: Math.round(dist / CONFIG.NAVIGATION.WALK_SPEED_MPS),
      estimatedDriveTimeSec: Math.round(dist / CONFIG.NAVIGATION.DRIVE_SPEED_MPS)
    };
    this.currentRoute = route;
    return route;
  }

  /**
   * 檢測玩家是否偏離路線超過指定門檻 (公尺)
   */
  public checkDeviation(playerPos: Point2D, thresholdMeters = CONFIG.NAVIGATION.RECALC_DEVIATION_METERS): boolean {
    if (!this.currentRoute || this.currentRoute.points.length < 2) return false;

    let minDistance = Infinity;
    const pts = this.currentRoute.points;

    for (let i = 0; i < pts.length - 1; i++) {
      const d = this.distToSegment(playerPos, pts[i], pts[i + 1]);
      if (d < minDistance) {
        minDistance = d;
      }
    }

    return minDistance > thresholdMeters;
  }

  /**
   * 檢測玩家是否已抵達目的地 (5 公尺以內)
   */
  public checkArrival(playerPos: Point2D, thresholdMeters = CONFIG.NAVIGATION.ARRIVAL_DISTANCE_METERS): boolean {
    if (!this.destinationPoint) return false;
    const dist = Math.hypot(playerPos.x - this.destinationPoint.x, playerPos.z - this.destinationPoint.z);
    return dist <= thresholdMeters;
  }

  private distToSegment(p: Point2D, v: Point2D, w: Point2D): number {
    const l2 = (w.x - v.x) ** 2 + (w.z - v.z) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.z - v.z);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.z - v.z) * (w.z - v.z)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = v.x + t * (w.x - v.x);
    const projZ = v.z + t * (w.z - v.z);
    return Math.hypot(p.x - projX, p.z - projZ);
  }

  public getCurrentRoute(): NavigationRoute | null {
    return this.currentRoute;
  }

  public getDestination(): Point2D | null {
    return this.destinationPoint;
  }

  public clearRoute(): void {
    this.currentRoute = null;
    this.destinationPoint = null;
  }

  public dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.nodes = [];
    this.roads = [];
    this.currentRoute = null;
  }
}
