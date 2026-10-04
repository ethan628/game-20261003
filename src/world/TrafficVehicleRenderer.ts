/**
 * TrafficVehicleRenderer.ts - NPC 車輛與駕駛/乘客高效率 GPU 實例渲染器
 * 遵循 RULES.md 與效能硬性要求：
 * 1. 全部車輛與駕駛/乘客使用 InstancedMesh 批次繪製
 * 2. 駕駛與乘客 Draw Calls 嚴格限制在 4 以內 (近景 driverNearMesh: 1, 遠景 driverFarMesh: 1)
 * 3. 距離分級 (LOD)：
 *    - 0 ~ 60m: 完整外觀（頭、安全帽、口罩、雨衣/衣服、手握方向盤/握把），Vertex Shader 動畫啟用
 *    - 60 ~ 120m: 簡化色塊人影（頭+肩），無動作
 *    - > 120m: 不渲染駕駛與乘客
 * 4. 車窗半透明偏深色 (白天可視內部駕駛手勢與輪廓，夜晚呈現剪影與儀表微光)
 * 5. 機車騎士與乘客過彎傾斜、等紅燈單腳落地、副駕與後座擺頭
 * 6. 計程車頂燈空車發光自亮 (MeshBasic/Standard Emissive)，載客熄滅
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { TrafficVehicle } from '../geo/TrafficTypes.ts';

// 顏色快取 (避免逐幀字串轉換)
const COLOR_CACHE = new Map<string, [number, number, number]>();
function parseHex(hex: string): [number, number, number] {
  let c = COLOR_CACHE.get(hex);
  if (!c) {
    const clean = hex.replace('#', '');
    const num = parseInt(clean, 16);
    c = [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
    COLOR_CACHE.set(hex, c);
  }
  return c;
}

export class TrafficVehicleRenderer {
  private group: THREE.Group;
  private maxVehicles: number;
  private maxCharacters: number;

  // 車輛本體 InstancedMesh
  private carMesh!: THREE.InstancedMesh;
  private carGlassMesh!: THREE.InstancedMesh;
  private scooterMesh!: THREE.InstancedMesh;
  private taxiRoofLightMesh!: THREE.InstancedMesh;

  // 駕駛與乘客 InstancedMesh (總共僅 2 Draw Calls，嚴格 <= 4)
  private driverNearMesh!: THREE.InstancedMesh;
  private driverFarMesh!: THREE.InstancedMesh;

  // 車身顏色 Buffer
  private carColors!: Float32Array;
  private scooterColors!: Float32Array;

  // 駕駛近景屬性 Buffer
  private skinColorAttr!: THREE.InstancedBufferAttribute;
  private shirtColorAttr!: THREE.InstancedBufferAttribute;
  private helmetColorAttr!: THREE.InstancedBufferAttribute;
  private animAttr!: THREE.InstancedBufferAttribute; // x: steer, y: headTurn, z: lookDown, w: footDown
  private flagsAttr!: THREE.InstancedBufferAttribute; // x: isCarDriver, y: hasMask, z: isScooter, w: isHolding

  // 駕駛遠景屬性 Buffer
  private farColorAttr!: THREE.InstancedBufferAttribute;

  // 變形與暫存變數 (零垃圾回收 GC)
  private dummyObj = new THREE.Object3D();
  private seatObj = new THREE.Object3D();
  private zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -9999, 0);
  private tempColor = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.maxVehicles = CONFIG.TRAFFIC.MAX_VEHICLES;
    this.maxCharacters = CONFIG.TRAFFIC.MAX_VEHICLES * 4; // 轎車最多4人，機車2人

    this.group = new THREE.Group();
    this.group.name = 'TrafficVehicleRendererGroup';

    this.initCarMesh();
    this.initScooterMesh();
    this.initTaxiRoofLightMesh();
    this.initDriverNearMesh();
    this.initDriverFarMesh();

    scene.add(this.group);
  }

  /**
   * 建立低多邊形轎車/計程車車身幾何體 (含底盤、車頂柱、儀表板、座椅、頭燈、尾燈與輪胎)
   */
  private createCarGeometry(): THREE.BufferGeometry {
    const parts = [
      // 0: 前引擎蓋/車頭 (長 1.35, 寬 1.78, 高 0.44)
      { geom: new THREE.BoxGeometry(1.78, 0.44, 1.35), offset: [0, 0.54, 1.48], partId: 0 },
      // 1: 後車廂/行李箱 (長 1.10, 寬 1.78, 高 0.44)
      { geom: new THREE.BoxGeometry(1.78, 0.44, 1.10), offset: [0, 0.54, -1.60], partId: 0 },
      // 2: 座艙底部地板 (長 1.95, 寬 1.66, 高 0.12)
      { geom: new THREE.BoxGeometry(1.66, 0.12, 1.95), offset: [0, 0.36, -0.10], partId: 2 },
      // 3: 左側門板下半部 (車窗下方門板)
      { geom: new THREE.BoxGeometry(0.08, 0.44, 1.95), offset: [-0.84, 0.54, -0.10], partId: 0 },
      // 4: 右側門板下半部
      { geom: new THREE.BoxGeometry(0.08, 0.44, 1.95), offset: [0.84, 0.54, -0.10], partId: 0 },
      // 5: 車頂棚金屬板 (薄頂棚，長 1.82, 寬 1.48, 高 0.05)
      { geom: new THREE.BoxGeometry(1.48, 0.05, 1.82), offset: [0, 1.45, -0.18], partId: 0 },
      // 6: 左前 A 柱 (傾斜)
      { geom: new THREE.BoxGeometry(0.07, 0.68, 0.07), offset: [-0.70, 1.10, 0.70], rotX: 0.32, partId: 0 },
      // 7: 右前 A 柱
      { geom: new THREE.BoxGeometry(0.07, 0.68, 0.07), offset: [0.70, 1.10, 0.70], rotX: 0.32, partId: 0 },
      // 8: 左中 B 柱
      { geom: new THREE.BoxGeometry(0.07, 0.68, 0.07), offset: [-0.73, 1.10, -0.18], partId: 0 },
      // 9: 右中 B 柱
      { geom: new THREE.BoxGeometry(0.07, 0.68, 0.07), offset: [0.73, 1.10, -0.18], partId: 0 },
      // 10: 左後 C 柱 (傾斜)
      { geom: new THREE.BoxGeometry(0.09, 0.68, 0.09), offset: [-0.70, 1.10, -1.06], rotX: -0.30, partId: 0 },
      // 11: 右後 C 柱
      { geom: new THREE.BoxGeometry(0.09, 0.68, 0.09), offset: [0.70, 1.10, -1.06], rotX: -0.30, partId: 0 },
      // 12: 儀表板基座 (寬 1.44, 高 0.24, 深 0.36)
      { geom: new THREE.BoxGeometry(1.44, 0.24, 0.36), offset: [0, 0.78, 0.64], partId: 3 },
      // 13: 駕駛儀表板儀表凸起
      { geom: new THREE.BoxGeometry(0.36, 0.12, 0.16), offset: [-0.38, 0.90, 0.54], partId: 3 },
      // 14: 儀表板夜光飾條 (微光)
      { geom: new THREE.BoxGeometry(0.85, 0.04, 0.04), offset: [0, 0.80, 0.50], partId: 4 },
      // 15: 前排駕駛座坐墊與椅背
      { geom: new THREE.BoxGeometry(0.44, 0.10, 0.44), offset: [-0.38, 0.34, 0.08], partId: 2 },
      { geom: new THREE.BoxGeometry(0.44, 0.46, 0.10), offset: [-0.38, 0.62, -0.14], partId: 2 },
      // 16: 前排副駕駛座坐墊與椅背
      { geom: new THREE.BoxGeometry(0.44, 0.10, 0.44), offset: [0.38, 0.34, 0.08], partId: 2 },
      { geom: new THREE.BoxGeometry(0.44, 0.46, 0.10), offset: [0.38, 0.62, -0.14], partId: 2 },
      // 17: 後座長椅坐墊與椅背
      { geom: new THREE.BoxGeometry(1.36, 0.10, 0.44), offset: [0.0, 0.34, -0.66], partId: 2 },
      { geom: new THREE.BoxGeometry(1.36, 0.46, 0.10), offset: [0.0, 0.62, -0.88], partId: 2 },
      // 18: 四顆車輪 (直徑 0.62, 厚 0.22)
      { geom: new THREE.CylinderGeometry(0.31, 0.31, 0.22, 12), offset: [-0.92, 0.31, 1.25], rotZ: Math.PI / 2, partId: 1 },
      { geom: new THREE.CylinderGeometry(0.31, 0.31, 0.22, 12), offset: [0.92, 0.31, 1.25], rotZ: Math.PI / 2, partId: 1 },
      { geom: new THREE.CylinderGeometry(0.31, 0.31, 0.22, 12), offset: [-0.92, 0.31, -1.25], rotZ: Math.PI / 2, partId: 1 },
      { geom: new THREE.CylinderGeometry(0.31, 0.31, 0.22, 12), offset: [0.92, 0.31, -1.25], rotZ: Math.PI / 2, partId: 1 },
      // 19: 車前大燈 (左右白光)
      { geom: new THREE.BoxGeometry(0.34, 0.14, 0.06), offset: [-0.64, 0.62, 2.16], partId: 5 },
      { geom: new THREE.BoxGeometry(0.34, 0.14, 0.06), offset: [0.64, 0.62, 2.16], partId: 5 },
      // 20: 車後尾燈 (左右紅光)
      { geom: new THREE.BoxGeometry(0.34, 0.14, 0.06), offset: [-0.64, 0.62, -2.16], partId: 6 },
      { geom: new THREE.BoxGeometry(0.34, 0.14, 0.06), offset: [0.64, 0.62, -2.16], partId: 6 }
    ];

    const posList: number[] = [];
    const normList: number[] = [];
    const partAttrList: number[] = [];

    for (const p of parts) {
      const g = p.geom.toNonIndexed();
      if ((p as any).rotZ) {
        g.rotateZ((p as any).rotZ);
      }
      if ((p as any).rotX) {
        g.rotateX((p as any).rotX);
      }
      g.translate(p.offset[0], p.offset[1], p.offset[2]);

      const pos = g.attributes.position.array as Float32Array;
      const norm = g.attributes.normal.array as Float32Array;
      for (let i = 0; i < pos.length; i += 3) {
        posList.push(pos[i], pos[i + 1], pos[i + 2]);
        normList.push(norm[i], norm[i + 1], norm[i + 2]);
        partAttrList.push(p.partId);
      }
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    merged.setAttribute('aCarPart', new THREE.Float32BufferAttribute(partAttrList, 1));
    return merged;
  }

  /**
   * 建立車窗玻璃幾何體 (半透明深色擋風玻璃與車窗)
   */
  private createCarGlassGeometry(): THREE.BufferGeometry {
    const parts = [
      // 前擋風玻璃 (傾斜向前)
      { geom: new THREE.BoxGeometry(1.38, 0.66, 0.03), offset: [0, 1.12, 0.70], rotX: 0.32 },
      // 後車窗 (傾斜向後)
      { geom: new THREE.BoxGeometry(1.38, 0.64, 0.03), offset: [0, 1.12, -1.06], rotX: -0.30 },
      // 左前側車窗
      { geom: new THREE.BoxGeometry(0.03, 0.54, 0.85), offset: [-0.72, 1.10, 0.25] },
      // 左後側車窗
      { geom: new THREE.BoxGeometry(0.03, 0.54, 0.82), offset: [-0.72, 1.10, -0.62] },
      // 右前側車窗
      { geom: new THREE.BoxGeometry(0.03, 0.54, 0.85), offset: [0.72, 1.10, 0.25] },
      // 右後側車窗
      { geom: new THREE.BoxGeometry(0.03, 0.54, 0.82), offset: [0.72, 1.10, -0.62] }
    ];

    const posList: number[] = [];
    const normList: number[] = [];

    for (const p of parts) {
      const g = p.geom.toNonIndexed();
      if ((p as any).rotX) g.rotateX((p as any).rotX);
      g.translate(p.offset[0], p.offset[1], p.offset[2]);

      const pos = g.attributes.position.array as Float32Array;
      const norm = g.attributes.normal.array as Float32Array;
      for (let i = 0; i < pos.length; i++) {
        posList.push(pos[i]);
        normList.push(norm[i]);
      }
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    return merged;
  }

  /**
   * 建立低多邊形機車幾何體 (台灣主流速克達造型)
   */
  private createScooterGeometry(): THREE.BufferGeometry {
    const parts = [
      // 0: 前斜板龍頭護板 (長 0.22, 寬 0.48, 高 0.62)
      { geom: new THREE.BoxGeometry(0.48, 0.62, 0.22), offset: [0, 0.65, 0.60], partId: 0 },
      // 1: 車底踏板與底盤 (長 1.35, 寬 0.46, 高 0.24)
      { geom: new THREE.BoxGeometry(0.46, 0.24, 1.35), offset: [0, 0.26, 0], partId: 2 },
      // 2: 龍頭把手 (寬 0.68, 高 0.06, 深 0.06)
      { geom: new THREE.BoxGeometry(0.68, 0.06, 0.06), offset: [0, 0.94, 0.54], partId: 2 },
      // 3: 左右後視鏡小圓鏡/方塊
      { geom: new THREE.BoxGeometry(0.08, 0.08, 0.04), offset: [-0.34, 1.02, 0.56], partId: 6 },
      { geom: new THREE.BoxGeometry(0.08, 0.08, 0.04), offset: [0.34, 1.02, 0.56], partId: 6 },
      // 4: 坐墊坐板 (長 0.82, 寬 0.38, 高 0.16)
      { geom: new THREE.BoxGeometry(0.38, 0.16, 0.82), offset: [0, 0.65, -0.16], partId: 1 },
      // 5: 前車輪 (半徑 0.22, 厚 0.12)
      { geom: new THREE.CylinderGeometry(0.22, 0.22, 0.12, 12), offset: [0, 0.22, 0.62], rotZ: Math.PI / 2, partId: 3 },
      // 6: 後車輪 (半徑 0.22, 厚 0.12)
      { geom: new THREE.CylinderGeometry(0.22, 0.22, 0.12, 12), offset: [0, 0.22, -0.55], rotZ: Math.PI / 2, partId: 3 },
      // 7: 排氣管
      { geom: new THREE.CylinderGeometry(0.05, 0.05, 0.42, 8), offset: [0.24, 0.20, -0.42], rotX: Math.PI / 2, partId: 2 },
      // 8: 大燈與尾燈
      { geom: new THREE.BoxGeometry(0.22, 0.12, 0.06), offset: [0, 0.85, 0.70], partId: 4 },
      { geom: new THREE.BoxGeometry(0.20, 0.08, 0.06), offset: [0, 0.58, -0.68], partId: 5 }
    ];

    const posList: number[] = [];
    const normList: number[] = [];
    const partAttrList: number[] = [];

    for (const p of parts) {
      const g = p.geom.toNonIndexed();
      if ((p as any).rotZ) g.rotateZ((p as any).rotZ);
      if ((p as any).rotX) g.rotateX((p as any).rotX);
      g.translate(p.offset[0], p.offset[1], p.offset[2]);

      const pos = g.attributes.position.array as Float32Array;
      const norm = g.attributes.normal.array as Float32Array;
      for (let i = 0; i < pos.length; i += 3) {
        posList.push(pos[i], pos[i + 1], pos[i + 2]);
        normList.push(norm[i], norm[i + 1], norm[i + 2]);
        partAttrList.push(p.partId);
      }
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    merged.setAttribute('aScooterPart', new THREE.Float32BufferAttribute(partAttrList, 1));
    return merged;
  }

  /**
   * 初始化汽車車身 InstancedMesh
   */
  private initCarMesh(): void {
    const geom = this.createCarGeometry();
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.45,
      metalness: 0.15
    });

    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aCarPart;
        varying float vCarPart;
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vCarPart = aCarPart;
        `
      );
      shader.fragmentShader = `
        varying float vCarPart;
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        if (vCarPart > 0.5 && vCarPart < 1.5) {
          diffuseColor.rgb = vec3(0.08, 0.08, 0.09); // 輪胎黑橡膠
        } else if (vCarPart > 1.5 && vCarPart < 2.5) {
          diffuseColor.rgb = vec3(0.18, 0.18, 0.20); // 座椅與內裝地板
        } else if (vCarPart > 2.5 && vCarPart < 3.5) {
          diffuseColor.rgb = vec3(0.12, 0.12, 0.14); // 儀表板基座
        } else if (vCarPart > 3.5 && vCarPart < 4.5) {
          diffuseColor.rgb = vec3(1.0, 0.75, 0.20); // 儀表板夜光飾條
        } else if (vCarPart > 4.5 && vCarPart < 5.5) {
          diffuseColor.rgb = vec3(1.0, 0.98, 0.88); // 前大燈
        } else if (vCarPart > 5.5 && vCarPart < 6.5) {
          diffuseColor.rgb = vec3(0.95, 0.08, 0.08); // 後尾燈
        }
        `
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `
        #include <emissivemap_fragment>
        if (vCarPart > 3.5 && vCarPart < 4.5) {
          totalEmissiveRadiance = vec3(1.0, 0.70, 0.20) * 0.8;
        } else if (vCarPart > 4.5 && vCarPart < 5.5) {
          totalEmissiveRadiance = vec3(1.0, 0.98, 0.88) * 1.5;
        } else if (vCarPart > 5.5 && vCarPart < 6.5) {
          totalEmissiveRadiance = vec3(0.95, 0.08, 0.08) * 1.2;
        }
        `
      );
    };

    this.carMesh = new THREE.InstancedMesh(geom, mat, this.maxVehicles);
    this.carMesh.name = 'Traffic_CarMesh';
    this.carMesh.frustumCulled = false;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.carColors = new Float32Array(this.maxVehicles * 3);
    this.carMesh.instanceColor = new THREE.InstancedBufferAttribute(this.carColors, 3);
    this.carMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < this.maxVehicles; i++) {
      this.carMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.carMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.carMesh);

    // 車窗玻璃 InstancedMesh
    const glassGeom = this.createCarGlassGeometry();
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x4a637d,
      roughness: 0.1,
      metalness: 0.25,
      transparent: true,
      opacity: 0.35,
      depthWrite: false
    });
    this.carGlassMesh = new THREE.InstancedMesh(glassGeom, glassMat, this.maxVehicles);
    this.carGlassMesh.name = 'Traffic_CarGlassMesh';
    this.carGlassMesh.renderOrder = 2; // 保證在駕駛之後繪製，透光可視內部動作
    this.carGlassMesh.frustumCulled = false;
    glassGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.carGlassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < this.maxVehicles; i++) {
      this.carGlassMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.carGlassMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.carGlassMesh);
  }

  /**
   * 初始化機車 InstancedMesh
   */
  private initScooterMesh(): void {
    const geom = this.createScooterGeometry();
    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.5,
      metalness: 0.1
    });

    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aScooterPart;
        varying float vScooterPart;
      ` + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        #include <begin_vertex>
        vScooterPart = aScooterPart;
        `
      );
      shader.fragmentShader = `
        varying float vScooterPart;
      ` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        if (vScooterPart > 0.5 && vScooterPart < 1.5) {
          diffuseColor.rgb = vec3(0.12, 0.12, 0.13); // 座墊黑皮
        } else if (vScooterPart > 1.5 && vScooterPart < 2.5) {
          diffuseColor.rgb = vec3(0.18, 0.18, 0.20); // 把手/踏板/排氣管
        } else if (vScooterPart > 2.5 && vScooterPart < 3.5) {
          diffuseColor.rgb = vec3(0.08, 0.08, 0.09); // 輪胎黑橡膠
        } else if (vScooterPart > 3.5 && vScooterPart < 4.5) {
          diffuseColor.rgb = vec3(1.0, 0.98, 0.88); // 大燈
        } else if (vScooterPart > 4.5 && vScooterPart < 5.5) {
          diffuseColor.rgb = vec3(0.95, 0.08, 0.08); // 尾燈
        } else if (vScooterPart > 5.5) {
          diffuseColor.rgb = vec3(0.70, 0.70, 0.75); // 後視鏡銀
        }
        `
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `
        #include <emissivemap_fragment>
        if (vScooterPart > 3.5 && vScooterPart < 4.5) {
          totalEmissiveRadiance = vec3(1.0, 0.98, 0.88) * 1.5;
        } else if (vScooterPart > 4.5 && vScooterPart < 5.5) {
          totalEmissiveRadiance = vec3(0.95, 0.08, 0.08) * 1.2;
        }
        `
      );
    };

    this.scooterMesh = new THREE.InstancedMesh(geom, mat, this.maxVehicles);
    this.scooterMesh.name = 'Traffic_ScooterMesh';
    this.scooterMesh.frustumCulled = false;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.scooterMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scooterColors = new Float32Array(this.maxVehicles * 3);
    this.scooterMesh.instanceColor = new THREE.InstancedBufferAttribute(this.scooterColors, 3);
    this.scooterMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < this.maxVehicles; i++) {
      this.scooterMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.scooterMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.scooterMesh);
  }

  /**
   * 初始化計程車頂燈 InstancedMesh
   */
  private initTaxiRoofLightMesh(): void {
    const geom = new THREE.BoxGeometry(0.44, 0.16, 0.22);
    // 頂部往後偏移，剛好落在車頂中間
    geom.translate(0, 1.54, -0.15);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xfffbeb,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.3,
      roughness: 0.2,
      metalness: 0.1
    });

    this.taxiRoofLightMesh = new THREE.InstancedMesh(geom, mat, this.maxVehicles);
    this.taxiRoofLightMesh.name = 'Traffic_TaxiRoofLightMesh';
    this.taxiRoofLightMesh.frustumCulled = false;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.taxiRoofLightMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < this.maxVehicles; i++) {
      this.taxiRoofLightMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.taxiRoofLightMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.taxiRoofLightMesh);
  }

  /**
   * 建立近景駕駛與乘客合併幾何體 (軀幹、頭部、頭髮/鴨舌帽、安全帽與風鏡、口罩、左右手臂握盤/把手、方向盤、左右腿)
   */
  private createDriverNearGeometry(): THREE.BufferGeometry {
    const parts = [
      // 0: 軀幹 (寬 0.34, 高 0.46, 深 0.22), 樞軸 y=0.55
      { geom: new THREE.BoxGeometry(0.34, 0.46, 0.22), partId: 0, slot: 1, pivot: [0, 0.55, 0], offset: [0, 0.55, 0] },
      // 1: 臉部頭部 (寬 0.20, 高 0.22, 深 0.20), 樞軸 y=0.82 (脖子)
      { geom: new THREE.BoxGeometry(0.20, 0.22, 0.20), partId: 1, slot: 0, pivot: [0, 0.82, 0], offset: [0, 0.92, 0] },
      // 2: 口罩 (淺色小方塊)
      { geom: new THREE.BoxGeometry(0.16, 0.08, 0.06), partId: 2, slot: 5, pivot: [0, 0.82, 0], offset: [0, 0.87, 0.10] },
      // 3: 頭髮 / 鴨舌帽冠
      { geom: new THREE.BoxGeometry(0.22, 0.12, 0.22), partId: 3, slot: 3, pivot: [0, 0.82, 0], offset: [0, 1.01, 0] },
      // 3.5: 鴨舌帽帽簷
      { geom: new THREE.BoxGeometry(0.18, 0.03, 0.10), partId: 3.5, slot: 3, pivot: [0, 0.82, 0], offset: [0, 0.98, 0.14] },
      // 4: 安全帽外殼 (半罩/全罩造型)
      { geom: new THREE.BoxGeometry(0.26, 0.26, 0.25), partId: 4, slot: 4, pivot: [0, 0.82, 0], offset: [0, 0.95, 0] },
      // 4.5: 安全帽風鏡/護目鏡
      { geom: new THREE.BoxGeometry(0.22, 0.09, 0.04), partId: 4.5, slot: 7, pivot: [0, 0.82, 0], offset: [0, 0.93, 0.12] },
      // 5: 左手臂 (寬 0.09, 高 0.32, 深 0.09), 樞軸 [-0.20, 0.72, 0.0]
      { geom: new THREE.BoxGeometry(0.09, 0.32, 0.09), partId: 5, slot: 1, pivot: [-0.20, 0.72, 0.0], offset: [-0.20, 0.58, 0.12] },
      // 6: 右手臂 (寬 0.09, 高 0.32, 深 0.09), 樞軸 [0.20, 0.72, 0.0]
      { geom: new THREE.BoxGeometry(0.09, 0.32, 0.09), partId: 6, slot: 1, pivot: [0.20, 0.72, 0.0], offset: [0.20, 0.58, 0.12] },
      // 7: 汽車方向盤 (圓盤/方盤, 僅汽車駕駛顯現), 樞軸 [0.0, 0.70, 0.32]
      { geom: new THREE.BoxGeometry(0.30, 0.30, 0.04), partId: 7, slot: 6, pivot: [0, 0.70, 0.32], offset: [0, 0.70, 0.32] },
      // 8: 左腿 (坐姿前伸微彎), 樞軸 [-0.12, 0.36, 0.0]
      { geom: new THREE.BoxGeometry(0.11, 0.36, 0.11), partId: 8, slot: 2, pivot: [-0.12, 0.36, 0.0], offset: [-0.12, 0.20, 0.14] },
      // 9: 右腿, 樞軸 [0.12, 0.36, 0.0]
      { geom: new THREE.BoxGeometry(0.11, 0.36, 0.11), partId: 9, slot: 2, pivot: [0.12, 0.36, 0.0], offset: [0.12, 0.20, 0.14] }
    ];

    const posList: number[] = [];
    const normList: number[] = [];
    const partIdList: number[] = [];
    const colorSlotList: number[] = [];
    const pivotList: number[] = [];

    for (const p of parts) {
      const g = p.geom.toNonIndexed();
      g.translate(p.offset[0], p.offset[1], p.offset[2]);

      const pos = g.attributes.position.array as Float32Array;
      const norm = g.attributes.normal.array as Float32Array;
      const vCount = pos.length / 3;

      for (let i = 0; i < vCount; i++) {
        posList.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        normList.push(norm[i * 3], norm[i * 3 + 1], norm[i * 3 + 2]);
        partIdList.push(p.partId);
        colorSlotList.push(p.slot);
        pivotList.push(p.pivot[0], p.pivot[1], p.pivot[2]);
      }
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    merged.setAttribute('aPartId', new THREE.Float32BufferAttribute(partIdList, 1));
    merged.setAttribute('aColorSlot', new THREE.Float32BufferAttribute(colorSlotList, 1));
    merged.setAttribute('aPivot', new THREE.Float32BufferAttribute(pivotList, 3));

    return merged;
  }

  /**
   * 初始化近景駕駛/乘客 InstancedMesh (含 Vertex Shader 動態手腕、頭部、安全帽與口罩渲染)
   */
  private initDriverNearMesh(): void {
    const geom = this.createDriverNearGeometry();

    this.skinColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCharacters * 3), 3);
    this.shirtColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCharacters * 3), 3);
    this.helmetColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCharacters * 3), 3);
    this.animAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCharacters * 4), 4);
    this.flagsAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCharacters * 4), 4);

    this.skinColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.shirtColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.helmetColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.animAttr.setUsage(THREE.DynamicDrawUsage);
    this.flagsAttr.setUsage(THREE.DynamicDrawUsage);

    geom.setAttribute('aInstanceColorSkin', this.skinColorAttr);
    geom.setAttribute('aInstanceColorShirt', this.shirtColorAttr);
    geom.setAttribute('aInstanceColorHelmet', this.helmetColorAttr);
    geom.setAttribute('aInstanceAnim', this.animAttr);
    geom.setAttribute('aInstanceFlags', this.flagsAttr);

    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.75,
      metalness: 0.05
    });

    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aPartId;
        attribute float aColorSlot;
        attribute vec3 aPivot;

        attribute vec3 aInstanceColorSkin;
        attribute vec3 aInstanceColorShirt;
        attribute vec3 aInstanceColorHelmet;
        attribute vec4 aInstanceAnim;   // x: steer, y: headTurn, z: lookDown, w: footDown
        attribute vec4 aInstanceFlags;  // x: isCarDriver, y: hasMask, z: isScooter, w: isHolding 或 isCap

        varying vec3 vCharColor;

        mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c); }
        mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c); }
        mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0); }
      ` + shader.vertexShader;

      const beginNormalHook = `
        #include <beginnormal_vertex>

        float steer = aInstanceAnim.x;
        float headTurn = aInstanceAnim.y;
        float lookDown = aInstanceAnim.z;
        float footDown = aInstanceAnim.w;

        float isCar = aInstanceFlags.x;
        float isScooter = aInstanceFlags.z;
        float isHolding = aInstanceFlags.w;

        mat3 partRot = mat3(1.0);

        if (aPartId > 0.5 && aPartId < 4.8) {
          partRot = rotY(headTurn) * rotX(lookDown);
        } else if (aPartId < 0.5) {
          if (isCar > 0.5) partRot = rotZ(-steer * 0.15);
        } else if (aPartId > 4.8 && aPartId < 6.5) {
          float armSide = (aPartId < 5.5) ? -1.0 : 1.0;
          if (isCar > 0.5) {
            partRot = rotX(-0.65) * rotZ(steer * 0.75 + armSide * 0.12);
          } else if (isScooter > 0.5 && isHolding > 0.5) {
            partRot = rotX(-0.80) * rotZ(armSide * 0.22);
          } else if (isScooter > 0.5) {
            partRot = rotX(-0.55) * rotZ(armSide * 0.18 + steer * 0.35);
          } else {
            partRot = rotX(-0.25);
          }
        } else if (aPartId > 6.5 && aPartId < 7.5) {
          if (isCar > 0.5) partRot = rotZ(steer * 1.5);
        } else if (aPartId > 7.5 && aPartId < 8.5) {
          if (footDown > 0.5 && isScooter > 0.5) {
            partRot = rotX(0.42) * rotZ(-0.22);
          }
        }

        objectNormal = partRot * objectNormal;
      `;

      const beginVertexHook = `
        #include <begin_vertex>

        vec3 lPos = position - aPivot;

        // 口罩判定
        if (aPartId > 1.5 && aPartId < 2.5 && aInstanceFlags.y < 0.5) {
          lPos *= 0.0; // 無口罩時縮至零
        }
        if (aInstanceFlags.z > 0.5) {
          // 機車：顯示安全帽與護目鏡，隱藏普通頭髮與鴨舌帽
          if (aPartId > 2.8 && aPartId < 3.8) lPos *= 0.0;
        } else {
          // 汽車：顯示頭髮/帽子，隱藏安全帽與護目鏡
          if (aPartId > 3.8 && aPartId < 4.8) lPos *= 0.0;
          // 若非鴨舌帽，隱藏帽簷
          if (aPartId > 3.2 && aPartId < 3.8 && aInstanceFlags.w < 0.5) lPos *= 0.0;
        }
        // 非汽車駕駛隱藏方向盤
        if (aPartId > 6.5 && aPartId < 7.5 && aInstanceFlags.x < 0.5) {
          lPos *= 0.0;
        }

        transformed = aPivot + partRot * lPos;

        // 部位色彩分流
        vec3 col = aInstanceColorShirt;
        if (aColorSlot < 0.5) {
          col = aInstanceColorSkin;
        } else if (aColorSlot < 1.5) {
          col = aInstanceColorShirt;
        } else if (aColorSlot < 2.5) {
          col = vec3(0.20, 0.24, 0.32); // 褲子深灰藍
        } else if (aColorSlot < 3.5) {
          col = (aInstanceFlags.w > 0.5 && aInstanceFlags.z < 0.5) ? vec3(0.18, 0.22, 0.30) : vec3(0.12, 0.10, 0.08); // 鴨舌帽深藍灰或頭髮黑褐
        } else if (aColorSlot < 4.5) {
          col = aInstanceColorHelmet;   // 安全帽
        } else if (aColorSlot < 5.5) {
          col = vec3(0.88, 0.92, 0.96); // 口罩淺藍白
        } else if (aColorSlot < 6.5) {
          col = vec3(0.15, 0.16, 0.18); // 方向盤深灰
        } else {
          col = vec3(0.15, 0.18, 0.24); // 安全帽護目鏡深色
        }
        vCharColor = col;
      `;

      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', beginNormalHook);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', beginVertexHook);

      shader.fragmentShader = `varying vec3 vCharColor;\n` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor.rgb *= vCharColor;
        `
      );
    };

    this.driverNearMesh = new THREE.InstancedMesh(geom, mat, this.maxCharacters);
    this.driverNearMesh.name = 'Traffic_DriverNearMesh';
    this.driverNearMesh.frustumCulled = false;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.driverNearMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.driverNearMesh.renderOrder = 0;

    for (let i = 0; i < this.maxCharacters; i++) {
      this.driverNearMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.driverNearMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.driverNearMesh);
  }

  /**
   * 初始化遠景駕駛/乘客簡化體 InstancedMesh (僅 1 個合併頭身方塊，無動作)
   */
  private initDriverFarMesh(): void {
    const parts = [
      { geom: new THREE.BoxGeometry(0.34, 0.55, 0.22), offset: [0, 0.55, 0] },
      { geom: new THREE.BoxGeometry(0.20, 0.22, 0.20), offset: [0, 0.94, 0] }
    ];

    const posList: number[] = [];
    const normList: number[] = [];

    for (const p of parts) {
      const g = p.geom.toNonIndexed();
      g.translate(p.offset[0], p.offset[1], p.offset[2]);
      const pos = g.attributes.position.array as Float32Array;
      const norm = g.attributes.normal.array as Float32Array;
      for (let i = 0; i < pos.length; i++) {
        posList.push(pos[i]);
        normList.push(norm[i]);
      }
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));

    const mat = new THREE.MeshStandardMaterial({
      roughness: 0.8,
      metalness: 0.05
    });

    this.driverFarMesh = new THREE.InstancedMesh(merged, mat, this.maxCharacters);
    this.driverFarMesh.name = 'Traffic_DriverFarMesh';
    this.driverFarMesh.frustumCulled = false;
    merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.driverFarMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.farColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCharacters * 3), 3);
    this.driverFarMesh.instanceColor = this.farColorAttr;
    this.driverFarMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < this.maxCharacters; i++) {
      this.driverFarMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.driverFarMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.driverFarMesh);
  }

  /**
   * 逐幀更新所有車輛與駕駛/乘客的外觀、位置、姿態與 LOD
   */
  public update(vehicles: TrafficVehicle[], cameraPos: THREE.Vector3): void {
    let carIndex = 0;
    let scooterIndex = 0;
    let taxiIndex = 0;
    let nearCharIndex = 0;
    let farCharIndex = 0;

    const nearLOD = CONFIG.TRAFFIC.LOD_NEAR_RADIUS; // 60m
    const farLOD = CONFIG.TRAFFIC.LOD_FAR_RADIUS;   // 120m

    for (const v of vehicles) {
      if (!v.active) continue;

      const dist = Math.hypot(v.x - cameraPos.x, v.z - cameraPos.z);
      const isScooter = v.type === 'scooter';
      const isTaxi = v.type === 'taxi';

      // 1. 車輛本體矩陣更新
      this.dummyObj.position.set(v.x, v.y, v.z);
      this.dummyObj.rotation.set(0, v.rotationY, 0);

      // 機車依傾角進行側傾 (過彎傾斜)
      if (isScooter) {
        this.dummyObj.rotateZ(v.driver.leanAngle || 0);
      }

      this.dummyObj.updateMatrix();

      if (isScooter) {
        if (scooterIndex < this.maxVehicles) {
          this.scooterMesh.setMatrixAt(scooterIndex, this.dummyObj.matrix);
          const [r, g, b] = parseHex(v.bodyColorHex);
          this.tempColor.setRGB(r, g, b);
          this.scooterMesh.setColorAt(scooterIndex, this.tempColor);
          scooterIndex++;
        }
      } else {
        if (carIndex < this.maxVehicles) {
          this.carMesh.setMatrixAt(carIndex, this.dummyObj.matrix);
          this.carGlassMesh.setMatrixAt(carIndex, this.dummyObj.matrix);

          const hex = isTaxi ? '#facc15' : v.bodyColorHex;
          const [r, g, b] = parseHex(hex);
          this.tempColor.setRGB(r, g, b);
          this.carMesh.setColorAt(carIndex, this.tempColor);

          // 計程車頂燈
          if (isTaxi && taxiIndex < this.maxVehicles) {
            if (v.roofLightOn) {
              this.taxiRoofLightMesh.setMatrixAt(taxiIndex, this.dummyObj.matrix);
            } else {
              this.taxiRoofLightMesh.setMatrixAt(taxiIndex, this.zeroMatrix);
            }
            taxiIndex++;
          }

          carIndex++;
        }
      }

      // 若超出 120m 則不渲染駕駛與乘客
      if (dist > farLOD) {
        continue;
      }

      // 2. 駕駛與乘客人物更新
      const allPeople: {
        role: 'driver' | 'passenger';
        seatOffset: [number, number, number];
        app: any;
        steerAngle: number;
        headTurnAngle: number;
        lookDown: number;
        footDown: boolean;
        isCarDriver: boolean;
        isHolding: boolean;
      }[] = [];

      // 駕駛本人 (未被彈出時渲染)
      if (!v.driver.isEjected) {
        const seatOffset: [number, number, number] = isScooter
          ? [0.0, 0.68, 0.04]
          : [-0.38, 0.34, 0.08];

        allPeople.push({
          role: 'driver',
          seatOffset,
          app: v.driver.appearance,
          steerAngle: v.driver.steeringAngle,
          headTurnAngle: v.driver.headTurnAngle,
          lookDown: v.driver.lookPhoneTimer > 0 ? 0.35 : 0.0,
          footDown: v.driver.footDown,
          isCarDriver: !isScooter,
          isHolding: false
        });
      }

      // 乘客名單
      for (const pass of v.driver.passengers) {
        let seatOffset: [number, number, number] = [0.38, 0.34, 0.08];
        if (isScooter) {
          seatOffset = [0.0, 0.74, -0.38]; // 機車後座
        } else {
          if (pass.seat === 'passenger_front') seatOffset = [0.38, 0.34, 0.08];
          else if (pass.seat === 'passenger_rear_left') seatOffset = [-0.38, 0.34, -0.65];
          else if (pass.seat === 'passenger_rear_right') seatOffset = [0.38, 0.34, -0.65];
        }

        allPeople.push({
          role: 'passenger',
          seatOffset,
          app: pass.appearance,
          steerAngle: 0,
          headTurnAngle: pass.headTurnAngle,
          lookDown: 0,
          footDown: false,
          isCarDriver: false,
          isHolding: !!pass.isHoldingRider
        });
      }

      // LOD 分級渲染
      for (const p of allPeople) {
        // 人物座位在車內之相對矩陣轉換
        this.seatObj.position.set(p.seatOffset[0], p.seatOffset[1], p.seatOffset[2]);
        this.seatObj.rotation.set(0, 0, 0);
        this.seatObj.updateMatrix();

        // 世界矩陣 = 車輛矩陣 x 座位相對矩陣
        const charWorldMat = this.dummyObj.matrix.clone().multiply(this.seatObj.matrix);

        if (dist <= nearLOD) {
          // 0 ~ 60m: 完整細節模型與動作
          if (nearCharIndex < this.maxCharacters) {
            this.driverNearMesh.setMatrixAt(nearCharIndex, charWorldMat);

            // 膚色
            const [sr, sg, sb] = parseHex(p.app.skinColorHex);
            this.skinColorAttr.setXYZ(nearCharIndex, sr, sg, sb);

            // 上衣或雨衣色彩
            const shirtHex = p.app.hasRaincoat ? p.app.raincoatColorHex : p.app.shirtColorHex;
            const [tr, tg, tb] = parseHex(shirtHex);
            this.shirtColorAttr.setXYZ(nearCharIndex, tr, tg, tb);

            // 安全帽色彩
            const [hr, hg, hb] = parseHex(p.app.helmetColorHex || '#ffffff');
            this.helmetColorAttr.setXYZ(nearCharIndex, hr, hg, hb);

            // 動畫屬性: x=steer, y=headTurn, z=lookDown, w=footDown
            this.animAttr.setXYZW(
              nearCharIndex,
              p.steerAngle,
              p.headTurnAngle,
              p.lookDown,
              p.footDown ? 1.0 : 0.0
            );

            // 標誌屬性: x=isCarDriver, y=hasMask, z=isScooter, w=isHolding 或 isCap
            const isCap = (!isScooter && p.app.hatType === 'cap') ? 1.0 : 0.0;
            const flagW = isScooter ? (p.isHolding ? 1.0 : 0.0) : isCap;
            this.flagsAttr.setXYZW(
              nearCharIndex,
              p.isCarDriver ? 1.0 : 0.0,
              p.app.hasMask ? 1.0 : 0.0,
              isScooter ? 1.0 : 0.0,
              flagW
            );

            nearCharIndex++;
          }
        } else {
          // 60 ~ 120m: 簡化色塊人影
          if (farCharIndex < this.maxCharacters) {
            this.driverFarMesh.setMatrixAt(farCharIndex, charWorldMat);
            const shirtHex = p.app.hasRaincoat ? p.app.raincoatColorHex : p.app.shirtColorHex;
            const [fr, fg, fb] = parseHex(shirtHex);
            this.tempColor.setRGB(fr, fg, fb);
            this.driverFarMesh.setColorAt(farCharIndex, this.tempColor);
            farCharIndex++;
          }
        }
      }
    }

    // 清空剩餘未使用的實例
    for (let i = carIndex; i < this.maxVehicles; i++) {
      this.carMesh.setMatrixAt(i, this.zeroMatrix);
      this.carGlassMesh.setMatrixAt(i, this.zeroMatrix);
    }
    for (let i = scooterIndex; i < this.maxVehicles; i++) {
      this.scooterMesh.setMatrixAt(i, this.zeroMatrix);
    }
    for (let i = taxiIndex; i < this.maxVehicles; i++) {
      this.taxiRoofLightMesh.setMatrixAt(i, this.zeroMatrix);
    }
    for (let i = nearCharIndex; i < this.maxCharacters; i++) {
      this.driverNearMesh.setMatrixAt(i, this.zeroMatrix);
    }
    for (let i = farCharIndex; i < this.maxCharacters; i++) {
      this.driverFarMesh.setMatrixAt(i, this.zeroMatrix);
    }

    // 標記需要更新至 GPU
    this.carMesh.instanceMatrix.needsUpdate = true;
    if (this.carMesh.instanceColor) this.carMesh.instanceColor.needsUpdate = true;
    this.carGlassMesh.instanceMatrix.needsUpdate = true;

    this.scooterMesh.instanceMatrix.needsUpdate = true;
    if (this.scooterMesh.instanceColor) this.scooterMesh.instanceColor.needsUpdate = true;

    this.taxiRoofLightMesh.instanceMatrix.needsUpdate = true;

    this.driverNearMesh.instanceMatrix.needsUpdate = true;
    this.skinColorAttr.needsUpdate = true;
    this.shirtColorAttr.needsUpdate = true;
    this.helmetColorAttr.needsUpdate = true;
    this.animAttr.needsUpdate = true;
    this.flagsAttr.needsUpdate = true;

    this.driverFarMesh.instanceMatrix.needsUpdate = true;
    if (this.driverFarMesh.instanceColor) this.driverFarMesh.instanceColor.needsUpdate = true;
  }

  /**
   * 取得當前渲染器所消耗的 Draw Calls (車身 4 + 人物 2 = 6, 人物嚴格限制 <= 4)
   */
  public getDrawCalls(): number {
    return 6;
  }

  public dispose(): void {
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    this.carMesh.geometry.dispose();
    (this.carMesh.material as THREE.Material).dispose();
    this.carGlassMesh.geometry.dispose();
    (this.carGlassMesh.material as THREE.Material).dispose();
    this.scooterMesh.geometry.dispose();
    (this.scooterMesh.material as THREE.Material).dispose();
    this.taxiRoofLightMesh.geometry.dispose();
    (this.taxiRoofLightMesh.material as THREE.Material).dispose();
    this.driverNearMesh.geometry.dispose();
    (this.driverNearMesh.material as THREE.Material).dispose();
    this.driverFarMesh.geometry.dispose();
    (this.driverFarMesh.material as THREE.Material).dispose();
  }
}
