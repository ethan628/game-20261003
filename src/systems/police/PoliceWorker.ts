/**
 * PoliceWorker.ts - 警察追捕專用有向車道網圖與 A* 尋路背景 Worker
 * 依據 RULES.md 與效能要求：
 * 1. 在獨立執行緒運算圖搜尋，主遊戲幀率完全不受影響
 * 2. 嚴格有向車道圖 (Directed Lane Graph)：雙向道拆分為獨立正反向車道鏈，禁止中途逆向與原地迴轉
 * 3. 轉向約束：路口禁止銳角 U-turn (> 140度)，目標在後方時自動尋找「繞街廓一圈」的可行路線
 * 4. 無可行路線時回傳 null，由警車控制器放棄追捕回歸巡邏
 */

export {};

interface Point2D {
  x: number;
  z: number;
}

interface WorkerRoad {
  id: string;
  points: Point2D[];
  width: number;
  oneway?: boolean | number;
  type: string;
}

interface GraphNode {
  id: number;
  x: number;
  z: number;
  heading: number;     // 節點行進方向 (rad)
  roadId: string;
  roadPtIdx: number;
  isReverse: boolean;
  edges: GraphEdge[];
}

interface GraphEdge {
  targetId: number;
  distance: number;
  cost: number;
}

let nodes: GraphNode[] = [];
let roadChainsMap = new Map<string, { forwardChain?: number[]; backwardChain?: number[] }>();

/**
 * 建立有向車道圖 (Directed Lane Graph)
 */
