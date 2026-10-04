/**
 * PedestrianTypes.ts - 行人系統標準資料模型與型別定義
 * 注意：本模組遵循 RULES.md，嚴禁引用 Three.js，僅定義純資料結構
 */

import { Point2D } from './OsmTypes.ts';

export type PedestrianPathType = 'sidewalk' | 'arcade' | 'crosswalk' | 'path';

export interface PedestrianEdge {
  target: number;               // 目標節點 ID
  distance: number;             // 邊距離 (公尺)
  type: PedestrianPathType;     // 路徑類型
  isCrosswalk?: boolean;        // 是否為斑馬線過街邊
}

export interface PedestrianNode {
  id: number;
  x: number;                    // 局部公尺座標 (+X 東)
  z: number;                    // 局部公尺座標 (+Z 南, -Z 北)
  isCrosswalk?: boolean;        // 是否為過街等候/通行節點
  crosswalkGroupId?: number;    // 所屬路口/斑馬線分組 ID
  isArcade?: boolean;           // 是否位於騎樓下
  isShopEntrance?: boolean;     // 是否臨近店家門口
  densityWeight: number;        // 人口密度權重倍率 (如火車站 2.5, 溫泉街 2.0, 田野 0.25)
  edges: PedestrianEdge[];
}

export interface CrosswalkGroup {
  id: number;
  nodeIds: number[];
  center: Point2D;
}

export interface PedestrianNetworkData {
  nodes: PedestrianNode[];
  crosswalkGroups: CrosswalkGroup[];
  totalEdgesCount: number;
  generatedAt: number;
}

export enum PedestrianState {
  WALKING = 0,
  IDLE = 1,
  WAITING_CROSSWALK = 2,
  CROSSING = 3,
  EVADING = 4,
  PANIC = 5
}

export interface PedestrianSystemStats {
  total: number;
  walking: number;
  idle: number;
  waiting: number;
  crossing: number;
  evading: number;
  panic: number;
  aiTimeMs: number;
  drawCalls: number;
}
