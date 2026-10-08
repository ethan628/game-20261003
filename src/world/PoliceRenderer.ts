/**
 * PoliceRenderer.ts - 警察車輛、警員與警報地面假光斑高效能 GPU 渲染器
 * 遵循 RULES.md 與效能要求：
 * 1. 嚴格 Draw Calls 限制：警車+警員 <= 4，地面光斑 <= 2 (本實作總共 4 Draw Calls)
 * 2. 警車造型：白色車身 + 藍色條紋 + 車頂紅藍警示燈 + 虛構車牌 (POL-01)
 *    嚴禁任何真實警徽、真實車牌、機關標誌！
 * 3. 警員造型：藍灰制服 + 海軍藍長褲 + 大盤帽 + 抄寫開單板 (無真實徽章)
 * 4. 地面假光斑貼花：AdditiveBlending，半徑約 10m，紅藍閃爍投影
 * 5. 零逐幀記憶體配置 (GC free)，矩陣與顏色快取重用
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PoliceVehicle } from '../systems/police/PoliceTypes.ts';

export class PoliceRenderer {
  private group: THREE.Group;
  private maxCars = CONFIG.POLICE.MAX_CARS;
  private maxOfficers = CONFIG.POLICE.MAX_CARS * 2;

  // 1. 警車車身 InstancedMesh (Draw Call: 1)
  private carBodyMesh!: THREE.InstancedMesh;
  // 2. 警車車窗與車頂警示燈條 InstancedMesh (Draw Call: 1)
  private carGlassLightMesh!: THREE.InstancedMesh;
  // 3. 執勤警員 InstancedMesh (Draw Call: 1)
  private officerMesh!: THREE.InstancedMesh;
  // 4. 地面紅藍假光斑貼花 (Draw Call: 1, AdditiveBlending)
  private groundLightDecalMesh!: THREE.InstancedMesh;

  // Shader Uniform 與屬性 Buffer
  private sirenActiveAttr!: THREE.InstancedBufferAttribute;
  private groundSirenAttr!: THREE.InstancedBufferAttribute;
  private officerPoseAttr!: THREE.InstancedBufferAttribute; // x: isDismounted, y: writingTimer

  private timeUniform = { value: 0 };

  // 暫存矩陣與物件 (零記憶體配置)
  private dummyObj = new THREE.Object3D();
  private zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -9999, 0);

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'PoliceRendererGroup';

    this.initCarBodyMesh();
    this.initCarGlassLightMesh();
    this.initOfficerMesh();
    this.initGroundLightDecalMesh();

    scene.add(this.group);
  }

  /**
   * 建立警車車身幾何體 (白車身、藍色飾條、輪胎、虛構車牌 'POL-01')
   */
  private createPoliceCarGeometry(): THREE.BufferGeometry {
    // 建立多部件並烘焙頂點顏色
    const parts: Array<{ geom: THREE.BufferGeometry; offset: [number, number, number]; color: [number, number, number] }> = [];

    // 顏色定義 (純虛構設計，禁止真實警徽)
    const cWhite: [number, number, number] = [0.97, 0.98, 0.99]; // 白車身
    const cBlueStripe: [number, number, number] = [0.12, 0.28, 0.69]; // 藍條紋
    const cBlackTrim: [number, number, number] = [0.08, 0.10, 0.14]; // 保險桿/輪胎
    const cPlateWhite: [number, number, number] = [0.85, 0.88, 0.90]; // 虛構車牌
    const cGrille: [number, number, number] = [0.15, 0.16, 0.18]; // 車頭水箱護罩

    // 引擎蓋與前車頭
    parts.push({ geom: new THREE.BoxGeometry(1.78, 0.44, 1.35), offset: [0, 0.54, 1.48], color: cWhite });
    // 後車廂
    parts.push({ geom: new THREE.BoxGeometry(1.78, 0.44, 1.10), offset: [0, 0.54, -1.60], color: cWhite });
    // 座艙底板
    parts.push({ geom: new THREE.BoxGeometry(1.66, 0.12, 1.95), offset: [0, 0.36, -0.10], color: cWhite });
    // 左右門板 (上白下藍)
    parts.push({ geom: new THREE.BoxGeometry(0.08, 0.24, 1.95), offset: [-0.84, 0.64, -0.10], color: cWhite });
    parts.push({ geom: new THREE.BoxGeometry(0.08, 0.24, 1.95), offset: [0.84, 0.64, -0.10], color: cWhite });
    // 兩側辨識藍條紋 (非真實徽章，合法純色條紋)
    parts.push({ geom: new THREE.BoxGeometry(0.09, 0.16, 1.90), offset: [-0.842, 0.44, -0.10], color: cBlueStripe });
    parts.push({ geom: new THREE.BoxGeometry(0.09, 0.16, 1.90), offset: [0.842, 0.44, -0.10], color: cBlueStripe });
    // 引擎蓋藍色條紋 (車頭識別)
    parts.push({ geom: new THREE.BoxGeometry(0.50, 0.02, 1.15), offset: [0, 0.765, 1.50], color: cBlueStripe });

    // 車頂棚
    parts.push({ geom: new THREE.BoxGeometry(1.48, 0.05, 1.82), offset: [0, 1.45, -0.18], color: cWhite });

    // A/B/C 車柱
    parts.push({ geom: new THREE.BoxGeometry(0.06, 0.55, 0.06), offset: [-0.72, 1.12, 0.68], color: cWhite });
    parts.push({ geom: new THREE.BoxGeometry(0.06, 0.55, 0.06), offset: [0.72, 1.12, 0.68], color: cWhite });
    parts.push({ geom: new THREE.BoxGeometry(0.08, 0.55, 0.08), offset: [-0.74, 1.12, -0.22], color: cWhite });
    parts.push({ geom: new THREE.BoxGeometry(0.08, 0.55, 0.08), offset: [0.74, 1.12, -0.22], color: cWhite });
    parts.push({ geom: new THREE.BoxGeometry(0.08, 0.55, 0.08), offset: [-0.72, 1.12, -1.06], color: cWhite });
    parts.push({ geom: new THREE.BoxGeometry(0.08, 0.55, 0.08), offset: [0.72, 1.12, -1.06], color: cWhite });

    // 輪胎 (4 個)
    parts.push({ geom: new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10), offset: [-0.86, 0.32, 1.30], color: cBlackTrim });
    parts.push({ geom: new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10), offset: [0.86, 0.32, 1.30], color: cBlackTrim });
    parts.push({ geom: new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10), offset: [-0.86, 0.32, -1.35], color: cBlackTrim });
    parts.push({ geom: new THREE.CylinderGeometry(0.32, 0.32, 0.22, 10), offset: [0.86, 0.32, -1.35], color: cBlackTrim });

    // 車頭水箱護罩
    parts.push({ geom: new THREE.BoxGeometry(1.20, 0.22, 0.06), offset: [0, 0.50, 2.16], color: cGrille });
    // 前保險桿與後保險桿
    parts.push({ geom: new THREE.BoxGeometry(1.78, 0.20, 0.14), offset: [0, 0.30, 2.14], color: cBlackTrim });
    parts.push({ geom: new THREE.BoxGeometry(1.78, 0.20, 0.14), offset: [0, 0.30, -2.14], color: cBlackTrim });

    // 虛構車牌底板 (POL-01)
    parts.push({ geom: new THREE.BoxGeometry(0.44, 0.18, 0.04), offset: [0, 0.32, 2.22], color: cPlateWhite });
    parts.push({ geom: new THREE.BoxGeometry(0.44, 0.18, 0.04), offset: [0, 0.32, -2.22], color: cPlateWhite });

    // 車頂燈架底座
    parts.push({ geom: new THREE.BoxGeometry(0.85, 0.06, 0.18), offset: [0, 1.49, -0.15], color: cBlackTrim });

    // 合併幾何體
    return this.mergeGeometriesWithColors(parts);
  }

  /**
   * 建立車窗玻璃與車頂紅藍警示燈條幾何體
   */
  private createPoliceGlassLightGeometry(): THREE.BufferGeometry {
    const parts: Array<{ geom: THREE.BufferGeometry; offset: [number, number, number]; color: [number, number, number] }> = [];

    // 車窗深色玻璃
    const cGlass: [number, number, number] = [0.10, 0.14, 0.20];
    // 前擋風玻璃 (微斜)
    parts.push({ geom: new THREE.BoxGeometry(1.36, 0.54, 0.04), offset: [0, 1.15, 0.65], color: cGlass });
    // 後擋風玻璃
    parts.push({ geom: new THREE.BoxGeometry(1.36, 0.54, 0.04), offset: [0, 1.15, -1.02], color: cGlass });
    // 左側窗
    parts.push({ geom: new THREE.BoxGeometry(0.04, 0.44, 1.62), offset: [-0.74, 1.12, -0.18], color: cGlass });
    // 右側窗
    parts.push({ geom: new THREE.BoxGeometry(0.04, 0.44, 1.62), offset: [0.74, 1.12, -0.18], color: cGlass });

    // 車頂紅藍警示燈條 (左紅右藍，台灣標準長條排燈)
    const cRedLight: [number, number, number] = [1.0, 0.08, 0.08]; // 紅燈
    const cBlueLight: [number, number, number] = [0.08, 0.32, 1.0]; // 藍燈
    const cWhiteCenter: [number, number, number] = [0.95, 0.95, 0.95]; // 中央白燈

    parts.push({ geom: new THREE.BoxGeometry(0.42, 0.12, 0.22), offset: [-0.35, 1.57, -0.15], color: cRedLight });
    parts.push({ geom: new THREE.BoxGeometry(0.42, 0.12, 0.22), offset: [0.35, 1.57, -0.15], color: cBlueLight });
    parts.push({ geom: new THREE.BoxGeometry(0.24, 0.12, 0.22), offset: [0.0, 1.57, -0.15], color: cWhiteCenter });

    return this.mergeGeometriesWithColors(parts);
  }

  /**
   * 建立警員幾何體 (藍灰襯衫、深藍長褲、大盤帽、開單記錄板)
   */
  private createOfficerGeometry(): THREE.BufferGeometry {
    const parts: Array<{ geom: THREE.BufferGeometry; offset: [number, number, number]; color: [number, number, number] }> = [];

    const cUniformShirt: [number, number, number] = [0.38, 0.48, 0.62]; // 藍灰襯衫
    const cTrousers: [number, number, number] = [0.11, 0.14, 0.22]; // 深海軍藍長褲
    const cSkin: [number, number, number] = [0.96, 0.82, 0.72]; // 膚色
    const cCap: [number, number, number] = [0.12, 0.16, 0.25]; // 大盤帽頂
    const cCapVisor: [number, number, number] = [0.05, 0.05, 0.06]; // 帽簷
    const cClipboard: [number, number, number] = [0.65, 0.42, 0.20]; // 開單板 (木質/深棕)
    const cPaper: [number, number, number] = [0.95, 0.95, 0.92]; // 白單據

    // 軀幹
    parts.push({ geom: new THREE.BoxGeometry(0.38, 0.52, 0.22), offset: [0, 0.96, 0], color: cUniformShirt });
    // 腿部 (左/右)
    parts.push({ geom: new THREE.BoxGeometry(0.16, 0.68, 0.18), offset: [-0.10, 0.36, 0], color: cTrousers });
    parts.push({ geom: new THREE.BoxGeometry(0.16, 0.68, 0.18), offset: [0.10, 0.36, 0], color: cTrousers });
    // 頭部
    parts.push({ geom: new THREE.BoxGeometry(0.24, 0.24, 0.24), offset: [0, 1.34, 0], color: cSkin });

    // 大盤帽 (圓柱冠頂 + 前帽簷，非真實徽章)
    parts.push({ geom: new THREE.CylinderGeometry(0.17, 0.15, 0.10, 12), offset: [0, 1.48, 0], color: cCap });
    parts.push({ geom: new THREE.BoxGeometry(0.24, 0.02, 0.10), offset: [0, 1.44, 0.13], color: cCapVisor });

    // 手臂與開單板 (做出專注手持抄寫姿勢)
    parts.push({ geom: new THREE.BoxGeometry(0.10, 0.42, 0.10), offset: [-0.24, 0.98, 0.08], color: cUniformShirt });
    parts.push({ geom: new THREE.BoxGeometry(0.10, 0.42, 0.10), offset: [0.24, 0.98, 0.08], color: cUniformShirt });
    // 抄寫板與罰單紙 (端在胸前)
    parts.push({ geom: new THREE.BoxGeometry(0.26, 0.34, 0.02), offset: [0, 1.05, 0.24], color: cClipboard });
    parts.push({ geom: new THREE.BoxGeometry(0.22, 0.28, 0.01), offset: [0, 1.05, 0.252], color: cPaper });

    return this.mergeGeometriesWithColors(parts);
  }

  /**
   * 輔助幾何體合併並烘焙頂點顏色
   */
  private mergeGeometriesWithColors(
    parts: Array<{ geom: THREE.BufferGeometry; offset: [number, number, number]; color: [number, number, number] }>
  ): THREE.BufferGeometry {
    let totalVerts = 0;
    let totalIndices = 0;

    for (const p of parts) {
      const pos = p.geom.attributes.position;
      totalVerts += pos.count;
      if (p.geom.index) totalIndices += p.geom.index.count;
      else totalIndices += pos.count;
    }

    const posArray = new Float32Array(totalVerts * 3);
    const normArray = new Float32Array(totalVerts * 3);
    const colArray = new Float32Array(totalVerts * 3);
    const idxArray = new Uint16Array(totalIndices);

    let vOffset = 0;
    let iOffset = 0;

    for (const p of parts) {
      const g = p.geom;
      const pos = g.attributes.position;
      const norm = g.attributes.normal;
      const count = pos.count;
      const [ox, oy, oz] = p.offset;
      const [cr, cg, cb] = p.color;

      for (let i = 0; i < count; i++) {
        const vi = (vOffset + i) * 3;
        const si = i * 3;
        posArray[vi] = pos.array[si] + ox;
        posArray[vi + 1] = pos.array[si + 1] + oy;
        posArray[vi + 2] = pos.array[si + 2] + oz;

        if (norm) {
          normArray[vi] = norm.array[si];
          normArray[vi + 1] = norm.array[si + 1];
          normArray[vi + 2] = norm.array[si + 2];
        } else {
          normArray[vi] = 0;
          normArray[vi + 1] = 1;
          normArray[vi + 2] = 0;
        }

        colArray[vi] = cr;
        colArray[vi + 1] = cg;
        colArray[vi + 2] = cb;
      }

      if (g.index) {
        for (let j = 0; j < g.index.count; j++) {
          idxArray[iOffset + j] = vOffset + g.index.array[j];
        }
        iOffset += g.index.count;
      } else {
        for (let j = 0; j < count; j++) {
          idxArray[iOffset + j] = vOffset + j;
        }
        iOffset += count;
      }

      vOffset += count;
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    merged.setAttribute('normal', new THREE.BufferAttribute(normArray, 3));
    merged.setAttribute('color', new THREE.BufferAttribute(colArray, 3));
    merged.setIndex(new THREE.BufferAttribute(idxArray, 1));

    return merged;
  }

  // --- 初始化各 InstancedMesh ---

  private initCarBodyMesh(): void {
    const geom = this.createPoliceCarGeometry();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.35,
      metalness: 0.15
    });

    this.carBodyMesh = new THREE.InstancedMesh(geom, mat, this.maxCars);
    this.carBodyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.carBodyMesh.castShadow = true;
    this.carBodyMesh.receiveShadow = true;
    this.carBodyMesh.name = 'PoliceCarBodyMesh';

    for (let i = 0; i < this.maxCars; i++) {
      this.carBodyMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.carBodyMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.carBodyMesh);
  }

  private initCarGlassLightMesh(): void {
    const geom = this.createPoliceGlassLightGeometry();

    const sirenActiveData = new Float32Array(this.maxCars);
    this.sirenActiveAttr = new THREE.InstancedBufferAttribute(sirenActiveData, 1);
    geom.setAttribute('aSirenActive', this.sirenActiveAttr);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.1,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85
    });

    // 注入動態紅藍交替閃爍著色 Shader
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.timeUniform;
      shader.vertexShader = `
        attribute float aSirenActive;
        varying float vSirenActive;
        varying vec3 vOrigColor;
        ${shader.vertexShader}
      `.replace(
        '#include <color_vertex>',
        `
        #include <color_vertex>
        vSirenActive = aSirenActive;
        vOrigColor = color;
        `
      );

      shader.fragmentShader = `
        uniform float uTime;
        varying float vSirenActive;
        varying vec3 vOrigColor;
        ${shader.fragmentShader}
      `.replace(
        '#include <dithering_fragment>',
        `
        #include <dithering_fragment>
        if (vSirenActive > 0.5) {
          // 紅藍交替閃爍 (4Hz)
          float flash = sin(uTime * 24.0);
          bool isRedSide = vOrigColor.r > 0.6 && vOrigColor.b < 0.3;
          bool isBlueSide = vOrigColor.b > 0.6 && vOrigColor.r < 0.3;
          bool isCenterWhite = vOrigColor.r > 0.8 && vOrigColor.g > 0.8 && vOrigColor.b > 0.8;

          if (isRedSide) {
            float intensity = flash > 0.0 ? 3.5 : 0.2;
            gl_FragColor.rgb = vec3(1.0, 0.05, 0.05) * intensity;
          } else if (isBlueSide) {
            float intensity = flash < 0.0 ? 3.5 : 0.2;
            gl_FragColor.rgb = vec3(0.05, 0.35, 1.0) * intensity;
          } else if (isCenterWhite) {
            float strobe = sin(uTime * 48.0) > 0.5 ? 2.5 : 0.1;
            gl_FragColor.rgb = vec3(1.0) * strobe;
          }
        }
        `
      );
    };

    this.carGlassLightMesh = new THREE.InstancedMesh(geom, mat, this.maxCars);
    this.carGlassLightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.carGlassLightMesh.name = 'PoliceCarGlassLightMesh';

    for (let i = 0; i < this.maxCars; i++) {
      this.carGlassLightMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.carGlassLightMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.carGlassLightMesh);
  }

  private initOfficerMesh(): void {
    const geom = this.createOfficerGeometry();

    const poseData = new Float32Array(this.maxOfficers * 2);
    this.officerPoseAttr = new THREE.InstancedBufferAttribute(poseData, 2);
    geom.setAttribute('aOfficerPose', this.officerPoseAttr);

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.5,
      metalness: 0.05
    });

    this.officerMesh = new THREE.InstancedMesh(geom, mat, this.maxOfficers);
    this.officerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.officerMesh.castShadow = true;
    this.officerMesh.name = 'PoliceOfficerMesh';

    for (let i = 0; i < this.maxOfficers; i++) {
      this.officerMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.officerMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.officerMesh);
  }

  private initGroundLightDecalMesh(): void {
    // 圓形地面貼花 (直徑 20m，半徑 10m)
    const geom = new THREE.PlaneGeometry(20, 20);
    geom.rotateX(-Math.PI / 2); // 貼在水平地面上

    const sirenData = new Float32Array(this.maxCars);
    this.groundSirenAttr = new THREE.InstancedBufferAttribute(sirenData, 1);
    geom.setAttribute('aGroundSiren', this.groundSirenAttr);

    // AdditiveBlending 自發光地面假光斑，0~2 Draw Calls
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.timeUniform
      },
      vertexShader: `
        attribute float aGroundSiren;
        varying float vSiren;
        varying vec2 vUv;
        void main() {
          vSiren = aGroundSiren;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying float vSiren;
        varying vec2 vUv;
        void main() {
          if (vSiren < 0.5) {
            discard;
          }
          vec2 center = vUv - vec2(0.5);
          float dist = length(center) * 2.0;
          if (dist > 1.0) discard;

          float falloff = pow(1.0 - dist, 2.0);
          float flash = sin(uTime * 24.0);

          // 左紅右藍
          vec3 redLight = vec3(1.0, 0.05, 0.05) * max(0.0, flash) * 0.45;
          vec3 blueLight = vec3(0.05, 0.35, 1.0) * max(0.0, -flash) * 0.45;

          // 根據 UV.x 漸變偏左偏右
          vec3 col = mix(redLight, blueLight, vUv.x);
          gl_FragColor = vec4(col * falloff, falloff * 0.4);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.groundLightDecalMesh = new THREE.InstancedMesh(geom, mat, this.maxCars);
    this.groundLightDecalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.groundLightDecalMesh.name = 'PoliceGroundLightDecalMesh';

    for (let i = 0; i < this.maxCars; i++) {
      this.groundLightDecalMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.groundLightDecalMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.groundLightDecalMesh);
  }

  /**
   * 逐幀更新警車、警員與警報地面光斑實例矩陣
   */
  public update(policeVehicles: PoliceVehicle[], dt: number): void {
    this.timeUniform.value += dt;

    let carIdx = 0;
    let officerIdx = 0;

    for (let i = 0; i < policeVehicles.length && carIdx < this.maxCars; i++) {
      const pv = policeVehicles[i];
      if (!pv.active) continue;

      // 1. 車輛矩陣
      this.dummyObj.position.set(pv.x, pv.y || 0.1, pv.z);
      this.dummyObj.rotation.set(0, pv.rotationY, 0);
      this.dummyObj.scale.set(1, 1, 1);
      this.dummyObj.updateMatrix();

      this.carBodyMesh.setMatrixAt(carIdx, this.dummyObj.matrix);
      this.carGlassLightMesh.setMatrixAt(carIdx, this.dummyObj.matrix);

      // 警笛/警示燈啟用狀態
      const isSirenOn = pv.sirenActive || pv.state === 'STOP_AND_CITE';
      this.sirenActiveAttr.setX(carIdx, isSirenOn ? 1.0 : 0.0);

      // 地面假光斑貼花 (停在 y = 0.04 避免 z-fighting)
      if (isSirenOn) {
        this.dummyObj.position.set(pv.x, 0.04, pv.z);
        this.dummyObj.rotation.set(0, pv.rotationY, 0);
        this.dummyObj.scale.set(1, 1, 1);
        this.dummyObj.updateMatrix();
        this.groundLightDecalMesh.setMatrixAt(carIdx, this.dummyObj.matrix);
        this.groundSirenAttr.setX(carIdx, 1.0);
      } else {
        this.groundLightDecalMesh.setMatrixAt(carIdx, this.zeroMatrix);
        this.groundSirenAttr.setX(carIdx, 0.0);
      }

      // 2. 警員矩陣 (車內或下車)
      for (const off of pv.officers) {
        if (officerIdx >= this.maxOfficers) break;

        if (off.isDismounted) {
          // 下車執勤 (站立在車外開單)
          this.dummyObj.position.set(off.x, 0.08, off.z);
          this.dummyObj.rotation.set(0, off.rotationY, 0);
          this.dummyObj.scale.set(1, 1, 1);
          this.dummyObj.updateMatrix();

          this.officerMesh.setMatrixAt(officerIdx, this.dummyObj.matrix);
          this.officerPoseAttr.setXY(officerIdx, 1.0, off.writingTimer);
        } else {
          // 車內駕駛座/副駕 (微縮於座艙內，若視角近景可視)
          const isDriver = off.seat === 'driver';
          const sideOffset = isDriver ? -0.42 : 0.42; // 左駕
          const fwdX = Math.sin(pv.rotationY);
          const fwdZ = Math.cos(pv.rotationY);
          const rightX = Math.cos(pv.rotationY);
          const rightZ = -Math.sin(pv.rotationY);

          const posX = pv.x + rightX * sideOffset - fwdX * 0.15;
          const posZ = pv.z + rightZ * sideOffset - fwdZ * 0.15;

          this.dummyObj.position.set(posX, (pv.y || 0.1) + 0.1, posZ);
          this.dummyObj.rotation.set(0, pv.rotationY, 0);
          this.dummyObj.scale.set(0.9, 0.9, 0.9);
          this.dummyObj.updateMatrix();

          this.officerMesh.setMatrixAt(officerIdx, this.dummyObj.matrix);
          this.officerPoseAttr.setXY(officerIdx, 0.0, 0.0);
        }
        officerIdx++;
      }

      carIdx++;
    }

    // 清空剩餘實例
    for (let c = carIdx; c < this.maxCars; c++) {
      this.carBodyMesh.setMatrixAt(c, this.zeroMatrix);
      this.carGlassLightMesh.setMatrixAt(c, this.zeroMatrix);
      this.groundLightDecalMesh.setMatrixAt(c, this.zeroMatrix);
      this.sirenActiveAttr.setX(c, 0.0);
      this.groundSirenAttr.setX(c, 0.0);
    }
    for (let o = officerIdx; o < this.maxOfficers; o++) {
      this.officerMesh.setMatrixAt(o, this.zeroMatrix);
      this.officerPoseAttr.setXY(o, 0.0, 0.0);
    }

    // 標記 GPU 更新
    this.carBodyMesh.instanceMatrix.needsUpdate = true;
    this.carGlassLightMesh.instanceMatrix.needsUpdate = true;
    this.officerMesh.instanceMatrix.needsUpdate = true;
    this.groundLightDecalMesh.instanceMatrix.needsUpdate = true;

    this.sirenActiveAttr.needsUpdate = true;
    this.groundSirenAttr.needsUpdate = true;
    this.officerPoseAttr.needsUpdate = true;
  }
}
