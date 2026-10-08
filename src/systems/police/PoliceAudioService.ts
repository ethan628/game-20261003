/**
 * PoliceAudioService.ts - 純 Web Audio 程序化合成警笛音效系統
 * 遵循 RULES.md：零外部音訊檔案依賴、雙模式 (wail/yelp)、都卜勒效應與距離衰減
 */

import { CONFIG } from '../../config.ts';

interface ActiveSirenInstance {
  osc: OscillatorNode;
  gain: GainNode;
  carId: string;
}

export class PoliceAudioService {
  private ctx: AudioContext | null = null;
  private isInitialized = false;
  private masterGain: GainNode | null = null;
  private activeSirens: Map<string, ActiveSirenInstance> = new Map();
  private volume = CONFIG.POLICE.SIREN_VOLUME;
  private maxDistance = CONFIG.POLICE.SIREN_MAX_DISTANCE;

  constructor() {
    const initOnGesture = () => {
      this.initAudioContext();
      window.removeEventListener('click', initOnGesture);
      window.removeEventListener('keydown', initOnGesture);
    };

    window.addEventListener('click', initOnGesture, { once: true });
    window.addEventListener('keydown', initOnGesture, { once: true });
  }

  private initAudioContext(): void {
    if (this.isInitialized) return;

    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;

      this.ctx = new AudioCtxClass();
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      this.isInitialized = true;
    } catch (e) {
      console.warn('[PoliceAudioService] Web Audio 初始化失敗:', e);
    }
  }

  /**
   * 逐幀更新警笛音訊（計算距離音量衰減、都卜勒頻移與 wail/yelp 頻率震盪）
   */
  public updateSiren(
    carId: string,
    active: boolean,
    mode: 'wail' | 'yelp',
    carX: number,
    carZ: number,
    carSpeed: number,
    carHeading: number,
    playerX: number,
    playerZ: number
  ): void {
    if (!this.ctx || !this.isInitialized || !this.masterGain) return;

    if (!active) {
      this.stopSiren(carId);
      return;
    }

    const dist = Math.hypot(carX - playerX, carZ - playerZ);
    if (dist > this.maxDistance) {
      this.stopSiren(carId);
      return;
    }

    let instance = this.activeSirens.get(carId);
    const now = this.ctx.currentTime;

    if (!instance) {
      // 建立新的警笛震盪器
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth'; // 警笛尖銳穿透的鋸齒波特徵
      gain.gain.setValueAtTime(0.001, now);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start();

      instance = { osc, gain, carId };
      this.activeSirens.set(carId, instance);
    }

    // 1. 距離衰減計算 (反比衰減，近處飽滿，邊緣平滑靜音)
    const normalizedDist = Math.max(0, Math.min(1, dist / this.maxDistance));
    const distVol = Math.pow(1 - normalizedDist, 1.8) * this.volume;
    instance.gain.gain.setTargetAtTime(distVol, now, 0.05);

    // 2. 頻率擺動 (wail: 慢速長鳴 650Hz~950Hz 週期約 3.2s; yelp: 快速急鳴 650Hz~1150Hz 週期約 0.3s)
    let baseFreq = 750;
    const t = performance.now() * 0.001;

    if (mode === 'wail') {
      const cycle = (Math.sin(t * 1.95) + 1) * 0.5; // 0 ~ 1
      baseFreq = 650 + cycle * 320; // 650Hz ~ 970Hz
    } else {
      // yelp: 急促警笛 (三角波形震盪)
      const phase = (t * 3.8) % 1.0;
      const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      baseFreq = 680 + tri * 460; // 680Hz ~ 1140Hz
    }

    // 3. 都卜勒頻移 (Doppler shift)
    // 計算警車速度在朝向玩家視線上的投影
    const dx = playerX - carX;
    const dz = playerZ - carZ;
    const dLen = Math.hypot(dx, dz) || 1;
    const dirToPlayerX = dx / dLen;
    const dirToPlayerZ = dz / dLen;

    const carFwdX = Math.sin(carHeading);
    const carFwdZ = Math.cos(carHeading);
    const radialSpeed = carSpeed * (carFwdX * dirToPlayerX + carFwdZ * dirToPlayerZ);

    const speedOfSound = 343.0; // m/s
    // 朝向玩家時 radialSpeed > 0，波長壓縮頻率上升；遠離時下降
    const dopplerFactor = Math.max(0.85, Math.min(1.18, speedOfSound / (speedOfSound - radialSpeed)));
    const finalFreq = baseFreq * dopplerFactor;

    instance.osc.frequency.setTargetAtTime(finalFreq, now, 0.03);
  }

  public stopSiren(carId: string): void {
    const instance = this.activeSirens.get(carId);
    if (!instance || !this.ctx) return;

    const now = this.ctx.currentTime;
    instance.gain.gain.setTargetAtTime(0, now, 0.08);

    setTimeout(() => {
      try {
        instance.osc.stop();
        instance.osc.disconnect();
        instance.gain.disconnect();
      } catch (e) {
        // 忽略已停止例外
      }
    }, 120);

    this.activeSirens.delete(carId);
  }

  public stopAll(): void {
    for (const carId of this.activeSirens.keys()) {
      this.stopSiren(carId);
    }
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }
}
