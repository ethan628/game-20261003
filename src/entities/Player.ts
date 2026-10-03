/**
 * Player.ts - 玩家實體控制器
 * 管理運動物理（走/跑/跳/重力）、視角相對方向轉向、建築碰撞滑移及動作呈現
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { InputManager } from '../core/InputManager.ts';
import { CollisionSystem } from '../systems/CollisionSystem.ts';
import { BuildingCollisionData } from '../world/BuildingGenerator.ts';
import { CharacterRig } from './CharacterRig.ts';

export class Player {
  public position = new THREE.Vector3(0, 0, 0);
  public velocity = new THREE.Vector3(0, 0, 0);

  private rig: CharacterRig;
  private input: InputManager;
  private collisionSystem: CollisionSystem;

  private isGrounded = true;
  private facingAngle = 0;

  // 飛行狀態
  private isFlying = false;
  private flightStartX = 0;
  private flightStartY = 0;
  private flightStartZ = 0;
  private flightTargetX = 0;
  private flightTargetZ = 0;
  private flightApexY = 0;
  private flightProgress = 0;
  private flightDuration = 1.0;
  private onFlightComplete?: () => void;

  constructor(scene: THREE.Scene, input: InputManager, collisionSystem: CollisionSystem) {
    this.input = input;
    this.collisionSystem = collisionSystem;
    this.rig = new CharacterRig();
    scene.add(this.rig.group);
  }

  /**
   * 固定時間步長物理邏輯更新
   */
  public update(fixedDelta: number, cameraYaw: number, colliders: BuildingCollisionData[]): void {
    // 0. 若處於飛行前往狀態，執行高空弧形拋物線飛行邏輯
    if (this.isFlying) {
      this.flightProgress += fixedDelta / this.flightDuration;
      const t = Math.min(1.0, this.flightProgress);

      // 平滑 Ease-in-out Cubic
      const easeT = t * t * (3 - 2 * t);

      this.position.x = this.flightStartX + (this.flightTargetX - this.flightStartX) * easeT;
      this.position.z = this.flightStartZ + (this.flightTargetZ - this.flightStartZ) * easeT;

      // 弧形高空飛越 (sin 曲線頂點高度)
      const arc = Math.sin(t * Math.PI);
      this.position.y = (1 - easeT) * this.flightStartY + arc * this.flightApexY;

      // 朝向飛行前進向量
      const dx = this.flightTargetX - this.flightStartX;
      const dz = this.flightTargetZ - this.flightStartZ;
      if (Math.hypot(dx, dz) > 0.1) {
        this.facingAngle = Math.atan2(dx, dz);
        this.rig.setRotationY(this.facingAngle);
      }

      this.rig.setPosition(this.position);
      this.rig.setFlying(true);

      if (t >= 1.0) {
        this.isFlying = false;
        this.position.x = this.flightTargetX;
        this.position.z = this.flightTargetZ;
        this.position.y = 0;
        this.velocity.set(0, 0, 0);
        this.isGrounded = true;
        this.rig.setFlying(false);

        // 著陸防穿牆保護
        this.collisionSystem.resolvePlayerBuildingCollision(
          this.position,
          colliders,
          CONFIG.PLAYER.COLLISION_RADIUS
        );
        this.rig.setPosition(this.position);

        const cb = this.onFlightComplete;
        this.onFlightComplete = undefined;
        cb?.();
      }
      return;
    }

    // 1. 根據相機 Yaw 計算目前視角之「前向」與「右向」地面向量
    const forwardX = -Math.sin(cameraYaw);
    const forwardZ = -Math.cos(cameraYaw);
    const rightX = Math.cos(cameraYaw);
    const rightZ = -Math.sin(cameraYaw);

    // 2. 彙整鍵盤輸入方向
    let moveX = 0;
    let moveZ = 0;

    if (this.input.isForward()) {
      moveX += forwardX;
      moveZ += forwardZ;
    }
    if (this.input.isBackward()) {
      moveX -= forwardX;
      moveZ -= forwardZ;
    }
    if (this.input.isLeft()) {
      moveX -= rightX;
      moveZ -= rightZ;
    }
    if (this.input.isRight()) {
      moveX += rightX;
      moveZ += rightZ;
    }

    const inputLen = Math.hypot(moveX, moveZ);
    let currentSpeed = 0;

    if (inputLen > 0.001) {
      moveX /= inputLen;
      moveZ /= inputLen;

      const isSprint = this.input.isSprint();
      currentSpeed = isSprint ? CONFIG.PLAYER.RUN_SPEED : CONFIG.PLAYER.WALK_SPEED;

      this.velocity.x = moveX * currentSpeed;
      this.velocity.z = moveZ * currentSpeed;

      // 3. 角色平滑旋轉朝向移動方向
      const targetAngle = Math.atan2(moveX, moveZ);
      let diff = targetAngle - this.facingAngle;

      // 正規化角度差至 [-PI, PI] 避免 360 度倒轉
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;

      this.facingAngle += diff * Math.min(1.0, fixedDelta * CONFIG.PLAYER.ROTATION_SPEED);
    } else {
      // 漸進減速
      this.velocity.x *= 0.7;
      this.velocity.z *= 0.7;
      if (Math.abs(this.velocity.x) < 0.05) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 0.05) this.velocity.z = 0;
      currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    }

    // 4. 跳躍與重力模擬
    if (this.isGrounded && this.input.isJump()) {
      this.velocity.y = CONFIG.PLAYER.JUMP_VELOCITY;
      this.isGrounded = false;
    }

    if (!this.isGrounded) {
      this.velocity.y -= CONFIG.PLAYER.GRAVITY * fixedDelta;
    }

    // 5. 更新位置座標
    this.position.x += this.velocity.x * fixedDelta;
    this.position.z += this.velocity.z * fixedDelta;
    this.position.y += this.velocity.y * fixedDelta;

    // 6. 地面碰撞檢測
    if (this.position.y <= 0) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.isGrounded = true;
    }

    // 7. 建築物幾何碰撞檢測與滑移
    this.collisionSystem.resolvePlayerBuildingCollision(
      this.position,
      colliders,
      CONFIG.PLAYER.COLLISION_RADIUS
    );

    // 8. 更新角色模型位置、朝向與跑步動畫
    this.rig.setPosition(this.position);
    this.rig.setRotationY(this.facingAngle);
    this.rig.updateAnimation(currentSpeed, this.isGrounded, fixedDelta);
  }

  public teleport(x: number, y: number, z: number): void {
    this.isFlying = false;
    this.rig.setFlying(false);
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.isGrounded = true;
    this.rig.setPosition(this.position);
  }

  /**
   * 飛躍前往指定目標 (x, z) 座標
   */
  public flyTo(targetX: number, targetZ: number, onComplete?: () => void): void {
    const dx = targetX - this.position.x;
    const dz = targetZ - this.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 4) {
      this.teleport(targetX, 0, targetZ);
      onComplete?.();
      return;
    }

    this.isFlying = true;
    this.flightStartX = this.position.x;
    this.flightStartY = Math.max(0, this.position.y);
    this.flightStartZ = this.position.z;
    this.flightTargetX = targetX;
    this.flightTargetZ = targetZ;

    // 動態根據距離決定飛行時長 (0.8s ~ 1.8s) 與飛行頂點高度 (16m ~ 65m)
    this.flightDuration = Math.min(1.8, Math.max(0.8, 0.5 + dist * 0.0016));
    this.flightApexY = Math.min(65, Math.max(16, 12 + dist * 0.05));
    this.flightProgress = 0;
    this.onFlightComplete = onComplete;

    this.facingAngle = Math.atan2(dx, dz);
    this.rig.setRotationY(this.facingAngle);
    this.rig.setFlying(true);
  }

  public getIsFlying(): boolean {
    return this.isFlying;
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.rig.group);
  }
}
