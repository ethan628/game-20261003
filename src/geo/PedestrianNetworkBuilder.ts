/**
 * PedestrianNetworkBuilder.ts - 行人路網拓撲圖建構器
 * 依據 RULES.md，本模組嚴禁引用 Three.js，僅執行純幾何運算
 * 職責：
 * 1. 沿一般道路兩側內縮/外推計算雙向人行道折線
 * 2. 直接納入 footway, pedestrian, path, steps, living_street 純人行路段
 * 3. 沿騎樓建築臨街外廊建立騎樓下通道
 * 4. 於道路交叉口及路緣建立斑馬線過街邊 (Crosswalk Edges)
 * 5. 結合周邊車站、溫泉、商店資料計算各節點之人口密度權重
 */

import { Point2D, RoadFeature, BuildingFeature, ShopFeature } from './OsmTypes.ts';
import { PedestrianNode, PedestrianNetworkData, CrosswalkGroup } from './PedestrianTypes.ts';
import { CONFIG } from '../config.ts';

export class PedestrianNetworkBuilder {
  /**
   * 建構完整行人路網
   */
  public static buildNetwork(
    roads: RoadFeature[],
    buildings: BuildingFeature[] = [],
    shops: ShopFeature[] = []
  ): PedestrianNetworkData {
    const nodes: PedestrianNode[] = [];
    const SNAP_TOLERANCE = 1.6; // 1.6 公尺內吸附合併頂點
    const grid = new Map<string, number>();

    const getOrAddNode = (
      pt: Point2D,
      isCrosswalk = false,
      isArcade = false,
      crosswalkGroupId?: number
    ): number => {
      const gx = Math.round(pt.x / SNAP_TOLERANCE);
      const gz = Math.round(pt.z / SNAP_TOLERANCE);
      const key = `${gx}_${gz}`;

      const existingId = grid.get(key);
      if (existingId !== undefined) {
        const node = nodes[existingId];
        if (isCrosswalk) node.isCrosswalk = true;
        if (isArcade) node.isArcade = true;
        if (crosswalkGroupId !== undefined) node.crosswalkGroupId = crosswalkGroupId;
        return existingId;
      }

      const id = nodes.length;
      nodes.push({
        id,
        x: pt.x,
        z: pt.z,
        isCrosswalk,
        crosswalkGroupId,
        isArcade,
        densityWeight: 1.0,
        edges: []
      });
      grid.set(key, id);
      return id;
    };

    const addEdge = (from: number, to: number, type: 'sidewalk' | 'arcade' | 'crosswalk' | 'path') => {
      if (from === to) return;
      const nFrom = nodes[from];
      const nTo = nodes[to];
      const dist = Math.hypot(nTo.x - nFrom.x, nTo.z - nFrom.z);
      if (dist < 0.1) return;

      // 檢查是否已存在邊，避免重複
      if (!nFrom.edges.some((e) => e.target === to)) {
        nFrom.edges.push({
          target: to,
          distance: dist,
          type,
          isCrosswalk: type === 'crosswalk'
        });
      }
      if (!nTo.edges.some((e) => e.target === from)) {
        nTo.edges.push({
          target: from,
          distance: dist,
          type,
          isCrosswalk: type === 'crosswalk'
        });
      }
    };

    // 1. 解析道路人行道
    const crosswalkGroups: CrosswalkGroup[] = [];
    let nextCrosswalkGroupId = 1;

    for (const road of roads) {
      if (road.isRailway || road.points.length < 2) continue;

      const isPedestrianOnly = [
        'footway', 'pedestrian', 'path', 'steps', 'living_street', 'cycleway'
      ].includes(road.type);

      if (isPedestrianOnly) {
        // 純步行道：細分過長折線 (每 10~12m 一點)
        const subPts: Point2D[] = [];
        for (let i = 0; i < road.points.length; i++) {
          const p1 = road.points[i];
          subPts.push(p1);
          if (i < road.points.length - 1) {
            const p2 = road.points[i + 1];
            const dist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
            if (dist > 14.0) {
              const steps = Math.ceil(dist / 12.0);
              for (let s = 1; s < steps; s++) {
                const t = s / steps;
                subPts.push({
                  x: p1.x + (p2.x - p1.x) * t,
                  z: p1.z + (p2.z - p1.z) * t
                });
              }
            }
          }
        }

        let prevNode = -1;
        for (const pt of subPts) {
          const currNode = getOrAddNode(pt, false, false);
          if (prevNode !== -1) {
            addEdge(prevNode, currNode, 'path');
          }
          prevNode = currNode;
        }
      } else {
        // 車輛與行人共用道路：先將長折線均勻細分 (每 10~12m 一點)，確保沿途人行道有足夠節點
        const subRoadPts: Point2D[] = [];
        for (let i = 0; i < road.points.length; i++) {
          const p1 = road.points[i];
          subRoadPts.push(p1);
          if (i < road.points.length - 1) {
            const p2 = road.points[i + 1];
            const dist = Math.hypot(p2.x - p1.x, p2.z - p1.z);
            if (dist > 14.0) {
              const steps = Math.ceil(dist / 12.0);
              for (let s = 1; s < steps; s++) {
                const t = s / steps;
                subRoadPts.push({
                  x: p1.x + (p2.x - p1.x) * t,
                  z: p1.z + (p2.z - p1.z) * t
                });
              }
            }
          }
        }

        const halfWidth = Math.max(2.5, road.width * 0.5);
        const offsetDist = halfWidth + Math.max(1.0, road.sidewalkWidth > 0 ? road.sidewalkWidth * 0.5 : 1.2);

        const leftPts: Point2D[] = [];
        const rightPts: Point2D[] = [];

        for (let i = 0; i < subRoadPts.length; i++) {
          const p = subRoadPts[i];
          let dirX = 0;
          let dirZ = 0;

          if (i === 0) {
            const next = subRoadPts[1];
            dirX = next.x - p.x;
            dirZ = next.z - p.z;
          } else if (i === subRoadPts.length - 1) {
            const prev = subRoadPts[i - 1];
            dirX = p.x - prev.x;
            dirZ = p.z - prev.z;
          } else {
            const prev = subRoadPts[i - 1];
            const next = subRoadPts[i + 1];
            dirX = next.x - prev.x;
            dirZ = next.z - prev.z;
          }

          const len = Math.hypot(dirX, dirZ) || 1;
          const normX = -dirZ / len;
          const normZ = dirX / len;

          leftPts.push({ x: p.x - normX * offsetDist, z: p.z - normZ * offsetDist });
          rightPts.push({ x: p.x + normX * offsetDist, z: p.z + normZ * offsetDist });
        }

        // 建立左側人行道邊
        let prevLeft = -1;
        const leftNodeIds: number[] = [];
        for (const pt of leftPts) {
          const curr = getOrAddNode(pt, false, false);
          leftNodeIds.push(curr);
          if (prevLeft !== -1) {
            addEdge(prevLeft, curr, 'sidewalk');
          }
          prevLeft = curr;
        }

        // 建立右側人行道邊
        let prevRight = -1;
        const rightNodeIds: number[] = [];
        for (const pt of rightPts) {
          const curr = getOrAddNode(pt, false, false);
          rightNodeIds.push(curr);
          if (prevRight !== -1) {
            addEdge(prevRight, curr, 'sidewalk');
          }
          prevRight = curr;
        }

        // 在道路端點與中段適當距離 (約每 50~70m) 建立過街斑馬線邊
        const segSteps = Math.max(5, Math.floor(subRoadPts.length / 4));
        for (let i = 0; i < subRoadPts.length; i += segSteps) {
          const leftNode = leftNodeIds[i];
          const rightNode = rightNodeIds[i];
          if (leftNode !== undefined && rightNode !== undefined && leftNode !== rightNode) {
            const groupId = nextCrosswalkGroupId++;
            nodes[leftNode].isCrosswalk = true;
            nodes[leftNode].crosswalkGroupId = groupId;
            nodes[rightNode].isCrosswalk = true;
            nodes[rightNode].crosswalkGroupId = groupId;

            addEdge(leftNode, rightNode, 'crosswalk');

            crosswalkGroups.push({
              id: groupId,
              nodeIds: [leftNode, rightNode],
              center: {
                x: (nodes[leftNode].x + nodes[rightNode].x) * 0.5,
                z: (nodes[leftNode].z + nodes[rightNode].z) * 0.5
              }
            });
          }
        }
      }
    }

    // 2. 騎樓走道納入行人路網
    for (const bldg of buildings) {
      if (!bldg.footprint || bldg.footprint.length < 3) continue;

      // 若建築標記有騎樓，或臨近商業街道 (依樓層與高度特徵)
      const isLikelyArcade = bldg.levels >= 3 && bldg.height >= 9.0;
      if (isLikelyArcade) {
        // 取臨街較長的一條邊建立騎樓步道
        for (let i = 0; i < bldg.footprint.length - 1; i++) {
          const p1 = bldg.footprint[i];
          const p2 = bldg.footprint[i + 1];
          const edgeLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
          if (edgeLen >= 6.0 && edgeLen <= 25.0) {
            // 向建築內部內縮 1.2m
            const midX = (p1.x + p2.x) * 0.5;
            const midZ = (p1.z + p2.z) * 0.5;
            const toCenterX = bldg.center.x - midX;
            const toCenterZ = bldg.center.z - midZ;
            const cLen = Math.hypot(toCenterX, toCenterZ) || 1;

            const arcadePt1: Point2D = {
              x: p1.x + (toCenterX / cLen) * 1.2,
              z: p1.z + (toCenterZ / cLen) * 1.2
            };
            const arcadePt2: Point2D = {
              x: p2.x + (toCenterX / cLen) * 1.2,
              z: p2.z + (toCenterZ / cLen) * 1.2
            };

            const aNode1 = getOrAddNode(arcadePt1, false, true);
            const aNode2 = getOrAddNode(arcadePt2, false, true);
            addEdge(aNode1, aNode2, 'arcade');

            // 吸附連通至最近的人行道節點
            this.connectToNearestSidewalk(nodes, aNode1, 4.0, addEdge);
            this.connectToNearestSidewalk(nodes, aNode2, 4.0, addEdge);
            break;
          }
        }
      }
    }

    // 3. 結合 OSM 資料計算每個節點的密度權重 (Density Map)
    this.calculateDensityWeights(nodes, shops);

    // 計算總邊數
    let totalEdges = 0;
    for (const n of nodes) {
      totalEdges += n.edges.length;
    }

    console.log(
      `[PedestrianNetworkBuilder] 行人路網建立完成：節點數 ${nodes.length} 個，邊數 ${Math.round(totalEdges * 0.5)} 條，過街路口 ${crosswalkGroups.length} 處`
    );

    return {
      nodes,
      crosswalkGroups,
      totalEdgesCount: Math.round(totalEdges * 0.5),
      generatedAt: Date.now()
    };
  }

