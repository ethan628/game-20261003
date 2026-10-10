/**
 * PedestrianDebugVisualizer.ts - 行人路網與狀態除錯視覺化
 * 遵循 RULES.md：
 * 按 F8 鍵切換顯示：
 * 1. 行人路網折線：一般人行道 (青藍色)、騎樓通道 (暖黃色)、斑馬線過街邊 (紅/綠燈即時變色)
 * 2. 行人頭頂狀態標記：WALKING (綠)、IDLE (黃)、WAITING (橙)、CROSSING (藍)、EVADING (紫)、PANIC (紅)
 * 3. 行人行進目標導引線：連往當前 targetNode
 */

import * as THREE from 'three';
import {
  PedestrianNetworkData,
  PedestrianState
} from '../geo/PedestrianTypes.ts';
import { PedestrianAgent } from '../systems/PedestrianSystem.ts';
import { CONFIG } from '../config.ts';

export class PedestrianDebugVisualizer {
  private group: THREE.Group;
  private isVisible = false;

  // 路網線段
  private normalEdgesMesh: THREE.LineSegments | null = null;
  private arcadeEdgesMesh: THREE.LineSegments | null = null;
  private crosswalkEdgesMesh: THREE.LineSegments | null = null;
  private crosswalkMaterial: THREE.LineBasicMaterial;

