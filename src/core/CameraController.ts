/**
 * CameraController.ts - 第三人稱環繞軌道相機、防穿牆射線檢測與平滑跟隨
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { InputManager } from './InputManager.ts';
import { CollisionSystem } from '../systems/CollisionSystem.ts';

export class CameraController {
  private camera: THREE.PerspectiveCamera;
  private input: InputManager;
  private collisionSystem: CollisionSystem;

  private yaw = 0;   // 水平旋轉角 (弧度)
  private pitch = CONFIG.CAMERA.DEFAULT_PITCH; // 預設仰角約 28 度，提供開闊街景視野
  private targetDistance = CONFIG.CAMERA.DEFAULT_DISTANCE;
  private currentDistance = CONFIG.CAMERA.DEFAULT_DISTANCE;

  private rawLookTarget = new THREE.Vector3();
  private smoothLookTarget = new THREE.Vector3();
  private desiredPos = new THREE.Vector3();
  private smoothPos = new THREE.Vector3();
  private rayOrigin = new THREE.Vector3();
  private rayDir = new THREE.Vector3();
  private isInitialized = false;

  constructor(camera: THREE.PerspectiveCamera, input: InputManager, collisionSystem: CollisionSystem) {
    this.camera = camera;
    this.input = input;
    this.collisionSystem = collisionSystem;
  }

  public update(playerPos: THREE.Vector3, buildingsMesh: THREE.Mesh | null, fixedDelta: number = 1 / 60): void {
    const mouse = this.input.consumeMouseDelta();

    // 1. 根據滑鼠移動計算 Yaw 與 Pitch
    this.yaw -= mouse.dx * CONFIG.CAMERA.MOUSE_SENSITIVITY;
    this.pitch -= mouse.dy * CONFIG.CAMERA.MOUSE_SENSITIVITY;

    // 限制俯仰角度防反轉
    this.pitch = Math.max(CONFIG.CAMERA.PITCH_MIN, Math.min(CONFIG.CAMERA.PITCH_MAX, this.pitch));

    // 滾輪縮放目標距離
    if (mouse.wheel !== 0) {
      this.targetDistance += mouse.wheel * CONFIG.CAMERA.ZOOM_SPEED;
      this.targetDistance = Math.max(
        CONFIG.CAMERA.MIN_DISTANCE,
        Math.min(CONFIG.CAMERA.MAX_DISTANCE, this.targetDistance)
      );
    }

    // 平滑插值鏡頭縮放距離
    this.currentDistance += (this.targetDistance - this.currentDistance) * 0.15;

    // 2. 計算目標焦點（角色焦點高度約 1.5m）並加入平滑插值
    this.rawLookTarget.copy(playerPos);
    this.rawLookTarget.y += CONFIG.CAMERA.TARGET_HEIGHT;

    if (!this.isInitialized) {
      this.smoothLookTarget.copy(this.rawLookTarget);
      this.isInitialized = true;
    } else {
      const lerpFactor = Math.min(1.0, fixedDelta * CONFIG.CAMERA.LERP_SPEED);
      this.smoothLookTarget.lerp(this.rawLookTarget, lerpFactor);
    }

    // 3. 計算球面座標方向向量
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);

    this.rayDir.set(
      sinYaw * cosPitch,
      sinPitch,
      cosYaw * cosPitch
    ).normalize();

    this.rayOrigin.copy(this.smoothLookTarget);

    // 4. 防穿牆射線檢測 (Raycasting)
    const actualDist = this.collisionSystem.getCameraOcclusionDistance(
      this.rayOrigin,
      this.rayDir,
      this.currentDistance,
      buildingsMesh
    );

    // 5. 更新相機最終世界座標
    this.desiredPos.copy(this.smoothLookTarget).addScaledVector(this.rayDir, actualDist);

    // 確保相機不穿透至地面下方 (保持至少高於地面 0.4m)
    if (this.desiredPos.y < 0.4) {
      this.desiredPos.y = 0.4;
    }

    // 6. 相機位置輕微平滑跟隨
    if (this.smoothPos.lengthSq() < 0.001) {
      this.smoothPos.copy(this.desiredPos);
    } else {
      // 遇防穿牆時迅速收縮防穿透，平時平滑跟隨
      const isCloser = actualDist < this.currentDistance - 0.2;
      const posLerp = isCloser ? 0.35 : Math.min(1.0, fixedDelta * (CONFIG.CAMERA.LERP_SPEED + 2));
      this.smoothPos.lerp(this.desiredPos, posLerp);
    }

    this.camera.position.copy(this.smoothPos);
    this.camera.lookAt(this.smoothLookTarget);
  }

  /**
   * 重設鏡頭位置與朝向
   */
  public reset(yaw: number = 0, pitch: number = CONFIG.CAMERA.DEFAULT_PITCH): void {
    this.yaw = yaw;
    this.pitch = pitch;
    this.currentDistance = CONFIG.CAMERA.DEFAULT_DISTANCE;
    this.targetDistance = CONFIG.CAMERA.DEFAULT_DISTANCE;
    this.isInitialized = false;
    this.smoothPos.set(0, 0, 0);
  }

  public getYaw(): number {
    return this.yaw;
  }

  public setYaw(yaw: number): void {
    this.yaw = yaw;
  }

  public setViewPreset(preset: 'street' | 'aerial'): void {
    if (preset === 'aerial') {
      this.pitch = 50 * (Math.PI / 180);
      this.targetDistance = 48.0;
      this.currentDistance = 48.0;
    } else {
      this.pitch = 24 * (Math.PI / 180);
      this.targetDistance = CONFIG.CAMERA.DEFAULT_DISTANCE;
      this.currentDistance = CONFIG.CAMERA.DEFAULT_DISTANCE;
    }
    this.isInitialized = false;
  }
}
