/**
 * NavigationGuide3D.ts - 3D 世界地面導航引導線系統
 * 沿導航路線於地面繪製發光引導線與方向箭頭，具備高效能批次渲染與流動動效
 */

import * as THREE from 'three';
import { Point2D } from '../geo/OsmTypes.ts';
import { CONFIG } from '../config.ts';

export class NavigationGuide3D {
  private group: THREE.Group;
  private ribbonMesh: THREE.Mesh | null = null;
  private chevronInstancedMesh: THREE.InstancedMesh | null = null;
  private ribbonMaterial: THREE.MeshBasicMaterial;
  private chevronMaterial: THREE.MeshBasicMaterial;
  private scene: THREE.Scene;
  private isVisible = true;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'NavigationGuide3D';
    this.scene.add(this.group);

    // 發光導航路徑帶材質 (亮青色半透明)
    this.ribbonMaterial = new THREE.MeshBasicMaterial({
      color: CONFIG.NAVIGATION.GUIDE_LINE_COLOR,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 方向箭頭材質 (亮白青色)
    this.chevronMaterial = new THREE.MeshBasicMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthWrite: false
    });
  }

  /**
   * 設定導航路線並生成地面 3D 引導幾何
   */
  public setRoute(points: Point2D[]): void {
    this.clear();

    if (!CONFIG.NAVIGATION.SHOW_3D_GUIDE_LINE || points.length < 2) {
      return;
    }

    const yHeight = CONFIG.NAVIGATION.GUIDE_LINE_HEIGHT; // 離地高度約 0.15m
    const ribbonHalfWidth = 0.35; // 帶寬 0.7 公尺

    // 1. 建立地面平滑發光色帶 (Ribbon Quad-strip)
    const vertices: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let nx = 0;
      let nz = 0;

      if (i === 0) {
        const next = points[1];
        const dx = next.x - p.x;
        const dz = next.z - p.z;
        const len = Math.hypot(dx, dz) || 1;
        nx = -dz / len;
        nz = dx / len;
      } else if (i === points.length - 1) {
        const prev = points[i - 1];
        const dx = p.x - prev.x;
        const dz = p.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        nx = -dz / len;
        nz = dx / len;
      } else {
        const prev = points[i - 1];
        const next = points[i + 1];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const len = Math.hypot(dx, dz) || 1;
        nx = -dz / len;
        nz = dx / len;
      }

      // 左頂點與右頂點
      vertices.push(p.x - nx * ribbonHalfWidth, yHeight, p.z - nz * ribbonHalfWidth);
      vertices.push(p.x + nx * ribbonHalfWidth, yHeight, p.z + nz * ribbonHalfWidth);

      if (i < points.length - 1) {
        const base = i * 2;
        // 兩個三角形構成四邊形
        indices.push(base, base + 1, base + 2);
        indices.push(base + 1, base + 3, base + 2);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    this.ribbonMesh = new THREE.Mesh(geom, this.ribbonMaterial);
    this.ribbonMesh.renderOrder = 99;
    this.group.add(this.ribbonMesh);

    // 2. 沿折線每隔 12 公尺生成一個前進方向箭頭 (InstancedMesh，效能極佳)
    const arrowPositions: { x: number; z: number; angle: number }[] = [];
    const STEP_METERS = 12;

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
      if (segLen < 1) continue;

      const angle = Math.atan2(p2.x - p1.x, p2.z - p1.z);
      const steps = Math.floor(segLen / STEP_METERS);

      for (let s = 1; s <= steps; s++) {
        const t = (s * STEP_METERS) / segLen;
        arrowPositions.push({
          x: p1.x + t * (p2.x - p1.x),
          z: p1.z + t * (p2.z - p1.z),
          angle
        });
      }
    }

    if (arrowPositions.length > 0) {
      // 箭頭平面幾何形狀 (指向前方的等腰三角形)
      const arrowGeom = new THREE.BufferGeometry();
      const hw = 0.55;
      const hl = 0.9;
      const v = new Float32Array([
        -hw, 0, -hl * 0.5,
         hw, 0, -hl * 0.5,
          0, 0,  hl * 0.5
      ]);
      arrowGeom.setAttribute('position', new THREE.BufferAttribute(v, 3));

      this.chevronInstancedMesh = new THREE.InstancedMesh(
        arrowGeom,
        this.chevronMaterial,
        arrowPositions.length
      );
      this.chevronInstancedMesh.renderOrder = 100;

      const dummy = new THREE.Object3D();
      for (let i = 0; i < arrowPositions.length; i++) {
        const item = arrowPositions[i];
        dummy.position.set(item.x, yHeight + 0.02, item.z);
        dummy.rotation.set(0, item.angle, 0);
        dummy.updateMatrix();
        this.chevronInstancedMesh.setMatrixAt(i, dummy.matrix);
      }
      this.chevronInstancedMesh.instanceMatrix.needsUpdate = true;
      this.group.add(this.chevronInstancedMesh);
    }
  }

  public setVisible(visible: boolean): void {
    this.isVisible = visible;
    this.group.visible = visible;
  }

  public getVisible(): boolean {
    return this.isVisible;
  }

  /**
   * 清除地面導航線
   */
  public clear(): void {
    if (this.ribbonMesh) {
      this.group.remove(this.ribbonMesh);
      this.ribbonMesh.geometry.dispose();
      this.ribbonMesh = null;
    }
    if (this.chevronInstancedMesh) {
      this.group.remove(this.chevronInstancedMesh);
      this.chevronInstancedMesh.geometry.dispose();
      this.chevronInstancedMesh = null;
    }
  }

  public dispose(): void {
    this.clear();
    this.ribbonMaterial.dispose();
    this.chevronMaterial.dispose();
    this.scene.remove(this.group);
  }
}
