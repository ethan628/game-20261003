/**
 * PoliceVehicleController.ts - 單一警車行為控制器與有限狀態機
 * 遵循 RULES.md：嚴格零碰撞原則、全狀態機管理、遵守號誌與紅燈減速通過
 */

import { CONFIG } from '../../config.ts';
import { Point2D, RoadFeature, IntersectionFeature } from '../../geo/OsmTypes.ts';
import { PoliceVehicle } from './PoliceTypes.ts';
import { TrafficVehicle } from '../../geo/TrafficTypes.ts';
import { TrafficSignalSystem } from '../traffic-signals/TrafficSignalSystem.ts';
import { PedestrianAgent } from '../PedestrianSystem.ts';

export class PoliceVehicleController {
  public vehicle: PoliceVehicle;
  private roads: RoadFeature[];
  private intersections: IntersectionFeature[];
  private trafficSignalSystem?: TrafficSignalSystem;

  constructor(
    vehicle: PoliceVehicle,
    roads: RoadFeature[],
    intersections: IntersectionFeature[],
    trafficSignalSystem?: TrafficSignalSystem
  ) {
    this.vehicle = vehicle;
    this.roads = roads;
    this.intersections = intersections;
    this.trafficSignalSystem = trafficSignalSystem;
  }

  public setRoads(roads: RoadFeature[]): void {
    this.roads = roads;
  }

  public setIntersections(intersections: IntersectionFeature[]): void {
    this.intersections = intersections;
  }

  public setTrafficSignalSystem(sys?: TrafficSignalSystem): void {
    this.trafficSignalSystem = sys;
  }

  public setRoadsAndIntersections(
    roads: RoadFeature[],
    intersections: IntersectionFeature[],
    sys?: TrafficSignalSystem
  ): void {
    this.roads = roads;
    this.intersections = intersections;
    this.trafficSignalSystem = sys;
  }

  /**
   * 逐幀更新警車狀態機、路徑導航與物理移動
   */
  public update(
    dt: number,
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[],
    _playerPos: Point2D
  ): {
    requestPathPlan?: { from: Point2D; to: Point2D };
    pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
    citationIssued?: { actorType: 'vehicle' | 'pedestrian'; id: string | number; violationType: string; pos: Point2D };
  } {
    const v = this.vehicle;
    if (!v.active) return {};

    let resultEvent: {
      requestPathPlan?: { from: Point2D; to: Point2D };
      pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
      citationIssued?: { actorType: 'vehicle' | 'pedestrian'; id: string | number; violationType: string; pos: Point2D };
    } = {};

    v.stateTimer += dt;

    // 氣泡提示計時
    if (v.speechBubbleTimer && v.speechBubbleTimer > 0) {
      v.speechBubbleTimer -= dt;
      if (v.speechBubbleTimer <= 0) v.speechBubbleText = undefined;
    }

    // 警燈與閃爍相位更新
    if (v.sirenActive) {
      v.lightbarPhase = (v.lightbarPhase + dt * CONFIG.POLICE.LIGHTBAR_FLASH_RATE_HZ) % 1.0;
      v.wigWagPhase = (v.wigWagPhase + dt * (CONFIG.POLICE.LIGHTBAR_FLASH_RATE_HZ * 1.5)) % 1.0;
    } else {
      v.lightbarPhase = 0;
      v.wigWagPhase = 0;
    }

    // 狀態機分支
    switch (v.state) {
      case 'PATROL':
        this.updatePatrol(dt, allTrafficVehicles);
        break;

      case 'DETECTED':
        this.updateDetected(dt);
        break;

      case 'PURSUIT':
        resultEvent = this.updatePursuit(dt, allTrafficVehicles, allPedestrians);
        break;

      case 'INTERCEPT':
        resultEvent = this.updateIntercept(dt, allTrafficVehicles, allPedestrians);
        break;

      case 'STOP_AND_CITE':
        resultEvent = this.updateStopAndCite(dt, allTrafficVehicles);
        break;

      case 'RETURN':
        this.updateReturn(dt, allTrafficVehicles);
        break;
    }

    // 更新物理位移與平滑轉向
    this.updateMovement(dt, allTrafficVehicles, allPedestrians);

    return resultEvent;
  }

