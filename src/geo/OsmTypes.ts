/**
 * OsmTypes.ts - 地理模組標準化資料型別
 * 注意：本模組嚴禁依賴 Three.js，僅定義純幾何與屬性資料結構
 */

export interface Point2D {
  x: number; // 局部公尺座標 (東向為 +X)
  z: number; // 局部公尺座標 (南向為 +Z，北向為 -Z)
}

export interface RoadFeature {
  id: string;
  type: string;
  name?: string;
  points: Point2D[];
  width: number;
  sidewalkWidth: number;
  oneway?: boolean | number;
  isRailway?: boolean;
}

export interface BuildingCollisionData {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  footprint: Point2D[];
  height: number;
}

export type BuildingHeightSource = 'override' | 'osm' | 'external' | 'estimated';
export type BuildingRoofShape = 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'skillion';

export interface BuildingSourceStats {
  override: number;
  osm: number;
  external: number;
  estimated: number;
  total: number;
  estimatedAvgLevels: number;
  osmCount: number;
  osmPercent: number;
  externalCount: number;
  externalPercent: number;
  overrideCount: number;
  overridePercent: number;
  estimatedCount: number;
  estimatedPercent: number;
}

export interface BuildingOverrideData {
  levels?: number;
  height?: number;
  roofShape?: BuildingRoofShape;
  minHeight?: number;
  note?: string;
}

export interface BuildingOverridesFile {
  byOsmId: Record<string, BuildingOverrideData>;
  byCoord: Array<{
    lat: number;
    lon: number;
    levels?: number;
    height?: number;
    roofShape?: BuildingRoofShape;
    note?: string;
  }>;
}

export interface BuildingFeature {
  id: string;
  type: string;
  name?: string;
  height: number;
  levels: number;
  minHeight?: number;      // 懸空/騎樓上方起始高度 (m，預設 0)
  minLevel?: number;       // 懸空起始樓層
  footprint: Point2D[];    // 封閉多邊形外環頂點
  holes?: Point2D[][];     // 內環 (天井、中庭)
  roofShape: BuildingRoofShape;
  roofHeight?: number;
  roofLevels?: number;
  colorIndex: number;   // 預先計算之決定性調色盤索引
  heightSource: BuildingHeightSource;
  confidence: number;   // 0.0 ~ 1.0
  area: number;         // 占地面積 (m²)
  center: Point2D;      // 中心點
  note?: string;
  tags?: Record<string, string>;
  isSubdividedUnit?: boolean;
}

export interface PolygonFeature {
  id: string;
  kind: 'water' | 'green' | 'forest';
  name?: string;
  polygon: Point2D[];   // 封閉多邊形頂點串列
}

export interface ShopFeature {
  id: string;
  type: 'node' | 'way' | 'relation';
  name: string;
  category: string;     // 'shop' | 'amenity' | 'tourism' | 'craft' | 'office' 等
  subCategory: string;  // 如 'convenience', 'restaurant', 'cafe', 'hotel' 等
  point: Point2D;       // 局部公尺座標 (x, z)
  lat: number;
  lon: number;
  isFictional?: boolean;// 是否為自動補足之虛構店家招牌
}

export interface BuildingFootprintDebug {
  id: string;
  footprint: Point2D[];
  holes?: Point2D[][];
  status: 'generated' | 'failed' | 'discarded';
  reason?: string;
  source?: BuildingHeightSource;
  levels?: number;
  height?: number;
}

export interface BuildingPipelineStats {
  rawOverpass: {
    way: number;
    relation: number;
    total: number;
  };
  polygonFormed: number;
  polygonFailed: {
    missingNodes: number;
    unclosed: number;
    wrongOrientation: number;
    selfIntersecting: number;
    total: number;
    reasons: string[];
  };
  discarded: {
    tooSmall: number;
    zeroHeight: number;
    clearanceRule: number;
    total: number;
  };
  triangulationFailed: {
    count: number;
    errors: string[];
  };
  inSceneMeshes: number;
  totalVertices: number;
  nearby100m: number;
  sourceStats?: BuildingSourceStats;
}

export interface SignboardPipelineStats {
  rawOverpass: {
    node: number;
    way: number;
    relation: number;
    total: number;
  };
  normalizedNamed: number;
  matchedToBuilding: number;
  matchFailedDistance: number;
  foundStreetWall: number;
  onRealBuilding: number;    // 招牌貼在真實建築
  onProceduralShop: number;  // 貼在補生成的店面
  standalonePole: number;    // 路邊立柱
  generatedMeshes: number;
  visibleInFrustum: number;
  realCount: number;
  fictionalCount: number;
}

