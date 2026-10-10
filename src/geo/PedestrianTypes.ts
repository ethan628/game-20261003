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
  crossingId?: string;          // 對應之路口斑馬線 ID
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
  crossingId?: string;
  nodeIds: number[];
  center: Point2D;
  p1?: Point2D;
  p2?: Point2D;
  width?: number;
  length?: number;
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
  PANIC = 5,
  HAILING_TAXI = 6,
  KNOCKED_FLYING = 7,  // 被撞飛
  FALLEN = 8,          // 倒地
  GETTING_UP = 9,      // 起身中
  LEAVING_ROAD = 10    // 離開車道 (脫困中)
}

export interface PedestrianSystemStats {
  total: number;
  walking: number;
  idle: number;
  waiting: number;
  crossing: number;
  evading: number;
  panic: number;
  hailing?: number;
  specialStateCount: number;        // 特殊狀態行人數 (被撞飛/倒地/起身/離開車道)
  leaveRoadSuccessCount: number;    // 離開車道成功次數
  leaveRoadAvgDurationSec: number;  // 離開車道平均耗時 (目標 < 8s)
  leaveRoadFailCount: number;       // 離開車道失敗次數 (目標 0)
  returnToSidewalkRatioPercent: number; // 被撞後回到人行道比例 (目標 100%)
  outOfBoundsEventsCount: number;   // 越界事件 (目標 0)
  crowdedCount: number;             // 1.2m 內有 2 位以上非同伴
  crowdedRatePercent: number;       // 聚集比例 (目標 < 3%)
  crossingsTotal: number;           // 過街總次數
  crossingsOnZebra: number;         // 經斑馬線次數
  crossingsViolations: number;      // 違規過街次數
  backwardsWalkCount: number;       // 倒退走行人數 (目標 0)
  violationsCount: {
    jaywalkRed: number;
    crossNoZebra: number;
    walkRoadEdge: number;
    total: number;
  };
  violationRatePercent: number;     // 違規比例 (目標約 5~8%)
  aiTimeMs: number;
  drawCalls: number;
}

export interface PedestrianSamplingReport {
  samplingDurationSec: number;
  totalPedestriansSampled: number;
  specialStatePedestriansCount: number; // 特殊狀態行人數
  leaveRoadSuccessCount: number;        // 離開車道成功次數
  leaveRoadAvgDurationSec: number;      // 離開車道平均耗時 (目標 < 8s)
  leaveRoadFailCount: number;           // 離開車道失敗次數 (目標 0)
  returnToSidewalkRatioPercent: number; // 回到人行道比例 (目標 100%)
  outOfBoundsEventsCount: number;       // 越界事件數 (目標 0)
  backwardsCount: number;               // 目標 0
  crowdedRatePercent: number;           // 目標 < 3%
  crowdedEventsCount: number;           // 聚集事件數
  zebraComplianceRatePercent: number;   // 守規過街經斑馬線比例 (目標 100%)
  crossingsTotal: number;
  crossingsOnZebra: number;
  crossingsViolations: number;
  violationsCount: {
    jaywalkRed: number;
    crossNoZebra: number;
    walkRoadEdge: number;
    total: number;
  };
  violationRatePercent: number;         // 目標約 5~8%
  isCompliant: boolean;
}

