/**
 * PropGenerator.ts - 街道環境裝飾物生成器（低多邊形行道樹、路燈）
 * 全數採用 InstancedMesh 實例化渲染，維持 60+ FPS 極致效能 (總共僅佔 2 Draw Calls)
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { RoadFeature } from '../geo/OsmTypes.ts';

export class PropGenerator {
  private treesMesh: THREE.InstancedMesh | null = null;
  private lampsMesh: THREE.InstancedMesh | null = null;

  public generate(roads: RoadFeature[], scene: THREE.Scene): void {
    this.dispose(scene);

    if (!CONFIG.PROPS.ENABLED || roads.length === 0) return;

    const treeTransforms: THREE.Matrix4[] = [];
    const lampTransforms: THREE.Matrix4[] = [];

    const dummy = new THREE.Object3D();
    const sideY = CONFIG.ROADS.ELEVATION.SIDEWALK;

    const treeSpacing = CONFIG.PROPS.TREE_SPACING;
    const lampSpacing = CONFIG.PROPS.LAMP_SPACING;

    for (const road of roads) {
      // 僅在具備人行道之車道兩側種植行道樹與設立路燈
      if (road.sidewalkWidth < 0.8 || road.width < 4.0) continue;

      const pts = road.points;
      const halfW = road.width * 0.5;
      const sW = road.sidewalkWidth;
      const treeOffset = halfW + sW * 0.65; // 置於人行道靠外側
      const lampOffset = halfW + sW * 0.25; // 置於人行道路緣側

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 12.0) continue;

        const ux = dx / len;
        const uz = dz / len;
        const nx = -uz;
        const nz = ux;
        const roadAngle = Math.atan2(dx, dz);

        // 沿線段布置行道樹 (左右兩側交錯)
        let treeD = 8.0;
        while (treeD < len - 6.0 && treeTransforms.length < 2500) {
          // 左側樹木
          const lx = p1.x + ux * treeD - nx * treeOffset;
          const lz = p1.z + uz * treeD - nz * treeOffset;
          dummy.position.set(lx, sideY, lz);
          dummy.rotation.set(0, (treeD * 17) % (Math.PI * 2), 0);
          const s = 0.85 + ((treeD * 7) % 30) / 100.0;
          dummy.scale.set(s, s, s);
          dummy.updateMatrix();
          treeTransforms.push(dummy.matrix.clone());

          // 右側樹木 (間距錯開半格)
          const rightD = treeD + treeSpacing * 0.5;
          if (rightD < len - 6.0) {
            const rx = p1.x + ux * rightD + nx * treeOffset;
            const rz = p1.z + uz * rightD + nz * treeOffset;
            dummy.position.set(rx, sideY, rz);
            dummy.rotation.set(0, (rightD * 19) % (Math.PI * 2), 0);
            const rs = 0.85 + ((rightD * 9) % 30) / 100.0;
            dummy.scale.set(rs, rs, rs);
            dummy.updateMatrix();
            treeTransforms.push(dummy.matrix.clone());
          }

          treeD += treeSpacing;
        }

        // 沿線段布置路燈
        let lampD = 14.0;
        while (lampD < len - 8.0 && lampTransforms.length < 1500) {
          // 右側路燈 (燈臂朝向路心)
          const rx = p1.x + ux * lampD + nx * lampOffset;
          const rz = p1.z + uz * lampD + nz * lampOffset;
          dummy.position.set(rx, sideY, rz);
          // 旋轉使燈臂朝向路中央 (roadAngle - PI/2)
          dummy.rotation.set(0, roadAngle - Math.PI / 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          lampTransforms.push(dummy.matrix.clone());

          lampD += lampSpacing;
        }
      }
    }

    // --- 1. 建立低多邊形行道樹 InstancedMesh ---
    if (treeTransforms.length > 0) {
      const treeGeo = this.buildLowPolyTreeGeometry();
      const treeMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.88,
        metalness: 0.08
      });

      this.treesMesh = new THREE.InstancedMesh(treeGeo, treeMat, treeTransforms.length);
      this.treesMesh.name = 'StreetTrees';
      this.treesMesh.castShadow = true;
      this.treesMesh.receiveShadow = true;

      for (let i = 0; i < treeTransforms.length; i++) {
        this.treesMesh.setMatrixAt(i, treeTransforms[i]);
      }
      this.treesMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.treesMesh);
    }

    // --- 2. 建立低多邊形路燈 InstancedMesh ---
    if (lampTransforms.length > 0) {
      const lampGeo = this.buildLowPolyLampGeometry();
      const lampMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.45,
        metalness: 0.7
      });

      this.lampsMesh = new THREE.InstancedMesh(lampGeo, lampMat, lampTransforms.length);
      this.lampsMesh.name = 'StreetLamps';
      this.lampsMesh.castShadow = true;
      this.lampsMesh.receiveShadow = true;

      for (let i = 0; i < lampTransforms.length; i++) {
        this.lampsMesh.setMatrixAt(i, lampTransforms[i]);
      }
      this.lampsMesh.instanceMatrix.needsUpdate = true;
      scene.add(this.lampsMesh);
    }
  }

  /**
   * 組合低多邊形行道樹幾何體：樹幹 + 雙層立體樹冠 (帶頂點色彩)
   */
  private buildLowPolyTreeGeometry(): THREE.BufferGeometry {
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.26, 2.0, 6);
    trunkGeo.translate(0, 1.0, 0);

    const foliage1Geo = new THREE.ConeGeometry(1.6, 2.4, 7);
    foliage1Geo.translate(0, 2.8, 0);

    const foliage2Geo = new THREE.ConeGeometry(1.2, 2.0, 6);
    foliage2Geo.translate(0, 4.0, 0);

    // 著色頂點
    const trunkColor = new THREE.Color(CONFIG.PROPS.TREE_TRUNK_COLOR);
    const foliageColor1 = new THREE.Color(CONFIG.PROPS.TREE_FOLIAGE_COLORS[0]);
    const foliageColor2 = new THREE.Color(CONFIG.PROPS.TREE_FOLIAGE_COLORS[1]);

    const trunkCols = this.createColorArray(trunkGeo.attributes.position.count, trunkColor);
    const fol1Cols = this.createColorArray(foliage1Geo.attributes.position.count, foliageColor1);
    const fol2Cols = this.createColorArray(foliage2Geo.attributes.position.count, foliageColor2);

    trunkGeo.setAttribute('color', new THREE.Float32BufferAttribute(trunkCols, 3));
    foliage1Geo.setAttribute('color', new THREE.Float32BufferAttribute(fol1Cols, 3));
    foliage2Geo.setAttribute('color', new THREE.Float32BufferAttribute(fol2Cols, 3));

    return this.mergeGeometries([trunkGeo, foliage1Geo, foliage2Geo]);
  }

  /**
   * 組合低多邊形路燈幾何體：金屬細柱 + 懸臂橫桿 + 微光燈罩
   */
  private buildLowPolyLampGeometry(): THREE.BufferGeometry {
    // 主立柱
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 4.4, 6);
    poleGeo.translate(0, 2.2, 0);

    // 懸臂橫桿 (延伸 1.2m)
    const armGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.2, 5);
    armGeo.rotateZ(Math.PI / 2);
    armGeo.translate(0.6, 4.3, 0);

    // 燈罩
    const lampHeadGeo = new THREE.BoxGeometry(0.3, 0.15, 0.22);
    lampHeadGeo.translate(1.15, 4.2, 0);

    const metalColor = new THREE.Color(CONFIG.PROPS.LAMP_POLE_COLOR);
    const glowColor = new THREE.Color(CONFIG.PROPS.LAMP_LIGHT_COLOR);

    const poleCols = this.createColorArray(poleGeo.attributes.position.count, metalColor);
    const armCols = this.createColorArray(armGeo.attributes.position.count, metalColor);
    const headCols = this.createColorArray(lampHeadGeo.attributes.position.count, glowColor);

    poleGeo.setAttribute('color', new THREE.Float32BufferAttribute(poleCols, 3));
    armGeo.setAttribute('color', new THREE.Float32BufferAttribute(armCols, 3));
    lampHeadGeo.setAttribute('color', new THREE.Float32BufferAttribute(headCols, 3));

    return this.mergeGeometries([poleGeo, armGeo, lampHeadGeo]);
  }

  private createColorArray(count: number, color: THREE.Color): number[] {
    const arr: number[] = [];
    for (let i = 0; i < count; i++) {
      arr.push(color.r, color.g, color.b);
    }
    return arr;
  }

  private mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    let offset = 0;

    for (const g of geos) {
      const pos = g.attributes.position.array;
      const col = g.attributes.color.array;
      g.computeVertexNormals();
      const norm = g.attributes.normal.array;

      for (let i = 0; i < pos.length; i++) positions.push(pos[i]);
      for (let i = 0; i < norm.length; i++) normals.push(norm[i]);
      for (let i = 0; i < col.length; i++) colors.push(col[i]);

      if (g.index) {
        const idx = g.index.array;
        for (let i = 0; i < idx.length; i++) indices.push(offset + idx[i]);
      } else {
        const count = g.attributes.position.count;
        for (let i = 0; i < count; i++) indices.push(offset + i);
      }
      offset += g.attributes.position.count;
      g.dispose();
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    merged.setIndex(indices);
    return merged;
  }

  public dispose(scene: THREE.Scene): void {
    if (this.treesMesh) {
      scene.remove(this.treesMesh);
      this.treesMesh.geometry.dispose();
      (this.treesMesh.material as THREE.Material).dispose();
      this.treesMesh = null;
    }
    if (this.lampsMesh) {
      scene.remove(this.lampsMesh);
      this.lampsMesh.geometry.dispose();
      (this.lampsMesh.material as THREE.Material).dispose();
      this.lampsMesh = null;
    }
  }
}
