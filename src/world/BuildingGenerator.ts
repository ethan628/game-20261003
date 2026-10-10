/**
 * BuildingGenerator.ts - GTA 風格寫實建築多邊形擠出、PBR 髒污雨痕、窗戶反射、冷氣室外機與屋頂設備
 * 包含：
 * 1. 建築外牆 PBR (NormalMap、由下往上泥漬漸層、雨水流痕、水泥補丁)
 * 2. 樓層窗戶 (玻璃微反光、窗簾百葉窗、部分夜間亮燈)
 * 3. 屋頂設備 InstancedMesh (不鏽鋼水塔、冷氣室外機、通風排氣管、鐵皮天線)
 * 4. 街角外牆海報與塗鴉 (隨機分佈在臨街一樓)
 * 5. 維持單一合併幾何體與 InstancedMesh，確保極低 Draw Calls 與 60+ FPS
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { BuildingFeature, BuildingFootprintDebug, BuildingPipelineStats, Point2D } from '../geo/OsmTypes.ts';
import { TextureGenerator } from './TextureGenerator.ts';
import { LightmapShaderHook } from './lightmap/LightmapShaderHook.ts';

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
  private acUnitsInstancedMesh: THREE.InstancedMesh | null = null;
  private ventsInstancedMesh: THREE.InstancedMesh | null = null;
  private postersInstancedMesh: THREE.InstancedMesh | null = null;
  private debugGroup: THREE.Group | null = null;
  private floorLabelsGroup: THREE.Group | null = null;

  private collisionData: BuildingCollisionData[] = [];
  private buildingsList: BuildingFeature[] = [];
  private stats: BuildingPipelineStats | null = null;
  private isDebugVisible = false;
  private isFloorLabelsVisible = false;

  public generate(
    buildings: BuildingFeature[],
    scene: THREE.Scene,
    initialStats?: BuildingPipelineStats,
    debugFootprints?: BuildingFootprintDebug[]
  ): BuildingCollisionData[] {
    this.dispose(scene);
    this.collisionData = [];
    this.buildingsList = buildings;

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
    const uvs: number[] = [];
    const indices: number[] = [];
    let vertexOffset = 0;

    // 調色盤預先轉換
    const wallPalette = CONFIG.BUILDINGS.PALETTE.map((hex) => new THREE.Color(hex));
    const roofPalette = CONFIG.BUILDINGS.ROOF_PALETTE.map((hex) => new THREE.Color(hex));

    // 收集所有窗戶、水塔、冷氣室外機、通風管、海報 Transform Matrices
    const windowTransforms: THREE.Matrix4[] = [];
    const waterTankTransforms: THREE.Matrix4[] = [];
    const acUnitTransforms: THREE.Matrix4[] = [];
    const ventTransforms: THREE.Matrix4[] = [];
    const posterTransforms: THREE.Matrix4[] = [];

    const dummy = new THREE.Object3D();
    const parapetH = CONFIG.BUILDINGS.PARAPET_HEIGHT;

    for (let bIndex = 0; bIndex < buildings.length; bIndex++) {
      const bldg = buildings[bIndex];
      const poly = bldg.footprint;
      if (poly.length < 3) continue;

      const minH = bldg.minHeight || 0;
      const height = Math.max(minH + 3.2, bldg.height);
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
      const numFloors = Math.max(1, Math.floor((height - minH - 1.0) / CONFIG.BUILDINGS.LEVEL_HEIGHT));

      // --- 1. 外牆 (Side Walls) 四邊形 (支援 minHeight 懸空起始) ---
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

        // 頂點：p1底部(minH), p2底部(minH), p2頂部(height), p1頂部(height)
        positions.push(
          p1.x, minH, p1.z,
          p2.x, minH, p2.z,
          p2.x, height, p2.z,
          p1.x, height, p1.z
        );

        for (let k = 0; k < 4; k++) {
          normals.push(nx, 0, nz);
          colors.push(wallColor.r, wallColor.g, wallColor.b);
        }

        // UV：橫向依長度平鋪，縱向 0 是地面，1 是頂部 (對齊泥漬與雨痕)
        uvs.push(
          0, 1.0,
          edgeLen * 0.35, 1.0,
          edgeLen * 0.35, 0.0,
          0, 0.0
        );

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
              const wy = minH + (floor - 0.5) * CONFIG.BUILDINGS.LEVEL_HEIGHT;
              if (wy + 1.2 > height) continue;

              dummy.position.set(wx, wy, wz);
              dummy.rotation.set(0, wallAngle, 0);
              dummy.scale.set(1, 1, 1);
              dummy.updateMatrix();

              windowTransforms.push(dummy.matrix.clone());

              // 窗旁偶爾掛冷氣室外機 (台灣街景特色)
              if ((bldgHash + col + floor) % 7 === 0 && acUnitTransforms.length < 400) {
                dummy.position.set(wx + nx * 0.3 + (dx / edgeLen) * 0.9, wy - 0.45, wz + nz * 0.3 + (dz / edgeLen) * 0.9);
                dummy.rotation.set(0, wallAngle, 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                acUnitTransforms.push(dummy.matrix.clone());
              }
            }
          }
        }

        // --- 4. 臨街一樓牆面海報與塗鴉 (約 12% 機率) ---
        if (edgeLen >= 4.0 && (bldgHash + i) % 8 === 0 && posterTransforms.length < 80) {
          const posterX = midX + nx * 0.06;
          const posterZ = midZ + nz * 0.06;
          dummy.position.set(posterX, minH + 1.6, posterZ);
          dummy.rotation.set(0, Math.atan2(nx, nz), 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          posterTransforms.push(dummy.matrix.clone());
        }
      }

      // --- 1.1 懸空層底部天花板 (Soffit) ---
      if (minH > 0) {
        try {
          const v2Points = poly.map((p) => new THREE.Vector2(p.x, p.z));
          const v2Holes = (bldg.holes || []).map((h) => h.map((p) => new THREE.Vector2(p.x, p.z)));
          const soffitTris = THREE.ShapeUtils.triangulateShape(v2Points, v2Holes);
          if (soffitTris && soffitTris.length > 0) {
            const soffitStart = vertexOffset;
            const allPts = [...poly];
            if (bldg.holes) {
              for (const h of bldg.holes) allPts.push(...h);
            }
            for (const p of allPts) {
              positions.push(p.x, minH, p.z);
              normals.push(0, -1, 0);
              colors.push(wallColor.r * 0.9, wallColor.g * 0.9, wallColor.b * 0.9);
              uvs.push(p.x * 0.2, p.z * 0.2);
              vertexOffset++;
            }
            for (const tri of soffitTris) {
              indices.push(soffitStart + tri[0], soffitStart + tri[1], soffitStart + tri[2]);
            }
          }
        } catch {}
      }

      // --- 1.2 天井/中庭內牆 (Inner Courtyard Walls) ---
      if (bldg.holes && bldg.holes.length > 0) {
        for (const hole of bldg.holes) {
          const hn = hole.length;
          if (hn < 3) continue;
          let hcx = 0, hcz = 0;
          for (const hp of hole) { hcx += hp.x; hcz += hp.z; }
          hcx /= hn; hcz /= hn;

          for (let hi = 0; hi < hn; hi++) {
            const hp1 = hole[hi];
            const hp2 = hole[(hi + 1) % hn];
            const hdx = hp2.x - hp1.x;
            const hdz = hp2.z - hp1.z;
            const hLen = Math.hypot(hdx, hdz);
            if (hLen < 0.1) continue;

            let hnx = hdz / hLen;
            let hnz = -hdx / hLen;
            const hmx = (hp1.x + hp2.x) * 0.5;
            const hmz = (hp1.z + hp2.z) * 0.5;
            // 朝向天井中心
            if (hnx * (hcx - hmx) + hnz * (hcz - hmz) < 0) {
              hnx = -hnx;
              hnz = -hnz;
            }

            positions.push(
              hp1.x, minH, hp1.z,
              hp2.x, minH, hp2.z,
              hp2.x, height, hp2.z,
              hp1.x, height, hp1.z
            );
            for (let k = 0; k < 4; k++) {
              normals.push(hnx, 0, hnz);
              colors.push(wallColor.r, wallColor.g, wallColor.b);
            }
            uvs.push(0, 1.0, hLen * 0.35, 1.0, hLen * 0.35, 0.0, 0, 0.0);
            indices.push(
              vertexOffset, vertexOffset + 1, vertexOffset + 2,
              vertexOffset, vertexOffset + 2, vertexOffset + 3
            );
            vertexOffset += 4;
          }
        }
      }

      // --- 5. 屋頂生成 (依 roofShape: flat, gabled, pyramidal, hipped, skillion) ---
      const roofShape = bldg.roofShape || 'flat';
      const roofH = bldg.roofHeight || 2.4;

      if (roofShape === 'gabled' && poly.length >= 3) {
        // 雙坡屋頂 (Gabled Roof)
        const axisDx = maxX - minX;
        const axisDz = maxZ - minZ;
        const isXLonger = axisDx >= axisDz;
        const ridgeY = height + roofH;
        const ridgeP1 = isXLonger ? { x: minX, z: centerZ } : { x: centerX, z: minZ };
        const ridgeP2 = isXLonger ? { x: maxX, z: centerZ } : { x: centerX, z: maxZ };

        for (let i = 0; i < n; i++) {
          const p1 = poly[i];
          const p2 = poly[(i + 1) % n];
          const t1 = isXLonger ? Math.max(0, Math.min(1, (p1.x - minX) / (axisDx || 1))) : Math.max(0, Math.min(1, (p1.z - minZ) / (axisDz || 1)));
          const t2 = isXLonger ? Math.max(0, Math.min(1, (p2.x - minX) / (axisDx || 1))) : Math.max(0, Math.min(1, (p2.z - minZ) / (axisDz || 1)));
          const rp1 = { x: ridgeP1.x + (ridgeP2.x - ridgeP1.x) * t1, z: ridgeP1.z + (ridgeP2.z - ridgeP1.z) * t1 };
          const rp2 = { x: ridgeP1.x + (ridgeP2.x - ridgeP1.x) * t2, z: ridgeP1.z + (ridgeP2.z - ridgeP1.z) * t2 };

          positions.push(
            p1.x, height, p1.z,
            p2.x, height, p2.z,
            rp2.x, ridgeY, rp2.z,
            rp1.x, ridgeY, rp1.z
          );
          for (let k = 0; k < 4; k++) {
            normals.push(0, 0.85, 0);
            colors.push(roofColor.r, roofColor.g, roofColor.b);
          }
          uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
          indices.push(
            vertexOffset, vertexOffset + 1, vertexOffset + 2,
            vertexOffset, vertexOffset + 2, vertexOffset + 3
          );
          vertexOffset += 4;
        }
      } else if (roofShape === 'pyramidal' && poly.length >= 3) {
        // 金字塔頂 (Pyramidal Roof)
        const apexX = centerX;
        const apexY = height + roofH;
        const apexZ = centerZ;

        for (let i = 0; i < n; i++) {
          const p1 = poly[i];
          const p2 = poly[(i + 1) % n];

          positions.push(
            p1.x, height, p1.z,
            p2.x, height, p2.z,
            apexX, apexY, apexZ
          );
          for (let k = 0; k < 3; k++) {
            normals.push(0, 0.8, 0);
            colors.push(roofColor.r, roofColor.g, roofColor.b);
          }
          uvs.push(0, 0, 1, 0, 0.5, 1);
          indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2);
          vertexOffset += 3;
        }
      } else {
        // 平頂 (Flat Roof) + 女兒牆
        try {
          const v2Points = poly.map((p) => new THREE.Vector2(p.x, p.z));
          const v2Holes = (bldg.holes || []).map((h) => h.map((p) => new THREE.Vector2(p.x, p.z)));
          const triangles = THREE.ShapeUtils.triangulateShape(v2Points, v2Holes);

          if (triangles && triangles.length > 0) {
            const roofStartOffset = vertexOffset;
            const allPts = [...poly];
            if (bldg.holes) {
              for (const h of bldg.holes) allPts.push(...h);
            }

            for (const p of allPts) {
              positions.push(p.x, height, p.z);
              normals.push(0, 1, 0);
              colors.push(roofColor.r, roofColor.g, roofColor.b);
              uvs.push(p.x * 0.15, p.z * 0.15);
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

        // 女兒牆
        for (let i = 0; i < n; i++) {
          const p1 = poly[i];
          const p2 = poly[(i + 1) % n];
          const dx = p2.x - p1.x;
          const dz = p2.z - p1.z;
          const edgeLen = Math.hypot(dx, dz);
          if (edgeLen < 0.1) continue;

          let nx = dz / edgeLen;
          let nz = -dx / edgeLen;
          const midX = (p1.x + p2.x) * 0.5;
          const midZ = (p1.z + p2.z) * 0.5;
          if (nx * (midX - centerX) + nz * (midZ - centerZ) < 0) {
            nx = -nx;
            nz = -nz;
          }

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
          uvs.push(
            0, 0.2,
            edgeLen * 0.35, 0.2,
            edgeLen * 0.35, 0.0,
            0, 0.0
          );
          indices.push(
            vertexOffset, vertexOffset + 1, vertexOffset + 2,
            vertexOffset, vertexOffset + 2, vertexOffset + 3
          );
          vertexOffset += 4;
        }
      }

      // --- 6. 屋頂水塔與通風天線設備 (Water Tanks & Rooftop Vents) ---
      if (bldgHash % 10 < 4 && height >= 6.0 && waterTankTransforms.length < 500) {
        dummy.position.set(centerX, height + 0.1, centerZ);
        dummy.rotation.set(0, (bldgHash * 0.7) % (Math.PI * 2), 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        waterTankTransforms.push(dummy.matrix.clone());
      }

      if (bldgHash % 5 === 0 && height >= 10.0 && ventTransforms.length < 350) {
        dummy.position.set(centerX + 2.2, height + 0.1, centerZ - 1.8);
        dummy.rotation.set(0, (bldgHash * 1.3) % (Math.PI * 2), 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        ventTransforms.push(dummy.matrix.clone());
      }
    }

    // --- 建立全城合併建築 Mesh (PBR 牆面) ---
    if (positions.length > 0) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);

      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();

      const wallTex = TextureGenerator.getBuildingWallTextures('medium');

      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: wallTex.map,
        normalMap: wallTex.normalMap,
        roughnessMap: wallTex.roughnessMap,
        roughness: 0.82,
        metalness: 0.10,
        side: THREE.DoubleSide
      });

      // 注入區塊光照圖：底部 6 公尺以內照亮一樓與騎樓，隨高度漸淡
      material.onBeforeCompile = (shader) => {
        LightmapShaderHook.bindUniforms(shader);
        shader.vertexShader = LightmapShaderHook.injectVertexShader(shader.vertexShader);
        shader.fragmentShader = LightmapShaderHook.injectBuildingFragmentShader(shader.fragmentShader);
        (material as any).customShader = shader;
      };

      this.buildingsMesh = new THREE.Mesh(geometry, material);
      this.buildingsMesh.name = 'BuildingsMesh';
      this.buildingsMesh.castShadow = true;
      this.buildingsMesh.receiveShadow = true;
      this.buildingsMesh.frustumCulled = false;
      scene.add(this.buildingsMesh);
    }

    // --- 建立窗戶 InstancedMesh (PBR 反射玻璃貼圖 + 夜間自發光) ---
    if (windowTransforms.length > 0) {
      const winW = CONFIG.BUILDINGS.WINDOW.WIDTH;
      const winH = CONFIG.BUILDINGS.WINDOW.HEIGHT;
      const winGeo = new THREE.BoxGeometry(winW, winH, 0.08);

      const winTex = TextureGenerator.getWindowAtlasTexture();
      const winMat = new THREE.MeshStandardMaterial({
        map: winTex,
        roughness: 0.20,
        metalness: 0.75,
        color: 0x141e2e
      });
      winMat.defines = { USE_INSTANCING_COLOR: '' };

      winMat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          `
          #include <dithering_fragment>
          #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
            // 窗戶夜間自發光 (暖黃室內燈 / 冷白燈 / 電視藍光)
            if (dot(vColor.rgb, vec3(0.299, 0.587, 0.114)) > 0.25) {
              gl_FragColor.rgb += vColor.rgb * 1.35;
            }
          #endif
          `
        );
      };

      this.windowsInstancedMesh = new THREE.InstancedMesh(winGeo, winMat, windowTransforms.length);
      this.windowsInstancedMesh.name = 'BuildingWindows';
      this.windowsInstancedMesh.castShadow = false;
      this.windowsInstancedMesh.receiveShadow = true;
      this.windowsInstancedMesh.frustumCulled = false;
      this.windowsInstancedMesh.instanceColor = new THREE.InstancedBufferAttribute(
        new Float32Array(windowTransforms.length * 3),
        3
      );

      for (let i = 0; i < windowTransforms.length; i++) {
        this.windowsInstancedMesh.setMatrixAt(i, windowTransforms[i]);
      }
      this.windowsInstancedMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.windowsInstancedMesh);
    }

    // --- 建立冷氣室外機 InstancedMesh ---
    if (acUnitTransforms.length > 0) {
      const acGeo = new THREE.BoxGeometry(0.85, 0.62, 0.45);
      const acMat = new THREE.MeshStandardMaterial({
        color: 0xd6d3cc,
        roughness: 0.65,
        metalness: 0.45
      });

      this.acUnitsInstancedMesh = new THREE.InstancedMesh(acGeo, acMat, acUnitTransforms.length);
      this.acUnitsInstancedMesh.name = 'ACUnits_Instanced';
      this.acUnitsInstancedMesh.castShadow = true;
      this.acUnitsInstancedMesh.receiveShadow = true;

      for (let i = 0; i < acUnitTransforms.length; i++) {
        this.acUnitsInstancedMesh.setMatrixAt(i, acUnitTransforms[i]);
      }
      this.acUnitsInstancedMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.acUnitsInstancedMesh);
    }

    // --- 建立屋頂通風排氣管/天線 InstancedMesh ---
    if (ventTransforms.length > 0) {
      const ventGeo = new THREE.CylinderGeometry(0.35, 0.45, 1.8, 8);
      const ventMat = new THREE.MeshStandardMaterial({
        color: 0x94a3b8,
        roughness: 0.4,
        metalness: 0.8
      });

      this.ventsInstancedMesh = new THREE.InstancedMesh(ventGeo, ventMat, ventTransforms.length);
      this.ventsInstancedMesh.name = 'RooftopVents_Instanced';
      this.ventsInstancedMesh.castShadow = true;
      this.ventsInstancedMesh.receiveShadow = true;

      for (let i = 0; i < ventTransforms.length; i++) {
        this.ventsInstancedMesh.setMatrixAt(i, ventTransforms[i]);
      }
      this.ventsInstancedMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.ventsInstancedMesh);
    }

    // --- 建立外牆海報/塗鴉 InstancedMesh ---
    if (posterTransforms.length > 0) {
      const posterGeo = new THREE.PlaneGeometry(1.2, 0.9);
      const posterTex = TextureGenerator.getGraffitiTexture(0);
      const posterMat = new THREE.MeshStandardMaterial({
        map: posterTex,
        roughness: 0.75,
        metalness: 0.1,
        side: THREE.DoubleSide
      });

      this.postersInstancedMesh = new THREE.InstancedMesh(posterGeo, posterMat, posterTransforms.length);
      this.postersInstancedMesh.name = 'WallPosters_Instanced';

      for (let i = 0; i < posterTransforms.length; i++) {
        this.postersInstancedMesh.setMatrixAt(i, posterTransforms[i]);
      }
      this.postersInstancedMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.postersInstancedMesh);
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

    // --- 步驟 3：建立 F5 地面建築輪廓除錯線框 (依來源區分顏色) ---
    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'Building_Debug_Wireframes';
    this.debugGroup.visible = this.isDebugVisible;

    if (debugFootprints && debugFootprints.length > 0) {
      for (const item of debugFootprints) {
        if (!item.footprint || item.footprint.length < 3) continue;
        const pts = item.footprint.map((p) => new THREE.Vector3(p.x, 0.08, p.z));
        pts.push(new THREE.Vector3(item.footprint[0].x, 0.08, item.footprint[0].z));

        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        let color = 0x22c55e;
        if (item.status === 'failed') {
          color = 0xef4444;
        } else if (item.status === 'discarded') {
          color = 0xeab308;
        } else if (item.source && CONFIG.BUILDINGS.SOURCE_COLORS[item.source]) {
          color = CONFIG.BUILDINGS.SOURCE_COLORS[item.source];
        }

        const mat = new THREE.LineBasicMaterial({ color, linewidth: 2, depthTest: false });
        const line = new THREE.Line(geo, mat);
        line.renderOrder = 999;
        this.debugGroup.add(line);
      }
    }
    scene.add(this.debugGroup);

    // --- 步驟 4：建立 F7 3D 浮動樓層數字標籤 (底色依據來源顏色) ---
    this.floorLabelsGroup = new THREE.Group();
    this.floorLabelsGroup.name = 'BuildingFloorLabels';
    this.floorLabelsGroup.visible = this.isFloorLabelsVisible;

    for (const bldg of buildings) {
      const levels = bldg.levels || 1;
      const height = Math.max(3.5, bldg.height);
      const labelTex = this.createFloorLabelTexture(levels, bldg.heightSource);
      const spriteMat = new THREE.SpriteMaterial({ map: labelTex, depthTest: false });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.renderOrder = 1000;
      sprite.position.set(bldg.center.x, height + (bldg.roofShape === 'flat' ? 2.8 : 4.2), bldg.center.z);
      sprite.scale.set(4.8, 2.4, 1.0);
      this.floorLabelsGroup.add(sprite);
    }
    scene.add(this.floorLabelsGroup);

    // 統計更新
    stats.inSceneMeshes = (this.buildingsMesh ? 1 : 0) + (this.windowsInstancedMesh ? 1 : 0) + (this.waterTanksInstancedMesh ? 1 : 0) + (this.acUnitsInstancedMesh ? 1 : 0);
    stats.totalVertices = positions.length / 3;

    this.stats = stats;
    return this.collisionData;
  }

  private createFloorLabelTexture(levels: number, source: string): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;

    const hexColor = CONFIG.BUILDINGS.SOURCE_COLORS[source as keyof typeof CONFIG.BUILDINGS.SOURCE_COLORS] || 0x22c55e;
    const colorStr = '#' + hexColor.toString(16).padStart(6, '0');

    // 外邊框陰影底色
    ctx.fillStyle = 'rgba(15, 23, 42, 0.90)';
    ctx.beginPath();
    ctx.roundRect(4, 4, 120, 56, 12);
    ctx.fill();

    // 來源顏色內填色
    ctx.fillStyle = colorStr;
    ctx.beginPath();
    ctx.roundRect(6, 6, 116, 52, 10);
    ctx.fill();

    // 樓層數字文字
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
    ctx.shadowBlur = 4;
    ctx.fillText(`${levels}F`, 64, 33);

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  public toggleDebug(): boolean {
    this.isDebugVisible = !this.isDebugVisible;
    if (this.debugGroup) {
      this.debugGroup.visible = this.isDebugVisible;
    }
    return this.isDebugVisible;
  }

  public toggleFloorLabels(): boolean {
    this.isFloorLabelsVisible = !this.isFloorLabelsVisible;
    if (this.floorLabelsGroup) {
      this.floorLabelsGroup.visible = this.isFloorLabelsVisible;
    }
    return this.isFloorLabelsVisible;
  }

  public getBuildingsList(): BuildingFeature[] {
    return this.buildingsList;
  }

  public getBuildingFeatureById(id: string): BuildingFeature | undefined {
    return this.buildingsList.find((b) => b.id === id);
  }

  public getStats(): BuildingPipelineStats | null {
    return this.stats;
  }

  public getBuildingsMesh(): THREE.Mesh | null {
    return this.buildingsMesh;
  }

  public getWindowsMesh(): THREE.InstancedMesh | null {
    return this.windowsInstancedMesh;
  }

  public getCollisionData(): BuildingCollisionData[] {
    return this.collisionData;
  }

  public getNearbyBuildingsCount(playerPos: THREE.Vector3, radiusMeters: number): number {
    let count = 0;
    for (const b of this.collisionData) {
      const cx = (b.minX + b.maxX) * 0.5;
      const cz = (b.minZ + b.maxZ) * 0.5;
      const d = Math.hypot(cx - playerPos.x, cz - playerPos.z);
      if (d <= radiusMeters) {
        count++;
      }
    }
    return count;
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
    if (this.acUnitsInstancedMesh) {
      scene.remove(this.acUnitsInstancedMesh);
      this.acUnitsInstancedMesh.geometry.dispose();
      (this.acUnitsInstancedMesh.material as THREE.Material).dispose();
      this.acUnitsInstancedMesh = null;
    }
    if (this.ventsInstancedMesh) {
      scene.remove(this.ventsInstancedMesh);
      this.ventsInstancedMesh.geometry.dispose();
      (this.ventsInstancedMesh.material as THREE.Material).dispose();
      this.ventsInstancedMesh = null;
    }
    if (this.postersInstancedMesh) {
      scene.remove(this.postersInstancedMesh);
      this.postersInstancedMesh.geometry.dispose();
      (this.postersInstancedMesh.material as THREE.Material).dispose();
      this.postersInstancedMesh = null;
    }
    if (this.debugGroup) {
      scene.remove(this.debugGroup);
      this.debugGroup.clear();
      this.debugGroup = null;
    }
    if (this.floorLabelsGroup) {
      scene.remove(this.floorLabelsGroup);
      this.floorLabelsGroup.children.forEach((child) => {
        if (child instanceof THREE.Sprite) {
          child.material.map?.dispose();
          child.material.dispose();
        }
      });
      this.floorLabelsGroup.clear();
      this.floorLabelsGroup = null;
    }
  }
}
