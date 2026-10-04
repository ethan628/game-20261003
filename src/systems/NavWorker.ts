/**
 * NavWorker.ts - 導航路網 A* 尋路背景 Worker
 * 在獨立執行緒進行圖搜尋與路徑規劃，確保主遊戲畫面不發生任何微卡頓 (Jank)
 */

interface WorkerNode {
  id: number;
  x: number;
  z: number;
  edges: WorkerEdge[];
}

interface WorkerEdge {
  target: number;
  distance: number;
  cost: number;
  points: { x: number; z: number }[];
}

let graphNodes: WorkerNode[] = [];

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'INIT_GRAPH') {
    graphNodes = payload.nodes;
    self.postMessage({ type: 'GRAPH_READY', count: graphNodes.length });
  } else if (type === 'FIND_PATH') {
    const { startNodeId, endNodeId, startPt, endPt } = payload;
    const path = aStar(startNodeId, endNodeId);
    if (!path) {
      self.postMessage({ type: 'PATH_RESULT', route: null });
      return;
    }

    // 重組完整平滑折線
    const points: { x: number; z: number }[] = [startPt];
    let totalDist = 0;

    for (let i = 0; i < path.length - 1; i++) {
      const u = graphNodes[path[i]];
      const vId = path[i + 1];
      const edge = u.edges.find((e) => e.target === vId);
      if (edge && edge.points) {
        for (const p of edge.points) {
          points.push(p);
        }
        totalDist += edge.distance;
      } else {
        const v = graphNodes[vId];
        points.push({ x: v.x, z: v.z });
        totalDist += Math.hypot(v.x - u.x, v.z - u.z);
      }
    }
    points.push(endPt);

    self.postMessage({
      type: 'PATH_RESULT',
      route: {
        points,
        totalDistanceMeters: Math.round(totalDist),
        estimatedTimeSeconds: Math.round(totalDist / 1.4) // 預設步行速度
      }
    });
  }
};

function aStar(startId: number, goalId: number): number[] | null {
  if (!graphNodes[startId] || !graphNodes[goalId]) return null;

  const goalNode = graphNodes[goalId];
  const gScore = new Map<number, number>();
  const fScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();

  // 簡易最小堆疊
  const openSet: number[] = [startId];
  gScore.set(startId, 0);
  fScore.set(startId, Math.hypot(goalNode.x - graphNodes[startId].x, goalNode.z - graphNodes[startId].z));

  while (openSet.length > 0) {
    // 找出 fScore 最小之節點
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
      // 重建路徑
      const path = [currentId];
      let curr = currentId;
      while (cameFrom.has(curr)) {
        curr = cameFrom.get(curr)!;
        path.unshift(curr);
      }
      return path;
    }

    openSet.splice(lowestIdx, 1);
    const currNode = graphNodes[currentId];
    if (!currNode) continue;

    const currentG = gScore.get(currentId) ?? Infinity;

    for (const edge of currNode.edges) {
      const neighborId = edge.target;
      const neighborNode = graphNodes[neighborId];
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
