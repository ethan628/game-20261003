/**
 * TrafficSignalSystem.ts - 交通號誌全域管理系統
 * 遵循 RULES.md：
 * 1. 行人與未來車輛系統之中央控制中樞，外部系統僅能透過公開介面查詢
 * 2. 公開介面：getVehicleState, getPedestrianState, isRunningRedLight, signal:changed 事件
 * 3. 預留日夜模式與通緝違規檢測
 */

import { IntersectionFeature, Point2D, TrafficSignalStats, SignalPhaseGroup } from '../../geo/OsmTypes.ts';
import { SignalController, VehicleSignalInfo, PedestrianSignalInfo, VehicleSignalState } from './SignalController.ts';
import { CONFIG } from '../../config.ts';

type SignalChangeCallback = (data: {
  intersectionId: string;
  groupAState: VehicleSignalState;
  groupBState: VehicleSignalState;
}) => void;

export class TrafficSignalSystem {
  private controllers: Map<string, SignalController> = new Map();
  private intersections: IntersectionFeature[] = [];
  private eventListeners: Map<string, Set<SignalChangeCallback>> = new Map();

  private isNightMode = false;
  private lastUpdateTimeMs = 0;

  constructor() {
    this.eventListeners.set('signal:changed', new Set());
  }

  /**
   * 初始化並載入路口資料
   */
  public setIntersections(intersections: IntersectionFeature[]): void {
    this.intersections = intersections;
    this.controllers.clear();

    for (const inter of intersections) {
      if (inter.hasSignals) {
        this.controllers.set(inter.id, new SignalController(inter));
      }
    }

    console.log(
      `[TrafficSignalSystem] 號誌系統初始化完成：管理 ${this.controllers.size} 個號誌控制器`
    );
  }

  /**
   * 逐幀更新號誌時間與相位
   */
  public update(dt: number): void {
    if (!CONFIG.TRAFFIC_SIGNALS.ENABLED || this.controllers.size === 0) return;

    const tStart = performance.now();

    for (const [id, ctrl] of this.controllers.entries()) {
      const changed = ctrl.update(dt, this.isNightMode);
      if (changed) {
        const listeners = this.eventListeners.get('signal:changed');
        if (listeners && listeners.size > 0) {
          const payload = {
            intersectionId: id,
            groupAState: ctrl.getGroupVehicleState('A').state,
            groupBState: ctrl.getGroupVehicleState('B').state
          };
          for (const cb of listeners) {
            cb(payload);
          }
        }
      }
    }

    this.lastUpdateTimeMs = performance.now() - tStart;
  }

  /**
   * 【公開介面】查詢車輛號誌狀態 (車輛 AI 與玩家狀態使用)
   */
  public getVehicleState(intersectionId: string, approachId: string): VehicleSignalInfo {
    const ctrl = this.controllers.get(intersectionId);
    if (!ctrl) {
      return { state: 'green', remainingSec: 99 };
    }
    return ctrl.getVehicleState(approachId);
  }

  /**
   * 【公開介面】查詢行人號誌狀態 (行人系統使用)
   */
  public getPedestrianState(intersectionId: string, crossingId: string): PedestrianSignalInfo {
    const ctrl = this.controllers.get(intersectionId);
    if (!ctrl) {
      return { state: 'walk', remainingSec: 99 };
    }
    return ctrl.getPedestrianState(crossingId);
  }

  /**
   * 【公開介面】取得號誌倒數計時與顏色
   */
  public getCountdownSec(intersectionId: string, group: SignalPhaseGroup): { seconds: number; color: 'green' | 'yellow' | 'red' } {
    const ctrl = this.controllers.get(intersectionId);
    if (!ctrl) {
      return { seconds: 0, color: 'green' };
    }
    return ctrl.getCountdownSec(group);
  }

  /**
   * 【公開介面】強制全城紅燈 (自動化測試與除錯量測使用)
   */
  public setForceAllRed(enabled: boolean): void {
    this.forceAllRed = enabled;
    for (const ctrl of this.controllers.values()) {
      ctrl.setForceAllRed(enabled);
    }
  }

  public getIsAllRed(): boolean {
    return this.forceAllRed;
  }

  private forceAllRed = false;
  /**
   * 【公開介面】預留通緝系統違規判定：檢查實體是否闖紅燈
   */
  public isRunningRedLight(position: Point2D, headingRad: number): boolean {
    const cfg = CONFIG.TRAFFIC_SIGNALS.RED_LIGHT_DETECTION;
    const checkDist = cfg.CHECK_DISTANCE || 4.5;

    for (const ctrl of this.controllers.values()) {
      const inter = ctrl.intersection;
      const dToCenter = Math.hypot(position.x - inter.center.x, position.z - inter.center.z);
      if (dToCenter > inter.radius + 6.0) continue;

      // 檢查各 approach 的停止線
      for (const app of inter.approaches) {
        const vState = ctrl.getVehicleState(app.id);
        if (vState.state !== 'red') continue;

        // 停止線中點
        const stopMidX = (app.stopLineP1.x + app.stopLineP2.x) * 0.5;
        const stopMidZ = (app.stopLineP1.z + app.stopLineP2.z) * 0.5;
        const distToStopLine = Math.hypot(position.x - stopMidX, position.z - stopMidZ);

        if (distToStopLine <= checkDist) {
          // 檢查航向是否正朝向路口內部
          let angleDiff = Math.abs(headingRad - app.azimuthRad);
          while (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;
          if (angleDiff < Math.PI * 0.4) {
            return true; // 判定為正在紅燈越線闖入路口
          }
        }
      }
    }

    return false;
  }

  /**
   * 註冊事件監聽
   */
  public on(event: 'signal:changed', callback: SignalChangeCallback): void {
    const list = this.eventListeners.get(event);
    if (list) {
      list.add(callback);
    }
  }

  public off(event: 'signal:changed', callback: SignalChangeCallback): void {
    const list = this.eventListeners.get(event);
    if (list) {
      list.delete(callback);
    }
  }

  /**
   * 設定深夜離峰模式 (閃黃/閃紅)
   */
  public setNightMode(enabled: boolean): void {
    this.isNightMode = enabled;
  }

  public getNightMode(): boolean {
    return this.isNightMode;
  }

  public getController(intersectionId: string): SignalController | undefined {
    return this.controllers.get(intersectionId);
  }

  public getAllControllers(): SignalController[] {
    return Array.from(this.controllers.values());
  }

  public getIntersections(): IntersectionFeature[] {
    return this.intersections;
  }

  /**
   * 取得號誌系統統計資料 (供 HUD 與除錯器顯示)
   */
  public getStats(playerPos: Point2D, drawCalls: number = 0): TrafficSignalStats {
    let inRangeCount = 0;
    let totalPoles = 0;
    const updRadius = CONFIG.TRAFFIC_SIGNALS.UPDATE_RADIUS || 200.0;

    for (const ctrl of this.controllers.values()) {
      const inter = ctrl.intersection;
      totalPoles += inter.poles.length;
      const d = Math.hypot(inter.center.x - playerPos.x, inter.center.z - playerPos.z);
      if (d <= updRadius) {
        inRangeCount++;
      }
    }

    const osmCount = this.intersections.filter((i) => i.hasSignals && i.source === 'osm').length;
    const autoCount = this.intersections.filter((i) => i.hasSignals && i.source === 'auto').length;

    return {
      totalIntersections: this.intersections.length,
      signalizedCount: this.controllers.size,
      osmCount,
      autoCount,
      inRangeCount,
      totalPoles,
      updateTimeMs: this.lastUpdateTimeMs,
      drawCalls
    };
  }
}
