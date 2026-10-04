/**
 * TrafficIntersectionBuilder.ts - 路口辨識、方位角分析與號誌拓撲建構器
 * 依據 RULES.md，本模組嚴禁引用 Three.js，僅執行純幾何運算
 * 職責：
 * 1. 從道路路網中找出度數 >= 3 的節點與交叉點
 * 2. 把 30 公尺內的多個號誌點與鄰近交會節點歸為同一個路口
 * 3. 記錄各條進入道路 (approach) 的方位角、寬度、停止線與機車待轉區
 * 4. 方位角劃分雙相位群組 (Group A 主幹/南北向 vs Group B 次要/東西向)
 * 5. 無 OSM 號誌資料之路口，若兩條主要道路相交自動補上號誌 (標記 osm 或 auto)
 * 6. 生成懸臂式號誌桿之位置與朝向
 */

import { Point2D, RoadFeature, TrafficSignalFeature, IntersectionFeature, IntersectionApproach, IntersectionCrossing, TrafficSignalPoleConfig, SignalPhaseGroup } from './OsmTypes.ts';
import { CONFIG } from '../config.ts';

const MAJOR_ROAD_TYPES = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link'
]);

export class TrafficIntersectionBuilder {
  /**
   * 建構完整路口與號誌資料集合
   */
  public static buildIntersections(
    roads: RoadFeature[],
    rawSignals: TrafficSignalFeature[] = []
  ): IntersectionFeature[] {
    const cfg = CONFIG.TRAFFIC_SIGNALS;
    const clusterRadius = cfg.INTERSECTION_CLUSTER_RADIUS || 30.0;

    // 1. 抽取道路交叉點與端點候選
    const rawNodes = this.extractIntersectionNodes(roads);
    if (rawNodes.length === 0 && rawSignals.length === 0) {
      return [];
    }

    // 2. 空間聚類：30 公尺內的交叉節點與號誌點歸入同一路口
    const clusters = this.clusterNodesAndSignals(rawNodes, rawSignals, clusterRadius);

    // 3. 針對每個聚類構建路口特性 (Approaches, Phases, Crossings, Poles)
    const intersections: IntersectionFeature[] = [];
    let interIdx = 0;

    for (const cluster of clusters) {
      const id = `inter_${interIdx++}`;
      const center = cluster.center;
      const radius = Math.max(12.0, Math.min(32.0, cluster.radius + 5.0));

      // 提取進入路口的各條道路 (approach)
      const approaches = this.extractApproaches(id, center, radius, roads);

      // 如果進入道路小於 2 條，不足以構成路口
      if (approaches.length < 2) continue;

      // 方位角雙相位分配 (Group A vs Group B)
      this.assignSignalPhaseGroups(approaches);

      // 行人穿越道關聯 (Crossings)
      const crossings = this.buildCrossings(id, center, radius, approaches);

      // 號誌來源與設置判定 (OSM 或 Auto 自動補齊)
      const hasOsmSignals = cluster.signalIds.length > 0;
      let hasSignals = hasOsmSignals;
      let source: 'osm' | 'auto' = hasOsmSignals ? 'osm' : 'auto';

      if (!hasSignals) {
        // 規則：兩條主要道路 (primary、secondary、tertiary) 相交，自動補上號誌
        const majorApproaches = approaches.filter((a) => MAJOR_ROAD_TYPES.has(a.roadType));
        const distinctMajorRoads = new Set(majorApproaches.map((a) => a.roadName || a.roadType));
        if (distinctMajorRoads.size >= 2 || majorApproaches.length >= 3) {
          hasSignals = true;
          source = 'auto';
        } else if (approaches.length >= 4 && approaches.some((a) => MAJOR_ROAD_TYPES.has(a.roadType))) {
          // 4 岔路口且有主要道路穿過
          hasSignals = true;
          source = 'auto';
        }
      }

      // 生成懸臂式號誌桿配置 (台灣風格路口轉角立桿)
      const poles = hasSignals ? this.generatePoleConfigs(id, center, approaches, crossings) : [];

      intersections.push({
        id,
        center,
        radius,
        source,
        hasSignals,
        approaches,
        crossings,
        poles,
        osmSignalIds: cluster.signalIds
      });
    }

    console.log(
      `[TrafficIntersectionBuilder] 路口辨識完成：共 ${intersections.length} 處路口，其中 ${
        intersections.filter((i) => i.hasSignals).length
      } 處設有號誌 (OSM標註: ${intersections.filter((i) => i.source === 'osm').length} 處，自動補齊: ${
        intersections.filter((i) => i.source === 'auto').length
      } 處)`
    );

    return intersections;
  }