  /**
   * 常規巡邏：遵守號誌、速限 90%、隨機路段前進
   */
  private updatePatrol(_dt: number, _allTrafficVehicles: TrafficVehicle[]): void {
    const v = this.vehicle;
    v.sirenActive = false;
    v.targetSpeed = CONFIG.TRAFFIC.BASE_SPEED_MPS * CONFIG.POLICE.PATROL_SPEED_RATIO;

    // 號誌停等判定
    if (this.shouldStopAtRedSignal()) {
      v.targetSpeed = 0;
    }
  }

  /**
   * 發現違規：隨機反應延遲 0.5~1.5s
   */
  private updateDetected(dt: number): void {
    const v = this.vehicle;
    v.reactionTimer -= dt;
    if (v.reactionTimer <= 0) {
      // 警笛響起，進入追捕
      v.state = 'PURSUIT';
      v.stateTimer = 0;
      v.pursuitTimer = 0;
      v.sirenActive = true;
      v.sirenMode = 'wail';
      v.lastReplanTime = 0;
    }
  }

  /**
   * 鳴笛追捕：超速 1.4 倍、A* 導航、紅燈減速通過、40s 放棄上限
   */
  private updatePursuit(
    dt: number,
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[]
  ): {
    requestPathPlan?: { from: Point2D; to: Point2D };
    pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
  } {
    const v = this.vehicle;
    v.sirenActive = true;
    v.pursuitTimer += dt;

    // 超過 40 秒放棄追逐
    if (v.pursuitTimer > CONFIG.POLICE.MAX_PURSUIT_DURATION_SEC) {
      v.state = 'RETURN';
      v.sirenActive = false;
      v.targetViolator = null;
      return { pursuitEndedResult: 'abandoned' };
    }

    // 尋找違規目標當前座標
    const targetPos = this.getTargetPosition(allTrafficVehicles, allPedestrians);
    if (!targetPos) {
      // 目標消失或已被回收，放棄
      v.state = 'RETURN';
      v.sirenActive = false;
      v.targetViolator = null;
      return { pursuitEndedResult: 'escaped' };
    }

    const distToTarget = Math.hypot(targetPos.x - v.x, targetPos.z - v.z);

    // 接近到 30m 內時警笛切換為急促 yelp 模式
    v.sirenMode = distToTarget < 30.0 ? 'yelp' : 'wail';

    // 追至 12m 內進入攔截模式
    if (distToTarget <= CONFIG.POLICE.PURSUIT_TARGET_DISTANCE) {
      v.state = 'INTERCEPT';
      v.stateTimer = 0;
      if (CONFIG.POLICE.PULL_OVER_SPEECH_ENABLED) {
        v.speechBubbleText = '前方車輛請靠邊停車！';
        v.speechBubbleTimer = 3.5;
      }
      return {};
    }

    // 每 1.0s 請求 Worker A* 重新規劃路徑
    v.lastReplanTime += dt;
    let requestPathPlan: { from: Point2D; to: Point2D } | undefined;
    if (v.lastReplanTime >= CONFIG.POLICE.REPLAN_PATH_INTERVAL_SEC) {
      v.lastReplanTime = 0;
      requestPathPlan = {
        from: { x: v.x, z: v.z },
        to: { x: targetPos.x, z: targetPos.z }
      };
    }

    // 追捕巡航速度 (1.4 倍速限)
    let maxSpeed = CONFIG.TRAFFIC.MAX_SPEED_MPS * CONFIG.POLICE.PURSUIT_SPEED_RATIO;

    // 遇紅燈路口減速至 15 km/h (4.17 m/s) 通過
    if (this.isApproachingRedSignal()) {
      maxSpeed = Math.min(maxSpeed, CONFIG.POLICE.RED_LIGHT_CROSS_SPEED_MPS);
    }

    v.targetSpeed = maxSpeed;

    return { requestPathPlan };
  }

