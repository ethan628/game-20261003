/**
 * MapTileRenderer.ts - 靜態地圖圖塊快取與渲染器 (256m 瓦片架構)
 * 按需將 OSM 道路、建築、水域與綠地渲染至 256 公尺的 OffscreenCanvas 圖塊並進行快取
 * 支援 LOD 遠近細節分級，每幀繪製僅需極速 drawImage 拼貼，耗時控制在 1 ms 以內
 */

import { OsmWorldData, Point2D, RoadFeature, BuildingFeature, PolygonFeature } from '../geo/OsmTypes.ts';
import { CONFIG } from '../config.ts';

export type MapLod = 'high' | 'low';

export class MapTileRenderer {
  private tiles: Map<string, HTMLCanvasElement> = new Map();
  private data: OsmWorldData | null = null;
  private readonly tileSizeMeters = CONFIG.MINIMAP.TILE_SIZE_METERS; // 256m
  private readonly tilePixels = 256; // 1 pixel = 1 meter (搭配 Canvas 縮放可獲極致流暢與銳利度)

  // 空間網格快取以加速圖塊多邊形交叉計算
  private roadBuckets: Map<string, RoadFeature[]> = new Map();
  private buildingBuckets: Map<string, BuildingFeature[]> = new Map();
  private featureBuckets: Map<string, PolygonFeature[]> = new Map();

  constructor() {}