function buildGraph(roads: WorkerRoad[]) {
  nodes = [];
  roadChainsMap.clear();
  let nextNodeId = 0;

  // 1. 為每條道路建立有向車道鏈
  for (const road of roads) {
    if (road.points.length < 2) continue;

    const isOneWayForward = road.oneway === true || road.oneway === 1;
    const isOneWayBackward = road.oneway === -1;
    const isTwoWay = !road.oneway;
    const halfW = road.width * 0.5;
    const laneOffset = isTwoWay ? Math.max(1.2, halfW * 0.5) : 0.0;

    const chainRecord: { forwardChain?: number[]; backwardChain?: number[] } = {};

    // 1.1 正向車道鏈 (0 -> N-1)
    if (isOneWayForward || isTwoWay) {
      const fChain: number[] = [];
      for (let i = 0; i < road.points.length; i++) {
        const pt = road.points[i];
        let dirX = 0;
        let dirZ = 1;
        if (i < road.points.length - 1) {
          const next = road.points[i + 1];
          const len = Math.hypot(next.x - pt.x, next.z - pt.z) || 1.0;
          dirX = (next.x - pt.x) / len;
          dirZ = (next.z - pt.z) / len;
        } else {
          const prev = road.points[i - 1];
          const len = Math.hypot(pt.x - prev.x, pt.z - prev.z) || 1.0;
          dirX = (pt.x - prev.x) / len;
          dirZ = (pt.z - prev.z) / len;
        }

        const heading = Math.atan2(dirX, dirZ);
        const rightNormX = dirZ;
        const rightNormZ = -dirX;

        const nx = pt.x + rightNormX * laneOffset;
        const nz = pt.z + rightNormZ * laneOffset;

        const nId = nextNodeId++;
        nodes.push({
          id: nId,
          x: nx,
          z: nz,
          heading,
          roadId: road.id,
          roadPtIdx: i,
          isReverse: false,
          edges: []
        });
        fChain.push(nId);
      }

      // 建立車道內部單向連線
      for (let i = 0; i < fChain.length - 1; i++) {
        const u = fChain[i];
        const v = fChain[i + 1];
        const dist = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
        nodes[u].edges.push({ targetId: v, distance: dist, cost: dist });
      }
      chainRecord.forwardChain = fChain;
    }

    // 1.2 反向車道鏈 (N-1 -> 0)
    if (isOneWayBackward || isTwoWay) {
      const bChain: number[] = [];
      for (let i = road.points.length - 1; i >= 0; i--) {
        const pt = road.points[i];
        let dirX = 0;
        let dirZ = -1;
        if (i > 0) {
          const prev = road.points[i - 1];
          const len = Math.hypot(prev.x - pt.x, prev.z - pt.z) || 1.0;
          dirX = (prev.x - pt.x) / len;
          dirZ = (prev.z - pt.z) / len;
        } else {
          const next = road.points[i + 1];
          const len = Math.hypot(pt.x - next.x, pt.z - next.z) || 1.0;
          dirX = (pt.x - next.x) / len;
          dirZ = (pt.z - next.z) / len;
        }

        const heading = Math.atan2(dirX, dirZ);
        const rightNormX = dirZ;
        const rightNormZ = -dirX;

        const nx = pt.x + rightNormX * laneOffset;
        const nz = pt.z + rightNormZ * laneOffset;

        const nId = nextNodeId++;
        nodes.push({
          id: nId,
          x: nx,
          z: nz,
          heading,
          roadId: road.id,
          roadPtIdx: i,
          isReverse: true,
          edges: []
        });
        bChain.push(nId);
      }

      // 建立車道內部單向連線
      for (let i = 0; i < bChain.length - 1; i++) {
        const u = bChain[i];
        const v = bChain[i + 1];
        const dist = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);
        nodes[u].edges.push({ targetId: v, distance: dist, cost: dist });
      }
      chainRecord.backwardChain = bChain;
    }

    roadChainsMap.set(road.id, chainRecord);
  }

  // 2. 在路口端點交會處 (距離 < 16m) 連接相鄰合法車道 (禁止銳角迴轉)
  interface LaneExit {
    nodeId: number;
    x: number;
    z: number;
    heading: number;
    roadId: string;
  }
  interface LaneEntry {
    nodeId: number;
    x: number;
    z: number;
    heading: number;
    roadId: string;
  }

  const exits: LaneExit[] = [];
  const entries: LaneEntry[] = [];

  for (const [rId, chain] of roadChainsMap.entries()) {
    if (chain.forwardChain && chain.forwardChain.length > 0) {
      const entryId = chain.forwardChain[0];
      const exitId = chain.forwardChain[chain.forwardChain.length - 1];
      entries.push({ nodeId: entryId, x: nodes[entryId].x, z: nodes[entryId].z, heading: nodes[entryId].heading, roadId: rId });
      exits.push({ nodeId: exitId, x: nodes[exitId].x, z: nodes[exitId].z, heading: nodes[exitId].heading, roadId: rId });
    }
    if (chain.backwardChain && chain.backwardChain.length > 0) {
      const entryId = chain.backwardChain[0];
      const exitId = chain.backwardChain[chain.backwardChain.length - 1];
      entries.push({ nodeId: entryId, x: nodes[entryId].x, z: nodes[entryId].z, heading: nodes[entryId].heading, roadId: rId });
      exits.push({ nodeId: exitId, x: nodes[exitId].x, z: nodes[exitId].z, heading: nodes[exitId].heading, roadId: rId });
    }
  }

  for (const exit of exits) {
    let connectedCount = 0;
    for (const entry of entries) {
      if (exit.roadId === entry.roadId) continue; // 同一道路不自我相接 (禁止中途或端點原地掉頭)

      const d = Math.hypot(exit.x - entry.x, exit.z - entry.z);
      if (d < 16.0) {
        // 計算轉向角差
        let angleDiff = Math.abs(entry.heading - exit.heading);
        while (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;

        // 若轉彎角度 > 140 度 (銳角迴轉)，禁止相接
        if (angleDiff > (140 * Math.PI) / 180) {
          continue;
        }

        // 轉彎附加成本 (平順直行 1.0，大角度轉彎加權 1.25)
        const turnCost = d + angleDiff * 3.5;
        nodes[exit.nodeId].edges.push({
          targetId: entry.nodeId,
          distance: d,
          cost: turnCost
        });
        connectedCount++;
      }
    }

    // 若為無銜接之死巷盡頭 (dead end)，雙向道允許在末端合法迴車
    if (connectedCount === 0) {
      const rChain = roadChainsMap.get(exit.roadId);
      if (rChain && rChain.forwardChain && rChain.backwardChain) {
        // 從正向末端迴接到反向起點
        if (exit.nodeId === rChain.forwardChain[rChain.forwardChain.length - 1]) {
          const entryId = rChain.backwardChain[0];
          const d = Math.hypot(exit.x - nodes[entryId].x, exit.z - nodes[entryId].z);
          nodes[exit.nodeId].edges.push({ targetId: entryId, distance: d, cost: d + 15.0 });
        } else if (exit.nodeId === rChain.backwardChain[rChain.backwardChain.length - 1]) {
          const entryId = rChain.forwardChain[0];
          const d = Math.hypot(exit.x - nodes[entryId].x, exit.z - nodes[entryId].z);
          nodes[exit.nodeId].edges.push({ targetId: entryId, distance: d, cost: d + 15.0 });
        }
      }
    }
  }

  console.log(`[PoliceWorker] 有向車道網圖建置完成！節點數: ${nodes.length}，車道出口: ${exits.length}`);
}