export interface TrafficSignalFeature {
  id: string;
  point: Point2D;
  direction?: number;         // 號誌航向角 (rad)
  hasSound?: boolean;         // 是否有視障有聲號誌
  crossingType?: string;      // 行人穿越道類型
  rawTags?: Record<string, string>;
}

export type SignalPhaseGroup = 'A' | 'B';

/**
 * 停止線核心資料結構 (單一資料來源)
 * 供地面標線渲染、斑馬線、機慢車停等區、AI 煞車停車目標共同使用
 */
export interface StopLine {
  laneId: string;
  intersectionId: string;
  approachId: string;
  position: number;             // 沿車道曲線的距離 (米)
  worldPosition: Point2D;       // 停止線中心世界座標
  azimuthRad: number;           // 進入方位角 (rad)
  p1: Point2D;                  // 停止線左端點
  p2: Point2D;                  // 停止線右端點
  width: number;                // 停止線寬度 (m)
  crosswalkEdgeDistance: number;// 距離斑馬線外緣的距離 (m)
  hasScooterWaitingBox: boolean;// 是否有機慢車停等區
  scooterStopWorldPosition?: Point2D; // 機車停等目標位置 (若有機慢車停等區)
  scooterBoxCenter?: Point2D;   // 機慢車停等區中心
  scooterBoxWidth?: number;     // 停等區寬度
  scooterBoxLength?: number;    // 停等區長度
}

export interface IntersectionApproach {
  id: string;                 // e.g. "approach_0_1"
  roadName: string;
  roadType: string;
  azimuthRad: number;         // 進入路口的方位角 (-PI ~ PI，0為北向)
  width: number;
  entryPoint: Point2D;        // 進入點 / 停止線中心
  stopLineP1: Point2D;        // 停止線左端點
  stopLineP2: Point2D;        // 停止線右端點
  stopLine?: StopLine;        // 單一資料來源停止線
  waitingBoxCenter?: Point2D; // 機車待轉區中心
  waitingBoxP1?: Point2D;     // 機車待轉區左上角
  waitingBoxP2?: Point2D;     // 機車待轉區右下角
  signalGroup: SignalPhaseGroup;
  pedestrianCrossingId?: string; // 垂直對應之行人過街穿越道 ID
}

export interface IntersectionCrossing {
  id: string;                 // e.g. "cross_0_1"
  p1: Point2D;
  p2: Point2D;
  center: Point2D;
  width: number;
  length: number;             // 沿道路方向長度 (m，一般為 3.0m)
  azimuthRad: number;         // 道路前進方位角
  outerEdgeCenter: Point2D;   // 迎車方向之斑馬線外緣中心
  signalGroup: SignalPhaseGroup; // 當該群組車輛綠燈時，該穿越道平行通行 (綠燈)
  pedestrianNodeIds?: [number, number]; // 對應行人路網端點 (若有)
}

export interface TrafficSignalPoleConfig {
  id: string;
  position: Point2D;          // 燈桿立柱位置 (路口人行道轉角)
  armAzimuthRad: number;      // 橫臂伸向車道之方位角
  approachId: string;         // 面對之車流來向 approach
  signalGroup: SignalPhaseGroup;
  hasSecondaryHead: boolean;  // 是否有立柱副燈
  hasPedSignal: boolean;      // 是否有行人號誌 (小綠人/紅人)
  hasCountdown: boolean;      // 是否有倒數計時器
}

export interface IntersectionFeature {
  id: string;                 // e.g. "inter_0"
  center: Point2D;
  radius: number;
  source: 'osm' | 'auto';     // 'osm' (OSM 標註號誌) 或 'auto' (主幹道相交自動補齊)
  hasSignals: boolean;        // 是否有設置交通號誌
  approaches: IntersectionApproach[];
  crossings: IntersectionCrossing[];
  stopLines?: StopLine[];     // 該路口所有停止線清單
  poles: TrafficSignalPoleConfig[];
  osmSignalIds?: string[];
}

export interface TrafficSignalStats {
  totalIntersections: number;
  signalizedCount: number;
  osmCount: number;
  autoCount: number;
  inRangeCount: number;
  totalPoles: number;
  updateTimeMs: number;
  drawCalls: number;
}

export interface OsmWorldData {
  origin: {
    lat: number;
    lon: number;
    name: string;
  };
  radiusMeters: number;
  roads: RoadFeature[];
  buildings: BuildingFeature[];
  features: PolygonFeature[];
  shops: ShopFeature[];
  trafficSignals?: TrafficSignalFeature[];
  intersections?: IntersectionFeature[];
  pedestrianNetwork?: any; // PedestrianNetworkData (避免循環引用)
  stats?: SignboardPipelineStats;
  buildingStats?: BuildingPipelineStats;
  buildingDebugFootprints?: BuildingFootprintDebug[];
  fetchedAt: number;
}