  /**
   * 設定標準化地圖資料並建立空間分塊索引
   */
  public setData(data: OsmWorldData): void {
    this.data = data;
    this.clear();

    const size = this.tileSizeMeters;

    // 建立水域與綠地索引
    for (const f of data.features) {
      if (f.polygon.length < 3) continue;
      const b = this.calcBbox(f.polygon);
      const minTX = Math.floor(b.minX / size);
      const maxTX = Math.floor(b.maxX / size);
      const minTZ = Math.floor(b.minZ / size);
      const maxTZ = Math.floor(b.maxZ / size);
      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let tz = minTZ; tz <= maxTZ; tz++) {
          const key = `${tx}_${tz}`;
          let list = this.featureBuckets.get(key);
          if (!list) {
            list = [];
            this.featureBuckets.set(key, list);
          }
          list.push(f);
        }
      }
    }

    // 建立建築索引
    for (const bldg of data.buildings) {
      const tx = Math.floor(bldg.center.x / size);
      const tz = Math.floor(bldg.center.z / size);
      const key = `${tx}_${tz}`;
      let list = this.buildingBuckets.get(key);
      if (!list) {
        list = [];
        this.buildingBuckets.set(key, list);
      }
      list.push(bldg);
    }

    // 建立道路索引
    for (const road of data.roads) {
      if (road.points.length < 2) continue;
      const b = this.calcBbox(road.points);
      const minTX = Math.floor(b.minX / size);
      const maxTX = Math.floor(b.maxX / size);
      const minTZ = Math.floor(b.minZ / size);
      const maxTZ = Math.floor(b.maxZ / size);
      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let tz = minTZ; tz <= maxTZ; tz++) {
          const key = `${tx}_${tz}`;
          let list = this.roadBuckets.get(key);
          if (!list) {
            list = [];
            this.roadBuckets.set(key, list);
          }
          list.push(road);
        }
      }
    }
  }

  public getData(): OsmWorldData | null {
    return this.data;
  }

  /**
   * 清除快取圖塊
   */
  public clear(): void {
    this.tiles.clear();
    this.roadBuckets.clear();
    this.buildingBuckets.clear();
    this.featureBuckets.clear();
  }

  /**
   * 取得指定座標與 LOD 之快取圖塊 Canvas
   */
  public getTile(tx: number, tz: number, lod: MapLod): HTMLCanvasElement {
    const key = `${tx}_${tz}_${lod}`;
    const cached = this.tiles.get(key);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    canvas.width = this.tilePixels;
    canvas.height = this.tilePixels;
    const ctx = canvas.getContext('2d')!;

    this.renderTileContent(ctx, tx, tz, lod);

    this.tiles.set(key, canvas);
    return canvas;
  }

  /**
   * 繪製單個 256m 圖塊內容
   */
  private renderTileContent(
    ctx: CanvasRenderingContext2D,
    tx: number,
    tz: number,
    lod: MapLod
  ): void {
    const originX = tx * this.tileSizeMeters;
    const originZ = tz * this.tileSizeMeters;
    const scale = this.tilePixels / this.tileSizeMeters; // 1.0 px/m
    const palette = CONFIG.MAP_PALETTE;

    // 1. 底圖深藍灰填充
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, this.tilePixels, this.tilePixels);

    // 座標轉換輔助
    const toTileX = (wx: number) => (wx - originX) * scale;
    const toTileZ = (wz: number) => (wz - originZ) * scale;

    const bucketKey = `${tx}_${tz}`;

    // 2. 自然地貌：水域與綠地多邊形
    const features = this.featureBuckets.get(bucketKey) || [];
    for (const f of features) {
      if (f.polygon.length < 3) continue;

      ctx.beginPath();
      ctx.moveTo(toTileX(f.polygon[0].x), toTileZ(f.polygon[0].z));
      for (let i = 1; i < f.polygon.length; i++) {
        ctx.lineTo(toTileX(f.polygon[i].x), toTileZ(f.polygon[i].z));
      }
      ctx.closePath();

      if (f.kind === 'water') {
        ctx.fillStyle = palette.water;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = palette.waterStroke;
        ctx.stroke();
      } else {
        ctx.fillStyle = f.kind === 'forest' ? palette.forest : palette.green;
        ctx.fill();
      }
    }

    // 3. 建築物輪廓 (近景 HIGH LOD 繪製，遠景 LOW LOD 省略以保證效能)
    if (lod === 'high') {
      const buildings = this.buildingBuckets.get(bucketKey) || [];
      ctx.fillStyle = palette.building;
      ctx.strokeStyle = palette.buildingStroke;
      ctx.lineWidth = 1.0;

      for (const bldg of buildings) {
        if (bldg.footprint.length < 3) continue;

        ctx.beginPath();
        ctx.moveTo(toTileX(bldg.footprint[0].x), toTileZ(bldg.footprint[0].z));
        for (let i = 1; i < bldg.footprint.length; i++) {
          ctx.lineTo(toTileX(bldg.footprint[i].x), toTileZ(bldg.footprint[i].z));
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // 4. 道路與鐵路網絡
    const roads = this.roadBuckets.get(bucketKey) || [];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const road of roads) {
      if (road.points.length < 2) continue;

      const isMajor =
        road.type === 'motorway' ||
        road.type === 'trunk' ||
        road.type === 'primary' ||
        road.type === 'secondary';

      // LOW LOD 遠景模式只繪製主要幹道與鐵路
      if (lod === 'low' && !isMajor && !road.isRailway) {
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(toTileX(road.points[0].x), toTileZ(road.points[0].z));
      for (let i = 1; i < road.points.length; i++) {
        ctx.lineTo(toTileX(road.points[i].x), toTileZ(road.points[i].z));
      }

      if (road.isRailway) {
        // 鐵路虛線
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = Math.max(1.5, (road.width || 4) * scale * 0.4);
        ctx.strokeStyle = palette.railway;
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // 道路寬度與色彩層級
        let w = (road.width || 4) * scale;
        let strokeColor = palette.roadDefault;

        if (road.type === 'motorway' || road.type === 'trunk') {
          strokeColor = palette.roadHighway;
          w = Math.max(3.5, w * 0.6);
        } else if (road.type === 'primary') {
          strokeColor = palette.roadPrimary;
          w = Math.max(3.0, w * 0.55);
        } else if (road.type === 'secondary' || road.type === 'tertiary') {
          strokeColor = palette.roadMajor;
          w = Math.max(2.2, w * 0.5);
        } else {
          w = Math.max(1.2, w * 0.4);
        }

        ctx.lineWidth = w;
        ctx.strokeStyle = strokeColor;
        ctx.stroke();
      }
    }
  }

  /**
   * 計算點集邊界盒
   */
  private calcBbox(pts: Point2D[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return { minX, maxX, minZ, maxZ };
  }

  public getTileSizeMeters(): number {
    return this.tileSizeMeters;
  }
}
