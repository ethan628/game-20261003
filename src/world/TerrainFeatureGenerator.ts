/**
 * TerrainFeatureGenerator.ts - 水域與綠地多邊形 3D 幾何網格生成器
 * 依自然地貌類別產生不同高程與材質之低多邊形色塊
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PolygonFeature } from '../geo/OsmTypes.ts';
import { LightmapShaderHook } from './lightmap/LightmapShaderHook.ts';

export class TerrainFeatureGenerator {
  private waterMesh: THREE.Mesh | null = null;
  private greenMesh: THREE.Mesh | null = null;
  private waterMaterial: THREE.MeshStandardMaterial | null = null;
  private greenMaterial: THREE.MeshStandardMaterial | null = null;
  public nightFactor = 0.0;
  public groundVisibility = 1.0;

  private injectNightGroundShader(mat: THREE.MeshStandardMaterial, _boostRate = 0.095): void {
    mat.onBeforeCompile = (shader) => {
      LightmapShaderHook.bindUniforms(shader);
      shader.vertexShader = LightmapShaderHook.injectVertexShader(shader.vertexShader);
      shader.fragmentShader = LightmapShaderHook.injectGroundFragmentShader(shader.fragmentShader);
      (mat as any).customShader = shader;
    };
  }

  public setNightFactor(factor: number): void {
    this.nightFactor = factor;
    if (this.waterMaterial?.userData.nightUniforms) {
      this.waterMaterial.userData.nightUniforms.uNightFactor.value = factor;
    }
    if (this.greenMaterial?.userData.nightUniforms) {
      this.greenMaterial.userData.nightUniforms.uNightFactor.value = factor;
    }
  }

  public setGroundVisibility(val: number): void {
    this.groundVisibility = val;
    if (this.waterMaterial?.userData.nightUniforms) {
      this.waterMaterial.userData.nightUniforms.uGroundVisibility.value = val;
    }
    if (this.greenMaterial?.userData.nightUniforms) {
      this.greenMaterial.userData.nightUniforms.uGroundVisibility.value = val;
    }
  }

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

      this.waterMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.FEATURES.WATER_COLOR,
        roughness: 0.2,
        metalness: 0.1,
        transparent: true,
        opacity: 0.92
      });
      this.injectNightGroundShader(this.waterMaterial);

      this.waterMesh = new THREE.Mesh(waterGeo, this.waterMaterial);
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

      this.greenMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.9,
        metalness: 0.05
      });
      this.injectNightGroundShader(this.greenMaterial);

      this.greenMesh = new THREE.Mesh(greenGeo, this.greenMaterial);
      this.greenMesh.receiveShadow = true;
      this.greenMesh.name = 'GreenMesh';
      scene.add(this.greenMesh);
    }
  }

  public getWaterMesh(): THREE.Mesh | null {
    return this.waterMesh;
  }

  public getGreenMesh(): THREE.Mesh | null {
    return this.greenMesh;
  }

  public dispose(scene: THREE.Scene): void {
    if (this.waterMesh) {
      scene.remove(this.waterMesh);
      this.waterMesh.geometry.dispose();
      (this.waterMesh.material as THREE.Material).dispose();
      this.waterMesh = null;
      this.waterMaterial = null;
    }
    if (this.greenMesh) {
      scene.remove(this.greenMesh);
      this.greenMesh.geometry.dispose();
      (this.greenMesh.material as THREE.Material).dispose();
      this.greenMesh = null;
      this.greenMaterial = null;
    }
  }
}
