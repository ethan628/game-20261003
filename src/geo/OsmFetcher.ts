/**
 * OsmFetcher.ts - Overpass API 抓取、超時重試、快取與資料標準化解析
 * 依據 RULES.md：本模組只產出標準化資料，嚴禁引入 3D 渲染邏輯
 */

import { CONFIG } from '../config.ts';
import { GeoProjection } from './Projection.ts';
import { GeoCache } from './GeoCache.ts';
import {
  BuildingFeature,
  BuildingFootprintDebug,
  BuildingPipelineStats,
  OsmWorldData,
  Point2D,
  PolygonFeature,
  RoadFeature,
  ShopFeature,
  SignboardPipelineStats
} from './OsmTypes.ts';

export class OsmFetcher {
  private cache: GeoCache;

  constructor() {
    this.cache = new GeoCache();
  }

  /**
   * 根據中心經緯度與半徑取得世界標準資料（優先命中 IndexedDB 快取）
   */
  public async fetchWorldData(
    originLat: number,
    originLon: number,
    locationName: string,
    onProgress?: (message: string) => void,
    presetFile?: string
  ): Promise<OsmWorldData> {
    const radius = CONFIG.GEO.FETCH_RADIUS_METERS;
    const projection = new GeoProjection(originLat, originLon);

    // 0. 若提供本地預存的真實 OSM 資料檔案，極速秒級載入
    if (presetFile) {
      try {
        onProgress?.('載入預先準備之真實街區資料 (極速模式)...');
        const resp = await fetch(presetFile);
        if (resp.ok) {
          const raw = await resp.json();
          if (raw && raw.elements) {
            onProgress?.('解析標準化地圖幾何中...');
            const worldData = this.parseRawData(raw, projection, originLat, originLon, locationName, radius);
            await this.cache.set(originLat, originLon, radius, worldData);
            onProgress?.('載入成功！');
            return worldData;
          }
        }
      } catch (err) {
        console.warn('[OsmFetcher] 讀取預設檔案例外，轉入快取與網路抓取', err);
      }
    }

    // 1. 檢查 IndexedDB 本地快取
    onProgress?.('檢查本地快取中...');
    const cached = await this.cache.get(originLat, originLon, radius);
    if (cached) {
      onProgress?.('已載入本地快取資料！');
      return cached;
    }

    // 2. 建立邊界範圍
    const bbox = projection.getBoundingBox(radius);

    // 3. 組合 Overpass QL 查詢語句 (幾何與店家分開抓取，確保速度最快且不超時)
    const geomQuery = `
      [out:json][timeout:${Math.round(CONFIG.GEO.REQUEST_TIMEOUT_MS / 1000)}];
      (
        way["highway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        way["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        relation["building"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        way["building:part"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        relation["building:part"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        way["natural"="water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        way["waterway"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        way["water"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        way["leisure"="park"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        way["landuse"~"grass|forest|meadow|recreation_ground|village_green"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      );
      out geom;
    `;

    const shopQuery = `
      [out:json][timeout:${Math.round(CONFIG.GEO.REQUEST_TIMEOUT_MS / 1000)}];
      (
        nwr["shop"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        nwr["amenity"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        nwr["tourism"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        nwr["craft"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
        nwr["office"](${bbox.south},${bbox.west},${bbox.north},${bbox.east});
      );
      out center;
    `;

    // 4. 多站點容錯與超時重試請求
    onProgress?.('連線 Overpass API 獲取地理與店家資料...');
    const geomData = await this.queryOverpassWithFallback(geomQuery, '道路與建築幾何', onProgress);
    let shopData: any = null;
    try {
      shopData = await this.queryOverpassWithFallback(shopQuery, '真實店家與招牌', onProgress);
    } catch (err: any) {
      console.warn('[OsmFetcher] 店家資料網路查詢逾時，將由建物臨街生成備援店家招牌', err.message);
    }

    const rawOsmData = {
      elements: [
        ...(geomData?.elements || []),
        ...(shopData?.elements || [])
      ]
    };

    // 5. 解析標準化幾何與店家招牌資料
    onProgress?.('解析標準化地圖與店家招牌中...');
    const worldData = this.parseRawData(rawOsmData, projection, originLat, originLon, locationName, radius);

    // 6. 寫入 IndexedDB 本地快取
    await this.cache.set(originLat, originLon, radius, worldData);
    onProgress?.('資料快取完成，準備建立 3D 世界...');

    return worldData;
  }

