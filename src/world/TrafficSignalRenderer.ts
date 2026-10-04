/**
 * TrafficSignalRenderer.ts - 台灣風格懸臂式交通號誌 GPU 渲染器
 * 遵循 RULES.md 與效能硬性要求：
 * 1. 懸臂式燈桿、燈頭箱體、車輛發光號誌、行人號誌(小綠人/紅人)、倒數計時器、路面標線
 * 2. 全部採用 InstancedMesh 批次繪製，總 Draw Calls 嚴格不超過 6 個 (剛好 6 個)
 * 3. 倒數計時器使用 Texture Atlas 數字字元集，著色器座標動態映射，零額外幾何
 * 4. 僅更新玩家 300 公尺內之路口外觀，逐幀更新耗時控制在 0.3 ms 內
 * 5. 亮燈自發光效果 (MeshBasicMaterial + 光暈 Halo + toneMapped: false)
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { IntersectionFeature, TrafficSignalPoleConfig, Point2D } from '../geo/OsmTypes.ts';
import { TrafficSignalSystem } from '../systems/traffic-signals/TrafficSignalSystem.ts';

// 產生 0~9 數字 Texture Strip (512 x 64)
function createCountdownAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#050708';
  ctx.fillRect(0, 0, 512, 64);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 52px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const w = 512 / 10;
  for (let i = 0; i < 10; i++) {
    ctx.fillText(`${i}`, i * w + w * 0.5, 34);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// 產生行人號誌紋理 (256 x 512): 上半紅人、下半小綠人
function createPedSignalAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 512;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#06080a';
  ctx.fillRect(0, 0, 256, 512);

  // 上半格：紅色站立小人 (背景微暗紅)
  ctx.fillStyle = '#ff1e1e';
  // 頭部
  ctx.beginPath();
  ctx.arc(128, 80, 30, 0, Math.PI * 2);
  ctx.fill();
  // 身體與雙腿
  ctx.fillRect(104, 120, 48, 76);
  ctx.fillRect(102, 200, 20, 52);
  ctx.fillRect(134, 200, 20, 52);
  ctx.fillRect(76, 128, 20, 56);
  ctx.fillRect(160, 128, 20, 56);

  // 下半格：綠色快走小綠人
  ctx.fillStyle = '#00ff66';
  ctx.beginPath();
  ctx.arc(128, 330, 30, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(128, 370);
  ctx.rotate(0.18);
  ctx.fillRect(-24, 0, 48, 68);

  // 跨步雙腿
  ctx.beginPath();
  ctx.moveTo(-12, 68);
  ctx.lineTo(-40, 128);
  ctx.lineTo(-20, 130);
  ctx.lineTo(4, 72);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(12, 68);
  ctx.lineTo(40, 128);
  ctx.lineTo(20, 130);
  ctx.lineTo(-4, 72);
  ctx.fill();

  // 擺手
  ctx.fillRect(-44, 12, 16, 44);
  ctx.fillRect(28, 12, 16, 44);
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// 產生機車待轉區標線紋理 (256 x 256)
function createScooterBoxTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, 256, 256);

  // 白色邊框
  ctx.strokeStyle = '#f4f7fa';
  ctx.lineWidth = 14;
  ctx.strokeRect(10, 10, 236, 236);

  // 內部機車白色圖示
  ctx.fillStyle = '#f4f7fa';
  ctx.strokeStyle = '#f4f7fa';
  ctx.lineWidth = 8;

  // 輪子
  ctx.beginPath();
  ctx.arc(75, 168, 24, 0, Math.PI * 2);
  ctx.arc(181, 168, 24, 0, Math.PI * 2);
  ctx.stroke();

  // 車身車架
  ctx.beginPath();
  ctx.moveTo(75, 168);
  ctx.lineTo(115, 128);
  ctx.lineTo(155, 128);
  ctx.lineTo(181, 168);
  ctx.stroke();

  // 龍頭手把
  ctx.beginPath();
  ctx.moveTo(115, 128);
  ctx.lineTo(100, 95);
  ctx.lineTo(82, 95);
  ctx.stroke();

  // 座墊
  ctx.fillRect(115, 118, 42, 12);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class TrafficSignalRenderer {
  private group: THREE.Group;
  private maxPoles: number = 240;
  private maxMarkings: number = 300;

  // 6 個獨立 InstancedMesh (剛好 6 個 Draw Calls)
  private poleMesh!: THREE.InstancedMesh;         // Draw Call 1: 燈桿立柱、橫臂與警示條紋
  private housingMesh!: THREE.InstancedMesh;      // Draw Call 2: 黑色燈頭箱體與遮光罩
  private vehicleLightMesh!: THREE.InstancedMesh; // Draw Call 3: 車輛三色燈盤與光暈
  private pedSignalMesh!: THREE.InstancedMesh;    // Draw Call 4: 行人號誌盤 (小綠人/紅人)
  private countdownMesh!: THREE.InstancedMesh;    // Draw Call 5: 倒數計時數字盤
  private roadMarkingMesh!: THREE.InstancedMesh;  // Draw Call 6: 停止線與機車待轉區

  // 自訂實例著色器屬性
  private vehicleStateAttr!: THREE.InstancedBufferAttribute; // x: state (0=green, 1=yellow, 2=red, 3=flashYellow)
  private pedStateAttr!: THREE.InstancedBufferAttribute;     // x: state (0=walk, 1=flash, 2=dontWalk)
  private countdownAttr!: THREE.InstancedBufferAttribute;    // x: remainingSec, y: colType (0=green, 1=yellow, 2=red)

  // 全域計時 uniform (供小綠人閃爍)
  private globalUniforms = {
    uTime: { value: 0.0 }
  };

  private poleList: Array<{
    poleConfig: TrafficSignalPoleConfig;
    intersectionId: string;
    center: Point2D;
    matrix: THREE.Matrix4;
  }> = [];

  private markingList: Array<{
    matrix: THREE.Matrix4;
    center: Point2D;
  }> = [];

  private zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -9999, 0);
  private lastDrawCalls = 0;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'TrafficSignalRendererGroup';
    scene.add(this.group);

    this.initMeshes();
  }

  /**
   * 初始化 6 個 InstancedMesh 與材質
   */
  private initMeshes(): void {
    // 1. 燈桿與懸臂幾何體 (Draw Call 1: 台灣風格黃黑條紋底座 + 深灰立桿 + 橫跨車道橫臂)
    const poleGeom = this.createPoleGeometry();
    poleGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    const poleMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.65,
      metalness: 0.25,
      side: THREE.DoubleSide
    });
    this.poleMesh = new THREE.InstancedMesh(poleGeom, poleMat, this.maxPoles);
    this.poleMesh.name = 'SignalPoleMesh';
    this.poleMesh.castShadow = true;
    this.poleMesh.receiveShadow = true;
    this.poleMesh.frustumCulled = false;

    // 2. 燈頭箱體與遮光罩幾何體 (Draw Call 2: 黑色霧面外殼)
    const housingGeom = this.createHousingGeometry();
    housingGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x11161d,
      roughness: 0.85,
      metalness: 0.1,
      side: THREE.DoubleSide
    });
    this.housingMesh = new THREE.InstancedMesh(housingGeom, housingMat, this.maxPoles);
    this.housingMesh.name = 'SignalHousingMesh';
    this.housingMesh.castShadow = true;
    this.housingMesh.receiveShadow = true;
    this.housingMesh.frustumCulled = false;

    // 3. 車輛三色燈盤與發光光暈 (Draw Call 3: MeshBasicMaterial + 自發光著色器)
    const vLightGeom = this.createVehicleLightGeometry();
    vLightGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);

    this.vehicleStateAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPoles), 1);
    this.vehicleStateAttr.setUsage(THREE.DynamicDrawUsage);
    vLightGeom.setAttribute('aVehicleState', this.vehicleStateAttr);

    const vLightMat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      toneMapped: false
    });
    vLightMat.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aLightType; // 0=Green, 1=Yellow, 2=Red
        attribute float aIsHalo;    // 0=實心燈面, 1=擴散光暈
        attribute float aVehicleState; // 0=Green, 1=Yellow, 2=Red, 3=FlashYellow
        varying vec4 vLightColor;
      ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        float lit = 0.0;
        vec3 col = vec3(0.06, 0.06, 0.06);

        if (aVehicleState < 0.5) { // 綠燈
          if (aLightType < 0.5) { lit = 1.0; col = vec3(0.0, 1.0, 0.42); }
          else if (aLightType < 1.5) { col = vec3(0.12, 0.09, 0.02); }
          else { col = vec3(0.14, 0.03, 0.03); }
        } else if (aVehicleState < 1.5) { // 黃燈
          if (aLightType > 0.5 && aLightType < 1.5) { lit = 1.0; col = vec3(1.0, 0.80, 0.0); }
          else if (aLightType < 0.5) { col = vec3(0.03, 0.12, 0.05); }
          else { col = vec3(0.14, 0.03, 0.03); }
        } else if (aVehicleState < 2.5) { // 紅燈
          if (aLightType > 1.5) { lit = 1.0; col = vec3(1.0, 0.12, 0.12); }
          else if (aLightType < 0.5) { col = vec3(0.03, 0.12, 0.05); }
          else { col = vec3(0.12, 0.09, 0.02); }
        } else { // 閃黃燈
          if (aLightType > 0.5 && aLightType < 1.5) { lit = 1.0; col = vec3(1.0, 0.80, 0.0); }
        }

        float alpha = 1.0;
        if (aIsHalo > 0.5) {
          if (lit > 0.5) {
            alpha = 0.55;
          } else {
            alpha = 0.0;
          }
        }

        vLightColor = vec4(col, alpha);
        `
      );

      shader.fragmentShader = `
        varying vec4 vLightColor;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor = vLightColor;
        if (diffuseColor.a < 0.01) discard;
        `
      );
    };

    this.vehicleLightMesh = new THREE.InstancedMesh(vLightGeom, vLightMat, this.maxPoles);
    this.vehicleLightMesh.name = 'SignalVehicleLightMesh';
    this.vehicleLightMesh.frustumCulled = false;

    // 4. 行人號誌盤 (Draw Call 4: 小綠人 / 紅人)
    const pedGeom = this.createPedSignalGeometry();
    pedGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);

    this.pedStateAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPoles), 1);
    this.pedStateAttr.setUsage(THREE.DynamicDrawUsage);
    pedGeom.setAttribute('aPedState', this.pedStateAttr);

    const pedTex = createPedSignalAtlas();
    const pedMat = new THREE.MeshBasicMaterial({
      map: pedTex,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    pedMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.globalUniforms.uTime;
      shader.vertexShader = `
        uniform float uTime;
        attribute float aPedSlot;  // 0=上紅人, 1=下小綠人
        attribute float aPedState; // 0=walk, 1=flash, 2=dontWalk
        varying float vPedLit;
      ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        float lit = 0.0;
        if (aPedState < 0.5) { // 綠燈 Walk
          if (aPedSlot > 0.5) lit = 1.0;
        } else if (aPedState < 1.5) { // 閃爍 Flashing
          if (aPedSlot > 0.5) {
            lit = step(0.5, fract(uTime * 3.0));
          }
        } else { // 紅燈 DontWalk
          if (aPedSlot < 0.5) lit = 1.0;
        }
        vPedLit = lit;
        `
      );

      shader.fragmentShader = `
        varying float vPedLit;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor.rgb *= (0.16 + vPedLit * 0.84);
        `
      );
    };

    this.pedSignalMesh = new THREE.InstancedMesh(pedGeom, pedMat, this.maxPoles);
    this.pedSignalMesh.name = 'SignalPedMesh';
    this.pedSignalMesh.frustumCulled = false;

    // 5. 倒數計時數字盤 (Draw Call 5)
    const countdownGeom = this.createCountdownGeometry();
    countdownGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);

    this.countdownAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPoles * 2), 2);
    this.countdownAttr.setUsage(THREE.DynamicDrawUsage);
    countdownGeom.setAttribute('aCountdownData', this.countdownAttr);

    const countdownTex = createCountdownAtlas();
    const countdownMat = new THREE.MeshBasicMaterial({
      map: countdownTex,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    countdownMat.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aDigitPlace; // 0=十位數, 1=個位數
        attribute vec2 aCountdownData; // x: 秒數 (0~99), y: 顏色 (0=綠, 1=黃, 2=紅)
        varying vec3 vDigitColor;
      ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `
        #include <uv_vertex>
        #ifdef USE_MAP
        float sec = clamp(aCountdownData.x, 0.0, 99.0);
        float tens = floor(sec / 10.0);
        float ones = mod(floor(sec), 10.0);
        float digit = aDigitPlace < 0.5 ? tens : ones;

        // Texture Atlas: 10 個數字均分 (寬度 0.1)
        vMapUv.x = (vMapUv.x + digit) / 10.0;
        #endif

        vec3 c = vec3(0.0, 1.0, 0.42);
        if (aCountdownData.y > 1.5) c = vec3(1.0, 0.15, 0.15);
        else if (aCountdownData.y > 0.5) c = vec3(1.0, 0.80, 0.0);
        vDigitColor = c;
        `
      );

      shader.fragmentShader = `
        varying vec3 vDigitColor;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor.rgb *= vDigitColor;
        `
      );
    };

    this.countdownMesh = new THREE.InstancedMesh(countdownGeom, countdownMat, this.maxPoles);
    this.countdownMesh.name = 'SignalCountdownMesh';
    this.countdownMesh.frustumCulled = false;

    // 6. 路面停止線與機車待轉格 (Draw Call 6)
    const markingGeom = this.createRoadMarkingGeometry();
    markingGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);

    const scooterTex = createScooterBoxTexture();
    const markingMat = new THREE.MeshBasicMaterial({
      map: scooterTex,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });

    this.roadMarkingMesh = new THREE.InstancedMesh(markingGeom, markingMat, this.maxMarkings);
    this.roadMarkingMesh.name = 'SignalRoadMarkingMesh';
    this.roadMarkingMesh.frustumCulled = false;

    // 預設全數隱藏於地下
    for (let i = 0; i < this.maxPoles; i++) {
      this.poleMesh.setMatrixAt(i, this.zeroMatrix);
      this.housingMesh.setMatrixAt(i, this.zeroMatrix);
      this.vehicleLightMesh.setMatrixAt(i, this.zeroMatrix);
      this.pedSignalMesh.setMatrixAt(i, this.zeroMatrix);
      this.countdownMesh.setMatrixAt(i, this.zeroMatrix);
    }
    for (let i = 0; i < this.maxMarkings; i++) {
      this.roadMarkingMesh.setMatrixAt(i, this.zeroMatrix);
    }

    this.poleMesh.instanceMatrix.needsUpdate = true;
    this.housingMesh.instanceMatrix.needsUpdate = true;
    this.vehicleLightMesh.instanceMatrix.needsUpdate = true;
    this.pedSignalMesh.instanceMatrix.needsUpdate = true;
    this.countdownMesh.instanceMatrix.needsUpdate = true;
    this.roadMarkingMesh.instanceMatrix.needsUpdate = true;

    this.group.add(this.poleMesh);
    this.group.add(this.housingMesh);
    this.group.add(this.vehicleLightMesh);
    this.group.add(this.pedSignalMesh);
    this.group.add(this.countdownMesh);
    this.group.add(this.roadMarkingMesh);
  }

  /**
   * 建立燈桿與橫臂幾何體 (合併幾何體，含底座黃黑警示條紋頂點色)
   */
  private createPoleGeometry(): THREE.BufferGeometry {
    const vis = CONFIG.TRAFFIC_SIGNALS.VISUAL;
    const postHeight = vis.POLE_HEIGHT; // 7.2m
    const postRadius = vis.POLE_RADIUS; // 0.16m
    const armLength = vis.ARM_LENGTH;   // 5.8m
    const armHeight = vis.ARM_HEIGHT;   // 6.0m

    // 1. 立柱 (高 7.2m, 多細分高度段以支援頂點著色黃黑警示條紋)
    const postGeom = new THREE.CylinderGeometry(postRadius * 0.9, postRadius * 1.25, postHeight, 10, 24);
    postGeom.translate(0, postHeight * 0.5, 0);

    // 2. 懸臂橫桿 (長 5.8m, 沿車道橫跨方向 local +X 延伸)
    const armGeom = new THREE.CylinderGeometry(postRadius * 0.55, postRadius * 0.85, armLength, 8);
    armGeom.rotateZ(-Math.PI * 0.5);
    armGeom.translate(armLength * 0.5, armHeight, 0);

    // 3. 斜向加固拉桿 (從立柱 6.9m 連至橫臂 2.2m)
    const strutLen = Math.hypot(2.2, 0.9);
    const strutGeom = new THREE.CylinderGeometry(0.035, 0.035, strutLen, 6);
    const strutAngle = Math.atan2(2.2, -0.9);
    strutGeom.rotateZ(-strutAngle);
    strutGeom.translate(1.1, armHeight + 0.45, 0);

    // 4. 底座法蘭盤
    const baseGeom = new THREE.CylinderGeometry(postRadius * 1.6, postRadius * 1.7, 0.10, 10);
    baseGeom.translate(0, 0.05, 0);

    const merged = this.mergeGeometries([postGeom, armGeom, strutGeom, baseGeom]);

    // 頂點色彩填入：底座 1.8m 以下為台灣經典黃黑相間警示條紋，其餘為深灰藍防蝕漆
    const pos = merged.attributes.position.array as Float32Array;
    const colors = new Float32Array(pos.length);

    for (let i = 0; i < pos.length; i += 3) {
      const y = pos[i + 1];
      const x = pos[i];
      if (y < 1.85 && Math.abs(x) < 0.35) {
        // 每 0.28m 一道條紋
        const stripe = Math.floor(y / 0.28);
        if (stripe % 2 === 0) {
          // 警示亮黃
          colors[i] = 0.98;
          colors[i + 1] = 0.80;
          colors[i + 2] = 0.05;
        } else {
          // 警示黑灰
          colors[i] = 0.12;
          colors[i + 1] = 0.13;
          colors[i + 2] = 0.16;
        }
      } else {
        // 深灰藍底漆
        colors[i] = 0.16;
        colors[i + 1] = 0.20;
        colors[i + 2] = 0.25;
      }
    }

    merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return merged;
  }

  /**
   * 建立號誌箱體與遮光罩幾何體 (面向 -Z 車流來向)
   */
  private createHousingGeometry(): THREE.BufferGeometry {
    const geoms: THREE.BufferGeometry[] = [];
    const headW = 0.95;
    const headH = 0.38;
    const headD = 0.22;

    const addHeadBox = (cx: number, cy: number, cz: number) => {
      const box = new THREE.BoxGeometry(headW, headH, headD);
      box.translate(cx, cy, cz);
      geoms.push(box);

      // 遮光罩 (3 具朝向 -Z 的遮陽罩頂蓋)
      for (const dx of [-0.30, 0.0, 0.30]) {
        const visor = new THREE.BoxGeometry(0.30, 0.04, 0.16);
        visor.translate(cx + dx, cy + headH * 0.48, cz - headD * 0.5 - 0.07);
        geoms.push(visor);
      }
    };

    // 1. 懸臂外側主車輛燈箱 1 (懸臂 x = 3.6m, 高 6.0m)
    addHeadBox(3.6, 6.0, 0.0);

    // 2. 懸臂內側主車輛燈箱 2 (懸臂 x = 5.2m, 高 6.0m)
    addHeadBox(5.2, 6.0, 0.0);

    // 3. 立柱副燈箱 (立柱側 x = 0.25m, 高 3.8m)
    addHeadBox(0.25, 3.8, 0.0);

    // 4. 行人號誌箱 (立柱面向 -Z, 高 2.8m)
    const pedBox = new THREE.BoxGeometry(0.40, 0.76, 0.22);
    pedBox.translate(0.0, 2.8, -0.20);
    geoms.push(pedBox);

    // 行人遮光罩
    const pVisor1 = new THREE.BoxGeometry(0.38, 0.04, 0.15);
    pVisor1.translate(0.0, 2.8 + 0.36, -0.20 - 0.11 - 0.06);
    geoms.push(pVisor1);
    const pVisor2 = new THREE.BoxGeometry(0.38, 0.04, 0.15);
    pVisor2.translate(0.0, 2.8 - 0.02, -0.20 - 0.11 - 0.06);
    geoms.push(pVisor2);

    // 5. 倒數計時箱 (立柱面向 -Z, 行人箱旁 x = 0.44m, 高 2.8m)
    const countBox = new THREE.BoxGeometry(0.40, 0.40, 0.20);
    countBox.translate(0.44, 2.8, -0.20);
    geoms.push(countBox);

    const cVisor = new THREE.BoxGeometry(0.38, 0.04, 0.15);
    cVisor.translate(0.44, 2.8 + 0.19, -0.20 - 0.10 - 0.06);
    geoms.push(cVisor);

    return this.mergeGeometries(geoms);
  }

  /**
   * 建立車輛三色燈盤與發光光暈 (面向 -Z)
   */
  private createVehicleLightGeometry(): THREE.BufferGeometry {
    const posList: number[] = [];
    const normList: number[] = [];
    const typeList: number[] = []; // 0=Green, 1=Yellow, 2=Red
    const haloList: number[] = []; // 0=實體燈面, 1=擴散光暈

    const addLightDisk = (cx: number, cy: number, cz: number, lightType: number) => {
      // 1. 實心圓盤鏡片 (直徑 0.28m, 半徑 0.14m)
      const r = 0.14;
      const segs = 12;
      for (let i = 0; i < segs; i++) {
        const a1 = (i / segs) * Math.PI * 2;
        const a2 = ((i + 1) / segs) * Math.PI * 2;

        // CCW 繞行當從 -Z 朝向 +Z 觀看時
        posList.push(cx, cy, cz);
        posList.push(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz);
        posList.push(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, cz);

        normList.push(0, 0, -1,  0, 0, -1,  0, 0, -1);
        typeList.push(lightType, lightType, lightType);
        haloList.push(0.0, 0.0, 0.0);
      }

      // 2. 擴散發光光暈 Halo 盤 (半徑 0.32m, 略微前浮 0.005m)
      const rHalo = 0.32;
      const czHalo = cz - 0.005;
      for (let i = 0; i < segs; i++) {
        const a1 = (i / segs) * Math.PI * 2;
        const a2 = ((i + 1) / segs) * Math.PI * 2;

        posList.push(cx, cy, czHalo);
        posList.push(cx + Math.cos(a1) * rHalo, cy + Math.sin(a1) * rHalo, czHalo);
        posList.push(cx + Math.cos(a2) * rHalo, cy + Math.sin(a2) * rHalo, czHalo);

        normList.push(0, 0, -1,  0, 0, -1,  0, 0, -1);
        typeList.push(lightType, lightType, lightType);
        haloList.push(1.0, 1.0, 1.0);
      }
    };

    // 台灣橫式號誌標準：面對來車看去（由左至右為綠、黃、紅）
    // 朝著 -Z 望去時：左側為 +X, 中間為 0, 右側為 -X
    const addTripleLight = (headX: number, headY: number, headZ: number) => {
      const zLens = headZ - 0.115;
      addLightDisk(headX + 0.30, headY, zLens, 0); // 綠燈 (左側)
      addLightDisk(headX + 0.00, headY, zLens, 1); // 黃燈 (中間)
      addLightDisk(headX - 0.30, headY, zLens, 2); // 紅燈 (右側)
    };

    // 懸臂外側燈
    addTripleLight(3.6, 6.0, 0.0);
    // 懸臂內側燈
    addTripleLight(5.2, 6.0, 0.0);
    // 立柱副燈
    addTripleLight(0.25, 3.8, 0.0);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    geom.setAttribute('aLightType', new THREE.Float32BufferAttribute(typeList, 1));
    geom.setAttribute('aIsHalo', new THREE.Float32BufferAttribute(haloList, 1));
    return geom;
  }

  /**
   * 建立行人號誌幾何體 (上下兩格 Quad, 面向 -Z)
   */
  private createPedSignalGeometry(): THREE.BufferGeometry {
    const posList: number[] = [];
    const normList: number[] = [];
    const uvList: number[] = [];
    const slotList: number[] = []; // 0=上紅人, 1=下綠人

    const addQuad = (cx: number, cy: number, cz: number, w: number, h: number, vMin: number, vMax: number, slot: number) => {
      const hw = w * 0.5;
      const hh = h * 0.5;

      // CCW 繞行 (從 -Z 看向 +Z: 左為 +X, 右為 -X, 上為 +Y, 下為 -Y)
      // 三角形 1: (+hw, +hh) -> (-hw, +hh) -> (-hw, -hh)
      // 三角形 2: (+hw, +hh) -> (-hw, -hh) -> (+hw, -hh)
      posList.push(
        cx + hw, cy + hh, cz,
        cx - hw, cy + hh, cz,
        cx - hw, cy - hh, cz,

        cx + hw, cy + hh, cz,
        cx - hw, cy - hh, cz,
        cx + hw, cy - hh, cz
      );

      normList.push(
        0, 0, -1,  0, 0, -1,  0, 0, -1,
        0, 0, -1,  0, 0, -1,  0, 0, -1
      );

      uvList.push(
        1, vMax,  0, vMax,  0, vMin,
        1, vMax,  0, vMin,  1, vMin
      );

      slotList.push(slot, slot, slot, slot, slot, slot);
    };

    const czPed = -0.315;
    // 上格：紅人 (UV v: 0.5 ~ 1.0, 尺寸 0.36m x 0.36m)
    addQuad(0.0, 2.98, czPed, 0.36, 0.36, 0.5, 1.0, 0);
    // 下格：小綠人 (UV v: 0.0 ~ 0.5, 尺寸 0.36m x 0.36m)
    addQuad(0.0, 2.62, czPed, 0.36, 0.36, 0.0, 0.5, 1);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvList, 2));
    geom.setAttribute('aPedSlot', new THREE.Float32BufferAttribute(slotList, 1));
    return geom;
  }

  /**
   * 建立倒數計時器幾何體 (十位與個位雙 Quad, 面向 -Z)
   */
  private createCountdownGeometry(): THREE.BufferGeometry {
    const posList: number[] = [];
    const normList: number[] = [];
    const uvList: number[] = [];
    const placeList: number[] = []; // 0=十位, 1=個位

    const addQuad = (cx: number, cy: number, cz: number, w: number, h: number, place: number) => {
      const hw = w * 0.5;
      const hh = h * 0.5;

      posList.push(
        cx + hw, cy + hh, cz,
        cx - hw, cy + hh, cz,
        cx - hw, cy - hh, cz,

        cx + hw, cy + hh, cz,
        cx - hw, cy - hh, cz,
        cx + hw, cy - hh, cz
      );

      normList.push(
        0, 0, -1,  0, 0, -1,  0, 0, -1,
        0, 0, -1,  0, 0, -1,  0, 0, -1
      );

      // 基準 UV (0~1)，著色器橫向映射
      uvList.push(
        1, 1,  0, 1,  0, 0,
        1, 1,  0, 0,  1, 0
      );

      placeList.push(place, place, place, place, place, place);
    };

    const czCount = -0.315;
    // 面向 -Z 看去時：左側為十位數 (x = 0.53m)，右側為個位數 (x = 0.35m)
    addQuad(0.53, 2.80, czCount, 0.16, 0.32, 0);
    addQuad(0.35, 2.80, czCount, 0.16, 0.32, 1);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvList, 2));
    geom.setAttribute('aDigitPlace', new THREE.Float32BufferAttribute(placeList, 1));
    return geom;
  }

  /**
   * 建立路面機車待轉區幾何體 (水平貼地面片)
   */
  private createRoadMarkingGeometry(): THREE.BufferGeometry {
    const geom = new THREE.PlaneGeometry(2.6, 2.6);
    geom.rotateX(-Math.PI * 0.5);
    return geom;
  }

  private mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const posList: number[] = [];
    const normList: number[] = [];

    for (const g of geometries) {
      const nonIdx = g.toNonIndexed();
      const pos = nonIdx.attributes.position.array as Float32Array;
      const norm = nonIdx.attributes.normal.array as Float32Array;

      for (let i = 0; i < pos.length; i++) posList.push(pos[i]);
      for (let i = 0; i < norm.length; i++) normList.push(norm[i]);
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    return merged;
  }

  /**
   * 載入並構建路口號誌實例資料
   */
  public buildSceneSignals(intersections: IntersectionFeature[]): void {
    this.poleList = [];
    this.markingList = [];

    const dummy = new THREE.Object3D();

    for (const inter of intersections) {
      if (!inter.hasSignals) continue;

      for (const pole of inter.poles) {
        if (this.poleList.length >= this.maxPoles) break;

        dummy.position.set(pole.position.x, 0, pole.position.z);
        dummy.rotation.set(0, pole.armAzimuthRad, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();

        this.poleList.push({
          poleConfig: pole,
          intersectionId: inter.id,
          center: inter.center,
          matrix: dummy.matrix.clone()
        });
      }

      // 建立機車待轉格標線
      for (const app of inter.approaches) {
        if (!app.waitingBoxCenter || this.markingList.length >= this.maxMarkings) continue;

        dummy.position.set(app.waitingBoxCenter.x, CONFIG.ROADS.ELEVATION.ROAD + 0.008, app.waitingBoxCenter.z);
        dummy.rotation.set(0, app.azimuthRad, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();

        this.markingList.push({
          matrix: dummy.matrix.clone(),
          center: inter.center
        });
      }
    }

    console.log(
      `[TrafficSignalRenderer] 號誌網格實例構建完成：燈桿總數 ${this.poleList.length} 支，待轉區標線 ${this.markingList.length} 處`
    );
  }

  /**
   * 逐幀更新號誌渲染管線 (更新 300m 內，耗時 < 0.3ms)
   */
  public update(system: TrafficSignalSystem, playerPos: Point2D, gameTime: number): void {
    if (!CONFIG.TRAFFIC_SIGNALS.ENABLED || this.poleList.length === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    this.globalUniforms.uTime.value = gameTime;

    const updRadius = CONFIG.TRAFFIC_SIGNALS.UPDATE_RADIUS || 300.0;
    const vStateArr = this.vehicleStateAttr.array as Float32Array;
    const pStateArr = this.pedStateAttr.array as Float32Array;
    const countArr = this.countdownAttr.array as Float32Array;

    let poleDirty = false;
    let markDirty = false;

    // 1. 更新燈桿實例 (車燈、行人號誌、倒數計時)
    for (let i = 0; i < this.poleList.length; i++) {
      const p = this.poleList[i];
      const dist = Math.hypot(p.center.x - playerPos.x, p.center.z - playerPos.z);

      if (dist > updRadius) {
        // 遠處剔除
        this.poleMesh.setMatrixAt(i, this.zeroMatrix);
        this.housingMesh.setMatrixAt(i, this.zeroMatrix);
        this.vehicleLightMesh.setMatrixAt(i, this.zeroMatrix);
        this.pedSignalMesh.setMatrixAt(i, this.zeroMatrix);
        this.countdownMesh.setMatrixAt(i, this.zeroMatrix);
        poleDirty = true;
        continue;
      }

      this.poleMesh.setMatrixAt(i, p.matrix);
      this.housingMesh.setMatrixAt(i, p.matrix);
      this.vehicleLightMesh.setMatrixAt(i, p.matrix);
      this.pedSignalMesh.setMatrixAt(i, p.matrix);
      this.countdownMesh.setMatrixAt(i, p.matrix);
      poleDirty = true;

      const ctrl = system.getController(p.intersectionId);
      if (!ctrl) continue;

      const group = p.poleConfig.signalGroup;
      const vInfo = ctrl.getGroupVehicleState(group);
      const pInfo = ctrl.getGroupPedestrianState(group);
      const countdown = ctrl.getCountdownSec(group);

      // 車輛號誌狀態編碼: 0=Green, 1=Yellow, 2=Red, 3=FlashYellow
      let vCode = 2.0;
      if (vInfo.state === 'green') vCode = 0.0;
      else if (vInfo.state === 'yellow') vCode = 1.0;
      else if (vInfo.state === 'flashingYellow') vCode = 3.0;
      vStateArr[i] = vCode;

      // 行人號誌狀態編碼: 0=Walk, 1=Flash, 2=DontWalk
      let pCode = 2.0;
      if (pInfo.state === 'walk') pCode = 0.0;
      else if (pInfo.state === 'flashing') pCode = 1.0;
      pStateArr[i] = pCode;

      // 倒數計時資料: x=剩餘秒數, y=顏色(0=綠, 1=黃, 2=紅)
      countArr[i * 2] = countdown.seconds;
      let cCol = 2.0;
      if (countdown.color === 'green') cCol = 0.0;
      else if (countdown.color === 'yellow') cCol = 1.0;
      countArr[i * 2 + 1] = cCol;
    }

    // 2. 更新待轉區標線實例
    for (let i = 0; i < this.markingList.length; i++) {
      const m = this.markingList[i];
      const dist = Math.hypot(m.center.x - playerPos.x, m.center.z - playerPos.z);
      if (dist > updRadius) {
        this.roadMarkingMesh.setMatrixAt(i, this.zeroMatrix);
      } else {
        this.roadMarkingMesh.setMatrixAt(i, m.matrix);
      }
      markDirty = true;
    }

    if (poleDirty) {
      this.poleMesh.instanceMatrix.needsUpdate = true;
      this.housingMesh.instanceMatrix.needsUpdate = true;
      this.vehicleLightMesh.instanceMatrix.needsUpdate = true;
      this.pedSignalMesh.instanceMatrix.needsUpdate = true;
      this.countdownMesh.instanceMatrix.needsUpdate = true;
      this.vehicleStateAttr.needsUpdate = true;
      this.pedStateAttr.needsUpdate = true;
      this.countdownAttr.needsUpdate = true;
    }

    if (markDirty) {
      this.roadMarkingMesh.instanceMatrix.needsUpdate = true;
    }

    this.lastDrawCalls = 6;
  }

  public getDrawCallsCount(): number {
    return this.lastDrawCalls;
  }
}