  /**
   * 攔截階段：命令靠邊、跟隨等待、斜停
   */
  private updateIntercept(
    dt: number,
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[]
  ): {
    pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
  } {
    const v = this.vehicle;
    v.sirenActive = true;
    v.pursuitTimer += dt;

    if (v.pursuitTimer > CONFIG.POLICE.MAX_PURSUIT_DURATION_SEC) {
      v.state = 'RETURN';
      v.sirenActive = false;
      return { pursuitEndedResult: 'abandoned' };
    }

    // 檢查違規車輛狀態
    if (v.targetViolator?.actorType === 'vehicle') {
      const targetVeh = allTrafficVehicles.find((tv) => tv.id === v.targetViolator!.id && tv.active);
      if (!targetVeh) {
        v.state = 'RETURN';
        v.sirenActive = false;
        return { pursuitEndedResult: 'escaped' };
      }

      // 若目標車輛選擇逃逸 (8% 機率)
      if (targetVeh.isFleeing) {
        v.state = 'PURSUIT'; // 繼續追擊
        return {};
      }

      // 若目標車輛已在路邊停妥 (speed === 0)
      if (targetVeh.state === 'PULLED_OVER' && targetVeh.speed <= 0.1) {
        // 警車停在目標車後方 6m、向外側錯開 1.5m 斜停
        const fwdX = Math.sin(targetVeh.rotationY);
        const fwdZ = Math.cos(targetVeh.rotationY);
        const rightX = Math.cos(targetVeh.rotationY);
        const rightZ = -Math.sin(targetVeh.rotationY);

        const stopX = targetVeh.x - fwdX * CONFIG.POLICE.STOP_DISTANCE_BEHIND + rightX * CONFIG.POLICE.STOP_LATERAL_OFFSET;
        const stopZ = targetVeh.z - fwdZ * CONFIG.POLICE.STOP_DISTANCE_BEHIND + rightZ * CONFIG.POLICE.STOP_LATERAL_OFFSET;

        v.interceptAnchor = {
          stopX,
          stopZ,
          heading: targetVeh.rotationY + 0.12 // 輕微向內斜停 7 度警戒角
        };

        const dToStop = Math.hypot(stopX - v.x, stopZ - v.z);
        if (dToStop < 1.2) {
          v.speed = 0;
          v.targetSpeed = 0;
          v.x = stopX;
          v.z = stopZ;
          v.rotationY = v.interceptAnchor.heading;
          v.state = 'STOP_AND_CITE';
          v.stateTimer = 0;
          v.sirenActive = false; // 停妥後關閉警笛，保持警示燈
          // 警員下車
          if (v.officers.length > 0) {
            v.officers[0].isDismounted = true;
            v.officers[0].x = v.x;
            v.officers[0].z = v.z;
          }
          return { pursuitEndedResult: 'intercepted' };
        } else {
          v.targetPoint = { x: stopX, z: stopZ };
          v.targetSpeed = Math.min(4.0, dToStop * 1.5);
        }
      } else {
        // 目標正在減速靠邊中，保持跟隨在後方 8~12m
        v.targetSpeed = Math.max(0, targetVeh.speed);
      }
    } else {
      // 行人違規：警車在路旁安全停下，警員下車勸導
      const targetPed = allPedestrians.find((p) => p.id === v.targetViolator!.id && p.active);
      if (!targetPed) {
        v.state = 'RETURN';
        v.sirenActive = false;
        return { pursuitEndedResult: 'escaped' };
      }

      v.speed = Math.max(0, v.speed - dt * 5.0);
      if (v.speed < 0.2) {
        v.speed = 0;
        v.state = 'STOP_AND_CITE';
        v.stateTimer = 0;
        v.sirenActive = false;
        if (v.officers.length > 0) {
          v.officers[0].isDismounted = true;
          v.officers[0].x = v.x;
          v.officers[0].z = v.z;
        }
        return { pursuitEndedResult: 'intercepted' };
      }
    }

    return {};
  }

