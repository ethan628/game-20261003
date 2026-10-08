/**
 * TrafficTypes.ts - NPC 交通與駕駛系統標準資料模型與型別定義
 * 注意：本模組遵循 RULES.md，嚴禁引用 Three.js，僅定義純資料結構與數學型別
 */

import { Point2D, StopLine } from './OsmTypes.ts';

export type VehicleType = 'sedan' | 'taxi' | 'scooter';

export type DriverPersonalityType = 'cautious' | 'normal' | 'hurried' | 'slow' | 'taxi';

export type DriverMood = 'calm' | 'annoyed' | 'angry';

export type SeatRole =
  | 'driver'
  | 'passenger_front'
  | 'passenger_rear_left'
  | 'passenger_rear_right'
  | 'passenger_rear';

export interface DriverAppearance {
  skinColorHex: string;
  shirtColorHex: string;
  hairColorHex: string;
  hatType: 'none' | 'cap' | 'helmet_half' | 'helmet_full' | 'helmet_worker';
  helmetColorHex: string;
  hasMask: boolean;
  hasRaincoat: boolean;
  raincoatColorHex: string;
}

export interface PassengerNPC {
  id: string;
  seat: SeatRole;
  appearance: DriverAppearance;
  headTurnAngle: number;
  isHoldingRider?: boolean;
}

export interface DriverNPC {
  id: string;
  appearance: DriverAppearance;
  personality: DriverPersonalityType;
  mood: DriverMood;
  moodScore: number;            // 0 ~ 100 分 (0~33 平靜, 34~66 煩躁, 67~100 生氣)
  vehicleId: string;
  seat: 'driver';
  passengers: PassengerNPC[];
  isEjected: boolean;
  pedestrianAgentId?: number;   // 轉為行人時對應之 ID

  // 喇叭與行為狀態
  honkCooldown: number;
  honkCountTotal: number;
  waitTimer: number;            // 被阻擋/紅燈停等計時 (s)
  isHonking: boolean;
  honkSoundTimer: number;

  // 動作狀態 (0~60m 啟用，由 Renderer 讀取)
  steeringAngle: number;        // 方向盤/雙手旋轉角 (rad)
  headTurnAngle: number;        // 頭部左右轉動角 (rad)
  lookPhoneTimer: number;       // 等紅燈低頭看手機計時 (s)
  leanAngle: number;            // 機車身身傾斜角 (rad)
  footDown: boolean;            // 機車停等單腳落地

  // 氣泡對話與大燈
  speechBubbleText?: string;
  speechBubbleTimer?: number;
  highBeamTimer?: number;       // 閃遠光燈計時 (s)
}

export interface AIVehicleControllerConfig {
  desiredSpeed: number;
  followDistance: number;
  reactionTime: number;
  runYellowChance: number;
  honkChance: number;
  stopForPedNear: boolean;
  flashHighBeams: boolean;
}

export type VehicleState =
  | 'DRIVING'
  | 'STOPPED_SIGNAL'
  | 'STOPPED_OBSTACLE'
  | 'STOPPED_PEDESTRIAN'
  | 'PICKING_UP'
  | 'DROPPING_OFF'
  | 'UNMANNED'
  | 'YIELDING_SIREN'
  | 'PULLING_OVER'
  | 'PULLED_OVER'
  | 'FLEEING';

export type TaxiServiceState =
  | 'EMPTY_CRUISING'
  | 'DECELERATING_PICKUP'
  | 'PASSENGER_BOARDING'
  | 'OCCUPIED_DRIVING'
  | 'DROPPING_OFF';

export interface TrafficVehicle {
  id: string;
  type: VehicleType;
  active: boolean;
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
  laneOffset: number;           // 靠右行駛之車道橫向偏移 (+ 或 -)
  laneIndex: number;            // 所在車道編號 (0: 內側, 1: 外側/次車道, 2: 機慢車道)
  isReverse: boolean;           // 是否依 OSM 逆向點列行駛

  // 狀態機
  state: VehicleState;
  stateTimer: number;
  blockedTimer: number;

