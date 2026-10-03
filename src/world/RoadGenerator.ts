/**
 * RoadGenerator.ts - 道路、立體人行道、路緣石與路面標線（中央虛線/雙黃線、斑馬線）生成器
 * 依道路等級寬度產生車道瀝青、路面標線與高低差路緣石
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { Point2D, RoadFeature } from '../geo/OsmTypes.ts';

export class RoadGenerator {
  private roadMesh: THREE.Mesh | null = null;
  private sidewalkMesh: THREE.Mesh | null = null;
  private markingsMesh: THREE.Mesh | null = null;

  public generate(roads: RoadFeature[], scene: THREE.Scene): void {
    this.dispose(scene);

    if (roads.length === 0) return;

    // 1. 車道幾何緩衝
    const roadPos: number[] = [];
    const roadNorm: number[] = [];
    const roadIdx: number[] = [];
    let roadOffset = 0;

    // 2. 人行道與立體路緣石幾何緩衝 (使用頂點色彩區分人行道頂部與路緣石側壁)
    const sidePos: number[] = [];
    const sideNorm: number[] = [];
    const sideColors: number[] = [];
    const sideIdx: number[] = [];
    let sideOffset = 0;

    // 3. 車道標線幾何緩衝 (中央雙黃線/虛線、交會處斑馬線)
    const markPos: number[] = [];
    const markNorm: number[] = [];
    const markColors: number[] = [];
    const markIdx: number[] = [];
    let markOffset = 0;

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
          sideIdx.push(
            sideOffset, sideOffset + 1, sideOffset + 2,
            sideOffset, sideOffset + 2, sideOffset + 3
          );
          sideOffset += 4;

          // 4. 右側路緣石垂直立面 (從 roadY 上升至 sideY)
          sidePos.push(
            rR1x, roadY, rR1z,
            rR2x, roadY, rR2z,
            rR2x, sideY, rR2z,
            rR1x, sideY, rR1z
          );
          for (let k = 0; k < 4; k++) {
            sideNorm.push(-nx, 0, -nz);
            sideColors.push(curbColor.r, curbColor.g, curbColor.b);
          }
          sideIdx.push(
            sideOffset, sideOffset + 1, sideOffset + 2,
            sideOffset, sideOffset + 2, sideOffset + 3
          );
          sideOffset += 4;
        }

        // --- C. 車道中央標線 (Markings) ---
        if (road.width >= 5.0) {
          if (isWide) {
            // 寬路：中央雙黃實線 (各寬 0.15m，間距 0.2m)
            const gap = 0.1;
            const lineW = 0.15;
            this.appendSolidLine(p1, p2, nx, nz, markY, gap, lineW, yellowColor, markPos, markNorm, markColors, markIdx, () => markOffset, (v) => markOffset = v);
            this.appendSolidLine(p1, p2, nx, nz, markY, -gap - lineW, lineW, yellowColor, markPos, markNorm, markColors, markIdx, () => markOffset, (v) => markOffset = v);
          } else {
            // 中等路寬：白色中央虛線 (每段 3m 實線, 3m 間隔)
            this.appendDashedLine(p1, ux, uz, nx, nz, len, markY, 0.18, whiteColor, markPos, markNorm, markColors, markIdx, () => markOffset, (v) => markOffset = v);
          }
        }

        // --- D. 路口斑馬線 (Crosswalks) ---
        // 在長度足夠的道路起點與終點放置路口行人斑馬線
        if (road.width >= 5.5 && len >= 25) {
          if (i === 0) {
            // 起點端斑馬線
            const cwCenter = { x: p1.x + ux * 4.0, z: p1.z + uz * 4.0 };
            this.appendZebraCrossing(cwCenter, ux, uz, nx, nz, halfW - 0.3, markY, whiteColor, markPos, markNorm, markColors, markIdx, () => markOffset, (v) => markOffset = v);
          }
          if (i === pts.length - 2) {
            // 終點端斑馬線
            const cwCenter = { x: p2.x - ux * 4.0, z: p2.z - uz * 4.0 };
            this.appendZebraCrossing(cwCenter, ux, uz, nx, nz, halfW - 0.3, markY, whiteColor, markPos, markNorm, markColors, markIdx, () => markOffset, (v) => markOffset = v);
          }
        }

        // --- E. 折點轉角接合補丁 ---
        if (i < pts.length - 2) {
          this.appendJointPatch(p2, halfW, roadY, roadPos, roadNorm, roadIdx, () => roadOffset, (v) => roadOffset = v);
        }
      }
    }

    // 建立車道 Mesh
    if (roadPos.length > 0) {
      const roadGeo = new THREE.BufferGeometry();
      roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(roadPos, 3));
      roadGeo.setAttribute('normal', new THREE.Float32BufferAttribute(roadNorm, 3));
      roadGeo.setIndex(roadIdx);

      const roadMat = new THREE.MeshStandardMaterial({
        color: CONFIG.ROADS.ROAD_COLOR,
        roughness: 0.9,
        metalness: 0.1
      });

      this.roadMesh = new THREE.Mesh(roadGeo, roadMat);
      this.roadMesh.receiveShadow = true;
      this.roadMesh.name = 'RoadsMesh';
      scene.add(this.roadMesh);
    }

    // 建立人行道與路緣石 Mesh
    if (sidePos.length > 0) {
      const sideGeo = new THREE.BufferGeometry();
      sideGeo.setAttribute('position', new THREE.Float32BufferAttribute(sidePos, 3));
      sideGeo.setAttribute('normal', new THREE.Float32BufferAttribute(sideNorm, 3));
      sideGeo.setAttribute('color', new THREE.Float32BufferAttribute(sideColors, 3));
      sideGeo.setIndex(sideIdx);

      const sideMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.85,
        metalness: 0.05
      });

      this.sidewalkMesh = new THREE.Mesh(sideGeo, sideMat);
      this.sidewalkMesh.receiveShadow = true;
      this.sidewalkMesh.name = 'SidewalkMesh';
      scene.add(this.sidewalkMesh);
    }

    // 建立路面標線 Mesh
    if (markPos.length > 0) {
      const markGeo = new THREE.BufferGeometry();
      markGeo.setAttribute('position', new THREE.Float32BufferAttribute(markPos, 3));
      markGeo.setAttribute('normal', new THREE.Float32BufferAttribute(markNorm, 3));
      markGeo.setAttribute('color', new THREE.Float32BufferAttribute(markColors, 3));
      markGeo.setIndex(markIdx);

      const markMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.7,
        metalness: 0.1
      });

      this.markingsMesh = new THREE.Mesh(markGeo, markMat);
      this.markingsMesh.receiveShadow = true;
      this.markingsMesh.name = 'MarkingsMesh';
      scene.add(this.markingsMesh);
    }
  }

  private appendSolidLine(
    p1: Point2D,
    p2: Point2D,
    nx: number,
    nz: number,
    y: number,
    offsetNorm: number,
    width: number,
    color: THREE.Color,
    pos: number[],
    norm: number[],
    col: number[],
    idx: number[],
    getOffset: () => number,
    setOffset: (v: number) => void
  ): void {
    const oX = nx * offsetNorm;
    const oZ = nz * offsetNorm;
    const wX = nx * width;
    const wZ = nz * width;

    const vOffset = getOffset();
    pos.push(
      p1.x + oX, y, p1.z + oZ,
      p1.x + oX + wX, y, p1.z + oZ + wZ,
      p2.x + oX + wX, y, p2.z + oZ + wZ,
      p2.x + oX, y, p2.z + oZ
    );
    for (let k = 0; k < 4; k++) {
      norm.push(0, 1, 0);
      col.push(color.r, color.g, color.b);
    }
    idx.push(
      vOffset, vOffset + 1, vOffset + 2,
      vOffset, vOffset + 2, vOffset + 3
    );
    setOffset(vOffset + 4);
  }

  private appendDashedLine(
    p1: Point2D,
    ux: number,
    uz: number,
    nx: number,
    nz: number,
    totalLen: number,
    y: number,
    width: number,
    color: THREE.Color,
    pos: number[],
    norm: number[],
    col: number[],
    idx: number[],
    getOffset: () => number,
    setOffset: (v: number) => void
  ): void {
    const dashLen = 3.2;
    const gapLen = 2.8;
    const period = dashLen + gapLen;
    const hw = width * 0.5;

    let d = 1.0;
    while (d + dashLen < totalLen - 1.0) {
      const spX = p1.x + ux * d;
      const spZ = p1.z + uz * d;
      const epX = p1.x + ux * (d + dashLen);
      const epZ = p1.z + uz * (d + dashLen);

      const vOffset = getOffset();
      pos.push(
        spX - nx * hw, y, spZ - nz * hw,
        spX + nx * hw, y, spZ + nz * hw,
        epX + nx * hw, y, epZ + nz * hw,
        epX - nx * hw, y, epZ - nz * hw
      );
      for (let k = 0; k < 4; k++) {
        norm.push(0, 1, 0);
        col.push(color.r, color.g, color.b);
      }
      idx.push(
        vOffset, vOffset + 1, vOffset + 2,
        vOffset, vOffset + 2, vOffset + 3
      );
      setOffset(vOffset + 4);

      d += period;
    }
  }

  private appendZebraCrossing(
    center: Point2D,
    ux: number,
    uz: number,
    nx: number,
    nz: number,
    roadHalfW: number,
    y: number,
    color: THREE.Color,
    pos: number[],
    norm: number[],
    col: number[],
    idx: number[],
    getOffset: () => number,
    setOffset: (v: number) => void
  ): void {
    const barWidth = 0.45; // 斑馬線每條白槓寬度
    const barGap = 0.45;
    const barLength = 2.8; // 斑馬線沿路前進方向長度
    const halfLen = barLength * 0.5;

    let offset = -roadHalfW + 0.6;
    while (offset + barWidth <= roadHalfW - 0.6) {
      // 白槓中心在橫向 offset
      const cx = center.x + nx * (offset + barWidth * 0.5);
      const cz = center.z + nz * (offset + barWidth * 0.5);

      const p1x = cx - ux * halfLen - nx * (barWidth * 0.5);
      const p1z = cz - uz * halfLen - nz * (barWidth * 0.5);
      const p2x = cx - ux * halfLen + nx * (barWidth * 0.5);
      const p2z = cz - uz * halfLen + nz * (barWidth * 0.5);
      const p3x = cx + ux * halfLen + nx * (barWidth * 0.5);
      const p3z = cz + uz * halfLen + nz * (barWidth * 0.5);
      const p4x = cx + ux * halfLen - nx * (barWidth * 0.5);
      const p4z = cz + uz * halfLen - nz * (barWidth * 0.5);

      const vOffset = getOffset();
      pos.push(
        p1x, y, p1z,
        p2x, y, p2z,
        p3x, y, p3z,
        p4x, y, p4z
      );
      for (let k = 0; k < 4; k++) {
        norm.push(0, 1, 0);
        col.push(color.r, color.g, color.b);
      }
      idx.push(
        vOffset, vOffset + 1, vOffset + 2,
        vOffset, vOffset + 2, vOffset + 3
      );
      setOffset(vOffset + 4);

      offset += barWidth + barGap;
    }
  }

  private appendJointPatch(
    center: Point2D,
    halfW: number,
    roadY: number,
    roadPos: number[],
    roadNorm: number[],
    roadIdx: number[],
    getRoadOffset: () => number,
    setRoadOffset: (v: number) => void
  ): void {
    const segments = 6;
    const centerRoadIdx = getRoadOffset();
    roadPos.push(center.x, roadY, center.z);
    roadNorm.push(0, 1, 0);

    for (let s = 0; s <= segments; s++) {
      const angle = (s / segments) * Math.PI * 2;
      roadPos.push(center.x + Math.cos(angle) * halfW, roadY, center.z + Math.sin(angle) * halfW);
      roadNorm.push(0, 1, 0);
    }

    for (let s = 1; s <= segments; s++) {
      roadIdx.push(centerRoadIdx, centerRoadIdx + s, centerRoadIdx + s + 1);
    }
    setRoadOffset(getRoadOffset() + segments + 2);
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
  }
}