  /**
   * 收集道路交點
   */
  private static extractIntersectionNodes(roads: RoadFeature[]): Array<{ pt: Point2D; roadId: string; roadType: string }> {
    const rawNodes: Array<{ pt: Point2D; roadId: string; roadType: string }> = [];

    for (const r of roads) {
      if (r.isRailway || r.points.length < 2) continue;
      // 納入所有端點與折線節點
      rawNodes.push({ pt: r.points[0], roadId: r.id, roadType: r.type });
      rawNodes.push({ pt: r.points[r.points.length - 1], roadId: r.id, roadType: r.type });

      // 對於主要道路，每間隔取點
      for (let i = 1; i < r.points.length - 1; i += 2) {
        rawNodes.push({ pt: r.points[i], roadId: r.id, roadType: r.type });
      }
    }

    return rawNodes;
  }

  /**
   * 聚類半徑 30m 內的交叉節點與號誌點
   */
  private static clusterNodesAndSignals(
    rawNodes: Array<{ pt: Point2D; roadId: string; roadType: string }>,
    rawSignals: TrafficSignalFeature[],
    clusterRadius: number
  ): Array<{ center: Point2D; radius: number; signalIds: string[] }> {
    // 找出交會度數 >= 3 的節點中心
    const intersectionSeeds: Array<{ pt: Point2D; signalId?: string }> = [];

    // 先以 OSM 號誌點為種子
    for (const sig of rawSignals) {
      intersectionSeeds.push({ pt: sig.point, signalId: sig.id });
    }

    // 尋找度數 >= 3 的道路交點
    const SNAP = 5.0;
    const grid = new Map<string, Array<{ roadId: string; pt: Point2D }>>();

    for (const node of rawNodes) {
      const gx = Math.round(node.pt.x / SNAP);
      const gz = Math.round(node.pt.z / SNAP);
      const k = `${gx}_${gz}`;
      let list = grid.get(k);
      if (!list) {
        list = [];
        grid.set(k, list);
      }
      list.push({ roadId: node.roadId, pt: node.pt });
    }

    for (const [, list] of grid.entries()) {
      const distinctRoads = new Set(list.map((item) => item.roadId));
      if (distinctRoads.size >= 2 || list.length >= 3) {
        const avgX = list.reduce((s, item) => s + item.pt.x, 0) / list.length;
        const avgZ = list.reduce((s, item) => s + item.pt.z, 0) / list.length;
        intersectionSeeds.push({ pt: { x: avgX, z: avgZ } });
      }
    }

    // 聚類融合 30m 範圍內的種子
    const clusters: Array<{ center: Point2D; radius: number; signalIds: string[] }> = [];
    const used = new Set<number>();

    for (let i = 0; i < intersectionSeeds.length; i++) {
      if (used.has(i)) continue;
      used.add(i);

      const group = [intersectionSeeds[i]];
      const sigIds: string[] = [];
      if (intersectionSeeds[i].signalId) sigIds.push(intersectionSeeds[i].signalId!);

      for (let j = i + 1; j < intersectionSeeds.length; j++) {
        if (used.has(j)) continue;
        const d = Math.hypot(intersectionSeeds[i].pt.x - intersectionSeeds[j].pt.x, intersectionSeeds[i].pt.z - intersectionSeeds[j].pt.z);
        if (d <= clusterRadius) {
          used.add(j);
          group.push(intersectionSeeds[j]);
          if (intersectionSeeds[j].signalId) sigIds.push(intersectionSeeds[j].signalId!);
        }
      }

      const cX = group.reduce((s, g) => s + g.pt.x, 0) / group.length;
      const cZ = group.reduce((s, g) => s + g.pt.z, 0) / group.length;
      let maxDist = 8.0;
      for (const g of group) {
        maxDist = Math.max(maxDist, Math.hypot(g.pt.x - cX, g.pt.z - cZ));
      }

      clusters.push({
        center: { x: cX, z: cZ },
        radius: maxDist,
        signalIds: sigIds
      });
    }

    return clusters;
  }

