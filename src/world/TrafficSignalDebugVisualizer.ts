/**
 * TrafficSignalDebugVisualizer.ts - 交通號誌 F9 除錯視覺化工具
 * 顯示路口邊界圓環、資料來源配色 (綠=OSM, 橘=Auto)、Approach 方向箭頭、停止線
 * 以及每個號誌路口中心 20 公尺高彩色光柱 (綠色=OSM, 橘色=Auto)
 */

import * as THREE from 'three';
import { IntersectionFeature, Point2D } from '../geo/OsmTypes.ts';
import { TrafficSignalSystem } from '../systems/traffic-signals/TrafficSignalSystem.ts';

export class TrafficSignalDebugVisualizer {
  private group: THREE.Group;
  private isVisible: boolean = false;
  private lineMesh: THREE.LineSegments | null = null;
  private pillarMesh: THREE.Mesh | null = null;
  private intersections: IntersectionFeature[] = [];

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'TrafficSignalDebugGroup';
    this.group.visible = false;
    scene.add(this.group);
  }

  public setIntersections(intersections: IntersectionFeature[]): void {
    this.intersections = intersections;
    this.buildGeometry();
  }

  public toggle(): boolean {
    this.isVisible = !this.isVisible;
    this.group.visible = this.isVisible;
    return this.isVisible;
  }

  public getVisible(): boolean {
    return this.isVisible;
  }

  private buildGeometry(): void {
    if (this.lineMesh) {
      this.group.remove(this.lineMesh);
      this.lineMesh.geometry.dispose();
      (this.lineMesh.material as THREE.Material).dispose();
      this.lineMesh = null;
    }
    if (this.pillarMesh) {
      this.group.remove(this.pillarMesh);
      this.pillarMesh.geometry.dispose();
      (this.pillarMesh.material as THREE.Material).dispose();
      this.pillarMesh = null;
    }

    const posList: number[] = [];
    const colList: number[] = [];

    // 光柱網格幾何陣列
    const pillarPositions: number[] = [];
    const pillarColors: number[] = [];

    const addCircle = (center: Point2D, radius: number, r: number, g: number, b: number) => {
      const segs = 32;
      const y = 0.25;
      for (let i = 0; i < segs; i++) {
        const a1 = (i / segs) * Math.PI * 2;
        const a2 = ((i + 1) / segs) * Math.PI * 2;
        posList.push(
          center.x + Math.cos(a1) * radius, y, center.z + Math.sin(a1) * radius,
          center.x + Math.cos(a2) * radius, y, center.z + Math.sin(a2) * radius
        );
        colList.push(r, g, b, r, g, b);
      }
    };

    const addArrow = (start: Point2D, dirRad: number, len: number, r: number, g: number, b: number) => {
      const y = 0.35;
      const endX = start.x + Math.sin(dirRad) * len;
      const endZ = start.z + Math.cos(dirRad) * len;

      // 主線段
      posList.push(start.x, y, start.z, endX, y, endZ);
      colList.push(r, g, b, r, g, b);

      // 箭頭翼
      const wingLen = len * 0.3;
      const w1Angle = dirRad + Math.PI * 0.85;
      const w2Angle = dirRad - Math.PI * 0.85;

      posList.push(endX, y, endZ, endX + Math.sin(w1Angle) * wingLen, y, endZ + Math.cos(w1Angle) * wingLen);
      colList.push(r, g, b, r, g, b);

      posList.push(endX, y, endZ, endX + Math.sin(w2Angle) * wingLen, y, endZ + Math.cos(w2Angle) * wingLen);
      colList.push(r, g, b, r, g, b);
    };

    // 建立單根 20 公尺半透明光柱幾何
    const addPillarMesh = (cx: number, cz: number, rCol: number, gCol: number, bCol: number) => {
      const segs = 12;
      const rTop = 0.45;
      const rBot = 0.85;
      const h = 20.0;

      for (let i = 0; i < segs; i++) {
        const a1 = (i / segs) * Math.PI * 2;
        const a2 = ((i + 1) / segs) * Math.PI * 2;

        const x1B = cx + Math.cos(a1) * rBot;
        const z1B = cz + Math.sin(a1) * rBot;
        const x2B = cx + Math.cos(a2) * rBot;
        const z2B = cz + Math.sin(a2) * rBot;

        const x1T = cx + Math.cos(a1) * rTop;
        const z1T = cz + Math.sin(a1) * rTop;
        const x2T = cx + Math.cos(a2) * rTop;
        const z2T = cz + Math.sin(a2) * rTop;

        // Quad 1
        pillarPositions.push(
          x1B, 0.2, z1B,
          x2B, 0.2, z2B,
          x2T, h, z2T,

          x1B, 0.2, z1B,
          x2T, h, z2T,
          x1T, h, z1T
        );

        for (let k = 0; k < 6; k++) {
          pillarColors.push(rCol, gCol, bCol);
        }
      }
    };

    for (const inter of this.intersections) {
      if (!inter.hasSignals) continue;

      // 綠色 = OSM 實測號誌, 橘色 = 自動推算補齊
      const isOsm = inter.source === 'osm';
      const r = isOsm ? 0.08 : 0.98;
      const g = isOsm ? 0.95 : 0.48;
      const b = isOsm ? 0.42 : 0.08;

      // 1. 路口中心 20 公尺高彩色光柱
      addPillarMesh(inter.center.x, inter.center.z, r, g, b);

      // 光柱中央核心垂直線與頂部十字符號 (加強遠距離極細像素識別)
      posList.push(inter.center.x, 0.2, inter.center.z, inter.center.x, 20.0, inter.center.z);
      colList.push(r, g, b, r, g, b);

      posList.push(inter.center.x - 1.2, 20.0, inter.center.z, inter.center.x + 1.2, 20.0, inter.center.z);
      colList.push(r, g, b, r, g, b);
      posList.push(inter.center.x, 20.0, inter.center.z - 1.2, inter.center.x, 20.0, inter.center.z + 1.2);
      colList.push(r, g, b, r, g, b);

      // 2. 路口外圍圓環
      addCircle(inter.center, inter.radius, r, g, b);

      // 3. 各 approach 方向箭頭 (指向路口核心)
      for (const app of inter.approaches) {
        addArrow(app.entryPoint, app.azimuthRad, 4.5, r, g, b);

        // 停止線白線
        posList.push(app.stopLineP1.x, 0.28, app.stopLineP1.z, app.stopLineP2.x, 0.28, app.stopLineP2.z);
        colList.push(1, 1, 1, 1, 1, 1);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(posList, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colList, 3));

    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      linewidth: 2,
      depthTest: true
    });

    this.lineMesh = new THREE.LineSegments(geom, mat);
    this.group.add(this.lineMesh);

    // 建立光柱半透明實體網格
    if (pillarPositions.length > 0) {
      const pGeom = new THREE.BufferGeometry();
      pGeom.setAttribute('position', new THREE.Float32BufferAttribute(pillarPositions, 3));
      pGeom.setAttribute('color', new THREE.Float32BufferAttribute(pillarColors, 3));

      const pMat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false
      });

      this.pillarMesh = new THREE.Mesh(pGeom, pMat);
      this.group.add(this.pillarMesh);
    }
  }

  public update(_system: TrafficSignalSystem): void {
    // 保持活動
  }
}
