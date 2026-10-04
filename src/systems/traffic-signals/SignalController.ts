/**
 * SignalController.ts - 單一路口號誌狀態機與相位時序控制器
 * 包含雙相位時序、綠波偏移、行人倒數連動與深夜模式
 */

import { IntersectionFeature, SignalPhaseGroup } from '../../geo/OsmTypes.ts';
import { CONFIG } from '../../config.ts';

export type VehicleSignalState = 'green' | 'yellow' | 'red' | 'flashingYellow';
export type PedestrianSignalState = 'walk' | 'flashing' | 'dontWalk';

export interface VehicleSignalInfo {
  state: VehicleSignalState;
  remainingSec: number;
}

export interface PedestrianSignalInfo {
  state: PedestrianSignalState;
  remainingSec: number;
}

export interface SignalTimingConfig {
  greenA: number;
  yellowA: number;
  allRed1: number;
  greenB: number;
  yellowB: number;
  allRed2: number;
  pedFlashDuration: number;
  pedClearanceSec: number;
  offsetSec: number;
}

export class SignalController {
  public readonly intersection: IntersectionFeature;
  private timing: SignalTimingConfig;
  private cycleLength: number;
  private currentTime: number = 0;
  private isNightMode: boolean = false;

  // 記錄前一次狀態以供事件變更檢測
  private lastStateA: VehicleSignalState = 'red';
  private lastStateB: VehicleSignalState = 'red';

  constructor(intersection: IntersectionFeature) {
    this.intersection = intersection;

    const cfg = CONFIG.TRAFFIC_SIGNALS.TIMING;

    // 主要道路路口給予較長綠燈 (加時)
    const hasMajorRoad = intersection.approaches.some((a) =>
      ['motorway', 'trunk', 'primary', 'secondary'].includes(a.roadType)
    );
    const bonus = hasMajorRoad ? cfg.MAJOR_ROAD_BONUS : 0;

    const greenA = cfg.DEFAULT_GREEN_A + bonus;
    const yellowA = cfg.DEFAULT_YELLOW_A;
    const allRed1 = cfg.ALL_RED_1;
    const greenB = cfg.DEFAULT_GREEN_B;
    const yellowB = cfg.DEFAULT_YELLOW_B;
    const allRed2 = cfg.ALL_RED_2;

    // 綠波相鄰路口偏移 (依地理座標產生自然連續綠波錯開)
    const offsetSec = Math.abs((intersection.center.x * 0.08 + intersection.center.z * 0.05) % 60);

    this.timing = {
      greenA,
      yellowA,
      allRed1,
      greenB,
      yellowB,
      allRed2,
      pedFlashDuration: cfg.PED_FLASH_DURATION,
      pedClearanceSec: cfg.PED_CLEARANCE_SEC,
      offsetSec
    };

    this.cycleLength = greenA + yellowA + allRed1 + greenB + yellowB + allRed2;
    this.currentTime = this.timing.offsetSec;
  }

  /**
   * 推進遊戲時間 (秒)
   */
  public update(dt: number, nightMode = false): boolean {
    this.isNightMode = nightMode;
    this.currentTime = (this.currentTime + dt) % this.cycleLength;

    const stateA = this.getGroupVehicleState('A').state;
    const stateB = this.getGroupVehicleState('B').state;

    const changed = stateA !== this.lastStateA || stateB !== this.lastStateB;
    this.lastStateA = stateA;
    this.lastStateB = stateB;

    return changed;
  }

  /**
   * 取得車輛號誌狀態 (根據 approachId 或 signalGroup)
   */
  public getVehicleState(approachId: string): VehicleSignalInfo {
    const app = this.intersection.approaches.find((a) => a.id === approachId);
    const group: SignalPhaseGroup = app ? app.signalGroup : 'A';
    return this.getGroupVehicleState(group);
  }

  /**
   * 取得行人號誌狀態 (根據 crossingId 或 signalGroup)
   */
  public getPedestrianState(crossingId: string): PedestrianSignalInfo {
    const cross = this.intersection.crossings.find((c) => c.id === crossingId);
    const group: SignalPhaseGroup = cross ? cross.signalGroup : 'A';
    return this.getGroupPedestrianState(group);
  }

  private forceAllRed: boolean = false;

  public setForceAllRed(enabled: boolean): void {
    this.forceAllRed = enabled;
  }