  /**
   * 將騎樓通道端點連通至臨近人行道節點
   */
  private static connectToNearestSidewalk(
    nodes: PedestrianNode[],
    targetNodeId: number,
    maxDist: number,
    addEdge: (from: number, to: number, type: 'sidewalk' | 'arcade' | 'crosswalk' | 'path') => void
  ): void {
    const target = nodes[targetNodeId];
    let bestDist = Infinity;
    let bestNode = -1;

    for (const n of nodes) {
      if (n.id === targetNodeId || n.isArcade) continue;
      const d = Math.hypot(n.x - target.x, n.z - target.z);
      if (d < bestDist && d <= maxDist) {
        bestDist = d;
        bestNode = n.id;
      }
    }

    if (bestNode !== -1) {
      addEdge(targetNodeId, bestNode, 'arcade');
    }
  }

  /**
   * 計算各節點的人口密度權重 (Density Weights)
   */
  private static calculateDensityWeights(nodes: PedestrianNode[], shops: ShopFeature[]): void {
    const cfg = CONFIG.PEDESTRIAN.DENSITY;

    // 預設火車站中心大致在 (0, 0)
    for (const node of nodes) {
      let weight = cfg.RESIDENTIAL_FACTOR; // 基準 1.0

      const distToCenter = Math.hypot(node.x, node.z);
      if (distToCenter < cfg.STATION_RADIUS) {
        // 火車站周邊高密度
        weight = Math.max(weight, cfg.STATION_FACTOR);
      }

      // 檢查附近 45 公尺內店家
      let nearbyShops = 0;
      let hasHotSpring = false;

      for (const s of shops) {
        const d = Math.hypot(s.point.x - node.x, s.point.z - node.z);
        if (d < 45.0) {
          nearbyShops++;
          if (
            s.name.includes('溫泉') ||
            s.name.includes('湯') ||
            s.subCategory === 'hotel' ||
            s.category === 'tourism'
          ) {
            hasHotSpring = true;
          }
        }
      }

      if (hasHotSpring) {
        weight = Math.max(weight, cfg.HOT_SPRING_FACTOR);
      } else if (nearbyShops >= 4) {
        weight = Math.max(weight, cfg.COMMERCIAL_FACTOR);
      } else if (distToCenter > 380) {
        // 遠離市區田野區域
        weight = cfg.RURAL_FACTOR;
      }

      node.densityWeight = weight;
    }
  }
}