/**
 * 尋找警車前方合法起點節點 (嚴禁選取後方節點，強制向前導航)
 */
function findForwardStartNode(from: Point2D, carHeading: number, currentRoadId?: string): number {
  const fwdX = Math.sin(carHeading);
  const fwdZ = Math.cos(carHeading);

  let bestNodeId = -1;
  let bestScore = Infinity;

  // 1. 若已知目前道路，優先在目前道路的正向前進方向挑選下一個節點
  if (currentRoadId && roadChainsMap.has(currentRoadId)) {
    const chain = roadChainsMap.get(currentRoadId)!;
    const candidates: number[] = [];
    if (chain.forwardChain) candidates.push(...chain.forwardChain);
    if (chain.backwardChain) candidates.push(...chain.backwardChain);

    for (const nId of candidates) {
      const n = nodes[nId];
      const dx = n.x - from.x;
      const dz = n.z - from.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 50.0) continue;

      const dotFwd = (dx * fwdX + dz * fwdZ) / (dist || 1.0);
      const dotHeading = Math.sin(n.heading) * fwdX + Math.cos(n.heading) * fwdZ;

      // 節點必須位於車頭前方 (dotFwd > 0.0) 且車道同向 (dotHeading > 0.5)
      if (dotFwd >= -0.05 && dotHeading > 0.3) {
        const score = dist - dotFwd * 5.0;
        if (score < bestScore) {
          bestScore = score;
          bestNodeId = nId;
        }
      }
    }
    if (bestNodeId !== -1) return bestNodeId;
  }

  // 2. 全圖搜尋車頭前方 45 公尺內之最佳同向節點
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const dx = n.x - from.x;
    const dz = n.z - from.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 45.0) continue;

    const dotFwd = (dx * fwdX + dz * fwdZ) / (dist || 1.0);
    const dotHeading = Math.sin(n.heading) * fwdX + Math.cos(n.heading) * fwdZ;

    if (dotFwd >= -0.1 && dotHeading > 0.2) {
      const score = dist + (1.0 - dotHeading) * 15.0;
      if (score < bestScore) {
        bestScore = score;
        bestNodeId = i;
      }
    }
  }

  if (bestNodeId !== -1) return bestNodeId;

  // 3. 備援：全圖最近節點
  let fallbackId = 0;
  let minD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = Math.hypot(nodes[i].x - from.x, nodes[i].z - from.z);
    if (d < minD) {
      minD = d;
      fallbackId = i;
    }
  }
  return fallbackId;
}

