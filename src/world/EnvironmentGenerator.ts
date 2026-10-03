/**
 * EnvironmentGenerator.ts - 基礎世界環境生成
 * 包括漸層半球天空穹頂、地平線霧氣融合、玩家動態跟隨陰影方向光與半球環境光
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';

export class EnvironmentGenerator {
  private groundMesh: THREE.Mesh | null = null;
  private skyDome: THREE.Mesh | null = null;
  private dirLight: THREE.DirectionalLight | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;

  /**
   * 設定場景的漸層天空、遠景霧氣與動態光照
   */
  public setupSceneEnvironment(scene: THREE.Scene): void {
    // 1. 漸層天空穹頂 (頂部深藍 -> 中層藍 -> 地平線淡藍暖白)
    if (!this.skyDome) {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 512;
      const ctx = canvas.getContext('2d')!;

      const grad = ctx.createLinearGradient(0, 0, 0, 512);
      grad.addColorStop(0.0, CONFIG.WORLD.SKY_GRADIENT.TOP);
      grad.addColorStop(0.45, CONFIG.WORLD.SKY_GRADIENT.MIDDLE);
      grad.addColorStop(1.0, CONFIG.WORLD.SKY_GRADIENT.HORIZON);

      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 2, 512);

      const skyTex = new THREE.CanvasTexture(canvas);
      skyTex.colorSpace = THREE.SRGBColorSpace;
      skyTex.wrapS = THREE.ClampToEdgeWrapping;
      skyTex.wrapT = THREE.ClampToEdgeWrapping;

      const skyGeo = new THREE.SphereGeometry(950, 32, 24);
      const skyMat = new THREE.MeshBasicMaterial({
        map: skyTex,
        side: THREE.BackSide,
        depthWrite: false
      });

      this.skyDome = new THREE.Mesh(skyGeo, skyMat);
      this.skyDome.name = 'SkyDome';
      scene.add(this.skyDome);
    }

    // 2. 地平線霧氣（顏色與天空穹頂地平線 100% 一致，自然淡出遠景邊界）
    scene.fog = new THREE.Fog(
      CONFIG.WORLD.FOG_COLOR,
      CONFIG.WORLD.FOG_NEAR,
      CONFIG.WORLD.FOG_FAR
    );

    // 3. 半球環境光（模擬天光與地面次表面反射）
    if (!this.hemiLight) {
      this.hemiLight = new THREE.HemisphereLight(
        CONFIG.WORLD.HEMI_SKY_COLOR,
        CONFIG.WORLD.HEMI_GROUND_COLOR,
        CONFIG.WORLD.HEMI_INTENSITY
      );
      this.hemiLight.position.set(0, 100, 0);
      scene.add(this.hemiLight);
    }

    // 4. 主太陽方向光（柔和暖白，高解析度陰影貼圖，跟隨玩家）
    if (!this.dirLight) {
      this.dirLight = new THREE.DirectionalLight(
        CONFIG.WORLD.SUN_COLOR,
        CONFIG.WORLD.SUN_INTENSITY
      );
      this.dirLight.position.set(80, 140, 65);
      this.dirLight.castShadow = true;

      // 設定陰影相機視野範圍覆蓋玩家周邊
      const d = CONFIG.WORLD.SHADOW_CAMERA_RADIUS;
      this.dirLight.shadow.camera.left = -d;
      this.dirLight.shadow.camera.right = d;
      this.dirLight.shadow.camera.top = d;
      this.dirLight.shadow.camera.bottom = -d;
      this.dirLight.shadow.camera.near = 30;
      this.dirLight.shadow.camera.far = 400;
      this.dirLight.shadow.bias = -0.0003;

      this.dirLight.shadow.mapSize.width = CONFIG.WORLD.SHADOW_MAP_SIZE;
      this.dirLight.shadow.mapSize.height = CONFIG.WORLD.SHADOW_MAP_SIZE;

      scene.add(this.dirLight);
      scene.add(this.dirLight.target);
    }

    // 5. 基礎大地平面網格
    if (!this.groundMesh) {
      const groundGeo = new THREE.PlaneGeometry(
        CONFIG.WORLD.GROUND_SIZE,
        CONFIG.WORLD.GROUND_SIZE,
        1,
        1
      );
      groundGeo.rotateX(-Math.PI / 2);

      const groundMat = new THREE.MeshStandardMaterial({
        color: CONFIG.WORLD.GROUND_COLOR,
        roughness: 0.95,
        metalness: 0.05
      });

      this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
      this.groundMesh.name = 'GroundBase';
      this.groundMesh.receiveShadow = true;
      scene.add(this.groundMesh);
    }
  }

  /**
   * 每幀更新：太陽光與陰影正交投影盒跟隨玩家移動
   */
  public update(playerPos: THREE.Vector3): void {
    if (this.dirLight) {
      this.dirLight.position.set(
        playerPos.x + 80,
        playerPos.y + 140,
        playerPos.z + 65
      );
      this.dirLight.target.position.copy(playerPos);
      this.dirLight.target.updateMatrixWorld();
    }
    if (this.skyDome) {
      this.skyDome.position.set(playerPos.x, 0, playerPos.z);
    }
  }

  public dispose(scene: THREE.Scene): void {
    if (this.skyDome) {
      scene.remove(this.skyDome);
      this.skyDome.geometry.dispose();
      (this.skyDome.material as THREE.Material).dispose();
      this.skyDome = null;
    }
    if (this.groundMesh) {
      scene.remove(this.groundMesh);
      this.groundMesh.geometry.dispose();
      (this.groundMesh.material as THREE.Material).dispose();
      this.groundMesh = null;
    }
    if (this.dirLight) {
      scene.remove(this.dirLight);
      this.dirLight.dispose();
      this.dirLight = null;
    }
    if (this.hemiLight) {
      scene.remove(this.hemiLight);
      this.hemiLight.dispose();
      this.hemiLight = null;
    }
  }
}