  /**
   * 識別並計算各進入道路 (Approach) 之方位角與停止線
   */
  private static extractApproaches(
    interId: string,
    center: Point2D,
    radius: number,
    roads: RoadFeature[]
  ): IntersectionApproach[] {
    const rawApproaches: Array<{
      road: RoadFeature;
      azimuthRad: number;
      entryPoint: Point2D;
    }> = [];

    for (const r of roads) {
      if (r.isRailway || r.points.length < 2) continue;

      for (let i = 0; i < r.points.length - 1; i++) {
        const p1 = r.points[i];
        const p2 = r.points[i + 1];

        const d1 = Math.hypot(p1.x - center.x, p1.z - center.z);
        const d2 = Math.hypot(p2.x - center.x, p2.z - center.z);

        // 線段跨越路口邊界 (一端在內，一端在外)
        if ((d1 <= radius && d2 > radius) || (d2 <= radius && d1 > radius)) {
          // 外端點與內端點
          const ptOutside = d1 > radius ? p1 : p2;
          const ptInside = d1 > radius ? p2 : p1;

          // 車流進入路口向量 (從外指向內)
          const dirX = ptInside.x - ptOutside.x;
          const dirZ = ptInside.z - ptOutside.z;
          const len = Math.hypot(dirX, dirZ) || 1;

          // 方位角：車流指向 (-PI ~ PI)
          const azimuthRad = Math.atan2(dirX, dirZ);

          // 停止線所在交界點 (路口邊界內縮 1.5m)
          const entryPoint: Point2D = {
            x: center.x - (dirX / len) * (radius - 1.5),
            z: center.z - (dirZ / len) * (radius - 1.5)
          };

          rawApproaches.push({ road: r, azimuthRad, entryPoint });
        }
      }
    }

    // 合併同向接近道路 (角度差 < 25度 且 同一路名/寬度)
    const approaches: IntersectionApproach[] = [];
    const used = new Set<number>();

    for (let i = 0; i < rawApproaches.length; i++) {
      if (used.has(i)) continue;
      used.add(i);

      const a1 = rawApproaches[i];
      let bestWidth = a1.road.width;
      let bestName = a1.road.name || '街道';
      let bestType = a1.road.type;
      let avgAzimuth = a1.azimuthRad;
      let count = 1;

      for (let j = i + 1; j < rawApproaches.length; j++) {
        if (used.has(j)) continue;
        const a2 = rawApproaches[j];
        let diff = Math.abs(a1.azimuthRad - a2.azimuthRad);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;

        if (diff < 0.42 && (a1.road.name === a2.road.name || !a1.road.name)) {
          used.add(j);
          avgAzimuth += a2.azimuthRad;
          count++;
          bestWidth = Math.max(bestWidth, a2.road.width);
        }
      }

      avgAzimuth /= count;

      // 計算停止線幾何 (寬度垂直方向)
      const forwardX = Math.sin(avgAzimuth);
      const forwardZ = Math.cos(avgAzimuth);
      const rightX = -forwardZ;
      const rightZ = forwardX;

      const halfW = Math.max(2.5, bestWidth * 0.5);
      const stopLineP1: Point2D = {
        x: a1.entryPoint.x - rightX * halfW,
        z: a1.entryPoint.z - rightZ * halfW
      };
      const stopLineP2: Point2D = {
        x: a1.entryPoint.x + rightX * (halfW * 0.1), // 劃在右側進路車道
        z: a1.entryPoint.z + rightZ * (halfW * 0.1)
      };

      // 機車待轉區 (停止線前方 1.8m)
      const waitCenter: Point2D = {
        x: a1.entryPoint.x + forwardX * 2.0 + rightX * (halfW * 0.5),
        z: a1.entryPoint.z + forwardZ * 2.0 + rightZ * (halfW * 0.5)
      };

      approaches.push({
        id: `${interId}_app_${approaches.length}`,
        roadName: bestName,
        roadType: bestType,
        azimuthRad: avgAzimuth,
        width: bestWidth,
        entryPoint: a1.entryPoint,
        stopLineP1,
        stopLineP2,
        waitingBoxCenter: waitCenter,
        signalGroup: 'A' // 稍後分派
      });
    }

    return approaches;
  }

