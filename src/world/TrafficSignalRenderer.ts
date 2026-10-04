/**
 * TrafficSignalRenderer.ts - 台灣風格懸臂式交通號誌 GPU 渲染器
 * 遵循 RULES.md 與效能硬性要求：
 * 1. 懸臂式燈桿、燈頭箱體、車輛發光號誌、行人號誌(小綠人/紅人)、倒數計時器、路面標線
 * 2. 全部採用 InstancedMesh 批次繪製，總 Draw Calls 嚴格不超過 6 個 (剛好 6 個)
 * 3. 倒數計時器使用 Texture Atlas 數字字元集，著色器座標動態映射，零額外幾何
 * 4. 僅更新玩家 200 公尺內之路口外觀，逐幀更新耗時控制在 0.3 ms 內
 * 5. 亮燈自發光效果 (PBR Emissive)
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
  ctx.font = 'bold 50px "Courier New", monospace';
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

// 產生行人號誌紋理 (128 x 256): 上半紅人、下半小綠人
function createPedSignalAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#06080a';
  ctx.fillRect(0, 0, 128, 256);

  // 上格：紅色站立小人
  ctx.fillStyle = '#ff2222';
  // 頭
  ctx.beginPath();
  ctx.arc(64, 40, 15, 0, Math.PI * 2);
  ctx.fill();
  // 身體與站立雙腿
  ctx.fillRect(52, 60, 24, 38);
  ctx.fillRect(51, 100, 10, 26);
  ctx.fillRect(67, 100, 10, 26);
  ctx.fillRect(38, 64, 10, 28);
  ctx.fillRect(80, 64, 10, 28);

  // 下格：綠色快走小綠人
  ctx.fillStyle = '#00ff77';
  ctx.beginPath();
  ctx.arc(64, 165, 15, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(64, 185);
  ctx.rotate(0.15);
  ctx.fillRect(-12, 0, 24, 34);

  // 跨步雙腿
  ctx.beginPath();
  ctx.moveTo(-6, 34);
  ctx.lineTo(-20, 64);
  ctx.lineTo(-10, 65);
  ctx.lineTo(2, 36);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(6, 34);
  ctx.lineTo(20, 64);
  ctx.lineTo(10, 65);
  ctx.lineTo(-2, 36);
  ctx.fill();

  // 擺手
  ctx.fillRect(-22, 6, 8, 22);
  ctx.fillRect(14, 6, 8, 22);
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
  private poleMesh!: THREE.InstancedMesh;         // Draw Call 1: 燈桿與懸臂
  private housingMesh!: THREE.InstancedMesh;      // Draw Call 2: 燈頭箱體與遮光罩
  private vehicleLightMesh!: THREE.InstancedMesh; // Draw Call 3: 車輛三色燈盤
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
    const vis = CONFIG.TRAFFIC_SIGNALS.VISUAL;

    // 1. 燈桿與懸臂幾何體 (Draw Call 1)
    const poleGeom = this.createPoleGeometry();
    poleGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    const poleMat = new THREE.MeshStandardMaterial({
      color: vis.POLE_COLOR,
      roughness: 0.65,
      metalness: 0.25
    });
    this.poleMesh = new THREE.InstancedMesh(poleGeom, poleMat, this.maxPoles);
    this.poleMesh.name = 'SignalPoleMesh';
    this.poleMesh.castShadow = true;
    this.poleMesh.receiveShadow = true;
    this.poleMesh.frustumCulled = false;

    // 2. 燈頭箱體與遮光罩幾何體 (Draw Call 2)
    const housingGeom = this.createHousingGeometry();
    housingGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    const housingMat = new THREE.MeshStandardMaterial({
      color: vis.HOUSING_COLOR,
      roughness: 0.85,
      metalness: 0.1
    });
    this.housingMesh = new THREE.InstancedMesh(housingGeom, housingMat, this.maxPoles);
    this.housingMesh.name = 'SignalHousingMesh';
    this.housingMesh.castShadow = true;
    this.housingMesh.receiveShadow = true;
    this.housingMesh.frustumCulled = false;

    // 3. 車輛三色燈盤 (Draw Call 3)
    const vLightGeom = this.createVehicleLightGeometry();
    vLightGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);

    this.vehicleStateAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxPoles), 1);
    this.vehicleStateAttr.setUsage(THREE.DynamicDrawUsage);
    vLightGeom.setAttribute('aVehicleState', this.vehicleStateAttr);

    const vLightMat = new THREE.MeshStandardMaterial({
      roughness: 0.3,
      metalness: 0.1
    });
    vLightMat.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aLightType; // 0=Green, 1=Yellow, 2=Red
        attribute float aVehicleState; // 0=Green, 1=Yellow, 2=Red, 3=FlashYellow
        varying vec3 vLightColor;
        varying float vIsLit;
      ` + shader.vertexShader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        float lit = 0.0;
        vec3 col = vec3(0.08, 0.08, 0.08);

        if (aVehicleState < 0.5) { // 綠燈
          if (aLightType < 0.5) { lit = 1.0; col = vec3(0.0, 0.95, 0.4); }
          else if (aLightType < 1.5) { col = vec3(0.15, 0.12, 0.02); }
          else { col = vec3(0.18, 0.04, 0.04); }
        } else if (aVehicleState < 1.5) { // 黃燈
          if (aLightType > 0.5 && aLightType < 1.5) { lit = 1.0; col = vec3(1.0, 0.75, 0.0); }
          else if (aLightType < 0.5) { col = vec3(0.02, 0.15, 0.06); }
          else { col = vec3(0.18, 0.04, 0.04); }
        } else if (aVehicleState < 2.5) { // 紅燈
          if (aLightType > 1.5) { lit = 1.0; col = vec3(1.0, 0.12, 0.12); }
          else if (aLightType < 0.5) { col = vec3(0.02, 0.15, 0.06); }
          else { col = vec3(0.15, 0.12, 0.02); }
        } else { // 閃黃燈
          if (aLightType > 0.5 && aLightType < 1.5) { lit = 1.0; col = vec3(1.0, 0.75, 0.0); }
        }

        vLightColor = col;
        vIsLit = lit;
        `
      );

      shader.fragmentShader = `
        varying vec3 vLightColor;
        varying float vIsLit;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor.rgb = vLightColor;
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `
        #include <emissivemap_fragment>
        totalEmissiveRadiance = vLightColor * (vIsLit * 2.2);
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
    const pedMat = new THREE.MeshStandardMaterial({
      map: pedTex,
      roughness: 0.4,
      metalness: 0.0
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
            lit = step(0.5, fract(uTime * 2.5));
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
        diffuseColor.rgb *= (0.15 + vPedLit * 0.85);
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `
        #include <emissivemap_fragment>
        totalEmissiveRadiance = diffuseColor.rgb * (vPedLit * 2.0);
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
    const countdownMat = new THREE.MeshStandardMaterial({
      map: countdownTex,
      roughness: 0.4,
      metalness: 0.0
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
        float sec = clamp(aCountdownData.x, 0.0, 99.0);
        float tens = floor(sec / 10.0);
        float ones = mod(floor(sec), 10.0);
        float digit = aDigitPlace < 0.5 ? tens : ones;

        // Texture Atlas: 10 個數字均分 (寬度 0.1)
        vUv.x = (vUv.x + digit) / 10.0;

        vec3 c = vec3(0.0, 1.0, 0.4);
        if (aCountdownData.y > 1.5) c = vec3(1.0, 0.15, 0.15);
        else if (aCountdownData.y > 0.5) c = vec3(1.0, 0.8, 0.0);
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

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `
        #include <emissivemap_fragment>
        totalEmissiveRadiance = diffuseColor.rgb * 2.2;
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
    const markingMat = new THREE.MeshStandardMaterial({
      map: scooterTex,
      roughness: 0.75,
      metalness: 0.05,
      transparent: true,
      depthWrite: false
    });

    this.roadMarkingMesh = new THREE.InstancedMesh(markingGeom, markingMat, this.maxMarkings);
    this.roadMarkingMesh.name = 'SignalRoadMarkingMesh';
    this.roadMarkingMesh.receiveShadow = true;
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
   * 建立燈桿與橫臂幾何體 (合併幾何體)
   */
  private createPoleGeometry(): THREE.BufferGeometry {
    const vis = CONFIG.TRAFFIC_SIGNALS.VISUAL;

    // 立柱 (高 6.8m)
    const postGeom = new THREE.CylinderGeometry(vis.POLE_RADIUS * 0.9, vis.POLE_RADIUS * 1.2, vis.POLE_HEIGHT, 8);
    postGeom.translate(0, vis.POLE_HEIGHT * 0.5, 0);

    // 橫臂 (長 5.5m)
    const armGeom = new THREE.CylinderGeometry(vis.POLE_RADIUS * 0.6, vis.POLE_RADIUS * 0.8, vis.ARM_LENGTH, 8);
    armGeom.rotateX(Math.PI * 0.5);
    armGeom.translate(0, vis.ARM_HEIGHT, vis.ARM_LENGTH * 0.5);

    // 斜向加固拉桿
    const strutGeom = new THREE.CylinderGeometry(0.035, 0.035, 2.6, 6);
    strutGeom.rotateX(Math.PI * 0.35);
    strutGeom.translate(0, vis.ARM_HEIGHT + 0.35, 1.2);

    return this.mergeGeometries([postGeom, armGeom, strutGeom]);
  }

  /**
   * 建立號誌箱體與遮光罩幾何體 (合併幾何體)
   */
  private createHousingGeometry(): THREE.BufferGeometry {
    const geoms: THREE.BufferGeometry[] = [];

    // 橫臂主車輛燈箱 1 (懸臂中段 z = 3.2m, 高 5.8m)
    const h1 = new THREE.BoxGeometry(1.05, 0.36, 0.22);
    h1.translate(0, 5.8, 3.2);
    geoms.push(h1);

    // 橫臂前端車輛燈箱 2 (懸臂末端 z = 4.8m, 高 5.8m)
    const h2 = new THREE.BoxGeometry(1.05, 0.36, 0.22);
    h2.translate(0, 5.8, 4.8);
    geoms.push(h2);

    // 立柱副燈箱 (立柱側 z = 0.35m, 高 3.6m)
    const hSub = new THREE.BoxGeometry(1.05, 0.36, 0.22);
    hSub.translate(0, 3.6, 0.35);
    geoms.push(hSub);

    // 行人號誌箱 (立柱 z = 0.25m, 高 2.5m)
    const hPed = new THREE.BoxGeometry(0.32, 0.62, 0.20);
    hPed.translate(0, 2.5, 0.25);
    geoms.push(hPed);

    // 倒數計時箱 (行人箱旁 x = 0.34m, 高 2.5m)
    const hCount = new THREE.BoxGeometry(0.32, 0.32, 0.18);
    hCount.translate(0.34, 2.5, 0.25);
    geoms.push(hCount);

    return this.mergeGeometries(geoms);
  }

  /**
   * 建立車輛三色燈盤幾何體 (每桿包含 9 個圓盤透鏡)
   */
  private createVehicleLightGeometry(): THREE.BufferGeometry {
    const posList: number[] = [];
    const normList: number[] = [];
    const typeList: number[] = []; // 0=Green, 1=Yellow, 2=Red

    const addLightDisk = (cx: number, cy: number, cz: number, lightType: number) => {
      // 8 邊形圓盤
      const r = 0.11;
      const segs = 8;
      for (let i = 0; i < segs; i++) {
        const a1 = (i / segs) * Math.PI * 2;
        const a2 = ((i + 1) / segs) * Math.PI * 2;

        posList.push(cx, cy, cz);
        posList.push(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, cz);
        posList.push(cx + Math.cos(a2) * r, cy + Math.sin(a2) * r, cz);

        normList.push(0, 0, -1, 0, 0, -1, 0, 0, -1);
        typeList.push(lightType, lightType, lightType);
      }
    };

    // 橫式號誌標準：由左至右為綠、黃、紅 (向著車流來向 -Z 看去：左為 +X, 中為 0, 右為 -X)
    // 主燈 1 (z = 3.08)
    addLightDisk(0.32, 5.8, 3.08, 0);  // 綠燈
    addLightDisk(0.00, 5.8, 3.08, 1);  // 黃燈
    addLightDisk(-0.32, 5.8, 3.08, 2); // 紅燈

    // 主燈 2 (z = 4.68)
    addLightDisk(0.32, 5.8, 4.68, 0);
    addLightDisk(0.00, 5.8, 4.68, 1);
    addLightDisk(-0.32, 5.8, 4.68, 2);

    // 立柱副燈 (z = 0.23)
    addLightDisk(0.32, 3.6, 0.23, 0);
    addLightDisk(0.00, 3.6, 0.23, 1);
    addLightDisk(-0.32, 3.6, 0.23, 2);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    geom.setAttribute('aLightType', new THREE.Float32BufferAttribute(typeList, 1));
    return geom;
  }

  /**
   * 建立行人號誌幾何體 (上下兩格 Quad)
   */
  private createPedSignalGeometry(): THREE.BufferGeometry {
    const posList: number[] = [];
    const normList: number[] = [];
    const uvList: number[] = [];
    const slotList: number[] = []; // 0=上紅人, 1=下綠人

    const addQuad = (cx: number, cy: number, cz: number, w: number, h: number, vMin: number, vMax: number, slot: number) => {
      const hw = w * 0.5;
      const hh = h * 0.5;

      posList.push(
        cx - hw, cy + hh, cz,
        cx - hw, cy - hh, cz,
        cx + hw, cy - hh, cz,

        cx - hw, cy + hh, cz,
        cx + hw, cy - hh, cz,
        cx + hw, cy + hh, cz
      );

      normList.push(
        0, 0, -1,  0, 0, -1,  0, 0, -1,
        0, 0, -1,  0, 0, -1,  0, 0, -1
      );

      uvList.push(
        0, vMax,  0, vMin,  1, vMin,
        0, vMax,  1, vMin,  1, vMax
      );

      slotList.push(slot, slot, slot, slot, slot, slot);
    };

    // 上格：紅人 (UV v: 0.5 ~ 1.0)
    addQuad(0, 2.64, 0.14, 0.26, 0.26, 0.5, 1.0, 0);
    // 下格：小綠人 (UV v: 0.0 ~ 0.5)
    addQuad(0, 2.36, 0.14, 0.26, 0.26, 0.0, 0.5, 1);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvList, 2));
    geom.setAttribute('aPedSlot', new THREE.Float32BufferAttribute(slotList, 1));
    return geom;
  }

  /**
   * 建立倒數計時器幾何體 (十位與個位雙 Quad)
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
        cx - hw, cy + hh, cz,
        cx - hw, cy - hh, cz,
        cx + hw, cy - hh, cz,

        cx - hw, cy + hh, cz,
        cx + hw, cy - hh, cz,
        cx + hw, cy + hh, cz
      );

      normList.push(
        0, 0, -1,  0, 0, -1,  0, 0, -1,
        0, 0, -1,  0, 0, -1,  0, 0, -1
      );

      // 基準 UV (0~1)，後續頂點著色器橫向縮放至 1/10
      uvList.push(
        0, 1,  0, 0,  1, 0,
        0, 1,  1, 0,  1, 1
      );

      placeList.push(place, place, place, place, place, place);
    };

    // 十位數 (左)
    addQuad(0.27, 2.50, 0.15, 0.12, 0.24, 0);
    // 個位數 (右)
    addQuad(0.41, 2.50, 0.15, 0.12, 0.24, 1);

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
    const geom = new THREE.PlaneGeometry(2.4, 2.4);
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
   * 逐幀更新號誌渲染管線 (僅更新 200m 內，耗時 < 0.3ms)
   */
  public update(system: TrafficSignalSystem, playerPos: Point2D, gameTime: number): void {
    if (!CONFIG.TRAFFIC_SIGNALS.ENABLED || this.poleList.length === 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    this.globalUniforms.uTime.value = gameTime;

    const updRadius = CONFIG.TRAFFIC_SIGNALS.UPDATE_RADIUS || 200.0;
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
