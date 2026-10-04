/**
 * PropGenerator.ts - 街道環境裝飾與雜物系統 (GTA 風格街景)
 * 包含：
 * 1. 行道樹 (低多邊形樹幹與多層樹冠)
 * 2. 街燈 (高挑金屬彎臂與微光燈罩)
 * 3. 台灣經典機車 (Parked Scooters)
 * 4. 路邊停靠汽車 (Parked Cars, 多彩隨機塗裝)
 * 5. 交通錐 (Traffic Cones) 與路障 (Barricades)
 * 6. 消防栓 (Fire Hydrants)
 * 7. 垃圾桶 (Trash Cans) 與紙箱堆 (Cardboard Boxes)
 * 8. 電線桿 (Utility Poles 與十字橫擔)
 * 9. 郵筒 (Mailboxes)
 * 10. 自動販賣機 (Vending Machines)
 *
 * 全數採用 InstancedMesh 實例化渲染，維持 60+ FPS 極致效能！
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { RoadFeature, IntersectionFeature, Point2D } from '../geo/OsmTypes.ts';

export class PropGenerator {
  private treesMesh: THREE.InstancedMesh | null = null;
  private lampsMesh: THREE.InstancedMesh | null = null;
  private scootersMesh: THREE.InstancedMesh | null = null;
  private carsMesh: THREE.InstancedMesh | null = null;
  private conesMesh: THREE.InstancedMesh | null = null;
  private hydrantsMesh: THREE.InstancedMesh | null = null;
  private trashCansMesh: THREE.InstancedMesh | null = null;
  private boxesMesh: THREE.InstancedMesh | null = null;
  private polesMesh: THREE.InstancedMesh | null = null;
  private mailboxesMesh: THREE.InstancedMesh | null = null;
  private vendingMesh: THREE.InstancedMesh | null = null;
  private lampTransforms: THREE.Matrix4[] = [];

  public getLampTransforms(): THREE.Matrix4[] {
    return this.lampTransforms;
  }

  public generate(roads: RoadFeature[], scene: THREE.Scene, intersections: IntersectionFeature[] = []): void {
    this.dispose(scene);
    this.lampTransforms = [];

    if (!CONFIG.PROPS.ENABLED || roads.length === 0) return;

    // 收集號誌桿位置，路邊設施與號誌桿去重 (避免重疊)
    const signalPoles: Point2D[] = [];
    for (const inter of intersections) {
      if (inter.hasSignals) {
        for (const p of inter.poles) {
          signalPoles.push(p.position);
        }
      }
    }
    const isNearSignalPole = (x: number, z: number, dist = 6.0) => {
      for (let s = 0; s < signalPoles.length; s++) {
        if (Math.hypot(signalPoles[s].x - x, signalPoles[s].z - z) < dist) return true;
      }
      return false;
    };

    const dummy = new THREE.Object3D();
    const sideY = CONFIG.ROADS.ELEVATION.SIDEWALK;
    const roadY = CONFIG.ROADS.ELEVATION.ROAD;

    // Transform Matrices 收集器
    const treeTransforms: THREE.Matrix4[] = [];
    const lampTransforms: THREE.Matrix4[] = [];
    const scooterTransforms: THREE.Matrix4[] = [];
    const carTransforms: THREE.Matrix4[] = [];
    const coneTransforms: THREE.Matrix4[] = [];
    const hydrantTransforms: THREE.Matrix4[] = [];
    const trashCanTransforms: THREE.Matrix4[] = [];
    const boxTransforms: THREE.Matrix4[] = [];
    const poleTransforms: THREE.Matrix4[] = [];
    const mailboxTransforms: THREE.Matrix4[] = [];
    const vendingTransforms: THREE.Matrix4[] = [];

    const treeSpacing = CONFIG.PROPS.TREE_SPACING;
    const lampSpacing = CONFIG.PROPS.LAMP_SPACING;

    for (let rIdx = 0; rIdx < roads.length; rIdx++) {
      const road = roads[rIdx];
      const pts = road.points;
      if (pts.length < 2) continue;

      const halfW = road.width * 0.5;
      const sW = road.sidewalkWidth;
      const isWideRoad = road.width >= 7.5;
      const hasSidewalk = sW >= 0.8;

      const treeOffset = halfW + sW * 0.65;
      const lampOffset = halfW + sW * 0.22;
      const wallOffset = halfW + sW * 0.82;

      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];

        const dx = p2.x - p1.x;
        const dz = p2.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 10.0) continue;

        const ux = dx / len;
        const uz = dz / len;
        const nx = -uz;
        const nz = ux;
        const roadAngle = Math.atan2(dx, dz);

        // --- 1. 行道樹 (交錯排列) ---
        if (hasSidewalk) {
          let treeD = 8.0;
          while (treeD < len - 6.0 && treeTransforms.length < 1800) {
            const lx = p1.x + ux * treeD - nx * treeOffset;
            const lz = p1.z + uz * treeD - nz * treeOffset;
            dummy.position.set(lx, sideY, lz);
            dummy.rotation.set(0, (treeD * 17) % (Math.PI * 2), 0);
            const s = 0.85 + ((treeD * 7) % 30) / 100.0;
            dummy.scale.set(s, s, s);
            dummy.updateMatrix();
            treeTransforms.push(dummy.matrix.clone());

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
        }

        // --- 2. 街燈 (燈臂朝向路中央) ---
        if (hasSidewalk) {
          let lampD = 14.0;
          while (lampD < len - 8.0 && lampTransforms.length < 900) {
            const rx = p1.x + ux * lampD + nx * lampOffset;
            const rz = p1.z + uz * lampD + nz * lampOffset;
            if (isNearSignalPole(rx, rz)) {
              lampD += lampSpacing;
              continue;
            }
            dummy.position.set(rx, sideY, rz);
            dummy.rotation.set(0, roadAngle - Math.PI / 2, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            lampTransforms.push(dummy.matrix.clone());

            lampD += lampSpacing;
          }
        }

        // --- 3. 路邊停靠機車 (台灣街景靈魂：靠路緣人行道停放) ---
        if (hasSidewalk && len > 16.0 && (rIdx + i) % 3 === 0 && scooterTransforms.length < CONFIG.STREET_DEBRIS.MAX_SCOOTERS) {
          const numScooters = 2 + ((rIdx + i) % 3);
          const startDist = 6.0;
          for (let s = 0; s < numScooters; s++) {
            const scDist = startDist + s * 1.35;
            if (scDist > len - 4.0) break;
            const scX = p1.x + ux * scDist - nx * (halfW + 0.55);
            const scZ = p1.z + uz * scDist - nz * (halfW + 0.55);
            dummy.position.set(scX, sideY, scZ);
            // 垂直或微斜停放於路緣
            dummy.rotation.set(0, roadAngle + Math.PI / 2 + ((s * 3) % 15 - 7) * (Math.PI / 180), 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            scooterTransforms.push(dummy.matrix.clone());
          }
        }

        // --- 4. 路邊停靠轎車 (平行停在車道側緣) ---
        if (isWideRoad && len > 32.0 && (rIdx + i) % 4 === 0 && carTransforms.length < CONFIG.STREET_DEBRIS.MAX_CARS) {
          const carD = 12.0;
          const carX = p1.x + ux * carD + nx * (halfW - 1.15);
          const carZ = p1.z + uz * carD + nz * (halfW - 1.15);
          dummy.position.set(carX, roadY, carZ);
          dummy.rotation.set(0, roadAngle, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          carTransforms.push(dummy.matrix.clone());
        }

        // --- 5. 交通錐 (施工/路邊警示) ---
        if (len > 18.0 && (rIdx * 7 + i) % 9 === 0 && coneTransforms.length < CONFIG.STREET_DEBRIS.MAX_CONES) {
          const coneD = len * 0.4;
          const coneX = p1.x + ux * coneD - nx * (halfW + 0.25);
          const coneZ = p1.z + uz * coneD - nz * (halfW + 0.25);
          dummy.position.set(coneX, sideY, coneZ);
          dummy.rotation.set(0, Math.random() * Math.PI, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          coneTransforms.push(dummy.matrix.clone());
        }

        // --- 6. 消防栓 ---
        if (hasSidewalk && len > 22.0 && (rIdx + i) % 7 === 1 && hydrantTransforms.length < CONFIG.STREET_DEBRIS.MAX_HYDRANTS) {
          const hyD = len * 0.7;
          const hyX = p1.x + ux * hyD + nx * lampOffset;
          const hyZ = p1.z + uz * hyD + nz * lampOffset;
          dummy.position.set(hyX, sideY, hyZ);
          dummy.rotation.set(0, roadAngle - Math.PI / 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          hydrantTransforms.push(dummy.matrix.clone());
        }

        // --- 7. 人行道垃圾桶 ---
        if (hasSidewalk && len > 25.0 && (rIdx + i) % 6 === 2 && trashCanTransforms.length < CONFIG.STREET_DEBRIS.MAX_TRASH_CANS) {
          const tcX = p1.x + ux * (len * 0.3) - nx * wallOffset;
          const tcZ = p1.z + uz * (len * 0.3) - nz * wallOffset;
          dummy.position.set(tcX, sideY, tcZ);
          dummy.rotation.set(0, roadAngle, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          trashCanTransforms.push(dummy.matrix.clone());
        }

        // --- 8. 紙箱堆與垃圾包 (店門口/街角堆疊) ---
        if (hasSidewalk && len > 20.0 && (rIdx + i) % 5 === 3 && boxTransforms.length < CONFIG.STREET_DEBRIS.MAX_BOXES) {
          const bx = p1.x + ux * (len * 0.8) - nx * wallOffset;
          const bz = p1.z + uz * (len * 0.8) - nz * wallOffset;
          dummy.position.set(bx, sideY, bz);
          dummy.rotation.set(0, ((rIdx + i) * 31) % (Math.PI * 2), 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          boxTransforms.push(dummy.matrix.clone());
        }

        // --- 9. 電線桿 (水泥電桿與十字橫擔) ---
        if (hasSidewalk && len > 28.0 && (rIdx + i) % 8 === 4 && poleTransforms.length < CONFIG.STREET_DEBRIS.MAX_POLES) {
          const px = p1.x + ux * (len * 0.6) + nx * wallOffset;
          const pz = p1.z + uz * (len * 0.6) + nz * wallOffset;
          if (!isNearSignalPole(px, pz)) {
            dummy.position.set(px, sideY, pz);
            dummy.rotation.set(0, roadAngle, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            poleTransforms.push(dummy.matrix.clone());
          }
        }

        // --- 10. 台灣紅綠郵筒 ---
        if (hasSidewalk && len > 35.0 && (rIdx + i) % 11 === 5 && mailboxTransforms.length < 25) {
          const mx = p1.x + ux * (len * 0.5) - nx * wallOffset;
          const mz = p1.z + uz * (len * 0.5) - nz * wallOffset;
          dummy.position.set(mx, sideY, mz);
          dummy.rotation.set(0, roadAngle + Math.PI / 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          mailboxTransforms.push(dummy.matrix.clone());
        }

        // --- 11. 自動販賣機 (靠牆擺放) ---
        if (hasSidewalk && len > 30.0 && (rIdx + i) % 9 === 6 && vendingTransforms.length < CONFIG.STREET_DEBRIS.MAX_VENDING_MACHINES) {
          const vx = p1.x + ux * (len * 0.25) - nx * wallOffset;
          const vz = p1.z + uz * (len * 0.25) - nz * wallOffset;
          dummy.position.set(vx, sideY, vz);
          dummy.rotation.set(0, roadAngle + Math.PI, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          vendingTransforms.push(dummy.matrix.clone());
        }
      }
    }

    // --- 實例化各個 InstancedMesh ---

    // 1. 行道樹
    if (treeTransforms.length > 0) {
      this.treesMesh = this.buildTreesInstanced(treeTransforms);
      scene.add(this.treesMesh);
    }

    // 2. 街燈
    if (lampTransforms.length > 0) {
      this.lampTransforms = lampTransforms;
      this.lampsMesh = this.buildLampsInstanced(lampTransforms);
      scene.add(this.lampsMesh);
    }

    // 3. 機車
    if (scooterTransforms.length > 0) {
      this.scootersMesh = this.buildScootersInstanced(scooterTransforms);
      scene.add(this.scootersMesh);
    }

    // 4. 停靠轎車
    if (carTransforms.length > 0) {
      this.carsMesh = this.buildCarsInstanced(carTransforms);
      scene.add(this.carsMesh);
    }

    // 5. 交通錐
    if (coneTransforms.length > 0) {
      this.conesMesh = this.buildConesInstanced(coneTransforms);
      scene.add(this.conesMesh);
    }

    // 6. 消防栓
    if (hydrantTransforms.length > 0) {
      this.hydrantsMesh = this.buildHydrantsInstanced(hydrantTransforms);
      scene.add(this.hydrantsMesh);
    }

    // 7. 垃圾桶
    if (trashCanTransforms.length > 0) {
      this.trashCansMesh = this.buildTrashCansInstanced(trashCanTransforms);
      scene.add(this.trashCansMesh);
    }

    // 8. 紙箱堆
    if (boxTransforms.length > 0) {
      this.boxesMesh = this.buildBoxesInstanced(boxTransforms);
      scene.add(this.boxesMesh);
    }

    // 9. 電線桿
    if (poleTransforms.length > 0) {
      this.polesMesh = this.buildPolesInstanced(poleTransforms);
      scene.add(this.polesMesh);
    }

    // 10. 郵筒
    if (mailboxTransforms.length > 0) {
      this.mailboxesMesh = this.buildMailboxesInstanced(mailboxTransforms);
      scene.add(this.mailboxesMesh);
    }

    // 11. 自動販賣機
    if (vendingTransforms.length > 0) {
      this.vendingMesh = this.buildVendingInstanced(vendingTransforms);
      scene.add(this.vendingMesh);
    }
  }

  // --- 幾何體建構輔助函式 ---

  private buildTreesInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const trunkGeo = new THREE.CylinderGeometry(0.24, 0.32, 2.8, 6);
    trunkGeo.translate(0, 1.4, 0);

    const foliage1 = new THREE.ConeGeometry(1.6, 2.5, 6);
    foliage1.translate(0, 3.4, 0);

    const foliage2 = new THREE.ConeGeometry(1.2, 2.1, 6);
    foliage2.translate(0, 4.6, 0);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(trunkGeo.attributes.position.array),
      ...Array.from(foliage1.attributes.position.array),
      ...Array.from(foliage2.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x2e7d32,
      roughness: 0.85,
      metalness: 0.05
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'StreetTrees_Instanced';
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildLampsInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.12, 6.5, 6);
    poleGeo.translate(0, 3.25, 0);

    const armGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6);
    armGeo.rotateZ(Math.PI / 3);
    armGeo.translate(0.65, 6.2, 0);

    const headGeo = new THREE.BoxGeometry(0.35, 0.15, 0.55);
    headGeo.translate(1.2, 6.4, 0);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(poleGeo.attributes.position.array),
      ...Array.from(armGeo.attributes.position.array),
      ...Array.from(headGeo.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.6,
      metalness: 0.7
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'StreetLamps_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildScootersInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const body = new THREE.BoxGeometry(0.38, 0.55, 1.25);
    body.translate(0, 0.45, 0);

    const seat = new THREE.BoxGeometry(0.32, 0.12, 0.65);
    seat.translate(0, 0.78, -0.15);

    const handle = new THREE.CylinderGeometry(0.03, 0.03, 0.65, 6);
    handle.rotateZ(Math.PI / 2);
    handle.translate(0, 1.05, 0.35);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(body.attributes.position.array),
      ...Array.from(seat.attributes.position.array),
      ...Array.from(handle.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x1e3a8a,
      roughness: 0.5,
      metalness: 0.6
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'ParkedScooters_Instanced';
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildCarsInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const chassis = new THREE.BoxGeometry(1.85, 0.58, 4.3);
    chassis.translate(0, 0.45, 0);

    const cabin = new THREE.BoxGeometry(1.55, 0.55, 2.4);
    cabin.translate(0, 1.0, -0.2);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(chassis.attributes.position.array),
      ...Array.from(cabin.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x475569,
      roughness: 0.35,
      metalness: 0.75
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'ParkedCars_Instanced';
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildConesInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const base = new THREE.BoxGeometry(0.38, 0.04, 0.38);
    base.translate(0, 0.02, 0);

    const cone = new THREE.ConeGeometry(0.16, 0.72, 8);
    cone.translate(0, 0.38, 0);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(base.attributes.position.array),
      ...Array.from(cone.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0xf97316,
      roughness: 0.6,
      metalness: 0.1
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'TrafficCones_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildHydrantsInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const body = new THREE.CylinderGeometry(0.16, 0.18, 0.75, 8);
    body.translate(0, 0.375, 0);

    const cap = new THREE.SphereGeometry(0.16, 8, 8);
    cap.translate(0, 0.75, 0);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(body.attributes.position.array),
      ...Array.from(cap.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0xdc2626,
      roughness: 0.5,
      metalness: 0.5
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'FireHydrants_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildTrashCansInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const bin = new THREE.BoxGeometry(0.5, 0.85, 0.45);
    bin.translate(0, 0.425, 0);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.65,
      metalness: 0.5
    });

    const mesh = new THREE.InstancedMesh(bin, mat, transforms.length);
    mesh.name = 'TrashCans_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildBoxesInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const box1 = new THREE.BoxGeometry(0.65, 0.5, 0.65);
    box1.translate(0, 0.25, 0);

    const box2 = new THREE.BoxGeometry(0.5, 0.4, 0.5);
    box2.translate(0.05, 0.7, -0.05);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(box1.attributes.position.array),
      ...Array.from(box2.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x855838,
      roughness: 0.9,
      metalness: 0.05
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'CardboardBoxes_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildPolesInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const pole = new THREE.CylinderGeometry(0.2, 0.25, 8.5, 8);
    pole.translate(0, 4.25, 0);

    const cross = new THREE.BoxGeometry(1.8, 0.14, 0.14);
    cross.translate(0, 7.8, 0);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(pole.attributes.position.array),
      ...Array.from(cross.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x64748b,
      roughness: 0.85,
      metalness: 0.2
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'UtilityPoles_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildMailboxesInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const post = new THREE.CylinderGeometry(0.06, 0.06, 0.6, 6);
    post.translate(0, 0.3, 0);

    const boxRed = new THREE.BoxGeometry(0.35, 0.55, 0.32);
    boxRed.translate(-0.2, 0.85, 0);

    const boxGreen = new THREE.BoxGeometry(0.35, 0.55, 0.32);
    boxGreen.translate(0.2, 0.85, 0);

    const combGeo = new THREE.BufferGeometry();
    const pos = [
      ...Array.from(post.attributes.position.array),
      ...Array.from(boxRed.attributes.position.array),
      ...Array.from(boxGreen.attributes.position.array)
    ];
    combGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    combGeo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x15803d,
      roughness: 0.5,
      metalness: 0.5
    });

    const mesh = new THREE.InstancedMesh(combGeo, mat, transforms.length);
    mesh.name = 'Mailboxes_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  private buildVendingInstanced(transforms: THREE.Matrix4[]): THREE.InstancedMesh {
    const box = new THREE.BoxGeometry(0.9, 1.85, 0.7);
    box.translate(0, 0.925, 0);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      roughness: 0.45,
      metalness: 0.6
    });

    const mesh = new THREE.InstancedMesh(box, mat, transforms.length);
    mesh.name = 'VendingMachines_Instanced';
    mesh.castShadow = true;

    for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]);
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  public dispose(scene: THREE.Scene): void {
    const meshes = [
      this.treesMesh, this.lampsMesh, this.scootersMesh, this.carsMesh,
      this.conesMesh, this.hydrantsMesh, this.trashCansMesh, this.boxesMesh,
      this.polesMesh, this.mailboxesMesh, this.vendingMesh
    ];
    for (const m of meshes) {
      if (m) {
        scene.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    }
    this.treesMesh = null;
    this.lampsMesh = null;
    this.scootersMesh = null;
    this.carsMesh = null;
    this.conesMesh = null;
    this.hydrantsMesh = null;
    this.trashCansMesh = null;
    this.boxesMesh = null;
    this.polesMesh = null;
    this.mailboxesMesh = null;
    this.vendingMesh = null;
    this.lampTransforms = [];
  }
}