  /**
   * 停車開罰：警員走到車窗/行人前抄寫 6~8 秒，發出罰單事件後回車回歸
   */
  private updateStopAndCite(
    dt: number,
    allTrafficVehicles: TrafficVehicle[]
  ): {
    citationIssued?: { actorType: 'vehicle' | 'pedestrian'; id: string | number; violationType: string; pos: Point2D };
  } {
    const v = this.vehicle;
    v.speed = 0;
    v.targetSpeed = 0;

    const officer = v.officers[0];
    if (officer) {
      officer.writingTimer += dt;

      // 警員位置：在違規者側邊約 1.2m
      if (v.targetViolator?.actorType === 'vehicle') {
        const tv = allTrafficVehicles.find((t) => t.id === v.targetViolator!.id);
        if (tv) {
          const rightX = Math.cos(tv.rotationY);
          const rightZ = -Math.sin(tv.rotationY);
          // 站在駕駛側 (台灣靠右行駛，左側車門為 -right)
          const targetStandX = tv.x - rightX * 1.2;
          const targetStandZ = tv.z - rightZ * 1.2;

          officer.x += (targetStandX - officer.x) * Math.min(1.0, dt * 2.5);
          officer.z += (targetStandZ - officer.z) * Math.min(1.0, dt * 2.5);
          officer.rotationY = tv.rotationY + Math.PI / 2; // 面對駕駛座
        }
      }
    }

    // 開單抄寫完成 (6~8 秒)
    if (v.stateTimer >= CONFIG.POLICE.CITATION_DURATION_SEC) {
      const citationData = v.targetViolator
        ? {
            actorType: v.targetViolator.actorType,
            id: v.targetViolator.id,
            violationType: v.targetViolator.violationType,
            pos: { x: v.x, z: v.z }
          }
        : undefined;

      // 釋放違規車輛/行人
      if (v.targetViolator?.actorType === 'vehicle') {
        const tv = allTrafficVehicles.find((t) => t.id === v.targetViolator!.id);
        if (tv) {
          tv.state = 'DRIVING';
          tv.targetSpeed = CONFIG.TRAFFIC.BASE_SPEED_MPS;
          tv.turnSignal = 'none';
          tv.lastCitedTimestamp = Date.now();
        }
      }

      // 警員回到車上
      if (officer) {
        officer.isDismounted = false;
        officer.writingTimer = 0;
      }

      v.state = 'RETURN';
      v.stateTimer = 0;
      v.sirenActive = false;
      v.targetViolator = null;

      return { citationIssued: citationData };
    }

    return {};
  }

  /**
   * 完成執法後回歸車道巡邏
   */
  private updateReturn(_dt: number, _allTrafficVehicles: TrafficVehicle[]): void {
    const v = this.vehicle;
    v.sirenActive = false;
    v.targetSpeed = CONFIG.TRAFFIC.BASE_SPEED_MPS * CONFIG.POLICE.PATROL_SPEED_RATIO;
    if (v.stateTimer > 3.0) {
      v.state = 'PATROL';
      v.stateTimer = 0;
    }
  }

