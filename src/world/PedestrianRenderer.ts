/**
 * PedestrianRenderer.ts - 行人高效能 GPU 渲染器
 * 遵循 RULES.md 與效能硬性要求：
 * 1. 全部行人使用 InstancedMesh 批次繪製（近景 Low-Poly Box Man + 遠景 LOD 簡化體 + 配件），總 Draw calls <= 4 (遠低於 10 的要求)
 * 2. 肢體前後擺動、上下起伏、走停待機動畫全數以 Vertex Shader (onBeforeCompile) 運算，CPU 零負載
 * 3. 隨機外觀色彩 (膚色、上衣、褲子、髮型/帽子) 由 InstancedBufferAttribute 與 PartId 著色
 * 4. LOD 機制：50m 內完整模型與肢體擺動，50~110m 遠景簡化體，>110m 自動剔除
 * 5. 陰影控制：陰影僅對 <= 40m 行人渲染，自訂 Depth Shader 精確裁剪，且遠景不投射陰影
 * 6. 配件 InstancedMesh：雨傘、提袋 (含溫泉提袋)，依狀態與機率動態掛載
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PedestrianAgent } from '../systems/PedestrianSystem.ts';

// 顏色 Hex 快取解析器 (避免逐幀字串轉換與記憶體配置)
const COLOR_CACHE = new Map<string, [number, number, number]>();
function parseHexColor(hex: string): [number, number, number] {
  let c = COLOR_CACHE.get(hex);
  if (!c) {
    const clean = hex.replace('#', '');
    const num = parseInt(clean, 16);
    c = [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
    COLOR_CACHE.set(hex, c);
  }
  return c;
}

export class PedestrianRenderer {
  private group: THREE.Group;
  private maxCount: number;

  // 近景完整模型 (0 ~ 50m)
  private nearMesh!: THREE.InstancedMesh;
  private nearMaterial!: THREE.MeshStandardMaterial;
  private nearDepthMaterial!: THREE.MeshDepthMaterial;

  // 遠景簡化模型 (50 ~ 110m)
  private farMesh!: THREE.InstancedMesh;
  private farMaterial!: THREE.MeshStandardMaterial;

  // 配件模型
  private umbrellaMesh!: THREE.InstancedMesh;
  private bagMesh!: THREE.InstancedMesh;

  // 近景屬性 Buffer
  private skinColorAttr!: THREE.InstancedBufferAttribute;
  private shirtColorAttr!: THREE.InstancedBufferAttribute;
  private pantsColorAttr!: THREE.InstancedBufferAttribute;
  private hairColorAttr!: THREE.InstancedBufferAttribute;
  private animAttr!: THREE.InstancedBufferAttribute; // x: walkPhase, y: speed, z: gesture, w: idlePhase

  // 遠景屬性 Buffer
  private farShirtColorAttr!: THREE.InstancedBufferAttribute;
  private farSkinColorAttr!: THREE.InstancedBufferAttribute;
  private farAnimAttr!: THREE.InstancedBufferAttribute;

  // 矩陣暫存器 (零記憶體配置)
  private dummyObj = new THREE.Object3D();
  private zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -9999, 0);
  private localAccMatrix = new THREE.Matrix4();
  private worldAccMatrix = new THREE.Matrix4();

  // Shader Uniform 參考
  private nearUniforms = {
    uPlayerPos: { value: new THREE.Vector3(0, 0, 0) }
  };

  constructor(scene: THREE.Scene) {
    this.maxCount = CONFIG.PEDESTRIAN.MAX_COUNT;
    this.group = new THREE.Group();
    this.group.name = 'PedestrianRendererGroup';

    this.initNearMesh();
    this.initFarMesh();
    this.initAccessories();

    scene.add(this.group);
  }

  /**
   * 建立近景 Box Man 合併幾何體 (軀幹、頭部、頭髮、左右手臂、左右腿部，共 252 頂點)
   */
  private createNearGeometry(): THREE.BufferGeometry {
    const parts: {
      geom: THREE.BufferGeometry;
      partId: number;
      defaultColorSlot: number;
      pivot: [number, number, number];
      offset: [number, number, number];
      isArmOrLeg?: 'arm' | 'leg';
    }[] = [
      // 0: 軀幹 (寬 0.36, 高 0.52, 深 0.22)
      {
        geom: new THREE.BoxGeometry(0.36, 0.52, 0.22),
        partId: 0,
        defaultColorSlot: 1, // 上衣
        pivot: [0, 0, 0],
        offset: [0, 0.95, 0]
      },
      // 1: 頭部 (寬 0.20, 高 0.22, 深 0.20)
      {
        geom: new THREE.BoxGeometry(0.20, 0.22, 0.20),
        partId: 1,
        defaultColorSlot: 0, // 膚色
        pivot: [0, 0, 0],
        offset: [0, 1.34, 0]
      },
      // 2: 頭髮 / 帽子 (寬 0.22, 高 0.08, 深 0.22)
      {
        geom: new THREE.BoxGeometry(0.22, 0.08, 0.22),
        partId: 2,
        defaultColorSlot: 3, // 髮色
        pivot: [0, 0, 0],
        offset: [0, 1.45, -0.01]
      },
      // 3: 左手臂 (寬 0.10, 高 0.46, 深 0.10) - 肩膀軸心 (-0.23, 1.15, 0.0)
      {
        geom: new THREE.BoxGeometry(0.10, 0.46, 0.10),
        partId: 3,
        defaultColorSlot: 1,
        pivot: [-0.23, 1.15, 0.0],
        offset: [-0.23, 0.92, 0.0],
        isArmOrLeg: 'arm'
      },
      // 4: 右手臂 (寬 0.10, 高 0.46, 深 0.10) - 肩膀軸心 (0.23, 1.15, 0.0)
      {
        geom: new THREE.BoxGeometry(0.10, 0.46, 0.10),
        partId: 4,
        defaultColorSlot: 1,
        pivot: [0.23, 1.15, 0.0],
        offset: [0.23, 0.92, 0.0],
        isArmOrLeg: 'arm'
      },
      // 5: 左腿 (寬 0.13, 高 0.62, 深 0.13) - 髖關節軸心 (-0.10, 0.66, 0.0)
      {
        geom: new THREE.BoxGeometry(0.13, 0.62, 0.13),
        partId: 5,
        defaultColorSlot: 2, // 褲子
        pivot: [-0.10, 0.66, 0.0],
        offset: [-0.10, 0.35, 0.0],
        isArmOrLeg: 'leg'
      },
      // 6: 右腿 (寬 0.13, 高 0.62, 深 0.13) - 髖關節軸心 (0.10, 0.66, 0.0)
      {
        geom: new THREE.BoxGeometry(0.13, 0.62, 0.13),
        partId: 6,
        defaultColorSlot: 2, // 褲子
        pivot: [0.10, 0.66, 0.0],
        offset: [0.10, 0.35, 0.0],
        isArmOrLeg: 'leg'
      }
    ];

    const posList: number[] = [];
    const normList: number[] = [];
    const partIdList: number[] = [];
    const colorSlotList: number[] = [];
    const pivotList: number[] = [];

    for (const p of parts) {
      const nonIdx = p.geom.toNonIndexed();
      nonIdx.translate(p.offset[0], p.offset[1], p.offset[2]);

      const pos = nonIdx.attributes.position.array as Float32Array;
      const norm = nonIdx.attributes.normal.array as Float32Array;
      const vCount = pos.length / 3;

      for (let i = 0; i < vCount; i++) {
        const vx = pos[i * 3];
        const vy = pos[i * 3 + 1];
        const vz = pos[i * 3 + 2];

        posList.push(vx, vy, vz);
        normList.push(norm[i * 3], norm[i * 3 + 1], norm[i * 3 + 2]);

        partIdList.push(p.partId);
        pivotList.push(p.pivot[0], p.pivot[1], p.pivot[2]);

        // 部位顏色插槽劃分 (手臂上半是袖子、下半是膚色；腿部下方是鞋子)
        let slot = p.defaultColorSlot;
        if (p.isArmOrLeg === 'arm') {
          slot = vy > 0.94 ? 1 : 0; // 上袖子，下手臂手掌
        } else if (p.isArmOrLeg === 'leg') {
          slot = vy > 0.10 ? 2 : 4; // 褲子，鞋底鞋面
        }
        colorSlotList.push(slot);
      }
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
   * 建立遠景簡化體幾何體 (僅 2 個方塊：一體成型身體 + 頭部，共 72 頂點)
   */
  private createFarGeometry(): THREE.BufferGeometry {
    const parts = [
      { geom: new THREE.BoxGeometry(0.36, 1.25, 0.22), offset: [0, 0.65, 0], slot: 1 },
      { geom: new THREE.BoxGeometry(0.20, 0.22, 0.20), offset: [0, 1.35, 0], slot: 0 }
    ];

    const posList: number[] = [];
    const normList: number[] = [];
    const colorSlotList: number[] = [];

    for (const p of parts) {
      const nonIdx = p.geom.toNonIndexed();
      nonIdx.translate(p.offset[0], p.offset[1], p.offset[2]);
      const pos = nonIdx.attributes.position.array as Float32Array;
      const norm = nonIdx.attributes.normal.array as Float32Array;
      const vCount = pos.length / 3;

      for (let i = 0; i < vCount; i++) {
        posList.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        normList.push(norm[i * 3], norm[i * 3 + 1], norm[i * 3 + 2]);
        colorSlotList.push(p.slot);
      }
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normList, 3));
    merged.setAttribute('aColorSlot', new THREE.Float32BufferAttribute(colorSlotList, 1));

    return merged;
  }

  /**
   * 初始化近景完整模型 InstancedMesh (含 PBR 材質與 Vertex Shader 動畫)
   */
  private initNearMesh(): void {
    const geom = this.createNearGeometry();

    // 實例屬性
    this.skinColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 3), 3);
    this.shirtColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 3), 3);
    this.pantsColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 3), 3);
    this.hairColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 3), 3);
    this.animAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 4), 4);

    this.skinColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.shirtColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.pantsColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.hairColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.animAttr.setUsage(THREE.DynamicDrawUsage);

    geom.setAttribute('aInstanceColorSkin', this.skinColorAttr);
    geom.setAttribute('aInstanceColorShirt', this.shirtColorAttr);
    geom.setAttribute('aInstanceColorPants', this.pantsColorAttr);
    geom.setAttribute('aInstanceColorHair', this.hairColorAttr);
    geom.setAttribute('aInstanceAnim', this.animAttr);

    // PBR 材質
    this.nearMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.85,
      metalness: 0.05
    });

    // 注入 Vertex Shader 動態肢體擺動與部位色彩
    this.nearMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aPartId;
        attribute float aColorSlot;
        attribute vec3 aPivot;

        attribute vec3 aInstanceColorSkin;
        attribute vec3 aInstanceColorShirt;
        attribute vec3 aInstanceColorPants;
        attribute vec3 aInstanceColorHair;
        attribute vec4 aInstanceAnim; // x: walkPhase, y: speed, z: gesture, w: idlePhase

        varying vec3 vPedColor;

        mat3 pedRotX(float angle) {
          float c = cos(angle);
          float s = sin(angle);
          return mat3(
            1.0, 0.0, 0.0,
            0.0, c, -s,
            0.0, s, c
          );
        }

        mat3 pedRotZ(float angle) {
          float c = cos(angle);
          float s = sin(angle);
          return mat3(
            c, -s, 0.0,
            s, c, 0.0,
            0.0, 0.0, 1.0
          );
        }
      ` + shader.vertexShader;

      const beginNormalHook = `
        #include <beginnormal_vertex>

        float phase = aInstanceAnim.x;
        float spd = aInstanceAnim.y;
        float gesture = aInstanceAnim.z;
        float idlePhase = aInstanceAnim.w;

        float isMoving = step(0.08, spd);
        float normSpd = clamp(spd / 1.4, 0.0, 1.3);

        float armSwing = sin(phase) * 0.65 * normSpd;
        float legSwing = sin(phase) * 0.65 * normSpd;

        mat3 partRot = mat3(1.0);

        if (aPartId > 2.5 && aPartId < 3.5) { // 3: 左臂
          if (gesture > 2.5) { // 3: 驚恐
            partRot = pedRotX(sin(phase * 4.0) * 0.8 + 1.2) * pedRotZ(-0.3);
          } else if (gesture > 0.5 && gesture < 1.5) { // 1: 手機端著
            partRot = pedRotX(-0.35) * pedRotZ(-0.25);
          } else {
            float a = isMoving * armSwing + (1.0 - isMoving) * sin(idlePhase * 1.2) * 0.04;
            partRot = pedRotX(a);
          }
        } else if (aPartId > 3.5 && aPartId < 4.5) { // 4: 右臂
          if (gesture > 2.5) { // 3: 驚恐
            partRot = pedRotX(sin(phase * 4.0 + 1.5) * 0.8 + 1.2) * pedRotZ(0.3);
          } else if (gesture > 0.5 && gesture < 1.5) { // 1: 講電話/看手機
            partRot = pedRotX(-1.6) * pedRotZ(0.35);
          } else if (gesture > 1.5 && gesture < 2.5) { // 2: 提袋或撐傘
            partRot = pedRotX(-0.6) * pedRotZ(0.15);
          } else {
            float a = isMoving * (-armSwing) + (1.0 - isMoving) * sin(idlePhase * 1.2 + 1.0) * 0.04;
            partRot = pedRotX(a);
          }
        } else if (aPartId > 4.5 && aPartId < 5.5) { // 5: 左腿
          partRot = pedRotX(isMoving * (-legSwing));
        } else if (aPartId > 5.5 && aPartId < 6.5) { // 6: 右腿
          partRot = pedRotX(isMoving * legSwing);
        }

        objectNormal = partRot * objectNormal;
      `;

      const beginVertexHook = `
        #include <begin_vertex>

        vec3 localPos = position - aPivot;
        transformed = aPivot + partRot * localPos;

        float yBounce = isMoving * abs(sin(phase)) * 0.038 * normSpd + (1.0 - isMoving) * sin(idlePhase * 1.5) * 0.012;
        transformed.y += yBounce;

        vec3 col = aInstanceColorShirt;
        if (aColorSlot < 0.5) {
          col = aInstanceColorSkin;
        } else if (aColorSlot < 1.5) {
          col = aInstanceColorShirt;
        } else if (aColorSlot < 2.5) {
          col = aInstanceColorPants;
        } else if (aColorSlot < 3.5) {
          col = aInstanceColorHair;
        } else {
          col = vec3(0.16, 0.16, 0.18); // 鞋子
        }
        vPedColor = col;
      `;

      shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', beginNormalHook);
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', beginVertexHook);

      shader.fragmentShader = `
        varying vec3 vPedColor;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor.rgb *= vPedColor;
        `
      );
    };

    // 建立 Custom Depth Material (使陰影具備行走的動態擺腿影子，並精確裁剪超過 40m 的陰影)
    this.nearDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking
    });

    this.nearDepthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uPlayerPos = this.nearUniforms.uPlayerPos;

      shader.vertexShader = `
        uniform vec3 uPlayerPos;
        attribute float aPartId;
        attribute vec3 aPivot;
        attribute vec4 aInstanceAnim;

        mat3 pedRotX(float angle) {
          float c = cos(angle);
          float s = sin(angle);
          return mat3(
            1.0, 0.0, 0.0,
            0.0, c, -s,
            0.0, s, c
          );
        }
        mat3 pedRotZ(float angle) {
          float c = cos(angle);
          float s = sin(angle);
          return mat3(
            c, -s, 0.0,
            s, c, 0.0,
            0.0, 0.0, 1.0
          );
        }
      ` + shader.vertexShader;

      const depthVertexHook = `
        #include <begin_vertex>

        float phase = aInstanceAnim.x;
        float spd = aInstanceAnim.y;
        float gesture = aInstanceAnim.z;
        float idlePhase = aInstanceAnim.w;

        float isMoving = step(0.08, spd);
        float normSpd = clamp(spd / 1.4, 0.0, 1.3);

        float armSwing = sin(phase) * 0.65 * normSpd;
        float legSwing = sin(phase) * 0.65 * normSpd;

        mat3 partRot = mat3(1.0);

        if (aPartId > 2.5 && aPartId < 3.5) {
          if (gesture > 2.5) {
            partRot = pedRotX(sin(phase * 4.0) * 0.8 + 1.2) * pedRotZ(-0.3);
          } else if (gesture > 0.5 && gesture < 1.5) {
            partRot = pedRotX(-0.35) * pedRotZ(-0.25);
          } else {
            partRot = pedRotX(isMoving * armSwing + (1.0 - isMoving) * sin(idlePhase * 1.2) * 0.04);
          }
        } else if (aPartId > 3.5 && aPartId < 4.5) {
          if (gesture > 2.5) {
            partRot = pedRotX(sin(phase * 4.0 + 1.5) * 0.8 + 1.2) * pedRotZ(0.3);
          } else if (gesture > 0.5 && gesture < 1.5) {
            partRot = pedRotX(-1.6) * pedRotZ(0.35);
          } else if (gesture > 1.5 && gesture < 2.5) {
            partRot = pedRotX(-0.6) * pedRotZ(0.15);
          } else {
            partRot = pedRotX(isMoving * (-armSwing) + (1.0 - isMoving) * sin(idlePhase * 1.2 + 1.0) * 0.04);
          }
        } else if (aPartId > 4.5 && aPartId < 5.5) {
          partRot = pedRotX(isMoving * (-legSwing));
        } else if (aPartId > 5.5 && aPartId < 6.5) {
          partRot = pedRotX(isMoving * legSwing);
        }

        vec3 localPos = position - aPivot;
        transformed = aPivot + partRot * localPos;
        transformed.y += isMoving * abs(sin(phase)) * 0.038 * normSpd + (1.0 - isMoving) * sin(idlePhase * 1.5) * 0.012;
      `;

      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', depthVertexHook);

      // 陰影只對 <= 40m 行人渲染，超過 40m 在 Vertex Shader 拋出硬體裁剪空間
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        #include <project_vertex>
        vec4 wPos = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
        if (distance(wPos.xz, uPlayerPos.xz) > 40.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }
        `
      );
    };

    this.nearMesh = new THREE.InstancedMesh(geom, this.nearMaterial, this.maxCount);
    this.nearMesh.name = 'PedestrianNearMesh';
    this.nearMesh.castShadow = true;
    this.nearMesh.receiveShadow = true;
    this.nearMesh.customDepthMaterial = this.nearDepthMaterial;
    this.nearMesh.frustumCulled = false;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.nearMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // 預設全數隱藏在地下
    for (let i = 0; i < this.maxCount; i++) {
      this.nearMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.nearMesh.instanceMatrix.needsUpdate = true;

    this.group.add(this.nearMesh);
  }

  /**
   * 初始化遠景簡化模型 InstancedMesh (50m ~ 110m)
   */
  private initFarMesh(): void {
    const geom = this.createFarGeometry();

    this.farSkinColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 3), 3);
    this.farShirtColorAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 3), 3);
    this.farAnimAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.maxCount * 2), 2); // x: walkPhase, y: speed

    this.farSkinColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.farShirtColorAttr.setUsage(THREE.DynamicDrawUsage);
    this.farAnimAttr.setUsage(THREE.DynamicDrawUsage);

    geom.setAttribute('aFarSkinColor', this.farSkinColorAttr);
    geom.setAttribute('aFarShirtColor', this.farShirtColorAttr);
    geom.setAttribute('aFarAnim', this.farAnimAttr);

    this.farMaterial = new THREE.MeshStandardMaterial({
      roughness: 0.9,
      metalness: 0.0
    });

    this.farMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = `
        attribute float aColorSlot;
        attribute vec3 aFarSkinColor;
        attribute vec3 aFarShirtColor;
        attribute vec2 aFarAnim;
        varying vec3 vFarColor;
      ` + shader.vertexShader;

      const beginVertexHook = `
        #include <begin_vertex>
        float phase = aFarAnim.x;
        float spd = aFarAnim.y;
        float isMoving = step(0.1, spd);
        transformed.y += isMoving * abs(sin(phase)) * 0.03;
        vFarColor = aColorSlot < 0.5 ? aFarSkinColor : aFarShirtColor;
      `;

      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', beginVertexHook);

      shader.fragmentShader = `
        varying vec3 vFarColor;
      ` + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        diffuseColor.rgb *= vFarColor;
        `
      );
    };

    this.farMesh = new THREE.InstancedMesh(geom, this.farMaterial, this.maxCount);
    this.farMesh.name = 'PedestrianFarMesh';
    this.farMesh.castShadow = false; // 遠景不投射陰影，大幅節省 GPU
    this.farMesh.receiveShadow = true;
    this.farMesh.frustumCulled = false;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.farMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < this.maxCount; i++) {
      this.farMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.farMesh.instanceMatrix.needsUpdate = true;

    this.group.add(this.farMesh);
  }

  /**
   * 初始化配件 InstancedMesh (雨傘、提袋)
   */
  private initAccessories(): void {
    // 1. 雨傘幾何體 (錐形傘頂 + 細握把)
    const umbrellaParts = [
      { geom: new THREE.ConeGeometry(0.55, 0.22, 8), offset: [0, 0.65, 0] },
      { geom: new THREE.CylinderGeometry(0.015, 0.015, 0.70, 6), offset: [0, 0.35, 0] }
    ];
    const uPos: number[] = [];
    const uNorm: number[] = [];
    for (const p of umbrellaParts) {
      const nonIdx = p.geom.toNonIndexed();
      nonIdx.translate(p.offset[0], p.offset[1], p.offset[2]);
      const pos = nonIdx.attributes.position.array as Float32Array;
      const norm = nonIdx.attributes.normal.array as Float32Array;
      for (let i = 0; i < pos.length; i++) {
        uPos.push(pos[i]);
        uNorm.push(norm[i]);
      }
    }
    const umbrellaGeom = new THREE.BufferGeometry();
    umbrellaGeom.setAttribute('position', new THREE.Float32BufferAttribute(uPos, 3));
    umbrellaGeom.setAttribute('normal', new THREE.Float32BufferAttribute(uNorm, 3));
    umbrellaGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);

    const umbrellaMat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.6,
      metalness: 0.1
    });

    this.umbrellaMesh = new THREE.InstancedMesh(umbrellaGeom, umbrellaMat, this.maxCount);
    this.umbrellaMesh.name = 'PedestrianUmbrellaMesh';
    this.umbrellaMesh.castShadow = true;
    this.umbrellaMesh.receiveShadow = false;
    this.umbrellaMesh.frustumCulled = false;
    this.umbrellaMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // 2. 提袋幾何體 (小提袋 / 溫泉毛巾袋)
    const bagGeom = new THREE.BoxGeometry(0.20, 0.24, 0.08);
    bagGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    const bagMat = new THREE.MeshStandardMaterial({
      color: 0xc2a67a, // 亞麻色提袋 / 米白毛巾袋
      roughness: 0.8,
      metalness: 0.0
    });

    this.bagMesh = new THREE.InstancedMesh(bagGeom, bagMat, this.maxCount);
    this.bagMesh.name = 'PedestrianBagMesh';
    this.bagMesh.castShadow = true;
    this.bagMesh.receiveShadow = false;
    this.bagMesh.frustumCulled = false;
    this.bagMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < this.maxCount; i++) {
      this.umbrellaMesh.setMatrixAt(i, this.zeroMatrix);
      this.bagMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.umbrellaMesh.instanceMatrix.needsUpdate = true;
    this.bagMesh.instanceMatrix.needsUpdate = true;

    this.group.add(this.umbrellaMesh);
    this.group.add(this.bagMesh);
  }

  /**
   * 逐幀更新行人渲染管線
   */
  public update(agents: PedestrianAgent[], playerPos: THREE.Vector3): void {
    if (!CONFIG.PEDESTRIAN.ENABLED) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    this.nearUniforms.uPlayerPos.value.copy(playerPos);

    let nearDirty = false;
    let farDirty = false;
    let umbrellaDirty = false;
    let bagDirty = false;

    const skinArr = this.skinColorAttr.array as Float32Array;
    const shirtArr = this.shirtColorAttr.array as Float32Array;
    const pantsArr = this.pantsColorAttr.array as Float32Array;
    const hairArr = this.hairColorAttr.array as Float32Array;
    const animArr = this.animAttr.array as Float32Array;

    const farSkinArr = this.farSkinColorAttr.array as Float32Array;
    const farShirtArr = this.farShirtColorAttr.array as Float32Array;
    const farAnimArr = this.farAnimAttr.array as Float32Array;

    for (let i = 0; i < this.maxCount; i++) {
      const agent = agents[i];

      // 檢查是否處於啟用狀態且未暫留建築物內部
      if (!agent || !agent.active || agent.insideBuildingTimer > 0) {
        this.nearMesh.setMatrixAt(i, this.zeroMatrix);
        this.farMesh.setMatrixAt(i, this.zeroMatrix);
        this.umbrellaMesh.setMatrixAt(i, this.zeroMatrix);
        this.bagMesh.setMatrixAt(i, this.zeroMatrix);
        nearDirty = true;
        farDirty = true;
        umbrellaDirty = true;
        bagDirty = true;
        continue;
      }

      // 計算與玩家距離 (以公尺為單位)
      const dx = agent.x - playerPos.x;
      const dz = agent.z - playerPos.z;
      const dist = Math.hypot(dx, dz);

      // 超出 110m 不渲染
      if (dist > CONFIG.PEDESTRIAN.LOD_LOW_DISTANCE) {
        this.nearMesh.setMatrixAt(i, this.zeroMatrix);
        this.farMesh.setMatrixAt(i, this.zeroMatrix);
        this.umbrellaMesh.setMatrixAt(i, this.zeroMatrix);
        this.bagMesh.setMatrixAt(i, this.zeroMatrix);
        nearDirty = true;
        farDirty = true;
        umbrellaDirty = true;
        bagDirty = true;
        continue;
      }

      // 準備幾何變換矩陣
      this.dummyObj.position.set(agent.x, agent.y, agent.z);
      this.dummyObj.rotation.set(0, agent.rotationY, 0);
      this.dummyObj.scale.set(agent.widthScale, agent.heightScale, agent.widthScale);
      this.dummyObj.updateMatrix();

      // LOD 分流
      if (dist <= CONFIG.PEDESTRIAN.LOD_HIGH_DISTANCE) {
        // [近景 0 ~ 50m]: 渲染完整模型
        this.nearMesh.setMatrixAt(i, this.dummyObj.matrix);
        this.farMesh.setMatrixAt(i, this.zeroMatrix);
        nearDirty = true;
        farDirty = true;

        // 寫入頂點著色器動畫與顏色屬性
        const sCol = parseHexColor(agent.skinColorHex);
        const tCol = parseHexColor(agent.shirtColorHex);
        const pCol = parseHexColor(agent.pantsColorHex);
        const hCol = parseHexColor(agent.hairColorHex);

        skinArr[i * 3] = sCol[0];
        skinArr[i * 3 + 1] = sCol[1];
        skinArr[i * 3 + 2] = sCol[2];

        shirtArr[i * 3] = tCol[0];
        shirtArr[i * 3 + 1] = tCol[1];
        shirtArr[i * 3 + 2] = tCol[2];

        pantsArr[i * 3] = pCol[0];
        pantsArr[i * 3 + 1] = pCol[1];
        pantsArr[i * 3 + 2] = pCol[2];

        hairArr[i * 3] = hCol[0];
        hairArr[i * 3 + 1] = hCol[1];
        hairArr[i * 3 + 2] = hCol[2];

        animArr[i * 4] = agent.walkPhase;
        animArr[i * 4 + 1] = agent.speed;
        animArr[i * 4 + 2] = agent.gesture;
        animArr[i * 4 + 3] = agent.idlePhase;

        // 配件處理 (僅近景且符合類型時顯示)
        if (agent.accessoryType === 'umbrella') {
          // 雨傘掛載於右手前伸處
          this.localAccMatrix.makeTranslation(0.24, 0.95, 0.18);
          this.worldAccMatrix.multiplyMatrices(this.dummyObj.matrix, this.localAccMatrix);
          this.umbrellaMesh.setMatrixAt(i, this.worldAccMatrix);
          this.bagMesh.setMatrixAt(i, this.zeroMatrix);
          umbrellaDirty = true;
          bagDirty = true;
        } else if (agent.accessoryType === 'bag') {
          // 提袋掛載於右手側邊
          this.localAccMatrix.makeTranslation(0.25, 0.55, 0.05);
          this.worldAccMatrix.multiplyMatrices(this.dummyObj.matrix, this.localAccMatrix);
          this.bagMesh.setMatrixAt(i, this.worldAccMatrix);
          this.umbrellaMesh.setMatrixAt(i, this.zeroMatrix);
          bagDirty = true;
          umbrellaDirty = true;
        } else {
          this.umbrellaMesh.setMatrixAt(i, this.zeroMatrix);
          this.bagMesh.setMatrixAt(i, this.zeroMatrix);
          umbrellaDirty = true;
          bagDirty = true;
        }
      } else {
        // [遠景 50 ~ 110m]: 渲染簡化模型，配件隱藏
        this.nearMesh.setMatrixAt(i, this.zeroMatrix);
        this.farMesh.setMatrixAt(i, this.dummyObj.matrix);
        this.umbrellaMesh.setMatrixAt(i, this.zeroMatrix);
        this.bagMesh.setMatrixAt(i, this.zeroMatrix);
        nearDirty = true;
        farDirty = true;
        umbrellaDirty = true;
        bagDirty = true;

        const sCol = parseHexColor(agent.skinColorHex);
        const tCol = parseHexColor(agent.shirtColorHex);

        farSkinArr[i * 3] = sCol[0];
        farSkinArr[i * 3 + 1] = sCol[1];
        farSkinArr[i * 3 + 2] = sCol[2];

        farShirtArr[i * 3] = tCol[0];
        farShirtArr[i * 3 + 1] = tCol[1];
        farShirtArr[i * 3 + 2] = tCol[2];

        farAnimArr[i * 2] = agent.walkPhase;
        farAnimArr[i * 2 + 1] = agent.speed;
      }
    }

    if (nearDirty) {
      this.nearMesh.instanceMatrix.needsUpdate = true;
      this.skinColorAttr.needsUpdate = true;
      this.shirtColorAttr.needsUpdate = true;
      this.pantsColorAttr.needsUpdate = true;
      this.hairColorAttr.needsUpdate = true;
      this.animAttr.needsUpdate = true;
    }
    if (farDirty) {
      this.farMesh.instanceMatrix.needsUpdate = true;
      this.farSkinColorAttr.needsUpdate = true;
      this.farShirtColorAttr.needsUpdate = true;
      this.farAnimAttr.needsUpdate = true;
    }
    if (umbrellaDirty) {
      this.umbrellaMesh.instanceMatrix.needsUpdate = true;
    }
    if (bagDirty) {
      this.bagMesh.instanceMatrix.needsUpdate = true;
    }
  }

  public getDrawCallsCount(): number {
    // 近景 1 + 遠景 1 + 雨傘 1 + 提袋 1 = 4 Draw calls
    return 4;
  }

  public dispose(): void {
    this.group.parent?.remove(this.group);
    this.nearMesh.geometry.dispose();
    this.nearMaterial.dispose();
    this.farMesh.geometry.dispose();
    this.farMaterial.dispose();
    this.umbrellaMesh.geometry.dispose();
    (this.umbrellaMesh.material as THREE.Material).dispose();
    this.bagMesh.geometry.dispose();
    (this.bagMesh.material as THREE.Material).dispose();
  }
}
