/**
 * PoliceTypes.ts - 警察執法系統資料模型與型別定義
 * 注意：本模組遵循 RULES.md，嚴禁引用 Three.js，僅定義純資料結構與數學型別
 */

import { Point2D } from '../../geo/OsmTypes.ts';

export type PoliceState =
  | 'PATROL'          // 常規巡邏
  | 'DETECTED'        // 發現違規 (反應時間 0.5~1.5s)
  | 'PURSUIT'         // 鳴笛追捕 (超速至1.4倍，A*路徑導航)
  | 'INTERCEPT'       // 追上後方12m內，命令靠邊停車
  | 'STOP_AND_CITE'   // 停妥開單 (警員下車抄寫 6~8s)
  | 'RETURN';         // 完成/放棄，回歸巡邏

export type ViolationActorType = 'vehicle' | 'pedestrian';

export interface ViolationEventData {
  actorType: ViolationActorType;
  id: string | number;
  violationType: string;
  position: Point2D;
  timestamp: number;
}

export interface PoliceOfficer {
  id: string;
  seat: 'driver' | 'passenger_front';
  isDismounted: boolean;
  x: number;
  y?: number;
  z: number;
  rotationY: number;
  writingTimer: number;
  uniformColorHex: string;  // 藍灰色制服 #3b5266
  pantsColorHex: string;    // 深藍長褲 #1e293b
  capColorHex: string;      // 大盤帽 #1e293b
}

export interface PoliceVehicle {
  id: string;
  active: boolean;
  licensePlate: string;     // 虛構車牌編號 (例: POL-01)
  x: number;
  y: number;
  z: number;
  rotationY: number;
  speed: number;
  targetSpeed: number;

  // 路網導航
  currentRoadId: string;
  roadPointIndex: number;
  targetPoint: Point2D;
  targetHeading: number;
  laneOffset: number;
  isReverse: boolean;

  // 狀態機
  state: PoliceState;
  stateTimer: number;
  reactionTimer: number;
  pursuitTimer: number;
  stuckTimer: number;

  // 追捕目標
  targetViolator: ViolationEventData | null;
  targetVehicleId?: string;
  targetPedestrianId?: number;
  predictedTarget?: Point2D;
  targetInvalidTimer: number;

  // A* 規劃路徑節點與路徑承諾
  pathWaypoints: Point2D[];
  pathIndex: number;
  lastReplanTime: number;
  lastReplanPos?: Point2D;
  pathCost?: number;
  pathHash?: string;
  committedSegmentIndex: number;

  // 轉向控制與抖動偵測 (Pure Pursuit)
  steeringAngle: number;
  targetSteeringAngle: number;
  steeringHeadingDiff: number;
  steeringFlips: Array<{ time: number; sign: number }>;
  jitterDetected: boolean;
  stuckReason?: string;

  // 位移監控 (6 秒位移檢查)
  stuckAnchorPos: Point2D;
  stuckDisplacementTimer: number;

  // 警員與警笛/警燈
  officers: PoliceOfficer[];
  sirenActive: boolean;
  sirenMode: 'wail' | 'yelp';
  lightbarPhase: number;    // 燈條閃爍相位 (0.0 ~ 1.0)
  wigWagPhase: number;      // 前後車燈交替閃爍相位
  speechBubbleText?: string;
  speechBubbleTimer?: number;

  // 攔截停靠位置錨定
  interceptAnchor?: {
    stopX: number;
    stopZ: number;
    heading: number;
  };
}

/**
 * 預留固定式執法照相機介面 (RULES.md 規範)
 */
export type CameraType = 'speed' | 'red_light';

export interface EnforcementCamera {
  id: string;
  type: CameraType;
  position: Point2D;
  headingRad: number;
  speedLimitMps?: number;
  intersectionId?: string;
  flashCooldown: number;
  citationsIssuedCount: number;
}

/**
 * 警察系統即時統計數據 (供 HUD 與 F15 面板使用)
 */
export interface PoliceStats {
  totalPoliceCars: number;
  activeCars: number;
  activePursuits: number;
  activePursuitsList?: Array<{ carId: string; targetId: string | number; remainingSec: number }>;
  citationsThisMinute: number;
  totalCitationsIssued: number;
  totalCitations: number;
  patrollingCount: number;
  patrollingCars: number;
  interceptingCount: number;
  citingCount: number;
  escapedCount: number;
  totalEscaped: number;
  abandonedCount: number;
  totalAbandoned: number;
  totalViolations: number;
  aiTimeMs: number;
  drawCalls: number;
}

/**
 * 60 秒執法抽樣評估報告
 */
export interface PoliceSamplingReport {
  samplingDurationSec: number;
  totalViolationsObserved: number;
  totalViolationsCommitted: number;
  detectedCount: number;
  policeDetectedCount: number;
  pursuitCount: number;
  pursuitsInitiatedCount: number;
  pursuitsStartedCount: number;        // 追捕開始次數
  validPursuitRatioPercent: number;    // 有效追捕比例
  interceptedCount: number;
  interceptedAndCitedCount: number;
  escapedCount: number;
  fledEscapedCount: number;
  abandonedCount: number;
  interceptRatePercent: number;        // 目標接近 90%
  interceptSuccessRatePercent: number;
  averageReactionTimeSec: number;      // 0.5~1.5s
  averageInterceptTimeSec: number;     // 從追捕到攔停平均秒數
  stuckEventsCount: number;            // 卡住次數 (目標 0)
  jitterEventsCount: number;           // 抖動事件次數 (目標 0)
  unstuckEventsCount: number;          // 脫困次數
  noTargetPursuitCount: number;        // 無目標追捕次數 (目標 0)
  collisionEventsCount: number;        // 追捕事故次數 (目標 0)
  isCompliant: boolean;
}
