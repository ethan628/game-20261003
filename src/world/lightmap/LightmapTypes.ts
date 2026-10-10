/**
 * LightmapTypes.ts - 區塊光照圖型別定義與規格
 * 支援 256m 世界座標區塊 + 20m 雙向邊界平滑過渡
 */

export interface LightSource {
  id: string;
  type: 'street_lamp' | 'shop' | 'signal' | 'window';
  x: number;
  y: number;
  z: number;
  radius: number;
  intensity: number;
  color: { r: number; g: number; b: number };
  turnOnThreshold: number; // 0.0 ~ 1.0 黃昏點亮門檻
  source?: 'osm' | 'auto';
  roadType?: string;
}

export type OcclusionSegment = [number, number, number, number]; // [x1, z1, x2, z2]

export interface LightmapChunkRequest {
  chunkId: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  resolution: number; // 1.0 m / pixel
  lights: LightSource[];
  occluders: OcclusionSegment[];
}

export interface LightmapChunkResult {
  chunkId: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray; // RGBA8
  computeTimeMs: number;
}

export interface LightCoverageReport {
  totalSamplePoints: number;
  litPoints: number;
  coveragePercent: number;
  totalLamps: number;
  osmLamps: number;
  autoLamps: number;
  maxDarkHole: {
    x: number;
    z: number;
    estimatedAreaM2: number;
    minIntensity: number;
  } | null;
}