  // 警察互動與避讓狀態
  isFleeing?: boolean;
  yieldResumeTimer?: number;
  targetedByPoliceId?: string;
  lastCitedTimestamp?: number;

  // 計程車專用載客狀態
  taxiState: TaxiServiceState;
  taxiPassengerId?: string;
  targetPedestrianId?: number;  // 叫車之行人 ID
  tripTimer: number;
  roofLightOn: boolean;         // 空車頂燈亮，載客熄滅

  // 燈光與視覺狀態
  brakeLightsOn: boolean;
  headlightsOn: boolean;
  highBeamsOn: boolean;
  turnSignal: 'none' | 'left' | 'right';
  turnSignalTimer: number;

  // 駕駛與乘客
  driver: DriverNPC;
  bodyColorHex: string;

  // 停止線與煞車停等 (單一資料來源)
  desiredStopGap?: number;             // 車頭目標停等間距 (0.5m ~ 1.0m)
  desiredQueueGap?: number;            // 排隊距前車車尾間距 (1.5m ~ 2.5m)
  targetStopLine?: StopLine;           // 目前面對之目標停止線
  frontBumperDistanceToLine?: number;  // 車頭距停止線之實測距離 (m)
  isLeadStoppedVehicle?: boolean;      // 是否為停在停止線第一位的領頭車
  queueLeadVehicleId?: string;         // 前方排隊領頭車 ID
  distanceToLeadVehicle?: number;      // 距前方排隊車輛之實測車距 (m)

  // 違規狀態與逆向檢測
  isViolator?: boolean;
  violationType?: 'early_red_run' | 'speeding' | 'press_crosswalk' | 'scooter_sidewalk' | 'none';
  violationTimer?: number;
  wrongWayTimer?: number;              // 累計 dot(車頭, 速度) < 0 時間 (s)
}

export interface StopLineMeasurement {
  vehicleId: string;
  vehicleType: VehicleType;
  intersectionId: string;
  approachId: string;
  isLeadVehicle: boolean;
  frontBumperDistanceToStopLine: number;
  targetStopLineType: 'car_stop_line' | 'scooter_box_line';
  status: 'compliant' | 'too_close' | 'line_pressed' | 'queueing';
  queueGapToLead?: number;
}

export interface StopLineStats {
  totalStopped: number;
  leadStoppedCount: number;
  compliantCount: number;
  compliantRate: number;
  tooCloseCount: number;
  pressedCount: number;
  pressedRate: number;
  averageDistanceToLine: number;
  measurements: StopLineMeasurement[];
}

export interface TrafficSystemStats {
  totalVehicles: number;
  totalDrivers: number;
  sedans: number;
  taxis: number;
  scooters: number;
  passengersCount: number;
  cautiousCount: number;
  normalCount: number;
  hurriedCount: number;
  slowCount: number;
  taxiDriverCount: number;
  calmMoodCount: number;
  annoyedMoodCount: number;
  angryMoodCount: number;
  honksThisFrame: number;
  totalHonks: number;
  wrongWayEvents: number;              // 逆向事件累計次數 (目標 0)
  headOppositeSpeedEvents: number;     // 車頭與速度相反事件累計次數 (目標 0)
  violationsCount: {
    earlyRedRun: number;
    speeding: number;
    pressCrosswalk: number;
    scooterSidewalk: number;
    total: number;
  };
  violationRatePercent: number;        // 違規比例 (目標約 5%)
  aiTimeMs: number;
  drawCalls: number;
}

export interface VehicleSamplingReport {
  samplingDurationSec: number;
  totalVehiclesSampled: number;
  averageSpeedKmh: number;
  wrongWayCount: number;               // 目標 0
  headOppositeSpeedCount: number;      // 目標 0
  violationsCount: {
    earlyRedRun: number;
    speeding: number;
    pressCrosswalk: number;
    scooterSidewalk: number;
    total: number;
  };
  violationRatePercent: number;        // 目標約 5%
  isCompliant: boolean;
}