  /**
   * 方位角雙相位分配 (Group A 主幹道/南北向 vs Group B 次要道/東西向)
   */
  private static assignSignalPhaseGroups(approaches: IntersectionApproach[]): void {
    if (approaches.length === 0) return;

    // 優先以主要道路為基準軸心，若無則以第一條 approach 為基準
    let baseIdx = 0;
    for (let i = 0; i < approaches.length; i++) {
      if (MAJOR_ROAD_TYPES.has(approaches[i].roadType)) {
        baseIdx = i;
        break;
      }
    }

    const baseAngle = approaches[baseIdx].azimuthRad;

    for (let i = 0; i < approaches.length; i++) {
      const app = approaches[i];
      let diff = Math.abs(app.azimuthRad - baseAngle);
      while (diff > Math.PI) diff = Math.PI * 2 - diff;

      // 與基準軸共線或反向 (角度差 <= 48度 或 >= 132度) 歸為 Group A
      if (diff <= (48 * Math.PI / 180) || diff >= (132 * Math.PI / 180)) {
        app.signalGroup = 'A';
      } else {
        app.signalGroup = 'B';
      }
    }
  }

  /**
   * 建立路口斑馬線穿越道 (Crossings)
   */
  private static buildCrossings(
    interId: string,
    _center: Point2D,
    _radius: number,
    approaches: IntersectionApproach[]
  ): IntersectionCrossing[] {
    const crossings: IntersectionCrossing[] = [];

    for (let i = 0; i < approaches.length; i++) {
      const app = approaches[i];
      const forwardX = Math.sin(app.azimuthRad);
      const forwardZ = Math.cos(app.azimuthRad);
      const rightX = -forwardZ;
      const rightZ = forwardX;

      const halfW = Math.max(3.0, app.width * 0.5 + 1.2);
      // 穿越道設在停止線前方約 1.2m
      const cMid: Point2D = {
        x: app.entryPoint.x + forwardX * 1.2,
        z: app.entryPoint.z + forwardZ * 1.2
      };

      const p1: Point2D = {
        x: cMid.x - rightX * halfW,
        z: cMid.z - rightZ * halfW
      };
      const p2: Point2D = {
        x: cMid.x + rightX * halfW,
        z: cMid.z + rightZ * halfW
      };

      // 關鍵連動：車輛群組 A 綠燈時，與 A 車流「垂直」的穿越道為綠燈 (即跨越 Group B 道路之穿越道)
      // 因此跨越 Group A 車道的穿越道，其通行相位為 Group B！
      const crossingGroup: SignalPhaseGroup = app.signalGroup === 'A' ? 'B' : 'A';

      const crossId = `${interId}_cross_${i}`;
      app.pedestrianCrossingId = crossId;

      crossings.push({
        id: crossId,
        p1,
        p2,
        center: cMid,
        width: halfW * 2,
        signalGroup: crossingGroup
      });
    }

    return crossings;
  }

  /**
   * 生成懸臂式號誌桿之位置與朝向 (台灣風格立桿)
   */
  private static generatePoleConfigs(
    interId: string,
    _center: Point2D,
    approaches: IntersectionApproach[],
    _crossings: IntersectionCrossing[]
  ): TrafficSignalPoleConfig[] {
    const poles: TrafficSignalPoleConfig[] = [];

    for (let i = 0; i < approaches.length; i++) {
      const app = approaches[i];
      const forwardX = Math.sin(app.azimuthRad);
      const forwardZ = Math.cos(app.azimuthRad);
      const rightX = -forwardZ;
      const rightZ = forwardX;

      const halfW = Math.max(2.5, app.width * 0.5);
      // 桿身立於右側人行道邊緣角隅
      const polePos: Point2D = {
        x: app.entryPoint.x + rightX * (halfW + 1.6) - forwardX * 0.5,
        z: app.entryPoint.z + rightZ * (halfW + 1.6) - forwardZ * 0.5
      };

      // 橫臂伸向車道上方 (沿 -right 向量延伸)
      const armAzimuth = Math.atan2(-rightX, -rightZ);

      poles.push({
        id: `${interId}_pole_${i}`,
        position: polePos,
        armAzimuthRad: armAzimuth,
        approachId: app.id,
        signalGroup: app.signalGroup,
        hasSecondaryHead: app.width >= 7.5,
        hasPedSignal: true,
        hasCountdown: true
      });
    }

    return poles;
  }
}