  // 行人狀態標記 InstancedMesh
  private markerMesh: THREE.InstancedMesh;
  private markerColors: Float32Array;
  private dummyObj = new THREE.Object3D();
  private zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0).setPosition(0, -9999, 0);

  // 目標導引線
  private targetLinesMesh: THREE.LineSegments;
  private targetLinesPositions: Float32Array;

  private networkData: PedestrianNetworkData | null = null;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'PedestrianDebugVisualizer';
    this.group.visible = false;

    this.crosswalkMaterial = new THREE.LineBasicMaterial({
      color: 0x22c55e,
      linewidth: 2
    });

    // 建立行人狀態標記 (小八面體幾何)
    const markerGeom = new THREE.OctahedronGeometry(0.2, 0);
    const markerMat = new THREE.MeshBasicMaterial();
    this.markerMesh = new THREE.InstancedMesh(markerGeom, markerMat, CONFIG.PEDESTRIAN.MAX_COUNT);
    this.markerMesh.frustumCulled = false;
    markerGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 100000);
    this.markerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markerColors = new Float32Array(CONFIG.PEDESTRIAN.MAX_COUNT * 3);
    this.markerMesh.instanceColor = new THREE.InstancedBufferAttribute(this.markerColors, 3);
    this.markerMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < CONFIG.PEDESTRIAN.MAX_COUNT; i++) {
      this.markerMesh.setMatrixAt(i, this.zeroMatrix);
    }
    this.markerMesh.instanceMatrix.needsUpdate = true;
    this.group.add(this.markerMesh);

    // 建立行人目標導向線 (最多 MAX_COUNT 條線，每條 2 頂點 * 3 座標)
    const targetGeom = new THREE.BufferGeometry();
    this.targetLinesPositions = new Float32Array(CONFIG.PEDESTRIAN.MAX_COUNT * 2 * 3);
    targetGeom.setAttribute('position', new THREE.BufferAttribute(this.targetLinesPositions, 3));
    const targetMat = new THREE.LineBasicMaterial({ color: 0x38bdf8 });
    this.targetLinesMesh = new THREE.LineSegments(targetGeom, targetMat);
    this.group.add(this.targetLinesMesh);

    scene.add(this.group);
  }

  public setNetwork(data: PedestrianNetworkData): void {
    this.networkData = data;
    this.rebuildNetworkLines();
  }

  private rebuildNetworkLines(): void {
    if (!this.networkData) return;

    // 清理舊線段
    if (this.normalEdgesMesh) {
      this.group.remove(this.normalEdgesMesh);
      this.normalEdgesMesh.geometry.dispose();
      (this.normalEdgesMesh.material as THREE.Material).dispose();
      this.normalEdgesMesh = null;
    }
    if (this.arcadeEdgesMesh) {
      this.group.remove(this.arcadeEdgesMesh);
      this.arcadeEdgesMesh.geometry.dispose();
      (this.arcadeEdgesMesh.material as THREE.Material).dispose();
      this.arcadeEdgesMesh = null;
    }
    if (this.crosswalkEdgesMesh) {
      this.group.remove(this.crosswalkEdgesMesh);
      this.crosswalkEdgesMesh.geometry.dispose();
      this.crosswalkEdgesMesh = null;
    }

    const normalCoords: number[] = [];
    const arcadeCoords: number[] = [];
    const crosswalkCoords: number[] = [];

    const nodes = this.networkData.nodes;

    for (const node of nodes) {
      for (const edge of node.edges) {
        if (edge.target >= nodes.length) continue;
        const targetNode = nodes[edge.target];

        // 稍微浮空 0.25m，避免與路面產生 Z-fighting
        const yOffset = 0.25;

        if (edge.isCrosswalk) {
          crosswalkCoords.push(node.x, yOffset + 0.05, node.z, targetNode.x, yOffset + 0.05, targetNode.z);
        } else if (edge.type === 'arcade') {
          arcadeCoords.push(node.x, yOffset, node.z, targetNode.x, yOffset, targetNode.z);
        } else {
          normalCoords.push(node.x, yOffset, node.z, targetNode.x, yOffset, targetNode.z);
        }
      }
    }

    // 一般人行道路網 (青藍色)
    if (normalCoords.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(normalCoords, 3));
      const m = new THREE.LineBasicMaterial({ color: 0x06b6d4, opacity: 0.85, transparent: true });
      this.normalEdgesMesh = new THREE.LineSegments(g, m);
      this.group.add(this.normalEdgesMesh);
    }

    // 騎樓路網 (暖黃色)
    if (arcadeCoords.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arcadeCoords, 3));
      const m = new THREE.LineBasicMaterial({ color: 0xf59e0b, opacity: 0.9, transparent: true });
      this.arcadeEdgesMesh = new THREE.LineSegments(g, m);
      this.group.add(this.arcadeEdgesMesh);
    }

    // 過街斑馬線 (綠燈/紅燈動態變色)
    if (crosswalkCoords.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(crosswalkCoords, 3));
      this.crosswalkEdgesMesh = new THREE.LineSegments(g, this.crosswalkMaterial);
      this.group.add(this.crosswalkEdgesMesh);
    }
  }

  public update(agents: PedestrianAgent[], isCrosswalkGreen: boolean): void {
    if (!this.isVisible) return;

    // 1. 更新過街邊顏色 (綠燈 0x22c55e, 紅燈 0xef4444)
    if (this.crosswalkEdgesMesh) {
      this.crosswalkMaterial.color.setHex(isCrosswalkGreen ? 0x22c55e : 0xef4444);
    }

    // 2. 更新行人頭頂狀態標記與目標導向線
    const posArr = this.targetLinesPositions;
    let lineIdx = 0;

    const stateColors: Record<PedestrianState, [number, number, number]> = {
      [PedestrianState.WALKING]: [0.13, 0.77, 0.37],         // 綠
      [PedestrianState.IDLE]: [0.92, 0.70, 0.03],            // 黃
      [PedestrianState.WAITING_CROSSWALK]: [0.98, 0.45, 0.09],// 橙
      [PedestrianState.CROSSING]: [0.23, 0.51, 0.96],         // 藍
      [PedestrianState.EVADING]: [0.66, 0.33, 0.97],          // 紫
      [PedestrianState.PANIC]: [0.94, 0.27, 0.27],           // 紅
      [PedestrianState.HAILING_TAXI]: [0.98, 0.80, 0.08],    // 亮黃 (招手叫計程車)
      [PedestrianState.KNOCKED_FLYING]: [1.0, 0.2, 0.2],     // 撞飛紅
      [PedestrianState.FALLEN]: [0.85, 0.1, 0.1],            // 倒地深紅
      [PedestrianState.GETTING_UP]: [0.98, 0.60, 0.1],       // 起身橙黃
      [PedestrianState.LEAVING_ROAD]: [0.2, 0.85, 1.0]       // 脫困亮青
    };

    const nodes = this.networkData?.nodes || [];

    for (let i = 0; i < CONFIG.PEDESTRIAN.MAX_COUNT; i++) {
      const agent = agents[i];
      if (!agent || !agent.active || agent.insideBuildingTimer > 0) {
        this.markerMesh.setMatrixAt(i, this.zeroMatrix);
        continue;
      }

      // 頭頂立體標記 (y + 1.95m)，若為違規者以放大且亮橘色醒目標註
      this.dummyObj.position.set(agent.x, agent.y + 1.95, agent.z);
      this.dummyObj.rotation.set(0, agent.rotationY, 0);
      if (agent.isViolator) {
        this.dummyObj.scale.set(1.8, 1.8, 1.8);
      } else {
        this.dummyObj.scale.set(1, 1, 1);
      }
      this.dummyObj.updateMatrix();
      this.markerMesh.setMatrixAt(i, this.dummyObj.matrix);

      const c = agent.isViolator ? [1.0, 0.45, 0.0] : (stateColors[agent.state] || [1, 1, 1]);
      this.markerColors[i * 3] = c[0];
      this.markerColors[i * 3 + 1] = c[1];
      this.markerColors[i * 3 + 2] = c[2];

      // 目標導向線 (一般節點或脫困目標點)
      if (agent.state === PedestrianState.LEAVING_ROAD && agent.escapeTargetPoint) {
        const base = lineIdx * 6;
        posArr[base] = agent.x;
        posArr[base + 1] = agent.y + 0.3;
        posArr[base + 2] = agent.z;
        posArr[base + 3] = agent.escapeTargetPoint.x;
        posArr[base + 4] = 0.3;
        posArr[base + 5] = agent.escapeTargetPoint.z;
        lineIdx++;
      } else if (agent.targetNodeId >= 0 && agent.targetNodeId < nodes.length) {
        const tn = nodes[agent.targetNodeId];
        const base = lineIdx * 6;
        posArr[base] = agent.x;
        posArr[base + 1] = agent.y + 0.3;
        posArr[base + 2] = agent.z;
        posArr[base + 3] = tn.x;
        posArr[base + 4] = 0.3;
        posArr[base + 5] = tn.z;
        lineIdx++;
      }
    }

    // 歸零剩餘線段
    for (let j = lineIdx * 6; j < posArr.length; j++) {
      posArr[j] = 0;
    }

    this.markerMesh.instanceMatrix.needsUpdate = true;
    if (this.markerMesh.instanceColor) {
      this.markerMesh.instanceColor.needsUpdate = true;
    }
    this.targetLinesMesh.geometry.attributes.position.needsUpdate = true;
  }

  public toggle(): boolean {
    this.isVisible = !this.isVisible;
    this.group.visible = this.isVisible;
    console.log(`[PedestrianDebugVisualizer] 行人除錯視覺化 (F8): ${this.isVisible ? '開啟' : '關閉'}`);
    return this.isVisible;
  }

  public getIsVisible(): boolean {
    return this.isVisible;
  }

  public dispose(): void {
    this.group.parent?.remove(this.group);
    if (this.normalEdgesMesh) this.normalEdgesMesh.geometry.dispose();
    if (this.arcadeEdgesMesh) this.arcadeEdgesMesh.geometry.dispose();
    if (this.crosswalkEdgesMesh) this.crosswalkEdgesMesh.geometry.dispose();
    this.markerMesh.geometry.dispose();
    this.targetLinesMesh.geometry.dispose();
  }
}
