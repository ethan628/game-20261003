/**
 * RoadGenerator.ts - GTA 風格寫實道路、立體人行道、磨損標線與街道細節
 * 包含：
 * 1. 柏油路面 PBR (NormalMap、RoughnessMap、裂縫、油漬、補丁、輪胎痕)
 * 2. 人行道地磚 PBR (方格地磚紋理、磁磚縫微凹凸、路緣石立體面)
 * 3. 標線磨損 (雙黃線、白虛線、斑馬線皆套用剝落褪色透明度遮罩)
 * 4. 街道細節 (鑄鐵人孔蓋與路緣排水孔，全部用 InstancedMesh)
 * 5. 支援濕潤模式 (按 R 切換：水窪、反光、roughness 驟降)
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { Point2D, RoadFeature, IntersectionFeature, StopLine, IntersectionCrossing } from '../geo/OsmTypes.ts';
import { TextureGenerator } from './TextureGenerator.ts';

export class RoadGenerator {
  private roadMesh: THREE.Mesh | null = null;
  private sidewalkMesh: THREE.Mesh | null = null;
  private markingsMesh: THREE.Mesh | null = null;
  private manholesMesh: THREE.InstancedMesh | null = null;
  private gratesMesh: THREE.InstancedMesh | null = null;

  private roadMaterial: THREE.MeshStandardMaterial | null = null;
  private sideMaterial: THREE.MeshStandardMaterial | null = null;
  private isWet = false;
  private nightFactor = 0.0;
  private groundVisibility = 1.0;

  private injectNightGroundShader(mat: THREE.MeshStandardMaterial): void {
    mat.userData.nightUniforms = {
      uNightFactor: { value: this.nightFactor },
      uGroundVisibility: { value: this.groundVisibility },
      uGroundNightBoost: { value: 0.075 } // 7.5% (符合 6~9% 白天強度)
    };

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNightFactor = mat.userData.nightUniforms.uNightFactor;
      shader.uniforms.uGroundVisibility = mat.userData.nightUniforms.uGroundVisibility;
      shader.uniforms.uGroundNightBoost = mat.userData.nightUniforms.uGroundNightBoost;

      shader.fragmentShader = `
        uniform float uNightFactor;
        uniform float uGroundVisibility;
        uniform float uGroundNightBoost;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        // 純冷藍灰補光 (#3a4764)，白天強度的 6~9%，不染粉/橘
        vec3 cGroundNight = vec3(0.227, 0.278, 0.392);
        float boost = uGroundNightBoost * uNightFactor * uGroundVisibility;
        gl_FragColor.rgb += cGroundNight * boost;
        `
      );
    };
  }

  public setNightFactor(factor: number): void {
    this.nightFactor = factor;
    if (this.roadMaterial?.userData.nightUniforms) {
      this.roadMaterial.userData.nightUniforms.uNightFactor.value = factor;
    }
    if (this.sideMaterial?.userData.nightUniforms) {
      this.sideMaterial.userData.nightUniforms.uNightFactor.value = factor;
    }
  }

  public setGroundVisibility(val: number): void {
    this.groundVisibility = val;
    if (this.roadMaterial?.userData.nightUniforms) {
      this.roadMaterial.userData.nightUniforms.uGroundVisibility.value = val;
    }
    if (this.sideMaterial?.userData.nightUniforms) {
      this.sideMaterial.userData.nightUniforms.uGroundVisibility.value = val;
    }
  }

  public generate(roads: RoadFeature[], scene: THREE.Scene, intersections: IntersectionFeature[] = []): void {
    this.dispose(scene);

    if (roads.length === 0) return;

    // 1. 車道幾何緩衝 (包含 UV 座標供 PBR 貼圖)
    const roadPos: number[] = [];
    const roadNorm: number[] = [];
    const roadUvs: number[] = [];
    const roadIdx: number[] = [];
    let roadOffset = 0;

    // 2. 人行道與立體路緣石幾何緩衝
    const sidePos: number[] = [];
    const sideNorm: number[] = [];
    const sideColors: number[] = [];
    const sideUvs: number[] = [];
    const sideIdx: number[] = [];
    let sideOffset = 0;

    // 3. 車道標線幾何緩衝 (中央雙黃線/虛線、交會處斑馬線)
    const markPos: number[] = [];
    const markNorm: number[] = [];
    const markColors: number[] = [];
    const markUvs: number[] = [];
    const markIdx: number[] = [];
    let markOffset = 0;

    // 4. 人孔蓋與路邊排水孔 Transform 矩陣 (InstancedMesh)
    const manholeTransforms: THREE.Matrix4[] = [];
    const grateTransforms: THREE.Matrix4[] = [];
    const dummy = new THREE.Object3D();

    const roadY = CONFIG.ROADS.ELEVATION.ROAD;
    const sideY = CONFIG.ROADS.ELEVATION.SIDEWALK;
    const markY = CONFIG.ROADS.ELEVATION.MARKING;

    const sideColor = new THREE.Color(CONFIG.ROADS.SIDEWALK_COLOR);
    const curbColor = new THREE.Color(CONFIG.ROADS.CURB_COLOR);
    const whiteColor = new THREE.Color(CONFIG.ROADS.MARKING_WHITE);
    const yellowColor = new THREE.Color(CONFIG.ROADS.MARKING_YELLOW);

    for (const road of roads) {
      const pts = road.points;
      if (pts.length < 2) continue;

      const halfW = road.width * 0.5;
      const sW = road.sidewalkWidth;
      const isWide = road.width >= 8.5;

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.25) continue;

        const ux = dx / len;
        const uz = dz / len;
        const nx = -uz;
        const nz = ux;

        // --- A. 車道路面 (Asphalt) ---
        const rL1x = p1.x - nx * halfW;
        const rL1z = p1.z - nz * halfW;
        const rR1x = p1.x + nx * halfW;
        const rR1z = p1.z + nz * halfW;
        const rR2x = p2.x + nx * halfW;
        const rR2z = p2.z + nz * halfW;
        const rL2x = p2.x - nx * halfW;
        const rL2z = p2.z - nz * halfW;

        roadPos.push(
          rL1x, roadY, rL1z,
          rR1x, roadY, rR1z,
          rR2x, roadY, rR2z,
          rL2x, roadY, rL2z
        );
        for (let k = 0; k < 4; k++) roadNorm.push(0, 1, 0);

        // 世界座標 UV，使柏油碎石與裂縫無接縫平鋪
        roadUvs.push(
          rL1x * 0.15, rL1z * 0.15,
          rR1x * 0.15, rR1z * 0.15,
          rR2x * 0.15, rR2z * 0.15,
          rL2x * 0.15, rL2z * 0.15
        );

        roadIdx.push(
          roadOffset, roadOffset + 1, roadOffset + 2,
          roadOffset, roadOffset + 2, roadOffset + 3
        );
        roadOffset += 4;

        // --- B. 人行道與立體路緣石 (Curb) ---
        if (sW > 0.1) {
          // 左側人行道外緣
          const sL1OutX = p1.x - nx * (halfW + sW);
          const sL1OutZ = p1.z - nz * (halfW + sW);
          const sL2OutX = p2.x - nx * (halfW + sW);
          const sL2OutZ = p2.z - nz * (halfW + sW);

          // 1. 左側人行道頂面
          sidePos.push(
            sL1OutX, sideY, sL1OutZ,
            rL1x, sideY, rL1z,
            rL2x, sideY, rL2z,
            sL2OutX, sideY, sL2OutZ
          );
          for (let k = 0; k < 4; k++) {
            sideNorm.push(0, 1, 0);
            sideColors.push(sideColor.r, sideColor.g, sideColor.b);
          }
          sideUvs.push(
            sL1OutX * 0.25, sL1OutZ * 0.25,
            rL1x * 0.25, rL1z * 0.25,
            rL2x * 0.25, rL2z * 0.25,
            sL2OutX * 0.25, sL2OutZ * 0.25
          );
          sideIdx.push(
            sideOffset, sideOffset + 1, sideOffset + 2,
            sideOffset, sideOffset + 2, sideOffset + 3
          );
          sideOffset += 4;

          // 2. 左側路緣石垂直立面 (從 roadY 上升至 sideY)
          sidePos.push(
            rL1x, roadY, rL1z,
            rL1x, sideY, rL1z,
            rL2x, sideY, rL2z,
            rL2x, roadY, rL2z
          );
          for (let k = 0; k < 4; k++) {
            sideNorm.push(nx, 0, nz);
            sideColors.push(curbColor.r, curbColor.g, curbColor.b);
          }
          sideUvs.push(
            rL1x * 0.5, roadY * 0.5,
            rL1x * 0.5, sideY * 0.5,
            rL2x * 0.5, sideY * 0.5,
            rL2x * 0.5, roadY * 0.5
          );
          sideIdx.push(
            sideOffset, sideOffset + 1, sideOffset + 2,
            sideOffset, sideOffset + 2, sideOffset + 3
          );
          sideOffset += 4;

          // 右側人行道外緣
          const sR1OutX = p1.x + nx * (halfW + sW);
          const sR1OutZ = p1.z + nz * (halfW + sW);
          const sR2OutX = p2.x + nx * (halfW + sW);
          const sR2OutZ = p2.z + nz * (halfW + sW);

          // 3. 右側人行道頂面
          sidePos.push(
            rR1x, sideY, rR1z,
            sR1OutX, sideY, sR1OutZ,
            sR2OutX, sideY, sR2OutZ,
            rR2x, sideY, rR2z
          );
          for (let k = 0; k < 4; k++) {
            sideNorm.push(0, 1, 0);
            sideColors.push(sideColor.r, sideColor.g, sideColor.b);
          }
          sideUvs.push(
            rR1x * 0.25, rR1z * 0.25,
            sR1OutX * 0.25, sR1OutZ * 0.25,
            sR2OutX * 0.25, sR2OutZ * 0.25,
            rR2x * 0.25, rR2z * 0.25
          );
          sideIdx.push(
            sideOffset, sideOffset + 1, sideOffset + 2,
            sideOffset, sideOffset + 2, sideOffset + 3
          );
          sideOffset += 4;

          // 4. 右側路緣石垂直立面
          sidePos.push(
            rR1x, sideY, rR1z,
            rR1x, roadY, rR1z,
            rR2x, roadY, rR2z,
            rR2x, sideY, rR2z
          );
          for (let k = 0; k < 4; k++) {
            sideNorm.push(-nx, 0, -nz);
            sideColors.push(curbColor.r, curbColor.g, curbColor.b);
          }
          sideUvs.push(
            rR1x * 0.5, sideY * 0.5,
            rR1x * 0.5, roadY * 0.5,
            rR2x * 0.5, roadY * 0.5,
            rR2x * 0.5, sideY * 0.5
          );
          sideIdx.push(
            sideOffset, sideOffset + 1, sideOffset + 2,
            sideOffset, sideOffset + 2, sideOffset + 3
          );
          sideOffset += 4;

          // 路緣排水孔 (每隔約 35m 在路邊緣放一個)
          if (len > 18.0 && grateTransforms.length < CONFIG.STREET_DEBRIS.MAX_MANHOLES) {
            const grateX = p1.x + ux * (len * 0.5) - nx * (halfW - 0.22);
            const grateZ = p1.z + uz * (len * 0.5) - nz * (halfW - 0.22);
            dummy.position.set(grateX, roadY + 0.005, grateZ);
            dummy.rotation.set(0, Math.atan2(dx, dz), 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            grateTransforms.push(dummy.matrix.clone());
          }
        }

        // --- C. 圓形鑄鐵人孔蓋 (Manhole) 沿路擺放 ---
        if (len > 25.0 && (i % 2 === 0) && manholeTransforms.length < CONFIG.STREET_DEBRIS.MAX_MANHOLES) {
          const mhX = p1.x + ux * (len * 0.45) + nx * (halfW * 0.35);
          const mhZ = p1.z + uz * (len * 0.45) + nz * (halfW * 0.35);
          dummy.position.set(mhX, roadY + 0.008, mhZ);
          dummy.rotation.set(0, (i * 1.7) % (Math.PI * 2), 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          manholeTransforms.push(dummy.matrix.clone());
        }

        // --- D. 車道中央標線 (雙黃線或白虛線) ---
        if (road.width >= 5.0) {
          if (isWide) {
            // 寬路雙黃線
            this.appendDoubleYellowLines(p1, p2, ux, uz, nx, nz, len, markY, yellowColor, markPos, markNorm, markColors, markUvs, markIdx, () => markOffset, (v) => markOffset = v);
          } else {
            // 一般車道白虛線
            this.appendDashedWhiteLine(p1, p2, ux, uz, nx, nz, len, markY, whiteColor, markPos, markNorm, markColors, markUvs, markIdx, () => markOffset, (v) => markOffset = v);
          }
        }

        // --- E. 接合補丁 ---
        if (i < pts.length - 2) {
          this.appendJointPatch(p2, halfW, roadY, roadPos, roadNorm, roadUvs, roadIdx, () => roadOffset, (v) => roadOffset = v);
        }
      }
    }

    // --- F. 單一資料來源：路口斑馬線、停止線與機慢車停等區 ---
    for (const inter of intersections) {
      // 1. 斑馬線 (行人穿越道)
      for (const cross of (inter.crossings || [])) {
        this.appendCrossingBars(cross, markY, whiteColor, markPos, markNorm, markColors, markUvs, markIdx, () => markOffset, (v) => markOffset = v);
      }
      // 2. 停止線與機慢車停等區
      for (const stopLine of (inter.stopLines || [])) {
        this.appendSolidStopLine(stopLine, markY, whiteColor, markPos, markNorm, markColors, markUvs, markIdx, () => markOffset, (v) => markOffset = v);
        if (stopLine.hasScooterWaitingBox) {
          this.appendScooterWaitingBox(stopLine, markY, whiteColor, markPos, markNorm, markColors, markUvs, markIdx, () => markOffset, (v) => markOffset = v);
        }
      }
    }

    // 建立車道 Mesh (PBR 柏油貼圖)
    if (roadPos.length > 0) {
      const roadGeo = new THREE.BufferGeometry();
      roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3));
      roadGeo.setAttribute('normal', new THREE.Float32BufferAttribute(roadNorm, 3));
      roadGeo.setAttribute('uv', new THREE.Float32BufferAttribute(roadUvs, 2));
      roadGeo.setIndex(roadIdx);

      const asphaltTex = TextureGenerator.getAsphaltTextures(this.isWet);

      this.roadMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.ROADS.ROAD_COLOR,
        map: asphaltTex.map,
        normalMap: asphaltTex.normalMap,
        roughnessMap: asphaltTex.roughnessMap,
        roughness: this.isWet ? 0.28 : 0.88,
        metalness: this.isWet ? 0.25 : 0.08
      });
      this.injectNightGroundShader(this.roadMaterial);

      this.roadMesh = new THREE.Mesh(roadGeo, this.roadMaterial);
      this.roadMesh.receiveShadow = true;
      this.roadMesh.name = 'RoadsMesh';
      scene.add(this.roadMesh);
    }

    // 建立人行道與路緣石 Mesh (PBR 方格地磚)
    if (sidePos.length > 0) {
      const sideGeo = new THREE.BufferGeometry();
      sideGeo.setAttribute('position', new THREE.Float32BufferAttribute(sidePos, 3));
      sideGeo.setAttribute('normal', new THREE.Float32BufferAttribute(sideNorm, 3));
      sideGeo.setAttribute('color', new THREE.Float32BufferAttribute(sideColors, 3));
      sideGeo.setAttribute('uv', new THREE.Float32BufferAttribute(sideUvs, 2));
      sideGeo.setIndex(sideIdx);

      const sidewalkTex = TextureGenerator.getSidewalkTextures();

      const sideMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: sidewalkTex.map,
        normalMap: sidewalkTex.normalMap,
        roughnessMap: sidewalkTex.roughnessMap,
        roughness: 0.82,
        metalness: 0.05
      });
      this.sideMaterial = sideMat;
      this.injectNightGroundShader(this.sideMaterial);

      this.sidewalkMesh = new THREE.Mesh(sideGeo, sideMat);
      this.sidewalkMesh.receiveShadow = true;
      this.sidewalkMesh.name = 'SidewalkMesh';
      scene.add(this.sidewalkMesh);
    }

    // 建立磨損標線 Mesh (透明磨損遮罩)
    if (markPos.length > 0) {
      const markGeo = new THREE.BufferGeometry();
      markGeo.setAttribute('position', new THREE.Float32BufferAttribute(markPos, 3));
      markGeo.setAttribute('normal', new THREE.Float32BufferAttribute(markNorm, 3));
      markGeo.setAttribute('color', new THREE.Float32BufferAttribute(markColors, 3));
      markGeo.setAttribute('uv', new THREE.Float32BufferAttribute(markUvs, 2));
      markGeo.setIndex(markIdx);

      const wearTex = TextureGenerator.getMarkingWearTexture();

      const markMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        alphaMap: wearTex,
        transparent: true,
        roughness: 0.72,
        metalness: 0.1,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });

      this.markingsMesh = new THREE.Mesh(markGeo, markMat);
      this.markingsMesh.receiveShadow = true;
      this.markingsMesh.name = 'RoadMarkingsMesh';
      scene.add(this.markingsMesh);
    }

    // 建立鑄鐵人孔蓋 InstancedMesh
    if (manholeTransforms.length > 0) {
      const manholeGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.03, 18);
      const manholeTex = TextureGenerator.getManholeTexture();
      const manholeMat = new THREE.MeshStandardMaterial({
        map: manholeTex,
        roughness: 0.65,
        metalness: 0.75
      });

      this.manholesMesh = new THREE.InstancedMesh(manholeGeo, manholeMat, manholeTransforms.length);
      this.manholesMesh.name = 'Manholes_Instanced';
      this.manholesMesh.receiveShadow = true;

      for (let i = 0; i < manholeTransforms.length; i++) {
        this.manholesMesh.setMatrixAt(i, manholeTransforms[i]);
      }
      this.manholesMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.manholesMesh);
    }

    // 建立路緣排水孔格柵 InstancedMesh
    if (grateTransforms.length > 0) {
      const grateGeo = new THREE.BoxGeometry(0.38, 0.02, 0.75);
      const grateMat = new THREE.MeshStandardMaterial({
        color: 0x1f2429,
        roughness: 0.55,
        metalness: 0.85
      });

      this.gratesMesh = new THREE.InstancedMesh(grateGeo, grateMat, grateTransforms.length);
      this.gratesMesh.name = 'DrainGrates_Instanced';
      this.gratesMesh.receiveShadow = true;

      for (let i = 0; i < grateTransforms.length; i++) {
        this.gratesMesh.setMatrixAt(i, grateTransforms[i]);
      }
      this.gratesMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.gratesMesh);
    }
  }

  /**
   * 切換濕潤路面模式 (按 R 鍵)
   */
  public setWetMode(wet: boolean): void {
    this.isWet = wet;
    if (this.roadMaterial) {
      const asphaltTex = TextureGenerator.getAsphaltTextures(this.isWet);
      this.roadMaterial.map = asphaltTex.map;
      this.roadMaterial.normalMap = asphaltTex.normalMap;
      this.roadMaterial.roughnessMap = asphaltTex.roughnessMap;
      this.roadMaterial.roughness = wet ? 0.28 : 0.88;
      this.roadMaterial.metalness = wet ? 0.25 : 0.08;
      const baseCol = new THREE.Color(CONFIG.ROADS.ROAD_COLOR);
      this.roadMaterial.color.copy(baseCol).multiplyScalar(wet ? 0.75 : 1.0);
      this.roadMaterial.needsUpdate = true;
    }
  }

  /**
   * 連續調節路面濕潤度 (由降雨與乾燥模型驅動)
   */
  public setWetness(wetness: number): void {
    if (this.roadMaterial) {
      const isCurrentlyWet = wetness > 0.3;
      if (isCurrentlyWet !== this.isWet) {
        this.isWet = isCurrentlyWet;
        const asphaltTex = TextureGenerator.getAsphaltTextures(this.isWet);
        this.roadMaterial.map = asphaltTex.map;
        this.roadMaterial.normalMap = asphaltTex.normalMap;
        this.roadMaterial.roughnessMap = asphaltTex.roughnessMap;
      }
      // 粗糙度下限嚴格保證 >= 0.28 (符合 >= 0.25 要求)
      this.roadMaterial.roughness = THREE.MathUtils.lerp(0.88, 0.28, wetness);
      this.roadMaterial.metalness = THREE.MathUtils.lerp(0.08, 0.25, wetness);

      // 濕潤時最多變暗 25% (乘數 0.75 ~ 1.0)，不可全黑
      const baseCol = new THREE.Color(CONFIG.ROADS.ROAD_COLOR);
      const darkenMult = 1.0 - 0.25 * Math.min(1.0, Math.max(0.0, wetness));
      this.roadMaterial.color.copy(baseCol).multiplyScalar(darkenMult);
    }
  }

  // --- 標線輔助產生函式 ---
  private appendDoubleYellowLines(
    p1: Point2D, p2: Point2D, _ux: number, _uz: number, nx: number, nz: number, len: number,
    y: number, color: THREE.Color, pos: number[], norm: number[], col: number[], uvs: number[], idx: number[],
    getOffset: () => number, setOffset: (v: number) => void
  ): void {
    const lineWidth = 0.15;
    const lineGap = 0.20;
    const offsets = [-lineGap * 0.5 - lineWidth * 0.5, lineGap * 0.5 + lineWidth * 0.5];

    for (const off of offsets) {
      const oOffset = getOffset();
      const p1x = p1.x + nx * off;
      const p1z = p1.z + nz * off;
      const p2x = p2.x + nx * off;
      const p2z = p2.z + nz * off;
      const hw = lineWidth * 0.5;

      pos.push(
        p1x - nx * hw, y, p1z - nz * hw,
        p1x + nx * hw, y, p1z + nz * hw,
        p2x + nx * hw, y, p2z + nz * hw,
        p2x - nx * hw, y, p2z - nz * hw
      );
      for (let k = 0; k < 4; k++) {
        norm.push(0, 1, 0);
        col.push(color.r, color.g, color.b);
      }
      uvs.push(0, 0, 1, 0, 1, len * 0.3, 0, len * 0.3);
      idx.push(oOffset, oOffset + 1, oOffset + 2, oOffset, oOffset + 2, oOffset + 3);
      setOffset(oOffset + 4);
    }
  }

  private appendDashedWhiteLine(
    p1: Point2D, _p2: Point2D, ux: number, uz: number, nx: number, nz: number, len: number,
    y: number, color: THREE.Color, pos: number[], norm: number[], col: number[], uvs: number[], idx: number[],
    getOffset: () => number, setOffset: (v: number) => void
  ): void {
    const dashLen = 3.5;
    const gapLen = 4.5;
    const lineWidth = 0.16;
    const hw = lineWidth * 0.5;
    let dist = 1.0;

    while (dist + dashLen < len) {
      const vOffset = getOffset();
      const s1x = p1.x + ux * dist;
      const s1z = p1.z + uz * dist;
      const s2x = p1.x + ux * (dist + dashLen);
      const s2z = p1.z + uz * (dist + dashLen);

      pos.push(
        s1x - nx * hw, y, s1z - nz * hw,
        s1x + nx * hw, y, s1z + nz * hw,
        s2x + nx * hw, y, s2z + nz * hw,
        s2x - nx * hw, y, s2z - nz * hw
      );
      for (let k = 0; k < 4; k++) {
        norm.push(0, 1, 0);
        col.push(color.r, color.g, color.b);
      }
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
      setOffset(vOffset + 4);

      dist += dashLen + gapLen;
    }
  }

  private appendCrossingBars(
    cross: IntersectionCrossing,
    y: number,
    color: THREE.Color,
    pos: number[],
    norm: number[],
    col: number[],
    uvs: number[],
    idx: number[],
    getOffset: () => number,
    setOffset: (v: number) => void
  ): void {
    const forwardX = Math.sin(cross.azimuthRad);
    const forwardZ = Math.cos(cross.azimuthRad);
    const rightX = Math.cos(cross.azimuthRad);
    const rightZ = -Math.sin(cross.azimuthRad);

    const barWidth = 0.45;
    const barGap = 0.45;
    const crossingLength = cross.length || 3.0;
    const hl = crossingLength * 0.5;
    const hw = barWidth * 0.5;

    const totalBars = Math.floor(cross.width / (barWidth + barGap));
    let offset = -cross.width * 0.5 + (barWidth + barGap) * 0.5;

    for (let b = 0; b < totalBars; b++) {
      const vOffset = getOffset();
      const cx = cross.center.x + rightX * offset;
      const cz = cross.center.z + rightZ * offset;

      const p1x = cx - rightX * hw - forwardX * hl;
      const p1z = cz - rightZ * hw - forwardZ * hl;
      const p2x = cx + rightX * hw - forwardX * hl;
      const p2z = cz + rightZ * hw - forwardZ * hl;
      const p3x = cx + rightX * hw + forwardX * hl;
      const p3z = cz + rightZ * hw + forwardZ * hl;
      const p4x = cx - rightX * hw + forwardX * hl;
      const p4z = cz - rightZ * hw + forwardZ * hl;

      pos.push(p1x, y, p1z, p2x, y, p2z, p3x, y, p3z, p4x, y, p4z);
      for (let k = 0; k < 4; k++) {
        norm.push(0, 1, 0);
        col.push(color.r, color.g, color.b);
      }
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
      setOffset(vOffset + 4);

      offset += barWidth + barGap;
    }
  }

  private appendSolidStopLine(
    stopLine: StopLine,
    y: number,
    color: THREE.Color,
    pos: number[],
    norm: number[],
    col: number[],
    uvs: number[],
    idx: number[],
    getOffset: () => number,
    setOffset: (v: number) => void
  ): void {
    const forwardX = Math.sin(stopLine.azimuthRad);
    const forwardZ = Math.cos(stopLine.azimuthRad);
    const lineWidth = CONFIG.TRAFFIC_SIGNALS.ROAD_MARKINGS.STOP_LINE_WIDTH || 0.40;
    const hl = lineWidth * 0.5;

    const vOffset = getOffset();
    const p1 = stopLine.p1;
    const p2 = stopLine.p2;

    const p1x = p1.x - forwardX * hl;
    const p1z = p1.z - forwardZ * hl;
    const p2x = p2.x - forwardX * hl;
    const p2z = p2.z - forwardZ * hl;
    const p3x = p2.x + forwardX * hl;
    const p3z = p2.z + forwardZ * hl;
    const p4x = p1.x + forwardX * hl;
    const p4z = p1.z + forwardZ * hl;

    pos.push(p1x, y, p1z, p2x, y, p2z, p3x, y, p3z, p4x, y, p4z);
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(color.r, color.g, color.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);
  }

  private appendScooterWaitingBox(
    stopLine: StopLine,
    y: number,
    whiteColor: THREE.Color,
    pos: number[],
    norm: number[],
    col: number[],
    uvs: number[],
    idx: number[],
    getOffset: () => number,
    setOffset: (v: number) => void
  ): void {
    if (!stopLine.scooterStopWorldPosition || !stopLine.scooterBoxCenter) return;

    const forwardX = Math.sin(stopLine.azimuthRad);
    const forwardZ = Math.cos(stopLine.azimuthRad);
    const rightX = Math.cos(stopLine.azimuthRad);
    const rightZ = -Math.sin(stopLine.azimuthRad);

    const laneHalfW = (stopLine.width || 3.5) * 0.5;
    const borderWidth = 0.15;
    const hb = borderWidth * 0.5;

    const frontPos = stopLine.scooterStopWorldPosition;
    const frontP1 = { x: frontPos.x - rightX * laneHalfW, z: frontPos.z - rightZ * laneHalfW };
    const frontP2 = { x: frontPos.x + rightX * laneHalfW, z: frontPos.z + rightZ * laneHalfW };

    // 1. 前端白實線 (機車停止線，寬 30cm)
    const frontLineWidth = 0.30;
    const hfl = frontLineWidth * 0.5;
    let vOffset = getOffset();
    pos.push(
      frontP1.x - forwardX * hfl, y, frontP1.z - forwardZ * hfl,
      frontP2.x - forwardX * hfl, y, frontP2.z - forwardZ * hfl,
      frontP2.x + forwardX * hfl, y, frontP2.z + forwardZ * hfl,
      frontP1.x + forwardX * hfl, y, frontP1.z + forwardZ * hfl
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(whiteColor.r, whiteColor.g, whiteColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);

    // 2. 左側邊界線
    const rearP1 = stopLine.p1;
    vOffset = getOffset();
    pos.push(
      rearP1.x - rightX * hb, y, rearP1.z - rightZ * hb,
      rearP1.x + rightX * hb, y, rearP1.z + rightZ * hb,
      frontP1.x + rightX * hb, y, frontP1.z + rightZ * hb,
      frontP1.x - rightX * hb, y, frontP1.z - rightZ * hb
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(whiteColor.r, whiteColor.g, whiteColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);

    // 3. 右側邊界線
    const rearP2 = stopLine.p2;
    vOffset = getOffset();
    pos.push(
      rearP2.x - rightX * hb, y, rearP2.z - rightZ * hb,
      rearP2.x + rightX * hb, y, rearP2.z + rightZ * hb,
      frontP2.x + rightX * hb, y, frontP2.z + rightZ * hb,
      frontP2.x - rightX * hb, y, frontP2.z - rightZ * hb
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(whiteColor.r, whiteColor.g, whiteColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);

    // 4. 停等區內部淺色鋪面底色
    const boxBgColor = new THREE.Color(0x384456);
    vOffset = getOffset();
    pos.push(
      rearP1.x, y - 0.002, rearP1.z,
      rearP2.x, y - 0.002, rearP2.z,
      frontP2.x, y - 0.002, frontP2.z,
      frontP1.x, y - 0.002, frontP1.z
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(boxBgColor.r, boxBgColor.g, boxBgColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);

    // 5. 白色機車圖示
    const bc = stopLine.scooterBoxCenter;
    // 前輪
    const fWheelC = { x: bc.x + forwardX * 0.45, z: bc.z + forwardZ * 0.45 };
    vOffset = getOffset();
    pos.push(
      fWheelC.x - rightX * 0.08 - forwardX * 0.18, y + 0.001, fWheelC.z - rightZ * 0.08 - forwardZ * 0.18,
      fWheelC.x + rightX * 0.08 - forwardX * 0.18, y + 0.001, fWheelC.z + rightZ * 0.08 - forwardZ * 0.18,
      fWheelC.x + rightX * 0.08 + forwardX * 0.18, y + 0.001, fWheelC.z + rightZ * 0.08 + forwardZ * 0.18,
      fWheelC.x - rightX * 0.08 + forwardX * 0.18, y + 0.001, fWheelC.z - rightZ * 0.08 + forwardZ * 0.18
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(whiteColor.r, whiteColor.g, whiteColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);

    // 後輪
    const rWheelC = { x: bc.x - forwardX * 0.45, z: bc.z - forwardZ * 0.45 };
    vOffset = getOffset();
    pos.push(
      rWheelC.x - rightX * 0.08 - forwardX * 0.18, y + 0.001, rWheelC.z - rightZ * 0.08 - forwardZ * 0.18,
      rWheelC.x + rightX * 0.08 - forwardX * 0.18, y + 0.001, rWheelC.z + rightZ * 0.08 - forwardZ * 0.18,
      rWheelC.x + rightX * 0.08 + forwardX * 0.18, y + 0.001, rWheelC.z + rightZ * 0.08 + forwardZ * 0.18,
      rWheelC.x - rightX * 0.08 + forwardX * 0.18, y + 0.001, rWheelC.z - rightZ * 0.08 + forwardZ * 0.18
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(whiteColor.r, whiteColor.g, whiteColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);

    // 車身
    vOffset = getOffset();
    pos.push(
      bc.x - rightX * 0.07 - forwardX * 0.40, y + 0.001, bc.z - rightZ * 0.07 - forwardZ * 0.40,
      bc.x + rightX * 0.07 - forwardX * 0.40, y + 0.001, bc.z + rightZ * 0.07 - forwardZ * 0.40,
      bc.x + rightX * 0.07 + forwardX * 0.40, y + 0.001, bc.z + rightZ * 0.07 + forwardZ * 0.40,
      bc.x - rightX * 0.07 + forwardX * 0.40, y + 0.001, bc.z - rightZ * 0.07 + forwardZ * 0.40
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(whiteColor.r, whiteColor.g, whiteColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);

    // 手把
    const handleC = { x: bc.x + forwardX * 0.35, z: bc.z + forwardZ * 0.35 };
    vOffset = getOffset();
    pos.push(
      handleC.x - rightX * 0.28 - forwardX * 0.06, y + 0.001, handleC.z - rightZ * 0.28 - forwardZ * 0.06,
      handleC.x + rightX * 0.28 - forwardX * 0.06, y + 0.001, handleC.z + rightZ * 0.28 - forwardZ * 0.06,
      handleC.x + rightX * 0.28 + forwardX * 0.06, y + 0.001, handleC.z + rightZ * 0.28 + forwardZ * 0.06,
      handleC.x - rightX * 0.28 + forwardX * 0.06, y + 0.001, handleC.z - rightZ * 0.28 + forwardZ * 0.06
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(whiteColor.r, whiteColor.g, whiteColor.b);
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(vOffset, vOffset + 1, vOffset + 2, vOffset, vOffset + 2, vOffset + 3);
    setOffset(vOffset + 4);
  }

  private appendJointPatch(
    center: Point2D, halfW: number, roadY: number,
    roadPos: number[], roadNorm: number[], roadUvs: number[], roadIdx: number[],
    getRoadOffset: () => number, setRoadOffset: (v: number) => void
  ): void {
    const segments = 6;
    const centerRoadIdx = getRoadOffset();
    roadPos.push(center.x, roadY, center.z);
    roadNorm.push(0, 1, 0);
    roadUvs.push(center.x * 0.15, center.z * 0.15);

    for (let s = 0; s <= segments; s++) {
      const angle = (s / segments) * Math.PI * 2;
      const px = center.x + Math.cos(angle) * halfW;
      const pz = center.z + Math.sin(angle) * halfW;
      roadPos.push(px, roadY, pz);
      roadNorm.push(0, 1, 0);
      roadUvs.push(px * 0.15, pz * 0.15);
    }

    for (let s = 1; s <= segments; s++) {
      roadIdx.push(centerRoadIdx, centerRoadIdx + s, centerRoadIdx + s + 1);
    }
    setRoadOffset(getRoadOffset() + segments + 2);
  }

  public getRoadMesh(): THREE.Mesh | null {
    return this.roadMesh;
  }

  public getSidewalkMesh(): THREE.Mesh | null {
    return this.sidewalkMesh;
  }

  public dispose(scene: THREE.Scene): void {
    if (this.roadMesh) {
      scene.remove(this.roadMesh);
      this.roadMesh.geometry.dispose();
      (this.roadMesh.material as THREE.Material).dispose();
      this.roadMesh = null;
    }
    if (this.sidewalkMesh) {
      scene.remove(this.sidewalkMesh);
      this.sidewalkMesh.geometry.dispose();
      (this.sidewalkMesh.material as THREE.Material).dispose();
      this.sidewalkMesh = null;
    }
    if (this.markingsMesh) {
      scene.remove(this.markingsMesh);
      this.markingsMesh.geometry.dispose();
      (this.markingsMesh.material as THREE.Material).dispose();
      this.markingsMesh = null;
    }
    if (this.manholesMesh) {
      scene.remove(this.manholesMesh);
      this.manholesMesh.geometry.dispose();
      (this.manholesMesh.material as THREE.Material).dispose();
      this.manholesMesh = null;
    }
    if (this.gratesMesh) {
      scene.remove(this.gratesMesh);
      this.gratesMesh.geometry.dispose();
      (this.gratesMesh.material as THREE.Material).dispose();
      this.gratesMesh = null;
    }
  }
}
