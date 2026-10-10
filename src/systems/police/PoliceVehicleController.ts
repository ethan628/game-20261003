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
  private lastClosestObstacleDist = Infinity;

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
  /**
   * 逐幀更新警車狀態機、路徑導航與物理移動
   */
  public update(
    dt: number,
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[],
    playerPos: Point2D
  ): {
    requestPathPlan?: { from: Point2D; to: Point2D };
    pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
    citationIssued?: { actorType: 'vehicle' | 'pedestrian'; id: string | number; violationType: string; pos: Point2D };
    unstuckTriggered?: boolean;
    jitterTriggered?: boolean;
  } {
    const v = this.vehicle;
    if (!v.active) return {};

    let resultEvent: {
      requestPathPlan?: { from: Point2D; to: Point2D };
      pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
      citationIssued?: { actorType: 'vehicle' | 'pedestrian'; id: string | number; violationType: string; pos: Point2D };
      unstuckTriggered?: boolean;
      jitterTriggered?: boolean;
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

    // 6 秒位移檢查 (排除 STOP_AND_CITE 開單停妥與紅燈停等狀態)
    if (v.state !== 'STOP_AND_CITE') {
      v.stuckDisplacementTimer += dt;
      if (v.stuckDisplacementTimer >= CONFIG.POLICE.STUCK_DISPLACEMENT_CHECK_SEC) {
        v.stuckDisplacementTimer = 0;
        const d6 = Math.hypot(v.x - v.stuckAnchorPos.x, v.z - v.stuckAnchorPos.z);
        if (d6 < CONFIG.POLICE.STUCK_MIN_DISPLACEMENT_M && !this.shouldStopAtRedSignal()) {
          v.stuckReason = 'low_displacement_6s';
          resultEvent.unstuckTriggered = true;
          if (v.state === 'PURSUIT' || v.state === 'INTERCEPT') {
            v.state = 'RETURN';
            v.stateTimer = 0;
            v.sirenActive = false;
            v.targetViolator = null;
            v.pathWaypoints = [];
            resultEvent.pursuitEndedResult = 'abandoned';
          }
        } else if (d6 >= CONFIG.POLICE.STUCK_MIN_DISPLACEMENT_M) {
          v.stuckReason = undefined;
        }
        v.stuckAnchorPos = { x: v.x, z: v.z };
      }
    } else {
      v.stuckDisplacementTimer = 0;
      v.stuckAnchorPos = { x: v.x, z: v.z };
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
        resultEvent = this.updatePursuit(dt, allTrafficVehicles, allPedestrians, playerPos);
        break;

      case 'INTERCEPT':
        resultEvent = this.updateIntercept(dt, allTrafficVehicles, allPedestrians, playerPos);
        break;

      case 'STOP_AND_CITE':
        resultEvent = this.updateStopAndCite(dt, allTrafficVehicles);
        break;

      case 'RETURN':
        this.updateReturn(dt, allTrafficVehicles);
        break;
    }

    // 更新物理位移與平滑轉向 (Pure Pursuit)
    this.updateMovement(dt, allTrafficVehicles, allPedestrians);

    // 抖動偵測 (2秒內轉向符號翻轉超過 4 次且車速低於 5 km/h)
    const sign = Math.abs(v.steeringAngle) > 0.035 ? Math.sign(v.steeringAngle) : 0;
    const nowSec = performance.now() * 0.001;
    if (sign !== 0) {
      const lastFlip = v.steeringFlips.length > 0 ? v.steeringFlips[v.steeringFlips.length - 1] : null;
      if (!lastFlip || lastFlip.sign !== sign) {
        v.steeringFlips.push({ time: nowSec, sign });
      }
    }
    v.steeringFlips = v.steeringFlips.filter((f) => nowSec - f.time <= CONFIG.POLICE.JITTER_WINDOW_SEC);
    if (
      v.steeringFlips.length >= CONFIG.POLICE.JITTER_MAX_SIGN_FLIPS &&
      v.speed * 3.6 < CONFIG.POLICE.JITTER_SPEED_MAX_KMH
    ) {
      if (!v.jitterDetected) {
        resultEvent.jitterTriggered = true;
        resultEvent.unstuckTriggered = true;
      }
      v.jitterDetected = true;
      v.stuckReason = 'steering_jitter';
      if (v.state === 'PURSUIT' || v.state === 'INTERCEPT') {
        v.state = 'RETURN';
        v.stateTimer = 0;
        v.sirenActive = false;
        v.targetViolator = null;
        v.pathWaypoints = [];
        resultEvent.pursuitEndedResult = 'abandoned';
      }
    } else {
      v.jitterDetected = false;
    }

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
      v.lastReplanPos = undefined;
    }
  }

  /**
   * 鳴笛追捕：超速 1.4 倍、A* 導航、紅燈減速通過、40s 放棄上限
   */
  private updatePursuit(
    dt: number,
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[],
    playerPos: Point2D
  ): {
    requestPathPlan?: { from: Point2D; to: Point2D };
    pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
  } {
    const v = this.vehicle;
    v.sirenActive = true;
    v.pursuitTimer += dt;

    // 檢查目標有效性 (不存在、被回收、超出 150m、已停下、已開罰、超過 40 秒)
    const targetCheck = this.checkTargetValidity(allTrafficVehicles, allPedestrians, playerPos);
    if (!targetCheck.isValid || v.pursuitTimer > CONFIG.POLICE.MAX_PURSUIT_DURATION_SEC) {
      v.targetInvalidTimer += dt;
      if (
        v.targetInvalidTimer >= CONFIG.POLICE.TARGET_INVALID_TIMEOUT_SEC ||
        v.pursuitTimer > CONFIG.POLICE.MAX_PURSUIT_DURATION_SEC
      ) {
        v.state = 'RETURN';
        v.stateTimer = 0;
        v.sirenActive = false;
        v.targetViolator = null;
        v.pathWaypoints = [];
        v.targetInvalidTimer = 0;
        return { pursuitEndedResult: v.pursuitTimer > CONFIG.POLICE.MAX_PURSUIT_DURATION_SEC ? 'abandoned' : 'escaped' };
      }
    } else {
      v.targetInvalidTimer = 0;
    }

    const targetPos = targetCheck.pos;
    if (!targetPos) {
      v.state = 'RETURN';
      v.stateTimer = 0;
      v.sirenActive = false;
      v.targetViolator = null;
      v.pathWaypoints = [];
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

    // 路徑承諾與重新規劃條件：
    // 1. 每 3 秒才允許一次
    // 2. 路口內與距離路口 15m 內不得重新規劃
    // 3. 只有在 (目標離上一次規劃終點超過 25m) 或 (路徑已走完/接近終點) 時才發出規劃請求
    v.lastReplanTime += dt;
    let requestPathPlan: { from: Point2D; to: Point2D } | undefined;

    const isNearIntersection = this.isNearAnyIntersection(v.x, v.z, CONFIG.POLICE.INTERSECTION_NO_REPLAN_RADIUS);

    if (v.lastReplanTime >= CONFIG.POLICE.REPLAN_PATH_INTERVAL_SEC && !isNearIntersection) {
      const predPos = v.predictedTarget || targetPos;
      const targetMovedFar =
        !v.lastReplanPos ||
        Math.hypot(predPos.x - v.lastReplanPos.x, predPos.z - v.lastReplanPos.z) >
          CONFIG.POLICE.REPLAN_MIN_TARGET_MOVE_M;
      const pathNearEnd =
        !v.pathWaypoints || v.pathWaypoints.length === 0 || v.pathIndex >= v.pathWaypoints.length - 2;

      if (targetMovedFar || pathNearEnd) {
        v.lastReplanTime = 0;
        v.lastReplanPos = { x: predPos.x, z: predPos.z };
        requestPathPlan = {
          from: { x: v.x, z: v.z },
          to: { x: predPos.x, z: predPos.z }
        };
      }
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
    allPedestrians: PedestrianAgent[],
    playerPos: Point2D
  ): {
    pursuitEndedResult?: 'intercepted' | 'escaped' | 'abandoned';
  } {
    const v = this.vehicle;
    v.sirenActive = true;
    v.pursuitTimer += dt;

    if (v.pursuitTimer > CONFIG.POLICE.MAX_PURSUIT_DURATION_SEC) {
      v.state = 'RETURN';
      v.stateTimer = 0;
      v.sirenActive = false;
      v.targetViolator = null;
      v.pathWaypoints = [];
      return { pursuitEndedResult: 'abandoned' };
    }

    // 檢查目標有效性
    const targetCheck = this.checkTargetValidity(allTrafficVehicles, allPedestrians, playerPos);
    if (!targetCheck.isValid) {
      v.targetInvalidTimer += dt;
      if (v.targetInvalidTimer >= CONFIG.POLICE.TARGET_INVALID_TIMEOUT_SEC) {
        v.state = 'RETURN';
        v.stateTimer = 0;
        v.sirenActive = false;
        v.targetViolator = null;
        v.pathWaypoints = [];
        v.targetInvalidTimer = 0;
        return { pursuitEndedResult: 'escaped' };
      }
    } else {
      v.targetInvalidTimer = 0;
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
        if (dToStop < 2.5) {
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
   * 車輛物理移動與避障 (採用 Pure Pursuit 與嚴格正向運動學)
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
      // 在 INTERCEPT 狀態下，若目標車已靠邊停下，允許警車接近至停靠點
      if (v.state === 'INTERCEPT' && v.targetViolator && String(other.id) === String(v.targetViolator.id)) {
        continue;
      }
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

    this.lastClosestObstacleDist = closestObstacleDist;

    // 若前方有障礙且距離太近 (< 5m)，煞車減速避讓
    if (closestObstacleDist < 5.0 && v.state !== 'STOP_AND_CITE') {
      v.targetSpeed = Math.min(v.targetSpeed, Math.max(0, (closestObstacleDist - 2.5) * 1.5));
    }

    // 速度加速度平滑
    const accel = v.targetSpeed > v.speed ? 5.5 : 8.0;
    v.speed += (v.targetSpeed - v.speed) * Math.min(1.0, dt * accel);
    v.speed = Math.max(0, v.speed); // 嚴格不可倒車！

    if (v.speed <= 0.01 && v.targetSpeed <= 0.01) {
      v.steeringAngle = 0;
      return;
    }

    // 尋找 Pure Pursuit 預視點 (Lookahead Point)
    const lookaheadL = Math.max(
      CONFIG.POLICE.PURE_PURSUIT_MIN_LOOKAHEAD,
      CONFIG.POLICE.PURE_PURSUIT_SPEED_FACTOR * v.speed
    );

    let lookaheadTarget: Point2D;

    if (v.state === 'PURSUIT' && v.pathWaypoints && v.pathWaypoints.length > 0) {
      // 推進 pathIndex：沿路徑推進至距離大於 2.0m 的節點
      while (v.pathIndex < v.pathWaypoints.length - 1) {
        const curPt = v.pathWaypoints[v.pathIndex];
        const dPt = Math.hypot(curPt.x - v.x, curPt.z - v.z);
        if (dPt < 2.0) {
          v.pathIndex++;
        } else {
          break;
        }
      }

      // 從 pathIndex 向前搜尋至距離至少為 lookaheadL 的節點
      let targetPt = v.pathWaypoints[v.pathIndex];
      for (let i = v.pathIndex; i < v.pathWaypoints.length; i++) {
        const pt = v.pathWaypoints[i];
        const dist = Math.hypot(pt.x - v.x, pt.z - v.z);
        if (dist >= lookaheadL) {
          targetPt = pt;
          break;
        }
        targetPt = pt;
      }
      lookaheadTarget = targetPt;
      v.targetPoint = lookaheadTarget;
    } else {
      // 巡邏或回歸模式：檢查是否到達 targetPoint
      const distToTarget = Math.hypot(v.targetPoint.x - v.x, v.targetPoint.z - v.z);
      if (distToTarget < 2.0 && (v.state === 'PATROL' || v.state === 'RETURN')) {
        this.advanceToNextPatrolSegment();
      }
      lookaheadTarget = v.targetPoint;
    }

    // Pure Pursuit 轉向角度運算
    const dx = lookaheadTarget.x - v.x;
    const dz = lookaheadTarget.z - v.z;
    const distToLookahead = Math.hypot(dx, dz) || 0.1;

    const targetHeading = Math.atan2(dx, dz);
    let headingDiff = targetHeading - v.rotationY;
    // 正規化至 [-PI, PI] (-180 ~ 180 度)
    headingDiff = Math.atan2(Math.sin(headingDiff), Math.cos(headingDiff));

    // ±2 度死區濾波，避免在零附近高頻抖動
    const deadbandRad = (CONFIG.POLICE.STEERING_DEADBAND_DEG * Math.PI) / 180;
    if (Math.abs(headingDiff) < deadbandRad) {
      headingDiff = 0;
    }

    // Pure Pursuit 幾何曲率公式: kappa = 2 * sin(alpha) / L
    const effectiveL = Math.max(lookaheadL, distToLookahead);
    const kappa = (2 * Math.sin(headingDiff)) / effectiveL;

    // 軸距 L_wb = 2.7m
    const Lwb = 2.7;
    let desiredSteer = Math.atan(kappa * Lwb);

    // 隨車速遞減之轉向角度限制 (低速最大 37 度 = 0.65 rad，高速收斂至 0.18 rad)
    const maxSteer = Math.max(0.18, 0.65 - 0.02 * v.speed);
    desiredSteer = Math.max(-maxSteer, Math.min(maxSteer, desiredSteer));

    // 限制轉向變化率 (最大 2.5 rad/s) 與低通濾波
    const maxRate = 2.5 * dt;
    const steerDelta = Math.max(-maxRate, Math.min(maxRate, desiredSteer - v.steeringAngle));
    v.steeringAngle += steerDelta;

    // 低通濾波
    v.steeringAngle += (desiredSteer - v.steeringAngle) * Math.min(1.0, dt * 10.0);
    v.targetSteeringAngle = desiredSteer;
    v.steeringHeadingDiff = headingDiff;

    // 車輛航向角更新 (阿克曼近似: yawRate = (v / Lwb) * tan(delta))
    const yawRate = (v.speed / Lwb) * Math.tan(v.steeringAngle);
    v.rotationY += yawRate * dt;
    v.rotationY = Math.atan2(Math.sin(v.rotationY), Math.cos(v.rotationY));

    // 物理位移更新：嚴格僅沿車頭方向前進，禁止任何側向或倒退位移！
    v.x += Math.sin(v.rotationY) * v.speed * dt;
    v.z += Math.cos(v.rotationY) * v.speed * dt;
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
      } else {
        // 尋找最近之相鄰道路 (擴大搜尋範圍至 35m) 保持正向行駛，避免死路掉頭碰撞
        let bestRoad: RoadFeature | null = null;
        let bestDist = Infinity;
        let bestPtIdx = 0;
        let bestRev = false;
        for (const r of this.roads) {
          if (r.points.length < 2) continue;
          for (let pIdx = 0; pIdx < r.points.length; pIdx++) {
            const d = Math.hypot(r.points[pIdx].x - lastPt.x, r.points[pIdx].z - lastPt.z);
            if (d < bestDist && d < 35.0) {
              bestDist = d;
              bestRoad = r;
              bestPtIdx = pIdx;
              bestRev = pIdx > 0;
            }
          }
        }
        if (bestRoad) {
          v.currentRoadId = bestRoad.id;
          v.isReverse = bestRev;
          v.roadPointIndex = bestPtIdx;
          const pt = bestRoad.points[bestPtIdx];
          v.targetPoint = { x: pt.x, z: pt.z };
        }
      }
    }
  }

  public isWaitingAtRedSignal(): boolean {
    return this.shouldStopAtRedSignal();
  }

  public isQueuedBehindTraffic(): boolean {
    return this.lastClosestObstacleDist < 6.0;
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

  private isNearAnyIntersection(x: number, z: number, extraRadius: number = 15.0): boolean {
    for (const inter of this.intersections) {
      const d = Math.hypot(inter.center.x - x, inter.center.z - z);
      if (d <= inter.radius + extraRadius) {
        return true;
      }
    }
    return false;
  }

  private checkTargetValidity(
    allTrafficVehicles: TrafficVehicle[],
    allPedestrians: PedestrianAgent[],
    playerPos: Point2D
  ): { target: TrafficVehicle | PedestrianAgent | null; isValid: boolean; pos: Point2D | null; reason?: string } {
    const v = this.vehicle;
    if (!v.targetViolator) {
      return { target: null, isValid: false, pos: null, reason: 'no_target' };
    }

    if (v.targetViolator.actorType === 'vehicle') {
      const tv = allTrafficVehicles.find((t) => t.id === v.targetViolator!.id && t.active);
      if (!tv) {
        return { target: null, isValid: false, pos: null, reason: 'despawned' };
      }
      const distToPlayer = Math.hypot(tv.x - playerPos.x, tv.z - playerPos.z);
      if (distToPlayer > CONFIG.POLICE.REMOTE_SETTLE_DISTANCE) {
        return { target: tv, isValid: false, pos: { x: tv.x, z: tv.z }, reason: 'beyond_sim_radius' };
      }
      if (tv.lastCitedTimestamp && Date.now() - tv.lastCitedTimestamp < 30000) {
        return { target: tv, isValid: false, pos: { x: tv.x, z: tv.z }, reason: 'already_cited' };
      }
      // 預測位置 (向前預測 2.5 秒)
      const predSec = CONFIG.POLICE.TARGET_PREDICTION_SEC;
      let predX = tv.x;
      let predZ = tv.z;
      if (tv.speed > 0.5) {
        predX += Math.sin(tv.rotationY) * tv.speed * predSec;
        predZ += Math.cos(tv.rotationY) * tv.speed * predSec;
      }
      v.predictedTarget = { x: predX, z: predZ };
      return { target: tv, isValid: true, pos: { x: tv.x, z: tv.z } };
    } else {
      const ped = allPedestrians.find((p) => p.id === v.targetViolator!.id && p.active);
      if (!ped) {
        return { target: null, isValid: false, pos: null, reason: 'ped_despawned' };
      }
      const distToPlayer = Math.hypot(ped.x - playerPos.x, ped.z - playerPos.z);
      if (distToPlayer > CONFIG.POLICE.REMOTE_SETTLE_DISTANCE) {
        return { target: ped, isValid: false, pos: { x: ped.x, z: ped.z }, reason: 'beyond_sim_radius' };
      }
      v.predictedTarget = { x: ped.x, z: ped.z };
      return { target: ped, isValid: true, pos: { x: ped.x, z: ped.z } };
    }
  }

  public onPathPlanResult(
    waypoints: Point2D[] | null,
    cost: number,
    pathHash: string,
    _targetPos?: Point2D
  ): void {
    const v = this.vehicle;
    if (!waypoints || waypoints.length === 0) {
      // 無可行合法有向路線 (例如單行道封閉或無法在圖上連通)：若無既有路徑則放棄追捕回歸巡邏
      if (v.pathWaypoints.length === 0) {
        v.state = 'RETURN';
        v.stateTimer = 0;
        v.sirenActive = false;
        v.targetViolator = null;
        v.pathWaypoints = [];
      }
      return;
    }

    // 承諾機制：若已有正在行駛之有效路徑，檢查是否值得更換 (成本低 15% 以上或目標位移 > 25m)
    if (v.pathWaypoints.length > 0 && v.pathIndex < v.pathWaypoints.length - 2) {
      const costImprovement = (v.pathCost || cost) - cost;
      const improvementRatio = v.pathCost && v.pathCost > 0 ? costImprovement / v.pathCost : 0;
      const targetMovedFar =
        v.lastReplanPos && _targetPos
          ? Math.hypot(_targetPos.x - v.lastReplanPos.x, _targetPos.z - v.lastReplanPos.z) >
            CONFIG.POLICE.REPLAN_MIN_TARGET_MOVE_M
          : false;

      if (improvementRatio < CONFIG.POLICE.REPLAN_COST_IMPROVEMENT_RATIO && !targetMovedFar) {
        // 未達 15% 改善且目標未大幅移動，保持原承諾路徑
        return;
      }
    }

    v.pathWaypoints = waypoints;
    v.pathIndex = 0;
    v.pathCost = cost;
    v.pathHash = pathHash;
    v.committedSegmentIndex = 0;
  }

  public setPathWaypoints(waypoints: Point2D[]): void {
    this.onPathPlanResult(waypoints, 0, 'legacy');
  }
}
