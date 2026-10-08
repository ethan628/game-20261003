/**
 * PoliceWorker.ts - 警察追捕專用車道網圖與 A* 尋路背景 Worker
 * 依據 RULES.md 與效能要求：在獨立執行緒運算圖搜尋，確保主遊戲幀率完全不受影響
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
  roadId: string;
  roadPtIdx: number;
  edges: GraphEdge[];
}

interface GraphEdge {
  targetId: number;
  distance: number;
  cost: number;
}

let nodes: GraphNode[] = [];

/**
 * 建立車道網圖
 */
function buildGraph(roads: WorkerRoad[]) {
  nodes = [];
  let nextNodeId = 0;

  // 1. 為每個道路節點建立圖節點
  const roadNodesMap = new Map<string, number[]>();

  for (const road of roads) {
    if (road.points.length < 2) continue;
    const nodeIds: number[] = [];

    for (let i = 0; i < road.points.length; i++) {
      const pt = road.points[i];
      const nId = nextNodeId++;
      nodes.push({
        id: nId,
        x: pt.x,
        z: pt.z,
        roadId: road.id,
        roadPtIdx: i,
        edges: []
      });
      nodeIds.push(nId);
    }
    roadNodesMap.set(road.id, nodeIds);

    // 道路內部連續連線 (遵守單雙向)
    const isOneWayForward = road.oneway === true || road.oneway === 1;
    const isOneWayBackward = road.oneway === -1;
    const isTwoWay = !road.oneway;

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const u = nodeIds[i];
      const v = nodeIds[i + 1];
      const dist = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].z - nodes[u].z);

      if (isOneWayForward || isTwoWay) {
        nodes[u].edges.push({ targetId: v, distance: dist, cost: dist });
      }
      if (isOneWayBackward || isTwoWay) {
        nodes[v].edges.push({ targetId: u, distance: dist, cost: dist });
      }
    }
  }

  // 2. 在端點交會處 (距離 < 14m) 連接相鄰道路
  const endpoints: { nodeId: number; x: number; z: number; isStart: boolean; roadId: string }[] = [];
  for (const [rId, nIds] of roadNodesMap.entries()) {
    if (nIds.length < 2) continue;
    const startId = nIds[0];
    const endId = nIds[nIds.length - 1];
    endpoints.push({ nodeId: startId, x: nodes[startId].x, z: nodes[startId].z, isStart: true, roadId: rId });
    endpoints.push({ nodeId: endId, x: nodes[endId].x, z: nodes[endId].z, isStart: false, roadId: rId });
  }

  for (let i = 0; i < endpoints.length; i++) {
    const epA = endpoints[i];
    for (let j = i + 1; j < endpoints.length; j++) {
      const epB = endpoints[j];
      if (epA.roadId === epB.roadId) continue;

      const d = Math.hypot(epA.x - epB.x, epA.z - epB.z);
      if (d < 14.0) {
        const u = epA.nodeId;
        const v = epB.nodeId;
        nodes[u].edges.push({ targetId: v, distance: d, cost: d * 1.05 });
        nodes[v].edges.push({ targetId: u, distance: d, cost: d * 1.05 });
      }
    }
  }
}

/**
 * 尋找最近的圖節點
 */
function findNearestNode(pt: Point2D): number {
  let bestDistSq = Infinity;
  let bestId = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const dSq = (n.x - pt.x) * (n.x - pt.x) + (n.z - pt.z) * (n.z - pt.z);
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestId = i;
    }
  }
  return bestId;
}

/**
 * A* 啟發式路徑搜尋
 */
function aStar(startNodeId: number, endNodeId: number): Point2D[] | null {
  if (nodes.length === 0 || startNodeId === endNodeId) {
    return [nodes[startNodeId]];
  }

  const openSet = new Set<number>([startNodeId]);
  const cameFrom = new Map<number, number>();

  const gScore = new Float32Array(nodes.length).fill(Infinity);
  const fScore = new Float32Array(nodes.length).fill(Infinity);

  const goal = nodes[endNodeId];

  gScore[startNodeId] = 0;
  fScore[startNodeId] = Math.hypot(goal.x - nodes[startNodeId].x, goal.z - nodes[startNodeId].z);

  let iterations = 0;
  const maxIterations = 1500; // 防呆安全上限

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

  if (!cameFrom.has(endNodeId) && startNodeId !== endNodeId) {
    return null;
  }

  // 重構路徑
  const path: Point2D[] = [];
  let curr: number | undefined = endNodeId;
  while (curr !== undefined) {
    path.push({ x: nodes[curr].x, z: nodes[curr].z });
    curr = cameFrom.get(curr);
  }
  path.reverse();
  return path;
}

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'INIT_ROADS') {
    buildGraph(payload.roads);
    self.postMessage({ type: 'ROADS_READY', nodeCount: nodes.length });
  } else if (type === 'PLAN_PURSUIT_PATH') {
    const { carId, from, to } = payload;
    const startNode = findNearestNode(from);
    const endNode = findNearestNode(to);
    const waypoints = aStar(startNode, endNode);

    self.postMessage({
      type: 'PURSUIT_PATH_RESULT',
      carId,
      waypoints: waypoints || [from, to]
    });
  }
};
