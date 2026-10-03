/**
 * CollisionSystem.ts - 實體與建築物 2D/3D 幾何碰撞檢測與滑移響應
 * 採用圓形與多邊形邊界投影檢測，並提供連續多步穿透解算 (Penetration Resolution)
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { BuildingCollisionData } from '../world/BuildingGenerator.ts';
import { Point2D } from '../geo/OsmTypes.ts';

export class CollisionSystem {
  private raycaster = new THREE.Raycaster();

  /**
   * 檢測並修正角色位置，防止穿透建築物外牆，並實現平滑沿牆滑行
   */
  public resolvePlayerBuildingCollision(
    playerPos: THREE.Vector3,
    colliders: BuildingCollisionData[],
    radius: number = CONFIG.PLAYER.COLLISION_RADIUS
  ): void {
    const px = playerPos.x;
    const pz = playerPos.z;
    const py = playerPos.y;
    const playerTop = py + CONFIG.PLAYER.HEIGHT;

    // 粗篩：僅過濾半徑 25 公尺內且高度有重疊之建築物
    const searchRadius = 25.0;
    const nearby: BuildingCollisionData[] = [];

    for (let i = 0; i < colliders.length; i++) {
      const b = colliders[i];
      if (py > b.height) continue; // 玩家位於建物屋頂上方
      if (playerTop < 0) continue;

      if (
        px + searchRadius >= b.minX &&
        px - searchRadius <= b.maxX &&
        pz + searchRadius >= b.minZ &&
        pz - searchRadius <= b.maxZ
      ) {
        nearby.push(b);
      }
    }

    if (nearby.length === 0) return;

    // 進行 2 回合迭代解算，處理雙牆夾角擠出
    for (let iter = 0; iter < 2; iter++) {
      let curX = playerPos.x;
      let curZ = playerPos.z;

      for (const bldg of nearby) {
        // AABB 擴展半徑篩選
        if (
          curX + radius < bldg.minX ||
          curX - radius > bldg.maxX ||
          curZ + radius < bldg.minZ ||
          curZ - radius > bldg.maxZ
        ) {
          continue;
        }

        const poly = bldg.footprint;
        const n = poly.length;

        // 1. 檢測是否完全落入建物多邊形內部 (Point-in-Polygon)
        const inside = this.isPointInPolygon(curX, curZ, poly);

        let nearestDist = Infinity;
        let pushX = 0;
        let pushZ = 0;
        let collided = false;

        // 2. 遍歷多邊形各邊，計算圓心至線段之最近距離
        for (let i = 0; i < n; i++) {
          const p1 = poly[i];
          const p2 = poly[(i + 1) % n];

          const edgeDx = p2.x - p1.x;
          const edgeDz = p2.z - p1.z;
          const edgeLenSq = edgeDx * edgeDx + edgeDz * edgeDz;
          if (edgeLenSq < 0.0001) continue;

          // 計算投影參數 t
          const t = Math.max(
            0,
            Math.min(
              1,
              ((curX - p1.x) * edgeDx + (curZ - p1.z) * edgeDz) / edgeLenSq
            )
          );

          const closeX = p1.x + t * edgeDx;
          const closeZ = p1.z + t * edgeDz;

          const toCircleX = curX - closeX;
          const toCircleZ = curZ - closeZ;
          const distSq = toCircleX * toCircleX + toCircleZ * toCircleZ;
          const dist = Math.sqrt(distSq);

          if (inside) {
            // 位於內部：尋找最近的外推邊緣
            if (dist < nearestDist) {
              nearestDist = dist;
              // 線段向外法向量
              const len = Math.sqrt(edgeLenSq);
              const outNx = (p2.z - p1.z) / len;
              const outNz = -(p2.x - p1.x) / len;
              pushX = outNx * (radius + dist + 0.02);
              pushZ = outNz * (radius + dist + 0.02);
              collided = true;
            }
          } else if (dist < radius) {
            // 位於外部但圓形與線段相交穿透
            const penetration = radius - dist;
            if (penetration > 0.0001) {
              const nx = dist > 0.0001 ? toCircleX / dist : (p2.z - p1.z) / Math.sqrt(edgeLenSq);
              const nz = dist > 0.0001 ? toCircleZ / dist : -(p2.x - p1.x) / Math.sqrt(edgeLenSq);

              curX += nx * (penetration + 0.002);
              curZ += nz * (penetration + 0.002);
            }
          }
        }

        if (inside && collided) {
          curX += pushX;
          curZ += pushZ;
        }
      }

      playerPos.x = curX;
      playerPos.z = curZ;
    }
  }

  /**
   * 射線法檢測點是否落於 2D 多邊形內
   */
  private isPointInPolygon(px: number, pz: number, poly: Point2D[]): boolean {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = poly[i].x, zi = poly[i].z;
      const xj = poly[j].x, zj = poly[j].z;

      const intersect =
        zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi + 0.0000001) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  /**
   * 鏡頭射線防穿牆檢測：自目標點發射射線至鏡頭理想位置，遇建物即拉近
   */
  public getCameraOcclusionDistance(
    origin: THREE.Vector3,
    targetDir: THREE.Vector3,
    maxDistance: number,
    buildingsMesh: THREE.Mesh | null
  ): number {
    if (!buildingsMesh) return maxDistance;

    this.raycaster.set(origin, targetDir);
    this.raycaster.near = 0.2;
    this.raycaster.far = maxDistance;

    const intersections = this.raycaster.intersectObject(buildingsMesh, false);
    if (intersections.length > 0) {
      const hitDist = intersections[0].distance;
      return Math.max(
        CONFIG.CAMERA.MIN_DISTANCE,
        hitDist - CONFIG.CAMERA.COLLISION_MARGIN
      );
    }

    return maxDistance;
  }
}