/**
 * 尋找目標預測位置最近之終點節點
 */
function findNearestTargetNode(to: Point2D): number {
  let bestDistSq = Infinity;
  let bestId = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const dSq = (n.x - to.x) * (n.x - to.x) + (n.z - to.z) * (n.z - to.z);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestId = i;
    }
  }
  return bestId;
}

/**
 * A* 啟發式路徑搜尋 (回傳路徑與總成本)
 */
function aStar(startNodeId: number, endNodeId: number): { waypoints: Point2D[]; totalCost: number } | null {
  if (nodes.length === 0) return null;
  if (startNodeId === endNodeId) {
    return { waypoints: [{ x: nodes[startNodeId].x, z: nodes[startNodeId].z }], totalCost: 0 };
  }

  const openSet = new Set<number>([startNodeId]);
  const cameFrom = new Map<number, number>();

  const gScore = new Float32Array(nodes.length).fill(Infinity);
  const fScore = new Float32Array(nodes.length).fill(Infinity);

  const goal = nodes[endNodeId];

  gScore[startNodeId] = 0;
  fScore[startNodeId] = Math.hypot(goal.x - nodes[startNodeId].x, goal.z - nodes[startNodeId].z);

  let iterations = 0;
  const maxIterations = 2000;

  while (openSet.size > 0 && iterations++ < maxIterations) {
    let current = -1;
    let minF = Infinity;

    for (const nId of openSet) {
      if (fScore[nId] < minF) {
        minF = fScore[nId];
        current = nId;
      }
    }

    if (current === -1 || current === endNodeId) {
      break;
    }

    openSet.delete(current);
    const currNode = nodes[current];

    for (const edge of currNode.edges) {
      const neighbor = edge.targetId;
      const tentativeG = gScore[current] + edge.cost;

      if (tentativeG < gScore[neighbor]) {
        cameFrom.set(neighbor, current);
        gScore[neighbor] = tentativeG;
        const h = Math.hypot(goal.x - nodes[neighbor].x, goal.z - nodes[neighbor].z);
        fScore[neighbor] = tentativeG + h;
        openSet.add(neighbor);
      }
    }
  }

  if (!cameFrom.has(endNodeId)) {
    return null; // 無合法有向路徑
  }

  // 重構路徑
  const path: Point2D[] = [];
  let curr: number | undefined = endNodeId;
  while (curr !== undefined) {
    path.push({ x: nodes[curr].x, z: nodes[curr].z });
    curr = cameFrom.get(curr);
  }
  path.reverse();

  return {
    waypoints: path,
    totalCost: gScore[endNodeId]
  };
}

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'INIT_ROADS') {
    buildGraph(payload.roads);
    self.postMessage({ type: 'ROADS_READY', nodeCount: nodes.length });
  } else if (type === 'PLAN_PURSUIT_PATH') {
    const { carId, from, to, carHeading, currentRoadId } = payload;
    const startNode = findForwardStartNode(from, carHeading ?? 0, currentRoadId);
    const endNode = findNearestTargetNode(to);
    const result = aStar(startNode, endNode);

    if (result) {
      const wp = result.waypoints;
      const pathHash = `${wp[0]?.x.toFixed(1)},${wp[0]?.z.toFixed(1)}|${wp[wp.length - 1]?.x.toFixed(1)},${wp[wp.length - 1]?.z.toFixed(1)}|${wp.length}`;
      self.postMessage({
        type: 'PURSUIT_PATH_RESULT',
        carId,
        waypoints: wp,
        cost: result.totalCost,
        pathHash,
        targetPos: to
      });
    } else {
      // 無可行路線：回傳 null，嚴禁直線回傳造成倒車或穿牆！
      self.postMessage({
        type: 'PURSUIT_PATH_RESULT',
        carId,
        waypoints: null,
        cost: Infinity,
        pathHash: 'none',
        targetPos: to
      });
    }
  }
};