  /**
   * 取得群組車輛狀態
   */
  public getGroupVehicleState(group: SignalPhaseGroup): VehicleSignalInfo {
    if (this.forceAllRed) {
      return { state: 'red', remainingSec: 99 };
    }

    if (this.isNightMode) {
      return {
        state: group === 'A' ? 'flashingYellow' : 'red',
        remainingSec: 1.0
      };
    }

    const t = this.currentTime;
    const { greenA, yellowA, allRed1, greenB, yellowB, allRed2 } = this.timing;

    const p0End = greenA;
    const p1End = p0End + yellowA;
    const p2End = p1End + allRed1;
    const p3End = p2End + greenB;
    const p4End = p3End + yellowB;
    const p5End = p4End + allRed2;

    if (group === 'A') {
      if (t < p0End) {
        return { state: 'green', remainingSec: Math.max(0, p0End - t) };
      } else if (t < p1End) {
        return { state: 'yellow', remainingSec: Math.max(0, p1End - t) };
      } else {
        // 紅燈，計算距離下一輪綠燈 (p5End - t)
        return { state: 'red', remainingSec: Math.max(0, p5End - t) };
      }
    } else {
      // Group B
      if (t < p2End) {
        // 紅燈，等待 p2End 開始綠燈
        return { state: 'red', remainingSec: Math.max(0, p2End - t) };
      } else if (t < p3End) {
        return { state: 'green', remainingSec: Math.max(0, p3End - t) };
      } else if (t < p4End) {
        return { state: 'yellow', remainingSec: Math.max(0, p4End - t) };
      } else {
        // 紅燈，等待循環結束回到 p2End
        return { state: 'red', remainingSec: Math.max(0, (p5End - t) + p2End) };
      }
    }
  }

  /**
   * 取得群組行人號誌狀態
   */
  public getGroupPedestrianState(group: SignalPhaseGroup): PedestrianSignalInfo {
    if (this.isNightMode) {
      return { state: 'dontWalk', remainingSec: 0 };
    }

    const t = this.currentTime;
    const { greenA, yellowA, allRed1, greenB, yellowB, allRed2, pedFlashDuration, pedClearanceSec } = this.timing;

    const p0End = greenA;
    const p1End = p0End + yellowA;
    const p2End = p1End + allRed1;
    const p3End = p2End + greenB;
    const p4End = p3End + yellowB;
    const p5End = p4End + allRed2;

    if (group === 'A') {
      // 行人 A 在 Phase 0 通行
      const walkDuration = Math.max(4.0, greenA - pedFlashDuration - pedClearanceSec);
      const flashEnd = greenA - pedClearanceSec;

      if (t < walkDuration) {
        return { state: 'walk', remainingSec: Math.max(0, walkDuration - t) };
      } else if (t < flashEnd) {
        return { state: 'flashing', remainingSec: Math.max(0, flashEnd - t) };
      } else {
        return { state: 'dontWalk', remainingSec: Math.max(0, p5End - t) };
      }
    } else {
      // 行人 B 在 Phase 3 通行 (p2End ~ p3End)
      const p3Start = p2End;
      const walkDuration = Math.max(4.0, greenB - pedFlashDuration - pedClearanceSec);
      const flashEnd = p3Start + greenB - pedClearanceSec;

      if (t < p3Start) {
        return { state: 'dontWalk', remainingSec: Math.max(0, p3Start - t) };
      } else if (t < p3Start + walkDuration) {
        return { state: 'walk', remainingSec: Math.max(0, p3Start + walkDuration - t) };
      } else if (t < flashEnd) {
        return { state: 'flashing', remainingSec: Math.max(0, flashEnd - t) };
      } else {
        return { state: 'dontWalk', remainingSec: Math.max(0, (p5End - t) + p3Start) };
      }
    }
  }

  /**
   * 取得當前主要倒數顯示秒數 (給號誌燈桿倒數顯示器使用)
   */
  public getCountdownSec(group: SignalPhaseGroup): { seconds: number; color: 'green' | 'yellow' | 'red' } {
    const v = this.getGroupVehicleState(group);
    const sec = Math.min(99, Math.max(0, Math.ceil(v.remainingSec)));
    let col: 'green' | 'yellow' | 'red' = 'red';
    if (v.state === 'green') col = 'green';
    else if (v.state === 'yellow') col = 'yellow';
    return { seconds: sec, color: col };
  }

  /**
   * 取得號誌循環資訊
   */
  public getCycleInfo(): { currentTime: number; cycleLength: number; timing: SignalTimingConfig } {
    return {
      currentTime: this.currentTime,
      cycleLength: this.cycleLength,
      timing: { ...this.timing }
    };
  }
}