  /**
   * 車輛物理移動與避障
   */
  private updateMovement(
    dt: number,
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[]
  ): void {
    const v = this.vehicle;

    // 前方障礙物檢測與防碰撞 (絕對不可撞擊其他車輛或行人)
    let closestObstacleDist = Infinity;
    const fwdX = Math.sin(v.rotationY);
    const fwdZ = Math.cos(v.rotationY);

    for (const other of allTrafficVehicles) {
      if (!other.active) continue;
      const dx = other.x - v.x;
      const dz = other.z - v.z;
      const fDist = dx * fwdX + dz * fwdZ;
      if (fDist > 0.5 && fDist < 15.0) {
        const latDist = Math.abs(dx * Math.cos(v.rotationY) - dz * Math.sin(v.rotationY));
        if (latDist < 1.6) {
          closestObstacleDist = Math.min(closestObstacleDist, fDist);
        }
      }
    }

    for (const ped of allPedestrians) {
      if (!ped.active) continue;
      const dx = ped.x - v.x;
      const dz = ped.z - v.z;
      const fDist = dx * fwdX + dz * fwdZ;
      if (fDist > 0.5 && fDist < 8.0) {
        const latDist = Math.abs(dx * Math.cos(v.rotationY) - dz * Math.sin(v.rotationY));
        if (latDist < 1.4) {
          closestObstacleDist = Math.min(closestObstacleDist, fDist);
        }
      }
    }

    // 若前方有障礙且距離太近 (< 5m)，煞車減速避讓
    if (closestObstacleDist < 5.0 && v.state !== 'STOP_AND_CITE') {
      v.targetSpeed = Math.min(v.targetSpeed, Math.max(0, (closestObstacleDist - 2.5) * 1.5));
    }

    // 速度加速度平滑
    const accel = v.targetSpeed > v.speed ? 5.5 : 8.0;
    v.speed += (v.targetSpeed - v.speed) * Math.min(1.0, dt * accel);
    v.speed = Math.max(0, v.speed);

    if (v.speed <= 0.01) return;

    // 若有 A* 導航路徑，依路徑推進
    if (v.pathWaypoints && v.pathWaypoints.length > 0 && v.state === 'PURSUIT') {
      const curTarget = v.pathWaypoints[v.pathIndex];
      if (curTarget) {
        v.targetPoint = curTarget;
        const dPt = Math.hypot(curTarget.x - v.x, curTarget.z - v.z);
        if (dPt < 2.5 && v.pathIndex < v.pathWaypoints.length - 1) {
          v.pathIndex++;
        }
      }
    }

    // 向目標點移動
    const dx = v.targetPoint.x - v.x;
    const dz = v.targetPoint.z - v.z;
    const distToTarget = Math.hypot(dx, dz);

    if (distToTarget < 1.5 && (v.state === 'PATROL' || v.state === 'RETURN')) {
      this.advanceToNextPatrolSegment();
    } else if (distToTarget > 0.05) {
      const dirX = dx / distToTarget;
      const dirZ = dz / distToTarget;
      v.x += dirX * v.speed * dt;
      v.z += dirZ * v.speed * dt;

      const targetRot = Math.atan2(dirX, dirZ);
      let rotDiff = targetRot - v.rotationY;
      while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
      while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
      v.rotationY += rotDiff * Math.min(1.0, dt * 6.5);
    }
  }

  /**
   * 巡邏沿路段前進或接續相鄰道路
   */
  private advanceToNextPatrolSegment(): void {
    const v = this.vehicle;
    const road = this.roads.find((r) => r.id === v.currentRoadId);
    if (!road) return;

    const nextIdx = v.isReverse ? v.roadPointIndex - 1 : v.roadPointIndex + 1;
    if (nextIdx >= 0 && nextIdx < road.points.length) {
      v.roadPointIndex = nextIdx;
      const pt = road.points[nextIdx];
      const prevPt = road.points[v.isReverse ? nextIdx + 1 : nextIdx - 1];
      const dx = pt.x - prevPt.x;
      const dz = pt.z - prevPt.z;
      const len = Math.hypot(dx, dz) || 1.0;
      const rightNormX = dz / len;
      const rightNormZ = -dx / len;
      const laneOffsetDist = !road.oneway ? Math.max(1.2, road.width * 0.25) : 0.0;
      v.laneOffset = laneOffsetDist;
      v.targetPoint = { x: pt.x + rightNormX * laneOffsetDist, z: pt.z + rightNormZ * laneOffsetDist };
      v.targetHeading = Math.atan2(dx / len, dz / len);
    } else {
      // 道路盡頭接續相鄰主要道路
      const lastPt = road.points[v.roadPointIndex];
      const connecting: Array<{ road: RoadFeature; isRev: boolean }> = [];
      for (const r of this.roads) {
        if (r.id === road.id || r.points.length < 2) continue;
        const dStart = Math.hypot(r.points[0].x - lastPt.x, r.points[0].z - lastPt.z);
        const dEnd = Math.hypot(r.points[r.points.length - 1].x - lastPt.x, r.points[r.points.length - 1].z - lastPt.z);
        if (dStart < 14.0 && r.oneway !== -1) connecting.push({ road: r, isRev: false });
        if (dEnd < 14.0 && (!r.oneway || r.oneway === -1)) connecting.push({ road: r, isRev: true });
      }

      if (connecting.length > 0) {
        const choice = connecting[Math.floor(Math.random() * connecting.length)];
        v.currentRoadId = choice.road.id;
        v.isReverse = choice.isRev;
        v.roadPointIndex = choice.isRev ? choice.road.points.length - 1 : 0;
        const targetPt = choice.isRev ? choice.road.points[choice.road.points.length - 2] : choice.road.points[1];
        const p0 = choice.road.points[choice.isRev ? choice.road.points.length - 1 : 0];
        const dx = targetPt.x - p0.x;
        const dz = targetPt.z - p0.z;
        const len = Math.hypot(dx, dz) || 1.0;
        const rightNormX = dz / len;
        const rightNormZ = -dx / len;
        const laneOffsetDist = !choice.road.oneway ? Math.max(1.2, choice.road.width * 0.25) : 0.0;
        v.laneOffset = laneOffsetDist;
        v.targetPoint = { x: targetPt.x + rightNormX * laneOffsetDist, z: targetPt.z + rightNormZ * laneOffsetDist };
        v.targetHeading = Math.atan2(dx / len, dz / len);
      } else if (!road.oneway) {
        v.isReverse = !v.isReverse;
        v.roadPointIndex = v.isReverse ? road.points.length - 1 : 0;
      }
    }
  }

