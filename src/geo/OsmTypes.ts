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
}

export interface BuildingFeature {
  id: string;
  type: string;
  name?: string;
  height: number;
  levels?: number;
  footprint: Point2D[]; // 封閉多邊形頂點串列
  colorIndex: number;   // 預先計算之決定性調色盤索引
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
  status: 'generated' | 'failed' | 'discarded';
  reason?: string;
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
  stats?: SignboardPipelineStats;
  buildingStats?: BuildingPipelineStats;
  buildingDebugFootprints?: BuildingFootprintDebug[];
  fetchedAt: number;
}
