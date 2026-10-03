/**
 * SignboardGenerator.ts - 3D 店家招牌系統與真實街景看板生成器
 * 依據 RULES.md 與使用者最新規格：
 * 1. 找不到真實建築時，先在該店家點生成一棟 2~3 層、寬 6~8m 的台灣風格透天店面建築並貼上招牌
 * 2. 只有在道路上或水域內之不可蓋房位置才降級為路邊獨立立柱，並自動推移至人行道邊緣
 * 3. 招牌尺寸限制：橫式寬 <= 4.0m, 高 <= 0.8m；直式突出高 <= 3.0m, 寬 <= 0.8m
 * 4. 統計與 HUD 顯示：真實建築 / 補生成店面 / 路邊立柱 三種招牌分佈
 * 5. 支援 F3 彩色除錯小球與懸浮標籤
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { BuildingCollisionData } from './BuildingGenerator.ts';
import { BuildingFeature, Point2D, PolygonFeature, RoadFeature, ShopFeature, SignboardPipelineStats } from '../geo/OsmTypes.ts';

interface WallCandidate {
  p1: Point2D;
  p2: Point2D;
  center: Point2D;
  normal: { x: number; z: number };
  length: number;
  distToRoad: number;
}

interface SignboardItem {
  shop: ShopFeature;
  mesh: THREE.Object3D;
  isStandalone: boolean;
  status: 'wall' | 'procedural_shop' | 'pole' | 'failed';
  failReason?: string;
}

export class SignboardGenerator {
  private signboardGroup: THREE.Group;
  private proceduralBuildingsGroup: THREE.Group;
  private debugGroup: THREE.Group;
  private items: SignboardItem[] = [];
  private stats: SignboardPipelineStats | null = null;
  private isDebugVisible = false;

  private frustum = new THREE.Frustum();
  private projScreenMatrix = new THREE.Matrix4();
  private tempSphere = new THREE.Sphere();

  constructor() {
    this.signboardGroup = new THREE.Group();
    this.signboardGroup.name = 'Signboard_Group';

    this.proceduralBuildingsGroup = new THREE.Group();
    this.proceduralBuildingsGroup.name = 'Procedural_Shop_Buildings_Group';

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'Signboard_Debug_Group';
    this.debugGroup.visible = false;
  }

  /**
   * 生成所有店家招牌 3D 物件並加入場景 (回傳統計與補生成店面之碰撞體清單)
   */
  public async generate(
    shops: ShopFeature[],
    buildings: BuildingFeature[],
    roads: RoadFeature[],
    features: PolygonFeature[],
    scene: THREE.Scene,
    initialStats?: SignboardPipelineStats
  ): Promise<{ stats: SignboardPipelineStats; extraBuildingColliders: BuildingCollisionData[] }> {
    this.dispose(scene);

    const extraBuildingColliders: BuildingCollisionData[] = [];

    // 確保字體載入完畢，避免 Canvas 繪圖字型閃爍或破圖
    if (typeof document !== 'undefined' && document.fonts) {
      try {
        await document.fonts.ready;
      } catch {}
    }

    const stats: SignboardPipelineStats = initialStats || {
      rawOverpass: { node: 0, way: 0, relation: 0, total: shops.length },
      normalizedNamed: shops.length,
      matchedToBuilding: 0,
      matchFailedDistance: 0,
      foundStreetWall: 0,
      onRealBuilding: 0,
      onProceduralShop: 0,
      standalonePole: 0,
      generatedMeshes: 0,
      visibleInFrustum: 0,
      realCount: shops.filter((s) => !s.isFictional).length,
      fictionalCount: shops.filter((s) => s.isFictional).length
    };

    const maxMatchDist = CONFIG.SIGNBOARD.MATCH_MAX_DISTANCE; // 30 公尺

    for (const shop of shops) {
      // --- 步驟 3：配對建築物 ---
      let pairedBuilding: BuildingFeature | null = null;

      // A. 先檢查是否直接在某棟建築多邊形內部
      for (const b of buildings) {
        if (this.isPointInPolygon(shop.point, b.footprint)) {
          pairedBuilding = b;
          break;
        }
      }

      // B. 若不在建築內，尋找 30 公尺內之最近建築
      let closestDist = Infinity;
      if (!pairedBuilding) {
        for (const b of buildings) {
          const d = this.getDistanceToBuilding(shop.point, b.footprint);
          if (d < closestDist) {
            closestDist = d;
            if (d <= maxMatchDist) {
              pairedBuilding = b;
            }
          }
        }
      }

      if (pairedBuilding) {
        stats.matchedToBuilding++;
      } else {
        stats.matchFailedDistance++;
      }

      // --- 步驟 4：尋找臨街牆面 ---
      let streetWall: WallCandidate | null = null;
      if (pairedBuilding) {
        streetWall = this.findBestStreetWall(shop.point, pairedBuilding, roads);
      }

      // --- 步驟 5：生成 3D 招牌 Mesh (與步驟 4 改善備援) ---
      if (streetWall) {
        // 情況 1：成功配對到真實建築臨街牆面
        stats.foundStreetWall++;
        stats.onRealBuilding++;
        const mesh = this.createWallSignboard(shop, streetWall);
        this.signboardGroup.add(mesh);
        stats.generatedMeshes++;

        this.items.push({
          shop,
          mesh,
          isStandalone: false,
          status: 'wall'
        });

        this.addDebugMarker(shop, 'wall');
      } else {
        // 未配對到真實建物或無臨街外牆：執行【步驟 4：招牌備援改善】
        const roadInfo = this.findNearestRoadInfo(shop.point, roads);

        // 檢查是否完全不適合蓋房子 (在馬路車道上或水域中)
        const isOnRoad = roadInfo ? roadInfo.dist < (roadInfo.road.width * 0.5 + 0.6) : false;
        let isInWater = false;
        for (const f of features) {
          if (f.kind === 'water' && this.isPointInPolygon(shop.point, f.polygon)) {
            isInWater = true;
            break;
          }
        }

        if (isOnRoad || isInWater) {
          // 情況 2：在車道或水域上，不可蓋房子，改為路邊立柱並移動到人行道邊緣
          let polePos = { x: shop.point.x, z: shop.point.z };
          if (roadInfo) {
            const sidewalkOffset = roadInfo.road.width * 0.5 + roadInfo.road.sidewalkWidth * 0.5;
            polePos = {
              x: roadInfo.projPt.x + roadInfo.norm.x * sidewalkOffset,
              z: roadInfo.projPt.z + roadInfo.norm.z * sidewalkOffset
            };
          }
          stats.standalonePole++;
          const poleMesh = this.createStandalonePoleSignboard(shop, roads, polePos);
          this.signboardGroup.add(poleMesh);
          stats.generatedMeshes++;

          this.items.push({
            shop,
            mesh: poleMesh,
            isStandalone: true,
            status: 'pole',
            failReason: isOnRoad ? '位於車道中央，移至人行道立柱' : '位於水域內，移至岸邊立柱'
          });

          this.addDebugMarker(shop, 'pole', Math.round(roadInfo ? roadInfo.dist : 0));
        } else {
          // 情況 3：適合蓋房子！先在店家點生成一棟 2~3 層、寬 6~8m 的台灣風格店面街屋，再貼上招牌
          stats.onProceduralShop++;
          const { buildingMesh, collider, frontWall } = this.createProceduralShophouse(shop, roadInfo);
          this.proceduralBuildingsGroup.add(buildingMesh);
          extraBuildingColliders.push(collider);

          const signMesh = this.createWallSignboard(shop, frontWall);
          this.signboardGroup.add(signMesh);
          stats.generatedMeshes++;

          this.items.push({
            shop,
            mesh: signMesh,
            isStandalone: false,
            status: 'procedural_shop'
          });

          this.addDebugMarker(shop, 'procedural_shop');
        }
      }
    }

    // 輸出管線完整診斷數量
    console.log(
      `%c[招牌管線第 3 關] 配對真實建築: ${stats.onRealBuilding} 家 | 補生成店面: ${stats.onProceduralShop} 棟 | 轉路邊立柱: ${stats.standalonePole} 支 (門檻: ${maxMatchDist}m)`,
      'color: #22c55e; font-weight: bold;'
    );
    console.log(
      `%c[招牌管線第 4 關] 找到臨街牆面: ${stats.foundStreetWall + stats.onProceduralShop} 面 (真實建物: ${stats.onRealBuilding}, 補生成店面: ${stats.onProceduralShop})`,
      'color: #22c55e; font-weight: bold;'
    );
    console.log(
      `%c[招牌管線第 5 關] 實際生成招牌 Mesh 總數: ${stats.generatedMeshes} 個 [真實建物: ${stats.onRealBuilding} | 補生成店面: ${stats.onProceduralShop} | 路邊立柱: ${stats.standalonePole}]`,
      'color: #22c55e; font-weight: bold;'
    );

    scene.add(this.proceduralBuildingsGroup);
    scene.add(this.signboardGroup);
    scene.add(this.debugGroup);

    this.stats = stats;
    return { stats, extraBuildingColliders };
  }

  /**
   * 建立橫式貼牆招牌 Mesh (依規定尺寸上限寬 <= 4.0m, 高 <= 0.8m)
   */
  private createWallSignboard(shop: ShopFeature, wall: WallCandidate): THREE.Object3D {
    const group = new THREE.Group();

    const rawW = Math.min(wall.length * 0.7, CONFIG.SIGNBOARD.WALL_SIGN_WIDTH);
    const signW = Math.min(rawW, CONFIG.SIGNBOARD.WALL_SIGN_MAX_WIDTH); // 上限 4.0m
    const signH = Math.min(CONFIG.SIGNBOARD.WALL_SIGN_HEIGHT, CONFIG.SIGNBOARD.WALL_SIGN_MAX_HEIGHT); // 上限 0.8m
    const signD = CONFIG.SIGNBOARD.WALL_SIGN_DEPTH;

    // 1. 動態 Canvas 2D 生成高解析台灣招牌貼圖
    const canvasTexture = this.drawCanvasTexture(shop, 512, 160);

    // 2. 招牌主體幾何與材質
    const signMat = new THREE.MeshStandardMaterial({
      map: canvasTexture,
      emissive: 0xffffff,
      emissiveMap: canvasTexture,
      emissiveIntensity: CONFIG.SIGNBOARD.EMISSIVE_INTENSITY,
      roughness: 0.35,
      metalness: 0.1,
      side: THREE.DoubleSide
    });

    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x22262c,
      roughness: 0.7,
      metalness: 0.3
    });

    // 多面材質：+Z 正面為店名貼圖，其餘 5 面為深色金屬邊框
    const materials: THREE.Material[] = [
      frameMat, frameMat, frameMat, frameMat, signMat, frameMat
    ];

    const boxGeo = new THREE.BoxGeometry(signW, signH, signD);
    const boxMesh = new THREE.Mesh(boxGeo, materials);
    boxMesh.castShadow = true;
    boxMesh.receiveShadow = true;
    group.add(boxMesh);

    // 3. 小型壁掛支架
    const bracketGeo = new THREE.CylinderGeometry(0.04, 0.04, CONFIG.SIGNBOARD.WALL_OFFSET + signD, 6);
    bracketGeo.rotateX(Math.PI / 2);
    const bracketMat = new THREE.MeshStandardMaterial({ color: 0x374151, metalness: 0.6 });
    const b1 = new THREE.Mesh(bracketGeo, bracketMat);
    b1.position.set(-signW * 0.35, 0, -signD * 0.5 - CONFIG.SIGNBOARD.WALL_OFFSET * 0.5);
    const b2 = new THREE.Mesh(bracketGeo, bracketMat);
    b2.position.set(signW * 0.35, 0, -signD * 0.5 - CONFIG.SIGNBOARD.WALL_OFFSET * 0.5);
    group.add(b1);
    group.add(b2);

    // 4. 定位在牆面中心或店家點投影位置 (一樓高度約 3.2m)
    const yPos = CONFIG.SIGNBOARD.DEFAULT_HEIGHT;
    const offset = CONFIG.SIGNBOARD.WALL_OFFSET + signD * 0.5;

    const posX = wall.center.x + wall.normal.x * offset;
    const posZ = wall.center.z + wall.normal.z * offset;
    group.position.set(posX, yPos, posZ);

    // 朝向：法線方向
    const angle = Math.atan2(wall.normal.x, wall.normal.z);
    group.rotation.y = angle;

    return group;
  }

  /**
   * 建立獨立直式招牌立柱 (依規定尺寸上限高 <= 3.0m, 寬 <= 0.8m)
   */
  private createStandalonePoleSignboard(shop: ShopFeature, roads: RoadFeature[], customPos?: Point2D): THREE.Object3D {
    const group = new THREE.Group();
    const poleH = CONFIG.SIGNBOARD.STANDALONE_POLE_HEIGHT;
    const signW = Math.min(CONFIG.SIGNBOARD.STANDALONE_SIGN_WIDTH, CONFIG.SIGNBOARD.PROJECTING_SIGN_MAX_WIDTH); // 0.8m
    const signH = Math.min(CONFIG.SIGNBOARD.STANDALONE_SIGN_HEIGHT, CONFIG.SIGNBOARD.PROJECTING_SIGN_MAX_HEIGHT); // 2.4m ~ 3.0m
    const signD = 0.12;

    // 1. 直立金屬立柱
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.07, poleH, 8);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x4b5563, roughness: 0.5, metalness: 0.6 });
    const poleMesh = new THREE.Mesh(poleGeo, poleMat);
    poleMesh.position.y = poleH * 0.5;
    poleMesh.castShadow = true;
    poleMesh.receiveShadow = true;
    group.add(poleMesh);

    // 2. 直式店名貼圖 (直書高對比看板)
    const canvasTexture = this.drawCanvasTexture(shop, 256, 480, true);

    const signMat = new THREE.MeshStandardMaterial({
      map: canvasTexture,
      emissive: 0xffffff,
      emissiveMap: canvasTexture,
      emissiveIntensity: CONFIG.SIGNBOARD.EMISSIVE_INTENSITY,
      roughness: 0.35,
      metalness: 0.1,
      side: THREE.DoubleSide
    });

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.7 });
    const materials: THREE.Material[] = [
      frameMat, frameMat, frameMat, frameMat, signMat, signMat
    ];

    const boxGeo = new THREE.BoxGeometry(signW, signH, signD);
    const boxMesh = new THREE.Mesh(boxGeo, materials);
    boxMesh.position.y = poleH * 0.65;
    boxMesh.castShadow = true;
    boxMesh.receiveShadow = true;
    group.add(boxMesh);

    // 3. 定位至指定座標 (或店家原座標)
    const posX = customPos ? customPos.x : shop.point.x;
    const posZ = customPos ? customPos.z : shop.point.z;
    group.position.set(posX, 0, posZ);

    // 朝向面對最近道路
    const nearestRoad = this.findNearestRoadInfo(shop.point, roads);
    if (nearestRoad) {
      const dx = nearestRoad.projPt.x - posX;
      const dz = nearestRoad.projPt.z - posZ;
      group.rotation.y = Math.atan2(dx, dz);
    }

    return group;
  }

  /**
   * 步驟 4：為未配對到店家的空地生成 2~3 層台灣透天街屋店面建築
   */
  private createProceduralShophouse(
    shop: ShopFeature,
    roadInfo: { road: RoadFeature; projPt: Point2D; dist: number; norm: Point2D } | null
  ): { buildingMesh: THREE.Object3D; collider: BuildingCollisionData; frontWall: WallCandidate } {
    const group = new THREE.Group();
    group.name = `ProceduralShophouse_${shop.id}`;

    // 1. 朝向與向量 (正面面向最近道路)
    let toRoad = { x: 0, z: -1 };
    if (roadInfo) {
      const dx = roadInfo.projPt.x - shop.point.x;
      const dz = roadInfo.projPt.z - shop.point.z;
      const len = Math.hypot(dx, dz);
      if (len > 0.05) {
        toRoad = { x: dx / len, z: dz / len };
      }
    }
    const perp = { x: -toRoad.z, z: toRoad.x };

    // 2. 街屋尺寸 (寬 7.2m, 深 8.5m, 高 7.5m 約 2.5 樓)
    const w = 7.2;
    const d = 8.5;
    const h = 7.5;

    // 決定性雜湊色票
    let hash = 0;
    for (let i = 0; i < shop.name.length; i++) hash = (hash << 5) - hash + shop.name.charCodeAt(i);
    const palette = CONFIG.BUILDINGS.PROCEDURAL_SHOP.PALETTE;
    const wallColor = palette[Math.abs(hash) % palette.length];
    const roofColor = CONFIG.BUILDINGS.PROCEDURAL_SHOP.ROOF_PALETTE[Math.abs(hash * 3) % CONFIG.BUILDINGS.PROCEDURAL_SHOP.ROOF_PALETTE.length];

    // 主體建物質感
    const wallMat = new THREE.MeshStandardMaterial({
      color: wallColor,
      roughness: 0.82,
      metalness: 0.1
    });
    const roofMat = new THREE.MeshStandardMaterial({
      color: roofColor,
      roughness: 0.6,
      metalness: 0.2
    });

    // 主體方塊：正面中心在 (0, 0, 0)，向後延伸 d
    const mainBodyGeo = new THREE.BoxGeometry(w, h, d);
    const mainMesh = new THREE.Mesh(mainBodyGeo, wallMat);
    mainMesh.position.set(0, h * 0.5, -d * 0.5);
    mainMesh.castShadow = true;
    mainMesh.receiveShadow = true;
    group.add(mainMesh);

    // 屋頂女兒牆加厚裝飾
    const parapetGeo = new THREE.BoxGeometry(w + 0.1, 0.45, d + 0.1);
    const parapetMesh = new THREE.Mesh(parapetGeo, roofMat);
    parapetMesh.position.set(0, h + 0.22, -d * 0.5);
    parapetMesh.castShadow = true;
    group.add(parapetMesh);

    // 一樓店面入口玻璃門 (深色玻璃)
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      roughness: 0.2,
      metalness: 0.8
    });
    const glassGeo = new THREE.PlaneGeometry(w * 0.8, 2.6);
    const glassMesh = new THREE.Mesh(glassGeo, glassMat);
    glassMesh.position.set(0, 1.3, 0.02);
    group.add(glassMesh);

    // 一樓外伸雨遮 / 招牌遮陽棚
    const awningMat = new THREE.MeshStandardMaterial({
      color: 0x854d0e,
      roughness: 0.5,
      metalness: 0.3
    });
    const awningGeo = new THREE.BoxGeometry(w * 0.95, 0.12, 1.3);
    const awningMesh = new THREE.Mesh(awningGeo, awningMat);
    awningMesh.position.set(0, 2.65, 0.55);
    awningMesh.rotation.x = 0.08;
    awningMesh.castShadow = true;
    group.add(awningMesh);

    // 二樓、三樓正面窗戶
    const winGeo = new THREE.BoxGeometry(1.2, 1.4, 0.1);
    const win1 = new THREE.Mesh(winGeo, glassMat);
    win1.position.set(-w * 0.25, 4.8, 0.02);
    group.add(win1);
    const win2 = new THREE.Mesh(winGeo, glassMat);
    win2.position.set(w * 0.25, 4.8, 0.02);
    group.add(win2);

    // 位移與旋轉到店家座標
    group.position.set(shop.point.x, 0, shop.point.z);
    const angle = Math.atan2(toRoad.x, toRoad.z);
    group.rotation.y = angle;

    // 計算 Footprint 與 Collider
    const p1 = { x: shop.point.x + perp.x * (w / 2), z: shop.point.z + perp.z * (w / 2) };
    const p2 = { x: shop.point.x - perp.x * (w / 2), z: shop.point.z - perp.z * (w / 2) };
    const p3 = { x: p2.x - toRoad.x * d, z: p2.z - toRoad.z * d };
    const p4 = { x: p1.x - toRoad.x * d, z: p1.z - toRoad.z * d };

    const minX = Math.min(p1.x, p2.x, p3.x, p4.x);
    const maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
    const minZ = Math.min(p1.z, p2.z, p3.z, p4.z);
    const maxZ = Math.max(p1.z, p2.z, p3.z, p4.z);

    const collider: BuildingCollisionData = {
      id: `procedural_shop_${shop.id}`,
      minX,
      maxX,
      minZ,
      maxZ,
      footprint: [p1, p2, p3, p4],
      height: h
    };

    const frontWall: WallCandidate = {
      p1,
      p2,
      center: { x: shop.point.x, z: shop.point.z },
      normal: toRoad,
      length: w,
      distToRoad: roadInfo ? roadInfo.dist : 0
    };

    return { buildingMesh: group, collider, frontWall };
  }

  /**
   * 使用 Canvas 2D 動態繪製經典台灣街景風格招牌貼圖
   */
  private drawCanvasTexture(shop: ShopFeature, width: number, height: number, isVertical: boolean = false): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    // 依據店家類型與名稱取得主題配色
    const theme = this.getShopColorTheme(shop);

    // 1. 底色
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    // 2. 經典雙色飾條或外框
    if (!isVertical) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(0, 0, width, 14);
      ctx.fillRect(0, height - 14, width, 14);

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.strokeRect(6, 6, width - 12, height - 12);
    } else {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(0, 0, width, 24);
      ctx.fillRect(0, height - 24, width, 24);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.strokeRect(6, 6, width - 12, height - 12);
    }

    // 3. 類別小標籤
    const categoryTag = theme.tag;
    ctx.font = isVertical ? 'bold 18px "Microsoft JhengHei", sans-serif' : 'bold 16px "Microsoft JhengHei", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (!isVertical) {
      ctx.fillText(categoryTag, width / 2, 28);
    } else {
      ctx.fillText(categoryTag, width / 2, 42);
    }

    // 4. 店家大名稱 (粗體、外發光黑色陰影邊框、高對比)
    const name = shop.name;
    if (!isVertical) {
      const fontSize = Math.min(46, Math.floor((width * 0.85) / Math.max(name.length, 3)));
      ctx.font = `900 ${fontSize}px "Microsoft JhengHei", "PingFang TC", sans-serif`;

      const textY = height * 0.65;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 7;
      ctx.strokeText(name, width / 2, textY);

      ctx.fillStyle = theme.text;
      ctx.fillText(name, width / 2, textY);
    } else {
      const chars = name.split('').slice(0, 6);
      const totalChars = chars.length;
      const startY = 70;
      const availH = height - 100;
      const stepY = availH / Math.max(totalChars, 1);
      const fontSize = Math.min(38, Math.floor(stepY * 0.75));

      ctx.font = `900 ${fontSize}px "Microsoft JhengHei", "PingFang TC", sans-serif`;

      for (let i = 0; i < totalChars; i++) {
        const y = startY + i * stepY + stepY * 0.5;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 6;
        ctx.strokeText(chars[i], width / 2, y);

        ctx.fillStyle = theme.text;
        ctx.fillText(chars[i], width / 2, y);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipMapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
  }

  /**
   * 根據店家類別與名稱產生經典店家色票
   */
  private getShopColorTheme(shop: ShopFeature): { bg: string; accent: string; text: string; tag: string } {
    const n = shop.name.toLowerCase();
    const c = shop.category;
    const s = shop.subCategory.toLowerCase();

    // 7-Eleven
    if (n.includes('7-11') || n.includes('7-eleven') || n.includes('統一超商')) {
      return { bg: '#007a3d', accent: '#f58220', text: '#ffffff', tag: '7-ELEVEn 24H' };
    }
    // 全家
    if (n.includes('全家') || n.includes('familymart')) {
      return { bg: '#00a0e9', accent: '#009944', text: '#ffffff', tag: 'FamilyMart 全家' };
    }
    // 飲料 / 咖啡
    if (s.includes('cafe') || s.includes('tea') || n.includes('50嵐') || n.includes('清心') || n.includes('茶')) {
      return { bg: '#eab308', accent: '#15803d', text: '#000000', tag: '冷熱現調飲品' };
    }
    // 溫泉 / 湯屋 / 飯店
    if (n.includes('溫泉') || n.includes('湯屋') || s.includes('hotel') || c === 'tourism') {
      return { bg: '#0284c7', accent: '#38bdf8', text: '#ffffff', tag: '♨️ 礁溪名泉湯屋' };
    }
    // 名產 / 伴手禮
    if (n.includes('名產') || n.includes('奕順軒') || n.includes('蔥油餅') || n.includes('鴨賞') || s.includes('bakery')) {
      return { bg: '#dc2626', accent: '#fbbf24', text: '#ffffff', tag: '宜蘭在地必吃名產' };
    }
    // 餐廳 / 小吃 / 拉麵
    if (c === 'amenity' || s.includes('restaurant') || s.includes('fast_food') || n.includes('拉麵') || n.includes('牛肉麵')) {
      return { bg: '#b91c1c', accent: '#f97316', text: '#ffffff', tag: '道地美食物產' };
    }
    // 藥妝
    if (s.includes('chemist') || n.includes('康是美') || n.includes('屈臣氏')) {
      return { bg: '#0d9488', accent: '#ea580c', text: '#ffffff', tag: '美妝保健生活館' };
    }

    const palettes = [
      { bg: '#1d4ed8', accent: '#60a5fa', text: '#ffffff', tag: '在地精選名店' },
      { bg: '#c2410c', accent: '#fde047', text: '#ffffff', tag: '人氣特選商號' },
      { bg: '#047857', accent: '#a7f3d0', text: '#ffffff', tag: '專業優質服務' },
      { bg: '#7c2d12', accent: '#fed7aa', text: '#ffffff', tag: '傳統老字號' }
    ];
    let hash = 0;
    for (let i = 0; i < shop.name.length; i++) hash = (hash << 5) - hash + shop.name.charCodeAt(i);
    return palettes[Math.abs(hash) % palettes.length];
  }

  /**
   * 步驟 4：除錯視覺化 (F3 模式小球與店名懸浮標籤)
   */
  private addDebugMarker(shop: ShopFeature, status: 'wall' | 'procedural_shop' | 'pole' | 'failed', distFailMeters?: number): void {
    const markerGroup = new THREE.Group();

    // 狀態球顏色
    let color = 0x22c55e; // 綠 (真實牆面)
    if (status === 'procedural_shop') color = 0x06b6d4; // 藍青 (補生成店面)
    else if (status === 'pole') color = 0xeab308; // 黃 (路邊立柱)
    else if (status === 'failed') color = 0xef4444; // 紅

    const sphereGeo = new THREE.SphereGeometry(0.35, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({ color, wireframe: false });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.set(shop.point.x, 2.0, shop.point.z);
    markerGroup.add(sphere);

    // 懸浮店名標籤 Sprite
    const labelSprite = this.createDebugLabelSprite(shop.name, status, distFailMeters);
    labelSprite.position.set(shop.point.x, 2.9, shop.point.z);
    markerGroup.add(labelSprite);

    this.debugGroup.add(markerGroup);
  }

  private createDebugLabelSprite(name: string, status: string, distMeters?: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 80;
    const ctx = canvas.getContext('2d')!;

    // 背景色
    if (status === 'wall') {
      ctx.fillStyle = 'rgba(22, 101, 52, 0.88)';
    } else if (status === 'procedural_shop') {
      ctx.fillStyle = 'rgba(14, 116, 144, 0.88)';
    } else if (status === 'pole') {
      ctx.fillStyle = 'rgba(133, 77, 14, 0.88)';
    } else {
      ctx.fillStyle = 'rgba(153, 27, 27, 0.88)';
    }

    ctx.roundRect(4, 4, 312, 72, 10);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = 'bold 22px "Microsoft JhengHei", sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.slice(0, 10), 160, 28);

    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#ffffff';
    let subText = '✓ 真實建物招牌';
    if (status === 'procedural_shop') subText = '✓ 補生成店面招牌';
    else if (status === 'pole') subText = `⚠ 路邊人行道立柱 (${distMeters ? distMeters + 'm' : ''})`;
    ctx.fillText(subText, 160, 54);

    const texture = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(3.6, 0.9, 1);
    return sprite;
  }

  /**
   * 步驟 6：逐幀計算視野錐 (Frustum Culling) 內招牌渲染數
   */
  public updateFrustum(camera: THREE.Camera): number {
    if (!this.stats || this.items.length === 0) return 0;

    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    let count = 0;
    for (const item of this.items) {
      this.tempSphere.center.copy(item.mesh.position);
      this.tempSphere.radius = 4.0;
      if (this.frustum.intersectsSphere(this.tempSphere)) {
        count++;
      }
    }

    this.stats.visibleInFrustum = count;
    return count;
  }

  public getItems(): SignboardItem[] {
    return this.items;
  }

  public toggleDebug(forceState?: boolean): boolean {
    this.isDebugVisible = forceState !== undefined ? forceState : !this.isDebugVisible;
    this.debugGroup.visible = this.isDebugVisible;
    return this.isDebugVisible;
  }

  public getIsDebugVisible(): boolean {
    return this.isDebugVisible;
  }

  public getStats(): SignboardPipelineStats | null {
    return this.stats;
  }

  // --- 幾何輔助計算 ---

  private findBestStreetWall(
    shopPt: Point2D,
    building: BuildingFeature,
    roads: RoadFeature[]
  ): WallCandidate | null {
    const poly = building.footprint;
    if (poly.length < 3) return null;

    const walls: WallCandidate[] = [];
    let cx = 0, cz = 0;
    for (const p of poly) {
      cx += p.x;
      cz += p.z;
    }
    cx /= poly.length;
    cz /= poly.length;

    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const len = Math.hypot(dx, dz);
      if (len < 1.2) continue;

      const midX = (p1.x + p2.x) * 0.5;
      const midZ = (p1.z + p2.z) * 0.5;

      let nx = -dz / len;
      let nz = dx / len;

      const toMidX = midX - cx;
      const toMidZ = midZ - cz;
      if (nx * toMidX + nz * toMidZ < 0) {
        nx = -nx;
        nz = -nz;
      }

      let minRoadDist = Infinity;
      for (const r of roads) {
        for (const pt of r.points) {
          const d = Math.hypot(midX - pt.x, midZ - pt.z);
          if (d < minRoadDist) minRoadDist = d;
        }
      }

      walls.push({
        p1,
        p2,
        center: { x: midX, z: midZ },
        normal: { x: nx, z: nz },
        length: len,
        distToRoad: minRoadDist
      });
    }

    if (walls.length === 0) return null;

    let bestWall: WallCandidate | null = null;
    let bestScore = Infinity;

    for (const w of walls) {
      const distToShop = Math.hypot(w.center.x - shopPt.x, w.center.z - shopPt.z);
      const score = distToShop * 1.5 + w.distToRoad * 0.5;
      if (score < bestScore) {
        bestScore = score;
        bestWall = w;
      }
    }

    return bestWall;
  }

  private findNearestRoadInfo(
    pt: Point2D,
    roads: RoadFeature[]
  ): { road: RoadFeature; projPt: Point2D; dist: number; norm: Point2D } | null {
    let minDist = Infinity;
    let bestResult: { road: RoadFeature; projPt: Point2D; dist: number; norm: Point2D } | null = null;

    for (const r of roads) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const p1 = r.points[i];
        const p2 = r.points[i + 1];
        const proj = this.projectOnSegment(pt, p1, p2);
        const d = Math.hypot(pt.x - proj.x, pt.z - proj.z);
        if (d < minDist) {
          minDist = d;
          let nx = pt.x - proj.x;
          let nz = pt.z - proj.z;
          const nLen = Math.hypot(nx, nz);
          if (nLen > 0.01) {
            nx /= nLen;
            nz /= nLen;
          } else {
            const rx = p2.x - p1.x;
            const rz = p2.z - p1.z;
            const rLen = Math.hypot(rx, rz) || 1;
            nx = -rz / rLen;
            nz = rx / rLen;
          }
          bestResult = {
            road: r,
            projPt: proj,
            dist: d,
            norm: { x: nx, z: nz }
          };
        }
      }
    }
    return bestResult;
  }

  private projectOnSegment(p: Point2D, v: Point2D, w: Point2D): Point2D {
    const l2 = (v.x - w.x) ** 2 + (v.z - w.z) ** 2;
    if (l2 === 0) return { x: v.x, z: v.z };
    let t = ((p.x - v.x) * (w.x - v.x) + (p.z - v.z) * (w.z - v.z)) / l2;
    t = Math.max(0, Math.min(1, t));
    return {
      x: v.x + t * (w.x - v.x),
      z: v.z + t * (w.z - v.z)
    };
  }

  private isPointInPolygon(pt: Point2D, poly: Point2D[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, zi = poly[i].z;
      const xj = poly[j].x, zj = poly[j].z;
      const intersect = zi > pt.z !== zj > pt.z && pt.x < ((xj - xi) * (pt.z - zi)) / (zj - zi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  private getDistanceToBuilding(pt: Point2D, poly: Point2D[]): number {
    let minDist = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const d = this.distToSegment(pt, p1, p2);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  private distToSegment(p: Point2D, v: Point2D, w: Point2D): number {
    const l2 = (v.x - w.x) * (v.x - w.x) + (v.z - w.z) * (v.z - w.z);
    if (l2 === 0) return Math.hypot(p.x - v.x, p.z - v.z);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.z - v.z) * (w.z - v.z)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projX = v.x + t * (w.x - v.x);
    const projZ = v.z + t * (w.z - v.z);
    return Math.hypot(p.x - projX, p.z - projZ);
  }

  public dispose(scene: THREE.Scene): void {
    if (this.signboardGroup) {
      scene.remove(this.signboardGroup);
      this.signboardGroup.clear();
    }
    if (this.proceduralBuildingsGroup) {
      scene.remove(this.proceduralBuildingsGroup);
      this.proceduralBuildingsGroup.clear();
    }
    if (this.debugGroup) {
      scene.remove(this.debugGroup);
      this.debugGroup.clear();
    }
    this.items = [];
    this.stats = null;
  }
}