  private shouldStopAtRedSignal(): boolean {
    if (!this.trafficSignalSystem) return false;
    for (const inter of this.intersections) {
      if (!inter.hasSignals) continue;
      const d = Math.hypot(inter.center.x - this.vehicle.x, inter.center.z - this.vehicle.z);
      if (d < inter.radius + 20.0) {
        for (const app of inter.approaches) {
          // 檢查警車方向是否與進口道一致 (避免被垂直方向紅燈誤煞停)
          let diff = Math.abs(this.vehicle.rotationY - app.azimuthRad);
          while (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff > 0.84) continue;

          const fwdX = Math.sin(app.azimuthRad);
          const fwdZ = Math.cos(app.azimuthRad);
          const dx = inter.center.x - this.vehicle.x;
          const dz = inter.center.z - this.vehicle.z;
          const longDist = dx * fwdX + dz * fwdZ;
          if (longDist > 0 && longDist < 25.0) {
            const sigState = this.trafficSignalSystem.getVehicleState(inter.id, app.id);
            if (sigState.state === 'red' || sigState.state === 'yellow') {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  private isApproachingRedSignal(): boolean {
    if (!this.trafficSignalSystem) return false;
    for (const inter of this.intersections) {
      if (!inter.hasSignals) continue;
      const d = Math.hypot(inter.center.x - this.vehicle.x, inter.center.z - this.vehicle.z);
      if (d < inter.radius + 20.0) {
        for (const app of inter.approaches) {
          let diff = Math.abs(this.vehicle.rotationY - app.azimuthRad);
          while (diff > Math.PI) diff = Math.PI * 2 - diff;
          if (diff > 0.84) continue;

          const fwdX = Math.sin(app.azimuthRad);
          const fwdZ = Math.cos(app.azimuthRad);
          const dx = inter.center.x - this.vehicle.x;
          const dz = inter.center.z - this.vehicle.z;
          const longDist = dx * fwdX + dz * fwdZ;
          if (longDist > 0 && longDist < 25.0) {
            const sigState = this.trafficSignalSystem.getVehicleState(inter.id, app.id);
            if (sigState.state === 'red') {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  private getTargetPosition(
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[]
  ): Point2D | null {
    const v = this.vehicle;
    if (!v.targetViolator) return null;

    if (v.targetViolator.actorType === 'vehicle') {
      const tv = allTrafficVehicles.find((t) => t.id === v.targetViolator!.id && t.active);
      if (tv) return { x: tv.x, z: tv.z };
    } else {
      const ped = allPedestrians.find((p) => p.id === v.targetViolator!.id && p.active);
      if (ped) return { x: ped.x, z: ped.z };
    }
    return null;
  }

  public setPathWaypoints(waypoints: Point2D[]): void {
    this.vehicle.pathWaypoints = waypoints;
    this.vehicle.pathIndex = 0;
  }
}
