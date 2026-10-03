/**
 * BuildingGenerator.ts - 建築物多邊形擠出、8色調色盤、雙色屋頂、女兒牆、樓層窗戶與屋頂水塔生成器
 * 採用單一合併幾何體與 InstancedMesh (窗戶、水塔) 確保全城維持極低 Draw Calls 與 60+ FPS
 * 支援建築管線 6 關診斷統計、F5 地面輪廓除錯線框、DoubleSide 材質與 Bounding Box/Sphere 計算
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { BuildingFeature, BuildingFootprintDebug, BuildingPipelineStats, Point2D } from '../geo/OsmTypes.ts';

export interface BuildingCollisionData {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  footprint: Point2D[];
  height: number;
}

export class BuildingGenerator {
  private buildingsMesh: THREE.Mesh | null = null;
  private windowsInstancedMesh: THREE.InstancedMesh | null = null;
  private waterTanksInstancedMesh: THREE.InstancedMesh | null = null;
  private debugGroup: THREE.Group | null = null;
  private collisionData: BuildingCollisionData[] = [];
  private stats: BuildingPipelineStats | null = null;
  private isDebugVisible = false;

  public generate(
    buildings: BuildingFeature[],
    scene: THREE.Scene,
    initialStats?: BuildingPipelineStats,
    debugFootprints?: BuildingFootprintDebug[]
  ): BuildingCollisionData[] {
    this.dispose(scene);
    this.collisionData = [];

    const stats: BuildingPipelineStats = initialStats || {
      rawOverpass: { way: buildings.length, relation: 0, total: buildings.length },
      polygonFormed: buildings.length,
      polygonFailed: { missingNodes: 0, unclosed: 0, wrongOrientation: 0, selfIntersecting: 0, total: 0, reasons: [] },
      discarded: { tooSmall: 0, zeroHeight: 0, clearanceRule: 0, total: 0 },
      triangulationFailed: { count: 0, errors: [] },
      inSceneMeshes: 0,
      totalVertices: 0,
      nearby100m: 0
    };

    if (buildings.length === 0) {
      this.stats = stats;
      return [];
    }

    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    let vertexOffset = 0;

    // 調色盤預先轉換
    const wallPalette = CONFIG.BUILDINGS.PALETTE.map((hex) => new THREE.Color(hex));
    const roofPalette = CONFIG.BUILDINGS.ROOF_PALETTE.map((hex) => new THREE.Color(hex));

    // 收集所有窗戶與水塔 Transform Matrices
    const windowTransforms: THREE.Matrix4[] = [];
    const waterTankTransforms: THREE.Matrix4[] = [];

    const dummy = new THREE.Object3D();
    const parapetH = CONFIG.BUILDINGS.PARAPET_HEIGHT;

    for (let bIndex = 0; bIndex < buildings.length; bIndex++) {
      const bldg = buildings[bIndex];
      const poly = bldg.footprint;
      if (poly.length < 3) continue;

      const height = Math.max(3.5, bldg.height);
      const bldgHash = Math.abs(bldg.colorIndex || bIndex);

      const wallColor = wallPalette[bldgHash % wallPalette.length];
      const roofColor = roofPalette[(bldgHash * 3) % roofPalette.length];
      const parapetColor = wallColor.clone().multiplyScalar(0.92);

      // 計算 2D AABB 與多邊形幾何中心
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      let centerX = 0, centerZ = 0;
      for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
        centerX += p.x;
        centerZ += p.z;
      }
      centerX /= poly.length;
      centerZ /= poly.length;

      this.collisionData.push({
        id: bldg.id,
        minX,
        maxX,
        minZ,
        maxZ,
        footprint: poly,
        height
      });

      const n = poly.length;
      const numFloors = Math.max(1, Math.floor((height - 1.0) / CONFIG.BUILDINGS.LEVEL_HEIGHT));

      // --- 1. 外牆 (Side Walls) 四邊形 ---
      for (let i = 0; i < n; i++) {
        const p1 = poly[i];
        const p2 = poly[(i + 1) % n];

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const edgeLen = Math.hypot(dx, dz);
        if (edgeLen < 0.1) continue;

        // 計算外法向量並確保背對建築中心指向外側
        let nx = dz / edgeLen;
        let nz = -dx / edgeLen;
        const midX = (p1.x + p2.x) * 0.5;
        const midZ = (p1.z + p2.z) * 0.5;
        if (nx * (midX - centerX) + nz * (midZ - centerZ) < 0) {
          nx = -nx;
          nz = -nz;
        }

        // 頂點：p1底部, p2底部, p2頂部, p1頂部
        positions.push(
          p1.x, 0, p1.z,
          p2.x, 0, p2.z,
          p2.x, height, p2.z,
          p1.x, height, p1.z
        );

        for (let k = 0; k < 4; k++) {
          normals.push(nx, 0, nz);
          colors.push(wallColor.r, wallColor.g, wallColor.b);
        }

        indices.push(
          vertexOffset, vertexOffset + 1, vertexOffset + 2,
          vertexOffset, vertexOffset + 2, vertexOffset + 3
        );
        vertexOffset += 4;

        // --- 2. 屋頂女兒牆 (Rooftop Parapet) ---
        positions.push(
          p1.x, height, p1.z,
          p2.x, height, p2.z,
          p2.x, height + parapetH, p2.z,
          p1.x, height + parapetH, p1.z
        );
        for (let k = 0; k < 4; k++) {
          normals.push(nx, 0, nz);
          colors.push(parapetColor.r, parapetColor.g, parapetColor.b);
        }
        indices.push(
          vertexOffset, vertexOffset + 1, vertexOffset + 2,
          vertexOffset, vertexOffset + 2, vertexOffset + 3
        );
        vertexOffset += 4;

        // --- 3. 牆面依樓層窗戶 (Windows Instanced Transforms) ---
        if (edgeLen >= 3.2 && windowTransforms.length < 18000) {
          const numCols = Math.max(1, Math.floor((edgeLen - 1.0) / 2.6));
          const stepDist = edgeLen / (numCols + 1);
          const wallAngle = Math.atan2(dx, dz);

          for (let col = 1; col <= numCols; col++) {
            const distOnEdge = col * stepDist;
            const wx = p1.x + (dx / edgeLen) * distOnEdge + nx * 0.05;
            const wz = p1.z + (dz / edgeLen) * distOnEdge + nz * 0.05;

            for (let floor = 1; floor <= numFloors; floor++) {
              const wy = (floor - 0.5) * CONFIG.BUILDINGS.LEVEL_HEIGHT;
              if (wy + 1.2 > height) continue;

              dummy.position.set(wx, wy, wz);
              dummy.rotation.set(0, wallAngle, 0);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();

              windowTransforms.push(dummy.matrix.clone());
            }
          }
        }
      }

      // --- 4. 平頂屋頂 (Flat Roof) 三角剖分 ---
      try {
        const v2Points = poly.map((p) => new THREE.Vector2(p.x, p.z));
        const triangles = THREE.ShapeUtils.triangulateShape(v2Points, []);

        if (triangles && triangles.length > 0) {
          const roofStartOffset = vertexOffset;

          for (const p of poly) {
            positions.push(p.x, height, p.z);
            normals.push(0, 1, 0);
            colors.push(roofColor.r, roofColor.g, roofColor.b);
            vertexOffset++;
          }

          for (const tri of triangles) {
            indices.push(
              roofStartOffset + tri[0],
              roofStartOffset + tri[2],
              roofStartOffset + tri[1]
            );
          }
        } else {
          stats.triangulationFailed.count++;
          stats.triangulationFailed.errors.push(`${bldg.id}: ShapeUtils 無法三角化`);
        }
      } catch (err: any) {
        stats.triangulationFailed.count++;
        stats.triangulationFailed.errors.push(`${bldg.id}: ${err.message}`);
      }

      // --- 5. 屋頂水塔裝飾 (Water Tanks) ---
      if (bldgHash % 10 < 4 && height >= 6.0 && waterTankTransforms.length < 500) {
        dummy.position.set(centerX, height + 0.1, centerZ);
        dummy.rotation.set(0, (bldgHash * 0.7) % (Math.PI * 2), 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        waterTankTransforms.push(dummy.matrix.clone());
      }
    }

    // --- 建立全城合併建築 Mesh ---
    if (positions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setIndex(indices);

      // 嚴格依規範呼叫 computeBoundingSphere 與 computeBoundingBox
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.82,
        metalness: 0.12,
        side: THREE.DoubleSide // 啟用雙面渲染避免任何法線消失
      });

      this.buildingsMesh = new THREE.Mesh(geometry, material);
      this.buildingsMesh.name = 'BuildingsMesh';
      this.buildingsMesh.castShadow = true;
      this.buildingsMesh.receiveShadow = true;
      // 依規範測試：將 frustumCulled 設為 false，避免近處建築被裁切
      this.buildingsMesh.frustumCulled = false;
      scene.add(this.buildingsMesh);
    }

    // --- 建立窗戶 InstancedMesh ---
    if (windowTransforms.length > 0) {
      const winW = CONFIG.BUILDINGS.WINDOW.WIDTH;
      const winH = CONFIG.BUILDINGS.WINDOW.HEIGHT;
      const winGeo = new THREE.BoxGeometry(winW, winH, 0.08);

      const winMat = new THREE.MeshStandardMaterial({
        color: CONFIG.BUILDINGS.WINDOW.COLOR,
        roughness: 0.15,
        metalness: 0.85
      });

      this.windowsInstancedMesh = new THREE.InstancedMesh(winGeo, winMat, windowTransforms.length);
      this.windowsInstancedMesh.name = 'BuildingWindows';
      this.windowsInstancedMesh.castShadow = false;
      this.windowsInstancedMesh.receiveShadow = true;
      this.windowsInstancedMesh.frustumCulled = false;

      for (let i = 0; i < windowTransforms.length; i++) {
        this.windowsInstancedMesh.setMatrixAt(i, windowTransforms[i]);
      }
      this.windowsInstancedMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.windowsInstancedMesh);
    }

    // --- 建立屋頂不鏽鋼水塔 InstancedMesh ---
    if (waterTankTransforms.length > 0) {
      const tankGeo = new THREE.CylinderGeometry(1.1, 1.1, 2.0, 10);
      tankGeo.translate(0, 1.4, 0);

      const standGeo = new THREE.CylinderGeometry(0.8, 1.2, 0.6, 6);
      standGeo.translate(0, 0.3, 0);

      const combinedGeo = new THREE.BufferGeometry();
      const pos1 = Array.from(tankGeo.attributes.position.array);
      const pos2 = Array.from(standGeo.attributes.position.array);
      combinedGeo.setAttribute('position', new THREE.Float32BufferAttribute([...pos1, ...pos2], 3));
      combinedGeo.computeVertexNormals();

      const tankMat = new THREE.MeshStandardMaterial({
        color: 0xc8d2dc,
        roughness: 0.35,
        metalness: 0.75
      });

      this.waterTanksInstancedMesh = new THREE.InstancedMesh(combinedGeo, tankMat, waterTankTransforms.length);
      this.waterTanksInstancedMesh.name = 'RooftopWaterTanks';
      this.waterTanksInstancedMesh.castShadow = true;
      this.waterTanksInstancedMesh.receiveShadow = true;
      this.waterTanksInstancedMesh.frustumCulled = false;

      for (let i = 0; i < waterTankTransforms.length; i++) {
        this.waterTanksInstancedMesh.setMatrixAt(i, waterTankTransforms[i]);
      }
      this.waterTanksInstancedMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.waterTanksInstancedMesh);
    }

    // --- 步驟 3：建立 F5 地面建築輪廓除錯線框 ---
    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'Building_Debug_Wireframes';
    this.debugGroup.visible = this.isDebugVisible;

    if (debugFootprints && debugFootprints.length > 0) {
      for (const item of debugFootprints) {
        if (!item.footprint || item.footprint.length < 3) continue;
        const pts = item.footprint.map((p) => new THREE.Vector3(p.x, 0.08, p.z));
        // 封閉線條
        pts.push(new THREE.Vector3(item.footprint[0].x, 0.08, item.footprint[0].z));

        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        let color = 0x22c55e; // 綠色＝已成功生成
        if (item.status === 'failed') color = 0xef4444; // 紅色＝生成失敗
        else if (item.status === 'discarded') color = 0xeab308; // 黃色＝被規則丟棄

        const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 999;
        this.debugGroup.add(line);
      }
    }
    scene.add(this.debugGroup);

    // 統計更新
    stats.inSceneMeshes = (this.buildingsMesh ? 1 : 0) + (this.windowsInstancedMesh ? 1 : 0) + (this.waterTanksInstancedMesh ? 1 : 0);
    stats.totalVertices = positions.length / 3;

    console.log(
      `%c[建築管線第 4 關] 三角化與幾何擠出: 成功 ${buildings.length - stats.triangulationFailed.count} 棟 | 三角化失敗 ${stats.triangulationFailed.count} 棟`,
      'color: #22c55e; font-weight: bold;'
    );
    console.log(
      `%c[建築管線第 5 關] 進入場景建築 Mesh 數: ${stats.inSceneMeshes} 個 | 總頂點數: ${stats.totalVertices} | frustumCulled=false (防近處裁切)`,
      'color: #22c55e; font-weight: bold;'
    );

    this.stats = stats;
    return this.collisionData;
  }

  /**
   * 計算玩家周圍 100 公尺內的建築數 (管線第 6 關)
   */
  public getNearbyBuildingsCount(playerPos: THREE.Vector3, radius: number = 100): number {
    let count = 0;
    for (const col of this.collisionData) {
      const cx = (col.minX + col.maxX) * 0.5;
      const cz = (col.minZ + col.maxZ) * 0.5;
      if (Math.hypot(cx - playerPos.x, cz - playerPos.z) <= radius) {
        count++;
      }
    }
    if (this.stats) {
      this.stats.nearby100m = count;
    }
    return count;
  }

  /**
   * 按 F5 切換地面彩色建築輪廓線框
   */
  public toggleDebug(forceState?: boolean): boolean {
    this.isDebugVisible = forceState !== undefined ? forceState : !this.isDebugVisible;
    if (this.debugGroup) {
      this.debugGroup.visible = this.isDebugVisible;
    }
    return this.isDebugVisible;
  }

  public getIsDebugVisible(): boolean {
    return this.isDebugVisible;
  }

  public getStats(): BuildingPipelineStats | null {
    return this.stats;
  }

  public getMesh(): THREE.Mesh | null {
    return this.buildingsMesh;
  }

  public getCollisionData(): BuildingCollisionData[] {
    return this.collisionData;
  }

  public dispose(scene: THREE.Scene): void {
    if (this.buildingsMesh) {
      scene.remove(this.buildingsMesh);
      this.buildingsMesh.geometry.dispose();
      (this.buildingsMesh.material as THREE.Material).dispose();
      this.buildingsMesh = null;
    }
    if (this.windowsInstancedMesh) {
      scene.remove(this.windowsInstancedMesh);
      this.windowsInstancedMesh.geometry.dispose();
      (this.windowsInstancedMesh.material as THREE.Material).dispose();
      this.windowsInstancedMesh = null;
    }
    if (this.waterTanksInstancedMesh) {
      scene.remove(this.waterTanksInstancedMesh);
      this.waterTanksInstancedMesh.geometry.dispose();
      (this.waterTanksInstancedMesh.material as THREE.Material).dispose();
      this.waterTanksInstancedMesh = null;
    }
    if (this.debugGroup) {
      scene.remove(this.debugGroup);
      this.debugGroup = null;
    }
    this.collisionData = [];
  }
}