  private async queryOverpassWithFallback(
    query: string,
    label: string,
    onProgress?: (message: string) => void
  ): Promise<any> {
    const endpoints = CONFIG.GEO.OVERPASS_ENDPOINTS;
    let lastError: Error | null = null;

    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];
      const attemptNum = i + 1;
      onProgress?.(`連線 Overpass API [${label}] (${attemptNum}/${endpoints.length})...`);

      try {
        const raw = await this.queryEndpointWithTimeout(endpoint, query, CONFIG.GEO.REQUEST_TIMEOUT_MS);
        if (raw && raw.elements) {
          return raw;
        }
      } catch (err: any) {
        console.warn(`[OsmFetcher] 伺服器 ${endpoint} [${label}] 請求失敗:`, err.message);
        lastError = err;
      }
    }

    throw new Error(
      `無法從 OpenStreetMap 取得 [${label}] 資料。\n錯誤細節: ${
        lastError ? lastError.message : '連線逾時'
      }`
    );
  }

  private async queryEndpointWithTimeout(endpoint: string, query: string, timeoutMs: number): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'GTA-OSM-Viewer/1.0 (Windows NT 10.0; Win64; x64)'
        },
        body: 'data=' + encodeURIComponent(query),
        signal: controller.signal
      });

      if (!resp.ok) {
        throw new Error(`HTTP 錯誤狀態 ${resp.status} (${resp.statusText})`);
      }

      const json = await resp.json();
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 將原始 Overpass JSON 解析為標準化 OsmWorldData
   */
  private parseRawData(
    raw: any,
    projection: GeoProjection,
    originLat: number,
    originLon: number,
    locationName: string,
    radius: number
  ): OsmWorldData {
    const nodesMap = new Map<number, { lat: number; lon: number }>();
    const ways: any[] = [];

    // 1. 建立節點快取表 (若為舊格式 out body)
    for (const elem of raw.elements) {
      if (elem.type === 'node') {
        nodesMap.set(elem.id, { lat: elem.lat, lon: elem.lon });
      } else if (elem.type === 'way') {
        ways.push(elem);
      }
    }

    const roads: RoadFeature[] = [];
    const buildings: BuildingFeature[] = [];
    const features: PolygonFeature[] = [];

    // 輔助函式：從 way 取得局部 (x, z) 座標點列（優先讀取 out geom 產出的 way.geometry，次之讀取 nodesMap）
    const resolvePoints = (way: any): Point2D[] => {
      if (Array.isArray(way.geometry) && way.geometry.length > 0) {
        return way.geometry.map((g: any) => projection.project(g.lat, g.lon));
      }
      const pts: Point2D[] = [];
      if (Array.isArray(way.nodes)) {
        for (const nid of way.nodes) {
          const n = nodesMap.get(nid);
          if (n) {
            pts.push(projection.project(n.lat, n.lon));
          }
        }
      }
      return pts;
    };

    // 輔助函式：計算雜湊數值 (用於隨機高度與配色決定性重現)
    const hashId = (id: number): number => {
      let h = id ^ 0x5bf03635;
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
      return Math.abs(h ^ (h >>> 16));
    };

    for (const way of ways) {
      const tags = way.tags || {};
      const pts = resolvePoints(way);
      if (pts.length < 2) continue;

      // --- A. 道路 (Highway) ---
      if (tags.highway) {
        const hwType = tags.highway;
        const widthConfig = CONFIG.ROADS.WIDTHS[hwType] || CONFIG.ROADS.WIDTHS.default;
        roads.push({
          id: `road_${way.id}`,
          type: hwType,
          name: tags.name,
          points: pts,
          width: widthConfig.road,
          sidewalkWidth: widthConfig.sidewalk
        });
      }

      // --- 水域 (Water / Waterway) ---
      else if (
        tags.natural === 'water' ||
        tags.waterway === 'riverbank' ||
        tags.water ||
        tags.landuse === 'basin' ||
        tags.landuse === 'reservoir'
      ) {
        if (pts.length >= 3) {
          const poly = this.cleanPolygon(pts);
          if (poly.length >= 3) {
            features.push({
              id: `water_${way.id}`,
              kind: 'water',
              name: tags.name,
              polygon: poly
            });
          }
        }
      }

      // --- D. 綠地與公園 (Park / Grass / Forest) ---
      else if (
        tags.leisure === 'park' ||
        tags.leisure === 'garden' ||
        tags.landuse === 'grass' ||
        tags.landuse === 'meadow' ||
        tags.landuse === 'village_green' ||
        tags.landuse === 'recreation_ground' ||
        tags.natural === 'wood' ||
        tags.landuse === 'forest'
      ) {
        if (pts.length >= 3) {
          const poly = this.cleanPolygon(pts);
          if (poly.length >= 3) {
            const isForest = tags.landuse === 'forest' || tags.natural === 'wood';
            features.push({
              id: `green_${way.id}`,
              kind: isForest ? 'forest' : 'green',
              name: tags.name,
              polygon: poly
            });
          }
        }
      }
    }

    // --- B. 建築管線解析與除錯診斷 (步驟 1 與 2) ---
    const rawBuildingStats = { way: 0, relation: 0, total: 0 };
    const polygonFailed = {
      missingNodes: 0,
      unclosed: 0,
      wrongOrientation: 0,
      selfIntersecting: 0,
      total: 0,
      reasons: [] as string[]
    };
    const discarded = {
      tooSmall: 0,
      zeroHeight: 0,
      clearanceRule: 0,
      total: 0
    };
    let polygonFormed = 0;
    const debugFootprints: BuildingFootprintDebug[] = [];

    for (const elem of raw.elements) {
      const tags = elem.tags || {};
      const isBuilding = !!((tags.building && tags.building !== 'no') || (tags['building:part'] && tags['building:part'] !== 'no'));
      if (!isBuilding) continue;

      if (elem.type === 'way') rawBuildingStats.way++;
      else if (elem.type === 'relation') rawBuildingStats.relation++;
      rawBuildingStats.total++;

      // 提取候選多邊形頂點序列
      const candidateRings: Point2D[][] = [];

      if (elem.type === 'way') {
        const pts = resolvePoints(elem);
        candidateRings.push(pts);
      } else if (elem.type === 'relation') {
        // Multipolygon 處理：提取 outer members 的幾何
        const members = elem.members || [];
        const outerMembers = members.filter((m: any) => m.role === 'outer');
        for (const m of outerMembers) {
          if (Array.isArray(m.geometry) && m.geometry.length >= 3) {
            candidateRings.push(m.geometry.map((g: any) => projection.project(g.lat, g.lon)));
          }
        }
      }

      if (candidateRings.length === 0) {
        polygonFailed.missingNodes++;
        polygonFailed.total++;
        polygonFailed.reasons.push(`${elem.type}_${elem.id}: 無有效頂點串列`);
        debugFootprints.push({ id: `bldg_${elem.id}`, footprint: [], status: 'failed', reason: '無有效頂點' });
        continue;
      }

      for (let ringIdx = 0; ringIdx < candidateRings.length; ringIdx++) {
        const pts = candidateRings[ringIdx];
        const ringId = candidateRings.length > 1 ? `bldg_${elem.id}_${ringIdx}` : `bldg_${elem.id}`;

        if (!pts || pts.length < 3) {
          polygonFailed.missingNodes++;
          polygonFailed.total++;
          polygonFailed.reasons.push(`${ringId}: 節點數小於 3 (${pts ? pts.length : 0})`);
          debugFootprints.push({ id: ringId, footprint: pts || [], status: 'failed', reason: '節點不足' });
          continue;
        }

        // 閉合檢測與自動修正
        const first = pts[0];
        const last = pts[pts.length - 1];
        const closeDist = Math.hypot(last.x - first.x, last.z - first.z);
        if (closeDist > 0.05) {
          if (closeDist < 30.0) {
            pts.push({ x: first.x, z: first.z });
          } else {
            polygonFailed.unclosed++;
            polygonFailed.total++;
            polygonFailed.reasons.push(`${ringId}: 多邊形未閉合 (首尾距離 ${closeDist.toFixed(1)}m)`);
            debugFootprints.push({ id: ringId, footprint: pts, status: 'failed', reason: '未閉合' });
            continue;
          }
        }

        // 清理重複點
        const cleaned = this.cleanPolygon(pts);
        if (cleaned.length < 3) {
          polygonFailed.missingNodes++;
          polygonFailed.total++;
          polygonFailed.reasons.push(`${ringId}: 去除重疊點後頂點小於 3`);
          debugFootprints.push({ id: ringId, footprint: cleaned, status: 'failed', reason: '重疊點過濾後不足3點' });
          continue;
        }

        // 計算有向面積 (Shoelace formula) 並統一為逆時針方向 (CCW)
        const signedArea = this.computeSignedArea(cleaned);
        if (signedArea < 0) {
          polygonFailed.wrongOrientation++;
          cleaned.reverse();
        }

        // 自相交檢測
        if (this.hasSelfIntersection(cleaned)) {
          polygonFailed.selfIntersecting++;
        }

        polygonFormed++;

        // 規則過濾檢測 (關卡 3)
        const absArea = Math.abs(signedArea);
        if (absArea < CONFIG.BUILDINGS.MIN_AREA) {
          discarded.tooSmall++;
          discarded.total++;
          debugFootprints.push({
            id: ringId,
            footprint: cleaned,
            status: 'discarded',
            reason: `面積過小 (${absArea.toFixed(1)}m² < ${CONFIG.BUILDINGS.MIN_AREA}m²)`
          });
          continue;
        }

        const hVal = hashId(elem.id);
        const height = this.resolveBuildingHeight(tags, hVal);
        if (height <= 0) {
          discarded.zeroHeight++;
          discarded.total++;
          debugFootprints.push({
            id: ringId,
            footprint: cleaned,
            status: 'discarded',
            reason: '高度為 0'
          });
          continue;
        }

        const colorIndex = hVal % CONFIG.BUILDINGS.PALETTE.length;
        buildings.push({
          id: ringId,
          type: tags.building || tags['building:part'] || 'yes',
          name: tags.name,
          height,
          levels: tags['building:levels'] ? parseFloat(tags['building:levels']) : undefined,
          footprint: cleaned,
          colorIndex
        });

        debugFootprints.push({
          id: ringId,
          footprint: cleaned,
          status: 'generated'
        });
      }
    }

    console.log(
      `%c[建築管線第 1 關] Overpass building 原始數: way=${rawBuildingStats.way}, relation=${rawBuildingStats.relation}, 總計=${rawBuildingStats.total}`,
      'color: #38bdf8; font-weight: bold;'
    );
    console.log(
      `%c[建築管線第 2 關] 成功組出多邊形: ${polygonFormed} 筆 | 失敗數: ${polygonFailed.total} 筆 (缺節點: ${polygonFailed.missingNodes}, 未閉合: ${polygonFailed.unclosed}, 方向已校正CCW: ${polygonFailed.wrongOrientation}, 自相交: ${polygonFailed.selfIntersecting})`,
      'color: #38bdf8; font-weight: bold;'
    );
    console.log(
      `%c[建築管線第 3 關] 規則過濾丟棄: ${discarded.total} 筆 (面積<${CONFIG.BUILDINGS.MIN_AREA}m²: ${discarded.tooSmall}, 高度<=0: ${discarded.zeroHeight}, 淨空區: ${discarded.clearanceRule}) | 通過留存: ${buildings.length} 棟`,
      'color: #38bdf8; font-weight: bold;'
    );

    const buildingStats: BuildingPipelineStats = {
      rawOverpass: rawBuildingStats,
      polygonFormed,
      polygonFailed,
      discarded,
      triangulationFailed: { count: 0, errors: [] },
      inSceneMeshes: 0,
      totalVertices: 0,
      nearby100m: 0
    };

    // --- C. 店家與 POI 資料解析 (招牌系統第 1 關與第 2 關) ---
    const rawShopStats = { node: 0, way: 0, relation: 0, total: 0 };
    const shops: ShopFeature[] = [];

    for (const elem of raw.elements) {
      const tags = elem.tags || {};
      const isShopLike = !!(tags.shop || tags.amenity || tags.tourism || tags.craft || tags.office);
      if (!isShopLike) continue;

      if (elem.type === 'node') rawShopStats.node++;
      else if (elem.type === 'way') rawShopStats.way++;
      else if (elem.type === 'relation') rawShopStats.relation++;
      rawShopStats.total++;

      let lat: number | undefined;
      let lon: number | undefined;

      if (elem.type === 'node') {
        lat = elem.lat;
        lon = elem.lon;
      } else if (elem.center) {
        lat = elem.center.lat;
        lon = elem.center.lon;
      } else if (Array.isArray(elem.geometry) && elem.geometry.length > 0) {
        let sumLat = 0, sumLon = 0;
        for (const g of elem.geometry) {
          sumLat += g.lat;
          sumLon += g.lon;
        }
        lat = sumLat / elem.geometry.length;
        lon = sumLon / elem.geometry.length;
      }

      if (lat === undefined || lon === undefined) continue;

      const name = tags.name || tags['name:zh'] || tags['name:en'] || tags['brand'] || tags['operator'];
      if (!name) continue;

      const category = tags.shop ? 'shop' : (tags.amenity ? 'amenity' : (tags.tourism ? 'tourism' : 'shop'));
      const subCategory = tags.shop || tags.amenity || tags.tourism || tags.craft || tags.office || 'general';

      const point = projection.project(lat, lon);
      shops.push({
        id: `shop_${elem.type}_${elem.id}`,
        type: elem.type,
        name,
        category,
        subCategory,
        point,
        lat,
        lon,
        isFictional: false
      });
    }

    const realShopsCount = shops.length;

    // 步驟 5：若真實店家少於 30 筆，自動以虛構通用招牌補足臨街一樓
    let fictionalShopsCount = 0;
    if (shops.length < CONFIG.SIGNBOARD.PROCEDURAL_MIN_SHOPS && buildings.length > 0) {
      const fictionalList = CONFIG.SIGNBOARD.FICTIONAL_SHOPS;
      let ficIdx = 0;
      while (shops.length < CONFIG.SIGNBOARD.PROCEDURAL_MIN_SHOPS) {
        const b = buildings[ficIdx % buildings.length];
        const template = fictionalList[ficIdx % fictionalList.length];
        const pt = b.footprint[0] || { x: 0, z: 0 };
        const unproj = projection.unproject(pt.x, pt.z);
        shops.push({
          id: `shop_fictional_${ficIdx}`,
          type: 'node',
          name: template.name,
          category: template.category,
          subCategory: template.subCategory,
          point: { x: pt.x, z: pt.z },
          lat: unproj.lat,
          lon: unproj.lon,
          isFictional: true
        });
        fictionalShopsCount++;
        ficIdx++;
      }
    }

    console.log(
      `%c[招牌管線第 1 關] Overpass 店家原始數: node=${rawShopStats.node}, way=${rawShopStats.way}, relation=${rawShopStats.relation}, 總計=${rawShopStats.total}`,
      'color: #38bdf8; font-weight: bold;'
    );
    console.log(
      `%c[招牌管線第 2 關] 正規化有座標且有名稱店家: 真實=${realShopsCount}, 虛構補足=${fictionalShopsCount}, 總計=${shops.length}`,
      'color: #38bdf8; font-weight: bold;'
    );

    const stats: SignboardPipelineStats = {
      rawOverpass: rawShopStats,
      normalizedNamed: realShopsCount + fictionalShopsCount,
      matchedToBuilding: 0,
      matchFailedDistance: 0,
      foundStreetWall: 0,
      onRealBuilding: 0,
      onProceduralShop: 0,
      standalonePole: 0,
      generatedMeshes: 0,
      visibleInFrustum: 0,
      realCount: realShopsCount,
      fictionalCount: fictionalShopsCount
    };

    return {
      origin: {
        lat: originLat,
        lon: originLon,
        name: locationName
      },
      radiusMeters: radius,
      roads,
      buildings,
      features,
      shops,
      stats,
      buildingStats,
      buildingDebugFootprints: debugFootprints,
      fetchedAt: Date.now()
    };
  }

  /**
   * 計算建物高度：優先 height 標籤，其次 levels 乘算，最後依類型決定性隨機
   */
  private resolveBuildingHeight(tags: any, hash: number): number {
    if (tags.height) {
      const h = parseFloat(tags.height);
      if (!isNaN(h) && h > 1.5) return Math.min(h, 450);
    }

    if (tags['building:levels']) {
      const lv = parseFloat(tags['building:levels']);
      if (!isNaN(lv) && lv > 0) {
        return Math.min(lv * CONFIG.BUILDINGS.LEVEL_HEIGHT, 400);
      }
    }

    const bType = tags.building;
    const range = CONFIG.BUILDINGS.TYPE_HEIGHTS[bType] || [
      CONFIG.BUILDINGS.DEFAULT_HEIGHT_MIN,
      CONFIG.BUILDINGS.DEFAULT_HEIGHT_MAX
    ];

    const ratio = (hash % 1000) / 1000.0;
    return range[0] + ratio * (range[1] - range[0]);
  }

  /**
   * 清理多邊形頂點（去除首尾重複、過近點）
   */
  private cleanPolygon(points: Point2D[]): Point2D[] {
    const res: Point2D[] = [];
    const minDistSq = 0.05 * 0.05;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (res.length > 0) {
        const prev = res[res.length - 1];
        const dx = p.x - prev.x;
        const dz = p.z - prev.z;
        if (dx * dx + dz * dz < minDistSq) continue;
      }
      res.push(p);
    }

    // 若最後一點與第一點過近，移除最後一點
    if (res.length > 2) {
      const first = res[0];
      const last = res[res.length - 1];
      const dx = last.x - first.x;
      const dz = last.z - first.z;
      if (dx * dx + dz * dz < minDistSq) {
        res.pop();
      }
    }

    return res;
  }

  private computeSignedArea(poly: Point2D[]): number {
    let sum = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % n];
      sum += (p1.x * p2.z - p2.x * p1.z);
    }
    return sum * 0.5;
  }

  private hasSelfIntersection(poly: Point2D[]): boolean {
    const n = poly.length;
    if (n < 4) return false;
    for (let i = 0; i < n; i++) {
      const a1 = poly[i];
      const a2 = poly[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const b1 = poly[j];
        const b2 = poly[(j + 1) % n];
        if (this.segmentsIntersect(a1, a2, b1, b2)) return true;
      }
    }
    return false;
  }

  private segmentsIntersect(p1: Point2D, p2: Point2D, p3: Point2D, p4: Point2D): boolean {
    const ccw = (a: Point2D, b: Point2D, c: Point2D) => (c.z - a.z) * (b.x - a.x) > (b.z - a.z) * (c.x - a.x);
    return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
  }

  /**
   * 當網路全數離線或 Overpass 伺服器異常時，提供備援之標準化展示街區資料
   */
  public getProceduralFallback(
    originLat: number,
    originLon: number,
    locationName: string
  ): OsmWorldData {
    const roads: RoadFeature[] = [];
    const buildings: BuildingFeature[] = [];
    const features: PolygonFeature[] = [];

    // 主幹道十字交會 (X = 0, Z = 0)
    roads.push({
      id: 'fallback_main_ns',
      type: 'primary',
      name: '中央大道 (南北向)',
      points: [{ x: 0, z: -300 }, { x: 0, z: 300 }],
      width: 12,
      sidewalkWidth: 2
    });
    roads.push({
      id: 'fallback_main_ew',
      type: 'primary',
      name: '中央大道 (東西向)',
      points: [{ x: -300, z: 0 }, { x: 300, z: 0 }],
      width: 12,
      sidewalkWidth: 2
    });

    // 次要棋盤街廓
    const gridCoords = [-180, -90, 90, 180];
    for (const c of gridCoords) {
      roads.push({
        id: `fallback_sub_ns_${c}`,
        type: 'secondary',
        points: [{ x: c, z: -250 }, { x: c, z: 250 }],
        width: 8,
        sidewalkWidth: 1.5
      });
      roads.push({
        id: `fallback_sub_ew_${c}`,
        type: 'secondary',
        points: [{ x: -250, z: c }, { x: 250, z: c }],
        width: 8,
        sidewalkWidth: 1.5
      });
    }

    // 中央休閒水池與綠地 (東北街廓)
    features.push({
      id: 'fallback_park',
      kind: 'green',
      name: '城市綠洲公園',
      polygon: [
        { x: 15, z: 15 },
        { x: 75, z: 15 },
        { x: 75, z: 75 },
        { x: 15, z: 75 }
      ]
    });
    features.push({
      id: 'fallback_lake',
      kind: 'water',
      name: '景觀水池',
      polygon: [
        { x: 30, z: 30 },
        { x: 60, z: 30 },
        { x: 60, z: 60 },
        { x: 30, z: 60 }
      ]
    });

    // 程序化生成建物群
    let bldgId = 1;
    const blocks = [
      { minX: -75, maxX: -15, minZ: -75, maxZ: -15 }, // 西北
      { minX: 15, maxX: 75, minZ: -75, maxZ: -15 },   // 東北
      { minX: -75, maxX: -15, minZ: 15, maxZ: 75 },   // 西南
      { minX: -165, maxX: -105, minZ: -75, maxZ: -15 },
      { minX: 105, maxX: 165, minZ: -75, maxZ: -15 },
      { minX: -165, maxX: -105, minZ: 15, maxZ: 75 },
      { minX: 105, maxX: 165, minZ: 15, maxZ: 75 }
    ];

    for (const b of blocks) {
      // 每個街廓切分 4 棟建築
      const midX = (b.minX + b.maxX) / 2;
      const midZ = (b.minZ + b.maxZ) / 2;
      const subCells = [
        { x1: b.minX + 2, x2: midX - 2, z1: b.minZ + 2, z2: midZ - 2 },
        { x1: midX + 2, x2: b.maxX - 2, z1: b.minZ + 2, z2: midZ - 2 },
        { x1: b.minX + 2, x2: midX - 2, z1: midZ + 2, z2: b.maxZ - 2 },
        { x1: midX + 2, x2: b.maxX - 2, z1: midZ + 2, z2: b.maxZ - 2 }
      ];

      for (const cell of subCells) {
        const height = 10 + (bldgId * 7) % 32;
        buildings.push({
          id: `fallback_bldg_${bldgId}`,
          type: 'commercial',
          name: `示範大樓 #${bldgId}`,
          height,
          footprint: [
            { x: cell.x1, z: cell.z1 },
            { x: cell.x2, z: cell.z1 },
            { x: cell.x2, z: cell.z2 },
            { x: cell.x1, z: cell.z2 }
          ],
          colorIndex: bldgId % CONFIG.BUILDINGS.PALETTE.length
        });
        bldgId++;
      }
    }

    // 程序化通用招牌 (備援展示模式)
    const shops: ShopFeature[] = [];
    const fictionalList = CONFIG.SIGNBOARD.FICTIONAL_SHOPS;
    const proj = new GeoProjection(originLat, originLon);

    for (let i = 0; i < Math.min(buildings.length, fictionalList.length); i++) {
      const b = buildings[i];
      const template = fictionalList[i];
      const pt = b.footprint[0] || { x: 0, z: 0 };
      const unproj = proj.unproject(pt.x, pt.z);
      shops.push({
        id: `shop_procedural_${i}`,
        type: 'node',
        name: template.name,
        category: template.category,
        subCategory: template.subCategory,
        point: { x: pt.x, z: pt.z },
        lat: unproj.lat,
        lon: unproj.lon,
        isFictional: true
      });
    }

    const stats: SignboardPipelineStats = {
      rawOverpass: { node: 0, way: 0, relation: 0, total: 0 },
      normalizedNamed: shops.length,
      matchedToBuilding: 0,
      matchFailedDistance: 0,
      foundStreetWall: 0,
      onRealBuilding: 0,
      onProceduralShop: 0,
      standalonePole: 0,
      generatedMeshes: 0,
      visibleInFrustum: 0,
      realCount: 0,
      fictionalCount: shops.length
    };

    const buildingStats: BuildingPipelineStats = {
      rawOverpass: { way: buildings.length, relation: 0, total: buildings.length },
      polygonFormed: buildings.length,
      polygonFailed: { missingNodes: 0, unclosed: 0, wrongOrientation: 0, selfIntersecting: 0, total: 0, reasons: [] },
      discarded: { tooSmall: 0, zeroHeight: 0, clearanceRule: 0, total: 0 },
      triangulationFailed: { count: 0, errors: [] },
      inSceneMeshes: 0,
      totalVertices: 0,
      nearby100m: 0
    };

    const buildingDebugFootprints: BuildingFootprintDebug[] = buildings.map((b) => ({
      id: b.id,
      footprint: b.footprint,
      status: 'generated'
    }));

    return {
      origin: {
        lat: originLat,
        lon: originLon,
        name: `${locationName} (展示備援街區)`
      },
      radiusMeters: CONFIG.GEO.FETCH_RADIUS_METERS,
      roads,
      buildings,
      features,
      shops,
      stats,
      buildingStats,
      buildingDebugFootprints,
      fetchedAt: Date.now()
    };
  }

  /**
   * 清除本地 IndexedDB 快取
   */
  public async clearCache(): Promise<void> {
    await this.cache.clearAll();
  }
}
