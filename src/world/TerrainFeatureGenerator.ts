/**
 * TerrainFeatureGenerator.ts - 水域與綠地多邊形 3D 幾何網格生成器
 * 依自然地貌類別產生不同高程與材質之低多邊形色塊
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PolygonFeature } from '../geo/OsmTypes.ts';

export class TerrainFeatureGenerator {
  private waterMesh: THREE.Mesh | null = null;
  private greenMesh: THREE.Mesh | null = null;

  public generate(features: PolygonFeature[], scene: THREE.Scene): void {
    this.dispose(scene);

    if (features.length === 0) return;

    const waterPositions: number[] = [];
    const waterNormals: number[] = [];
    const waterIndices: number[] = [];
    let waterOffset = 0;

    const greenPositions: number[] = [];
    const greenNormals: number[] = [];
    const greenColors: number[] = [];
    const greenIndices: number[] = [];
    let greenOffset = 0;

    const waterY = CONFIG.FEATURES.WATER_ELEVATION;
    const greenY = CONFIG.FEATURES.GREEN_ELEVATION;

    const parkColor = new THREE.Color(CONFIG.FEATURES.GREEN_COLOR);
    const forestColor = new THREE.Color(CONFIG.FEATURES.FOREST_COLOR);

    for (const feat of features) {
      const poly = feat.polygon;
      if (poly.length < 3) continue;

      try {
        const v2List = poly.map((p) => new THREE.Vector2(p.x, p.z));
        const triangles = THREE.ShapeUtils.triangulateShape(v2List, []);
        if (!triangles || triangles.length === 0) continue;

        if (feat.kind === 'water') {
          const start = waterOffset;
          for (const p of poly) {
            waterPositions.push(p.x, waterY, p.z);
            waterNormals.push(0, 1, 0);
            waterOffset++;
          }
          for (const tri of triangles) {
            waterIndices.push(start + tri[0], start + tri[2], start + tri[1]);
          }
        } else {
          // green or forest
          const c = feat.kind === 'forest' ? forestColor : parkColor;
          const start = greenOffset;
          for (const p of poly) {
            greenPositions.push(p.x, greenY, p.z);
            greenNormals.push(0, 1, 0);
            greenColors.push(c.r, c.g, c.b);
            greenOffset++;
          }
          for (const tri of triangles) {
            greenIndices.push(start + tri[0], start + tri[2], start + tri[1]);
          }
        }
      } catch (err) {
        // 忽略自交異常多邊形
      }
    }

    // 建立水體 Mesh
    if (waterPositions.length > 0) {
      const waterGeo = new THREE.BufferGeometry();
      waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(waterPositions, 3));
      waterGeo.setAttribute('normal', new THREE.Float32BufferAttribute(waterNormals, 3));
      waterGeo.setIndex(waterIndices);

      const waterMat = new THREE.MeshStandardMaterial({
        color: CONFIG.FEATURES.WATER_COLOR,
        roughness: 0.2,
        metalness: 0.1,
        transparent: true,
        opacity: 0.92
      });

      this.waterMesh = new THREE.Mesh(waterGeo, waterMat);
      this.waterMesh.receiveShadow = true;
      this.waterMesh.name = 'WaterMesh';
      scene.add(this.waterMesh);
    }

    // 建立綠地 Mesh
    if (greenPositions.length > 0) {
      const greenGeo = new THREE.BufferGeometry();
      greenGeo.setAttribute('position', new THREE.Float32BufferAttribute(greenPositions, 3));
      greenGeo.setAttribute('normal', new THREE.Float32BufferAttribute(greenNormals, 3));
      greenGeo.setAttribute('color', new THREE.Float32BufferAttribute(greenColors, 3));
      greenGeo.setIndex(greenIndices);

      const greenMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.05
      });

      this.greenMesh = new THREE.Mesh(greenGeo, greenMat);
      this.greenMesh.receiveShadow = true;
      this.greenMesh.name = 'GreenMesh';
      scene.add(this.greenMesh);
    }
  }

  public dispose(scene: THREE.Scene): void {
    if (this.waterMesh) {
      scene.remove(this.waterMesh);
      this.waterMesh.geometry.dispose();
      (this.waterMesh.material as THREE.Material).dispose();
      this.waterMesh = null;
    }
    if (this.greenMesh) {
      scene.remove(this.greenMesh);
      this.greenMesh.geometry.dispose();
      (this.greenMesh.material as THREE.Material).dispose();
      this.greenMesh = null;
    }
  }
}
