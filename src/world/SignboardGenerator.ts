/**
 * SignboardGenerator.ts - 3D 店家招牌系統與真實街景看板生成器 (GTA 風格升級)
 * 1. 找不到真實建築時，生成 2~3 層台灣風格透天店面建築並貼上招牌 (幾何全數合併渲染，極致降低 Draw Calls)
 * 2. 招牌壁掛支架與立柱全數採用 InstancedMesh，使全城招牌 Draw Calls 降至 300 以下
 * 3. 支援夜間霓虹模式 (按 T 切換)：emissive 強度提高並觸發 Bloom 光暈
 * 4. 招牌材質加入輕微老舊邊緣與固定螺栓質感
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

  private bracketsMesh: THREE.InstancedMesh | null = null;
  private polesMesh: THREE.InstancedMesh | null = null;
  private mergedProceduralMesh: THREE.Mesh | null = null;

  private items: SignboardItem[] = [];
  private signMaterials: THREE.MeshStandardMaterial[] = [];
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
    this.signMaterials = [];

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

    // 收集支架、立柱 Transform 矩陣
    const bracketTransforms: THREE.Matrix4[] = [];
    const poleTransforms: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();

    // 收集所有補生成透天街屋的頂點與顏色 (全數合併為 1 個 Mesh，消滅數百個 Draw Calls！)
    const procPos: number[] = [];
    const procNorm: number[] = [];
    const procCol: number[] = [];
    const procIdx: number[] = [];
    let procVertexOffset = 0;

    for (const shop of shops) {
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

      let streetWall: WallCandidate | null = null;
      if (pairedBuilding) {
        streetWall = this.findBestStreetWall(shop.point, pairedBuilding, roads);
      }

      if (streetWall) {
        // 情況 1：成功配對到真實建築臨街牆面
        stats.foundStreetWall++;
        stats.onRealBuilding++;
        const mesh = this.createWallSignboard(shop, streetWall, bracketTransforms, dummy);
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

        const isOnRoad = roadInfo ? roadInfo.dist < (roadInfo.road.width * 0.5 + 0.6) : false;
        let isInWater = false;
        for (const f of features) {
          if (f.kind === 'water' && this.isPointInPolygon(shop.point, f.polygon)) {
            isInWater = true;
            break;
          }
        }

        if (isOnRoad || isInWater) {
          // 情況 2：在車道或水域上，轉為路邊立柱
          let polePos = { x: shop.point.x, z: shop.point.z };
          if (roadInfo) {
            const sidewalkOffset = roadInfo.road.width * 0.5 + roadInfo.road.sidewalkWidth * 0.5;
            polePos = {
              x: roadInfo.projPt.x + roadInfo.norm.x * sidewalkOffset,
              z: roadInfo.projPt.z + roadInfo.norm.z * sidewalkOffset
            };
          }
          stats.standalonePole++;
          const poleMesh = this.createStandalonePoleSignboard(shop, roads, poleTransforms, dummy, polePos);
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
          // 情況 3：適合蓋房子！先在店家點生成一棟 2~3 層、寬 6~8m 的台灣風格透天街屋店面建築
          stats.onProceduralShop++;
          const { collider, frontWall } = this.appendProceduralShophouseGeometry(
            shop, roadInfo,
            procPos, procNorm, procCol, procIdx,
            () => procVertexOffset,
            (v) => procVertexOffset = v
          );
          extraBuildingColliders.push(collider);

          const signMesh = this.createWallSignboard(shop, frontWall, bracketTransforms, dummy);
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

    // --- 建立合併透天店面結構 Mesh (僅佔 1 Draw Call) ---
    if (procPos.length > 0) {
      const procGeo = new THREE.BufferGeometry();
      procGeo.setAttribute('position', new THREE.Float32BufferAttribute(procPos, 3));
      procGeo.setAttribute('normal', new THREE.Float32BufferAttribute(procNorm, 3));
      procGeo.setAttribute('color', new THREE.Float32BufferAttribute(procCol, 3));
      procGeo.setIndex(procIdx);
      procGeo.computeBoundingBox();
      procGeo.computeBoundingSphere();

      const procMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.82,
        metalness: 0.1
      });

      this.mergedProceduralMesh = new THREE.Mesh(procGeo, procMat);
      this.mergedProceduralMesh.name = 'Merged_Procedural_Shophouses';
      this.mergedProceduralMesh.castShadow = true;
      this.mergedProceduralMesh.receiveShadow = true;
      this.mergedProceduralMesh.frustumCulled = false;
      this.proceduralBuildingsGroup.add(this.mergedProceduralMesh);
    }

    // --- 建立支架 InstancedMesh (僅佔 1 Draw Call) ---
    if (bracketTransforms.length > 0) {
      const bGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.35, 6);
      bGeo.rotateX(Math.PI / 2);
      const bMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.7, roughness: 0.5 });
      this.bracketsMesh = new THREE.InstancedMesh(bGeo, bMat, bracketTransforms.length);
      this.bracketsMesh.name = 'SignboardBrackets_Instanced';
      for (let i = 0; i < bracketTransforms.length; i++) this.bracketsMesh.setMatrixAt(i, bracketTransforms[i]);
      this.bracketsMesh.instanceMatrix.needsUpdate = true;
      this.signboardGroup.add(this.bracketsMesh);
    }

    // --- 建立立柱 InstancedMesh (僅佔 1 Draw Call) ---
    if (poleTransforms.length > 0) {
      const pGeo = new THREE.CylinderGeometry(0.06, 0.07, CONFIG.SIGNBOARD.STANDALONE_POLE_HEIGHT, 8);
      const pMat = new THREE.MeshStandardMaterial({ color: 0x475569, metalness: 0.6, roughness: 0.5 });
      this.polesMesh = new THREE.InstancedMesh(pGeo, pMat, poleTransforms.length);
      this.polesMesh.name = 'SignboardPoles_Instanced';
      for (let i = 0; i < poleTransforms.length; i++) this.polesMesh.setMatrixAt(i, poleTransforms[i]);
      this.polesMesh.instanceMatrix.needsUpdate = true;
      this.signboardGroup.add(this.polesMesh);
    }

    scene.add(this.proceduralBuildingsGroup);
    scene.add(this.signboardGroup);
    scene.add(this.debugGroup);

    this.stats = stats;
    return { stats, extraBuildingColliders };
  }

  /**
   * 建立橫式貼牆招牌 Mesh (依規定尺寸上限寬 <= 4.0m, 高 <= 0.8m)
   */
  private createWallSignboard(
    shop: ShopFeature,
    wall: WallCandidate,
    bracketTransforms: THREE.Matrix4[],
    dummy: THREE.Object3D
  ): THREE.Object3D {
    const group = new THREE.Group();

    const rawW = Math.min(wall.length * 0.7, CONFIG.SIGNBOARD.WALL_SIGN_WIDTH);
    const signW = Math.min(rawW, CONFIG.SIGNBOARD.WALL_SIGN_MAX_WIDTH);
    const signH = Math.min(CONFIG.SIGNBOARD.WALL_SIGN_HEIGHT, CONFIG.SIGNBOARD.WALL_SIGN_MAX_HEIGHT);
    const signD = CONFIG.SIGNBOARD.WALL_SIGN_DEPTH;

    // 動態 Canvas 生成招牌貼圖
    const canvasTexture = this.drawCanvasTexture(shop, 512, 160);

    const signMat = new THREE.MeshStandardMaterial({
      map: canvasTexture,
      emissive: 0xffffff,
      emissiveMap: canvasTexture,
      emissiveIntensity: CONFIG.SIGNBOARD.EMISSIVE_INTENSITY,
      roughness: 0.35,
      metalness: 0.1,
      side: THREE.DoubleSide
    });
    this.signMaterials.push(signMat);

    const boxGeo = new THREE.BoxGeometry(signW, signH, signD);
    const boxMesh = new THREE.Mesh(boxGeo, signMat);
    boxMesh.receiveShadow = true;
    group.add(boxMesh);

    // 定位在牆面中心或店家點投影位置 (一樓高度約 3.2m)
    const yPos = CONFIG.SIGNBOARD.DEFAULT_HEIGHT;
    const offset = CONFIG.SIGNBOARD.WALL_OFFSET + signD * 0.5;

    const posX = wall.center.x + wall.normal.x * offset;
    const posZ = wall.center.z + wall.normal.z * offset;
    group.position.set(posX, yPos, posZ);

    const angle = Math.atan2(wall.normal.x, wall.normal.z);
    group.rotation.y = angle;

    // 收集壁掛支架 Transforms (交給 InstancedMesh 繪製)
    const perpX = -wall.normal.z;
    const perpZ = wall.normal.x;

    for (const signSide of [-1, 1]) {
      const bx = posX + perpX * (signW * 0.35 * signSide) - wall.normal.x * (offset * 0.5);
      const bz = posZ + perpZ * (signW * 0.35 * signSide) - wall.normal.z * (offset * 0.5);
      dummy.position.set(bx, yPos, bz);
      dummy.rotation.set(0, angle, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      bracketTransforms.push(dummy.matrix.clone());
    }

    return group;
  }

  /**
   * 建立獨立直式招牌立柱 (依規定尺寸上限高 <= 3.0m, 寬 <= 0.8m)
   */
  private createStandalonePoleSignboard(
    shop: ShopFeature,
    roads: RoadFeature[],
    poleTransforms: THREE.Matrix4[],
    dummy: THREE.Object3D,
    customPos?: Point2D
  ): THREE.Object3D {
    const group = new THREE.Group();
    const poleH = CONFIG.SIGNBOARD.STANDALONE_POLE_HEIGHT;
    const signW = Math.min(CONFIG.SIGNBOARD.STANDALONE_SIGN_WIDTH, CONFIG.SIGNBOARD.PROJECTING_SIGN_MAX_WIDTH);
    const signH = Math.min(CONFIG.SIGNBOARD.STANDALONE_SIGN_HEIGHT, CONFIG.SIGNBOARD.PROJECTING_SIGN_MAX_HEIGHT);
    const signD = 0.12;

    const posX = customPos ? customPos.x : shop.point.x;
    const posZ = customPos ? customPos.z : shop.point.z;

    // 收集立柱 Transform (交由 InstancedMesh 繪製)
    dummy.position.set(posX, poleH * 0.5, posZ);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    poleTransforms.push(dummy.matrix.clone());

    // 直式店名看板
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
    this.signMaterials.push(signMat);

    const boxGeo = new THREE.BoxGeometry(signW, signH, signD);
    const boxMesh = new THREE.Mesh(boxGeo, signMat);
    boxMesh.position.y = poleH * 0.65;
    boxMesh.receiveShadow = true;
    group.add(boxMesh);

    group.position.set(posX, 0, posZ);

    const nearestRoad = this.findNearestRoadInfo(shop.point, roads);
    if (nearestRoad) {
      const dx = nearestRoad.projPt.x - posX;
      const dz = nearestRoad.projPt.z - posZ;
      group.rotation.y = Math.atan2(dx, dz);
    }

    return group;
  }

  /**
   * 步驟 4：將 2~3 層台灣透天街屋幾何寫入全城合併幾何緩衝中 (徹底消滅額外 Draw Calls)
   */
  private appendProceduralShophouseGeometry(
    shop: ShopFeature,
    roadInfo: { road: RoadFeature; projPt: Point2D; dist: number; norm: Point2D } | null,
    pos: number[],
    norm: number[],
    col: number[],
    idx: number[],
    getOffset: () => number,
    setOffset: (v: number) => void
  ): { collider: BuildingCollisionData; frontWall: WallCandidate } {
    let toRoad = { x: 0, z: -1 };
    if (roadInfo) {
      const dx = roadInfo.projPt.x - shop.point.x;
      const dz = roadInfo.projPt.z - shop.point.z;
      const len = Math.hypot(dx, dz);
      if (len > 0.05) toRoad = { x: dx / len, z: dz / len };
    }
    const perp = { x: -toRoad.z, z: toRoad.x };

    const w = 7.2;
    const d = 8.5;
    const h = 7.5;

    let hash = 0;
    for (let i = 0; i < shop.name.length; i++) hash = (hash << 5) - hash + shop.name.charCodeAt(i);
    const palette = CONFIG.BUILDINGS.PROCEDURAL_SHOP.PALETTE;
    const wallColorHex = palette[Math.abs(hash) % palette.length];
    const roofColorHex = CONFIG.BUILDINGS.PROCEDURAL_SHOP.ROOF_PALETTE[Math.abs(hash * 3) % CONFIG.BUILDINGS.PROCEDURAL_SHOP.ROOF_PALETTE.length];

    const wallColor = new THREE.Color(wallColorHex);
    const roofColor = new THREE.Color(roofColorHex);
    const darkColor = new THREE.Color(0x1e293b);
    const awningColor = new THREE.Color(0x854d0e);

    const angle = Math.atan2(toRoad.x, toRoad.z);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // 輔助將局部空間立方體旋轉平移後寫入頂點緩衝
    const addBox = (bx: number, by: number, bz: number, bw: number, bh: number, bd: number, bCol: THREE.Color) => {
      const hw = bw * 0.5, hh = bh * 0.5, hd = bd * 0.5;
      const corners = [
        // 前面
        { lx: -hw, ly: -hh, lz: hd, nx: 0, ny: 0, nz: 1 },
        { lx: hw, ly: -hh, lz: hd, nx: 0, ny: 0, nz: 1 },
        { lx: hw, ly: hh, lz: hd, nx: 0, ny: 0, nz: 1 },
        { lx: -hw, ly: hh, lz: hd, nx: 0, ny: 0, nz: 1 },
        // 後面
        { lx: hw, ly: -hh, lz: -hd, nx: 0, ny: 0, nz: -1 },
        { lx: -hw, ly: -hh, lz: -hd, nx: 0, ny: 0, nz: -1 },
        { lx: -hw, ly: hh, lz: -hd, nx: 0, ny: 0, nz: -1 },
        { lx: hw, ly: hh, lz: -hd, nx: 0, ny: 0, nz: -1 },
        // 頂面
        { lx: -hw, ly: hh, lz: hd, nx: 0, ny: 1, nz: 0 },
        { lx: hw, ly: hh, lz: hd, nx: 0, ny: 1, nz: 0 },
        { lx: hw, ly: hh, lz: -hd, nx: 0, ny: 1, nz: 0 },
        { lx: -hw, ly: hh, lz: -hd, nx: 0, ny: 1, nz: 0 },
        // 底面
        { lx: -hw, ly: -hh, lz: -hd, nx: 0, ny: -1, nz: 0 },
        { lx: hw, ly: -hh, lz: -hd, nx: 0, ny: -1, nz: 0 },
        { lx: hw, ly: -hh, lz: hd, nx: 0, ny: -1, nz: 0 },
        { lx: -hw, ly: -hh, lz: hd, nx: 0, ny: -1, nz: 0 },
        // 右面
        { lx: hw, ly: -hh, lz: hd, nx: 1, ny: 0, nz: 0 },
        { lx: hw, ly: -hh, lz: -hd, nx: 1, ny: 0, nz: 0 },
        { lx: hw, ly: hh, lz: -hd, nx: 1, ny: 0, nz: 0 },
        { lx: hw, ly: hh, lz: hd, nx: 1, ny: 0, nz: 0 },
        // 左面
        { lx: -hw, ly: -hh, lz: -hd, nx: -1, ny: 0, nz: 0 },
        { lx: -hw, ly: -hh, lz: hd, nx: -1, ny: 0, nz: 0 },
        { lx: -hw, ly: hh, lz: hd, nx: -1, ny: 0, nz: 0 },
        { lx: -hw, ly: hh, lz: -hd, nx: -1, ny: 0, nz: 0 },
      ];

      for (let face = 0; face < 6; face++) {
        const vOffset = getOffset();
        for (let v = 0; v < 4; v++) {
          const c = corners[face * 4 + v];
          const localX = bx + c.lx;
          const localY = by + c.ly;
          const localZ = bz + c.lz;

          // 旋轉角 angle (繞 Y 軸)
          const worldX = shop.point.x + (localX * cosA + localZ * sinA);
          const worldY = localY;
          const worldZ = shop.point.z + (-localX * sinA + localZ * cosA);

          const worldNx = c.nx * cosA + c.nz * sinA;
          const worldNy = c.ny;
          const worldNz = -c.nx * sinA + c.nz * cosA;

          pos.push(worldX, worldY, worldZ);
          norm.push(worldNx, worldNy, worldNz);
          col.push(bCol.r, bCol.g, bCol.b);
        }
        idx.push(
          vOffset, vOffset + 1, vOffset + 2,
          vOffset, vOffset + 2, vOffset + 3
        );
        setOffset(vOffset + 4);
      }
    };

    // 1. 主建物箱體
    addBox(0, h * 0.5, -d * 0.5, w, h, d, wallColor);
    // 2. 屋頂女兒牆
    addBox(0, h + 0.22, -d * 0.5, w + 0.1, 0.45, d + 0.1, roofColor);
    // 3. 一樓大門入口凹槽深色面
    addBox(0, 1.3, 0.04, w * 0.78, 2.6, 0.1, darkColor);
    // 4. 一樓外伸雨遮
    addBox(0, 2.65, 0.55, w * 0.95, 0.12, 1.3, awningColor);
    // 5. 二樓與三樓窗戶
    addBox(-w * 0.25, 4.8, 0.04, 1.2, 1.4, 0.1, darkColor);
    addBox(w * 0.25, 4.8, 0.04, 1.2, 1.4, 0.1, darkColor);

    // 計算 Footprint 與碰撞體
    const p1 = { x: shop.point.x + perp.x * (w / 2), z: shop.point.z + perp.z * (w / 2) };
    const p2 = { x: shop.point.x - perp.x * (w / 2), z: shop.point.z - perp.z * (w / 2) };
    const p3 = { x: p2.x - toRoad.x * d, z: p2.z - toRoad.z * d };
    const p4 = { x: p1.x - toRoad.x * d, z: p1.z - toRoad.z * d };

    const minX = Math.min(p1.x, p2.x, p3.x, p4.x);
    const maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
    const minZ = Math.min(p1.z, p2.z, p3.z, p4.z);
    const maxZ = Math.max(p1.z, p2.z, p3.z, p4.z);

    const collider: BuildingCollisionData = {
      id: `proc_${shop.id}`,
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
      distToRoad: roadInfo ? roadInfo.dist : 5.0
    };

    return { collider, frontWall };
  }

  /**
   * 切換夜間霓虹自發光模式 (按 T 鍵切換：招牌光暈大亮)
   */
  public setNightMode(isNight: boolean): void {
    const intensity = isNight ? 1.35 : CONFIG.SIGNBOARD.EMISSIVE_INTENSITY;
    for (const mat of this.signMaterials) {
      mat.emissiveIntensity = intensity;
      mat.needsUpdate = true;
    }
  }

  /**
   * 動態 Canvas 2D 繪製台灣高對比特色招牌貼圖 (加入邊緣磨損、螺栓與霓虹光感)
   */
  private drawCanvasTexture(shop: ShopFeature, width: number, height: number, isVertical = false): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    const theme = this.getShopColorTheme(shop);

    // 1. 底色
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    // 2. 邊緣微污漬漸層 (Weathering Grime)
    const grimeGrad = ctx.createLinearGradient(0, 0, 0, 16);
    grimeGrad.addColorStop(0, 'rgba(0, 0, 0, 0.35)');
    grimeGrad.addColorStop(1, 'rgba(0, 0, 0, 0.0)');
    ctx.fillStyle = grimeGrad;
    ctx.fillRect(0, 0, width, 16);

    // 3. 經典雙色飾條或外框
    if (!isVertical) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(0, 0, width, 14);
      ctx.fillRect(0, height - 14, width, 14);

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.strokeRect(6, 6, width - 12, height - 12);
    } else {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(0, 0, width, 24);
      ctx.fillRect(0, height - 24, width, 24);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.strokeRect(6, 6, width - 12, height - 12);
    }

    // 四個角落金屬螺栓固定點 (Bolts)
    ctx.fillStyle = '#475569';
    ctx.fillRect(8, 8, 5, 5);
    ctx.fillRect(width - 13, 8, 5, 5);
    ctx.fillRect(8, height - 13, 5, 5);
    ctx.fillRect(width - 13, height - 13, 5, 5);

    // 4. 類別小標籤
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

    // 5. 店家大名稱 (粗體、外發光黑色邊框、高對比)
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

  private getShopColorTheme(shop: ShopFeature): { bg: string; accent: string; text: string; tag: string } {
    const n = shop.name.toLowerCase();
    const c = shop.category;
    const s = shop.subCategory.toLowerCase();

    if (n.includes('7-11') || n.includes('7-eleven') || n.includes('統一超商')) {
      return { bg: '#007a3d', accent: '#f58220', text: '#ffffff', tag: '7-ELEVEn 24H' };
    }
    if (n.includes('全家') || n.includes('familymart')) {
      return { bg: '#00a0e9', accent: '#009944', text: '#ffffff', tag: 'FamilyMart 全家' };
    }
    if (s.includes('cafe') || s.includes('tea') || n.includes('50嵐') || n.includes('清心') || n.includes('茶')) {
      return { bg: '#eab308', accent: '#15803d', text: '#000000', tag: '冷熱現調飲品' };
    }
    if (n.includes('溫泉') || n.includes('湯屋') || s.includes('hotel') || c === 'tourism') {
      return { bg: '#0284c7', accent: '#38bdf8', text: '#ffffff', tag: '♨️ 礁溪名泉湯屋' };
    }
    if (n.includes('名產') || n.includes('奕順軒') || n.includes('蔥油餅') || n.includes('鴨賞') || s.includes('bakery')) {
      return { bg: '#dc2626', accent: '#fbbf24', text: '#ffffff', tag: '宜蘭在地必吃名產' };
    }
    if (c === 'amenity' || s.includes('restaurant') || s.includes('fast_food') || n.includes('拉麵') || n.includes('牛肉麵')) {
      return { bg: '#b91c1c', accent: '#f97316', text: '#ffffff', tag: '道地美食物產' };
    }
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

  private addDebugMarker(shop: ShopFeature, status: 'wall' | 'procedural_shop' | 'pole' | 'failed', distFailMeters?: number): void {
    const markerGroup = new THREE.Group();

    let color = 0x22c55e;
    if (status === 'procedural_shop') color = 0x06b6d4;
    else if (status === 'pole') color = 0xeab308;
    else if (status === 'failed') color = 0xef4444;

    const sphereGeo = new THREE.SphereGeometry(0.35, 12, 12);
    const sphereMat = new THREE.MeshBasicMaterial({ color, wireframe: false });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    sphere.position.set(shop.point.x, 2.0, shop.point.z);
    markerGroup.add(sphere);

    const labelSprite = this.createDebugLabelSprite(shop.name, status, distFailMeters);
    labelSprite.position.set(shop.point.x, 2.9, shop.point.z);
    markerGroup.add(labelSprite);

    this.debugGroup.add(markerGroup);
  }

  private createDebugLabelSprite(name: string, status: string, dist?: number): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    let bgColor = 'rgba(34, 197, 94, 0.85)';
    let statusText = '牆面配對';
    if (status === 'procedural_shop') {
      bgColor = 'rgba(6, 182, 212, 0.85)';
      statusText = '補店面';
    } else if (status === 'pole') {
      bgColor = 'rgba(234, 179, 8, 0.85)';
      statusText = `立柱 (${dist || 0}m)`;
    } else if (status === 'failed') {
      bgColor = 'rgba(239, 68, 68, 0.85)';
      statusText = '配對失敗';
    }

    ctx.fillStyle = bgColor;
    ctx.roundRect ? ctx.roundRect(4, 4, 248, 56, 10) : ctx.fillRect(4, 4, 248, 56);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.roundRect ? ctx.roundRect(4, 4, 248, 56, 10) : ctx.strokeRect(4, 4, 248, 56);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(name.slice(0, 8), 128, 28);

    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#f8fafc';
    ctx.fillText(statusText, 128, 48);

    const tex = new THREE.CanvasTexture(canvas);
    const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(4.0, 1.0, 1.0);
    return sprite;
  }

  public updateFrustumCulling(camera: THREE.PerspectiveCamera): void {
    this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

    let count = 0;
    for (const item of this.items) {
      this.tempSphere.center.copy(item.mesh.position);
      this.tempSphere.radius = 2.5;

      const visible = this.frustum.intersectsSphere(this.tempSphere);
      if (visible) {
        count++;
      }
    }

    if (this.stats) {
      this.stats.visibleInFrustum = count;
    }
  }

  public toggleDebug(): boolean {
    this.isDebugVisible = !this.isDebugVisible;
    this.debugGroup.visible = this.isDebugVisible;
    return this.isDebugVisible;
  }

  public getStats(): SignboardPipelineStats | null {
    return this.stats;
  }

  public getSignboardItems(): SignboardItem[] {
    return this.items;
  }

  private findBestStreetWall(shopPt: Point2D, bldg: BuildingFeature, roads: RoadFeature[]): WallCandidate | null {
    const poly = bldg.footprint;
    const n = poly.length;
    if (n < 3) return null;

    let centerX = 0, centerZ = 0;
    for (const p of poly) {
      centerX += p.x;
      centerZ += p.z;
    }
    centerX /= n;
    centerZ /= n;

    const walls: WallCandidate[] = [];

    for (let i = 0; i < n; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % n];

      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const len = Math.hypot(dx, dz);
      if (len < 1.0) continue;

      let nx = dz / len;
      let nz = -dx / len;

      const midX = (p1.x + p2.x) * 0.5;
      const midZ = (p1.z + p2.z) * 0.5;

      if (nx * (midX - centerX) + nz * (midZ - centerZ) < 0) {
        nx = -nx;
        nz = -nz;
      }

      let minDistToRoad = Infinity;
      for (const r of roads) {
        for (let j = 0; j < r.points.length - 1; j++) {
          const d = this.distToSegment({ x: midX, z: midZ }, r.points[j], r.points[j + 1]);
          if (d < minDistToRoad) minDistToRoad = d;
        }
      }

      walls.push({
        p1,
        p2,
        center: { x: midX, z: midZ },
        normal: { x: nx, z: nz },
        length: len,
        distToRoad: minDistToRoad
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
    if (this.mergedProceduralMesh) {
      this.mergedProceduralMesh.geometry.dispose();
      (this.mergedProceduralMesh.material as THREE.Material).dispose();
      this.mergedProceduralMesh = null;
    }
    if (this.bracketsMesh) {
      this.bracketsMesh.geometry.dispose();
      (this.bracketsMesh.material as THREE.Material).dispose();
      this.bracketsMesh = null;
    }
    if (this.polesMesh) {
      this.polesMesh.geometry.dispose();
      (this.polesMesh.material as THREE.Material).dispose();
      this.polesMesh = null;
    }
    if (this.debugGroup) {
      scene.remove(this.debugGroup);
      this.debugGroup.clear();
    }
    this.items = [];
    this.signMaterials = [];
    this.stats = null;
  }
}
