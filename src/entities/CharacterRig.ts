/**
 * CharacterRig.ts - 低多邊形方塊人形實體骨架與程序化骨骼動作
 * 採用經典 Box Man 結構，包含頭部、軀幹、四肢關節與跑步擺動動畫
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';

export class CharacterRig {
  public group: THREE.Group;

  private headGroup: THREE.Group;
  private torsoMesh: THREE.Mesh;
  private leftArmPivot: THREE.Group;
  private rightArmPivot: THREE.Group;
  private leftLegPivot: THREE.Group;
  private rightLegPivot: THREE.Group;

  private walkPhase = 0;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'CharacterRig';

    // 共享材質
    const skinMat = new THREE.MeshStandardMaterial({
      color: CONFIG.PLAYER.COLORS.SKIN,
      roughness: 0.7
    });
    const shirtMat = new THREE.MeshStandardMaterial({
      color: CONFIG.PLAYER.COLORS.SHIRT,
      roughness: 0.7
    });
    const pantsMat = new THREE.MeshStandardMaterial({
      color: CONFIG.PLAYER.COLORS.PANTS,
      roughness: 0.8
    });
    const hairMat = new THREE.MeshStandardMaterial({
      color: CONFIG.PLAYER.COLORS.HAIR,
      roughness: 0.9
    });
    const glassesMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      roughness: 0.2,
      metalness: 0.8
    });

    // 1. 軀幹 (Torso)
    const torsoGeo = new THREE.BoxGeometry(0.46, 0.65, 0.28);
    this.torsoMesh = new THREE.Mesh(torsoGeo, shirtMat);
    this.torsoMesh.position.set(0, 0.95, 0);
    this.torsoMesh.castShadow = true;
    this.torsoMesh.receiveShadow = true;
    this.group.add(this.torsoMesh);

    // 2. 頭部群組 (Head & Hair & Sunglasses)
    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 1.45, 0);

    const headGeo = new THREE.BoxGeometry(0.36, 0.36, 0.36);
    const headMesh = new THREE.Mesh(headGeo, skinMat);
    headMesh.castShadow = true;
    this.headGroup.add(headMesh);

    // 頭髮 (頂部)
    const hairGeo = new THREE.BoxGeometry(0.38, 0.12, 0.38);
    const hairMesh = new THREE.Mesh(hairGeo, hairMat);
    hairMesh.position.set(0, 0.16, 0);
    hairMesh.castShadow = true;
    this.headGroup.add(hairMesh);

    // 墨鏡 (正面 +Z 方向，辨別朝向)
    const glassesGeo = new THREE.BoxGeometry(0.32, 0.08, 0.06);
    const glassesMesh = new THREE.Mesh(glassesGeo, glassesMat);
    glassesMesh.position.set(0, 0.04, 0.19);
    this.headGroup.add(glassesMesh);

    this.group.add(this.headGroup);

    // 3. 左手臂 (以肩關節為旋轉中心)
    this.leftArmPivot = new THREE.Group();
    this.leftArmPivot.position.set(-0.32, 1.22, 0);
    const armGeo = new THREE.BoxGeometry(0.16, 0.58, 0.18);
    armGeo.translate(0, -0.25, 0); // 將幾何體重心移至肩部下方
    const leftArmMesh = new THREE.Mesh(armGeo, shirtMat);
    leftArmMesh.castShadow = true;
    this.leftArmPivot.add(leftArmMesh);
    this.group.add(this.leftArmPivot);

    // 4. 右手臂
    this.rightArmPivot = new THREE.Group();
    this.rightArmPivot.position.set(0.32, 1.22, 0);
    const rightArmMesh = new THREE.Mesh(armGeo, shirtMat);
    rightArmMesh.castShadow = true;
    this.rightArmPivot.add(rightArmMesh);
    this.group.add(this.rightArmPivot);

    // 5. 左腿 (以髖關節為旋轉中心)
    this.leftLegPivot = new THREE.Group();
    this.leftLegPivot.position.set(-0.13, 0.65, 0);
    const legGeo = new THREE.BoxGeometry(0.18, 0.65, 0.22);
    legGeo.translate(0, -0.3, 0);
    const leftLegMesh = new THREE.Mesh(legGeo, pantsMat);
    leftLegMesh.castShadow = true;
    this.leftLegPivot.add(leftLegMesh);
    this.group.add(this.leftLegPivot);

    // 6. 右腿
    this.rightLegPivot = new THREE.Group();
    this.rightLegPivot.position.set(0.13, 0.65, 0);
    const rightLegMesh = new THREE.Mesh(legGeo, pantsMat);
    rightLegMesh.castShadow = true;
    this.rightLegPivot.add(rightLegMesh);
    this.group.add(this.rightLegPivot);
  }

  public updateAnimation(speed: number, isGrounded: boolean, delta: number): void {
    if (!isGrounded) {
      // 空中跳躍姿勢：雙臂略向上抬，腿微彎
      this.leftArmPivot.rotation.x = THREE.MathUtils.lerp(this.leftArmPivot.rotation.x, -1.1, 0.2);
      this.rightArmPivot.rotation.x = THREE.MathUtils.lerp(this.rightArmPivot.rotation.x, -1.1, 0.2);
      this.leftLegPivot.rotation.x = THREE.MathUtils.lerp(this.leftLegPivot.rotation.x, 0.4, 0.2);
      this.rightLegPivot.rotation.x = THREE.MathUtils.lerp(this.rightLegPivot.rotation.x, -0.3, 0.2);
      return;
    }

    if (speed > 0.1) {
      // 跑步或行走動畫
      const frequency = speed > 7.0 ? 16 : 10;
      this.walkPhase += delta * frequency;

      const armAmplitude = speed > 7.0 ? 0.9 : 0.6;
      const legAmplitude = speed > 7.0 ? 0.85 : 0.55;

      const swing = Math.sin(this.walkPhase);
      this.leftArmPivot.rotation.x = swing * armAmplitude;
      this.rightArmPivot.rotation.x = -swing * armAmplitude;

      this.leftLegPivot.rotation.x = -swing * legAmplitude;
      this.rightLegPivot.rotation.x = swing * legAmplitude;

      // 跑步時身體輕微上下起伏
      this.torsoMesh.position.y = 0.95 + Math.abs(Math.sin(this.walkPhase * 2)) * 0.04;
      this.headGroup.position.y = 1.45 + Math.abs(Math.sin(this.walkPhase * 2)) * 0.04;
    } else {
      // 靜止站立：平滑回復原位，呼吸輕微微動
      this.walkPhase += delta * 2;
      this.leftArmPivot.rotation.x = THREE.MathUtils.lerp(this.leftArmPivot.rotation.x, 0, 0.15);
      this.rightArmPivot.rotation.x = THREE.MathUtils.lerp(this.rightArmPivot.rotation.x, 0, 0.15);
      this.leftLegPivot.rotation.x = THREE.MathUtils.lerp(this.leftLegPivot.rotation.x, 0, 0.15);
      this.rightLegPivot.rotation.x = THREE.MathUtils.lerp(this.rightLegPivot.rotation.x, 0, 0.15);

      this.torsoMesh.position.y = 0.95 + Math.sin(this.walkPhase) * 0.01;
      this.headGroup.position.y = 1.45 + Math.sin(this.walkPhase) * 0.01;
    }
  }

  public setPosition(pos: THREE.Vector3): void {
    this.group.position.copy(pos);
  }

  public setRotationY(angle: number): void {
    this.group.rotation.y = angle;
  }

  /**
   * 設定飛行姿勢（超人破風傾角與手臂後拉）
   */
  public setFlying(isFlying: boolean): void {
    if (isFlying) {
      this.group.rotation.x = 0.52; // 身體前傾破風
      this.leftArmPivot.rotation.x = -1.3; // 雙臂向後流線擺動
      this.rightArmPivot.rotation.x = -1.3;
      this.leftLegPivot.rotation.x = 0.25;
      this.rightLegPivot.rotation.x = 0.25;
    } else {
      this.group.rotation.x = 0;
    }
  }
}
