/**
 * WeatherAudioManager.ts - 純 Web Audio 程序生成天候音效系統
 * 遵循 RULES.md：零外部音訊檔案依賴、使用者互動後啟動、騎樓低通遮蔽濾波
 */

import { CONFIG } from '../config.ts';

export class WeatherAudioManager {
  private ctx: AudioContext | null = null;
  private isInitialized = false;

  // 主節點
  private masterGain: GainNode | null = null;
  private weatherGain: GainNode | null = null;
  private occlusionFilter: BiquadFilterNode | null = null;

  // 雨聲節點
  private rainGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private rainSource: AudioBufferSourceNode | null = null;

  // 風聲節點
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windSource: AudioBufferSourceNode | null = null;

  // 蟲鳴節點
  private cricketGain: GainNode | null = null;
  private cricketOsc: OscillatorNode | null = null;
  private cricketModGain: GainNode | null = null;

  // 音量設定
  private masterVol = CONFIG.AUDIO.MASTER_VOLUME;
  private weatherVol = CONFIG.AUDIO.WEATHER_VOLUME;
  private isOccluded = false;

  constructor() {
    // 監聽首次使用者手勢以啟動 AudioContext (符合瀏覽器自動播放政策)
    const initOnGesture = () => {
      this.initAudioContext();
      window.removeEventListener('click', initOnGesture);
      window.removeEventListener('keydown', initOnGesture);
    };

    window.addEventListener('click', initOnGesture, { once: true });
    window.addEventListener('keydown', initOnGesture, { once: true });
  }

  /**
   * 初始化 Web Audio 節點圖
   */
  private initAudioContext(): void {
    if (this.isInitialized) return;

    try {
      const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtxClass) return;

      this.ctx = new AudioCtxClass();
      if (this.ctx.state === 'suspended') {
        this.ctx.resume();
      }

      // 1. 總音量與遮蔽濾波器 (騎樓低通)
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.setValueAtTime(this.masterVol, this.ctx.currentTime);
      this.masterGain.connect(this.ctx.destination);

      this.occlusionFilter = this.ctx.createBiquadFilter();
      this.occlusionFilter.type = 'lowpass';
      this.occlusionFilter.frequency.setValueAtTime(CONFIG.AUDIO.OPEN_AIR_FILTER_FREQ, this.ctx.currentTime);
      this.occlusionFilter.connect(this.masterGain);

      this.weatherGain = this.ctx.createGain();
      this.weatherGain.gain.setValueAtTime(this.weatherVol, this.ctx.currentTime);
      this.weatherGain.connect(this.occlusionFilter);

      // 2. 雨聲合成 (粉紅/白雜訊 + 帶通濾波)
      this.setupRainSynthesis();

      // 3. 風聲合成 (調製雜訊 + 低通頻率起伏)
      this.setupWindSynthesis();

      // 4. 夜間蟲鳴 (微弱脈衝調製)
      this.setupCricketSynthesis();

      this.isInitialized = true;
      console.log('[WeatherAudioManager] Web Audio 程序音訊引擎已啟動');
    } catch (e) {
      console.warn('[WeatherAudioManager] AudioContext init failed', e);
    }
  }

  /**
   * 建立雜訊緩衝區
   */
  private createNoiseBuffer(durationSec = 2.0): AudioBuffer {
    if (!this.ctx) throw new Error('No context');
    const bufferSize = this.ctx.sampleRate * durationSec;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);

    let lastOut = 0.0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      // 簡易粉紅雜訊濾波 (降低尖銳高頻)
      data[i] = (lastOut * 0.7) + (white * 0.3);
      lastOut = data[i];
    }
    return buffer;
  }

  private setupRainSynthesis(): void {
    if (!this.ctx || !this.weatherGain) return;

    const noiseBuffer = this.createNoiseBuffer(2.5);
    this.rainSource = this.ctx.createBufferSource();
    this.rainSource.buffer = noiseBuffer;
    this.rainSource.loop = true;

    this.rainFilter = this.ctx.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.setValueAtTime(1100, this.ctx.currentTime);
    this.rainFilter.Q.setValueAtTime(1.2, this.ctx.currentTime);

    this.rainGain = this.ctx.createGain();
    this.rainGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.rainSource.connect(this.rainFilter);
    this.rainFilter.connect(this.rainGain);
    this.rainGain.connect(this.weatherGain);

    this.rainSource.start();
  }

  private setupWindSynthesis(): void {
    if (!this.ctx || !this.weatherGain) return;

    const noiseBuffer = this.createNoiseBuffer(3.0);
    this.windSource = this.ctx.createBufferSource();
    this.windSource.buffer = noiseBuffer;
    this.windSource.loop = true;

    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.setValueAtTime(320, this.ctx.currentTime);
    this.windFilter.Q.setValueAtTime(3.0, this.ctx.currentTime);

    this.windGain = this.ctx.createGain();
    this.windGain.gain.setValueAtTime(0.05, this.ctx.currentTime);

    this.windSource.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.weatherGain);

    this.windSource.start();
  }

  private setupCricketSynthesis(): void {
    if (!this.ctx || !this.weatherGain) return;

    this.cricketOsc = this.ctx.createOscillator();
    this.cricketOsc.type = 'sine';
    this.cricketOsc.frequency.setValueAtTime(4600, this.ctx.currentTime);

    // 脈衝振幅調製
    this.cricketModGain = this.ctx.createGain();
    this.cricketModGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.cricketGain = this.ctx.createGain();
    this.cricketGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

    this.cricketOsc.connect(this.cricketModGain);
    this.cricketModGain.connect(this.cricketGain);
    this.cricketGain.connect(this.weatherGain);

    this.cricketOsc.start();
  }

  /**
   * 觸發雷鳴聲 (Procedural Thunder)
   */
  public triggerThunder(delaySec: number = 0.5): void {
    if (!this.ctx || !this.isInitialized || !this.weatherGain) return;

    setTimeout(() => {
      if (!this.ctx || !this.weatherGain) return;

      const now = this.ctx.currentTime;

      // 1. 低頻次重擊 (Bass Punch)
      const osc = this.ctx.createOscillator();
      const oscGain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(65, now);
      osc.frequency.exponentialRampToValueAtTime(24, now + 2.2);

      oscGain.gain.setValueAtTime(0.65, now);
      oscGain.gain.exponentialRampToValueAtTime(0.001, now + 2.5);

      osc.connect(oscGain);
      oscGain.connect(this.weatherGain);
      osc.start(now);
      osc.stop(now + 2.6);

      // 2. 轟鳴雜訊破空聲 (Noise Rumble)
      try {
        const noise = this.ctx.createBufferSource();
        noise.buffer = this.createNoiseBuffer(3.5);
        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(450, now);
        filter.frequency.exponentialRampToValueAtTime(120, now + 3.0);

        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.85, now + 0.05);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 3.2);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(this.weatherGain);

        noise.start(now);
        noise.stop(now + 3.3);
      } catch (e) {
        // ignore
      }
    }, Math.max(0, delaySec * 1000));
  }

  /**
   * 每幀平滑同步音量與濾波參數
   */
  public update(rainIntensity: number, windSpeedMps: number, isNight: boolean): void {
    if (!this.ctx || !this.isInitialized) return;

    const now = this.ctx.currentTime;
    const smoothTime = 0.25;

    // 雨聲音量
    if (this.rainGain && this.rainFilter) {
      const targetRainGain = rainIntensity > 0.01 ? Math.min(0.85, rainIntensity * 0.75) : 0.0;
      this.rainGain.gain.setTargetAtTime(targetRainGain, now, smoothTime);
      const targetFreq = 900 + rainIntensity * 1200;
      this.rainFilter.frequency.setTargetAtTime(targetFreq, now, smoothTime);
    }

    // 風聲音量
    if (this.windGain && this.windFilter) {
      const normalizedWind = Math.min(1.0, windSpeedMps / 25.0);
      const targetWindGain = 0.03 + normalizedWind * 0.45;
      this.windGain.gain.setTargetAtTime(targetWindGain, now, smoothTime);
      const targetWindFreq = 220 + normalizedWind * 550;
      this.windFilter.frequency.setTargetAtTime(targetWindFreq, now, smoothTime);
    }

    // 夜間蟲鳴 (晴朗安靜的夜晚顯現)
    if (this.cricketGain && this.cricketModGain) {
      const targetCricket = isNight && rainIntensity < 0.15 ? 0.045 : 0.0;
      this.cricketGain.gain.setTargetAtTime(targetCricket, now, 0.5);

      if (targetCricket > 0) {
        // 脈衝震盪調製
        const pulse = Math.sin(now * 16.0) > 0.2 ? 1.0 : 0.1;
        this.cricketModGain.gain.setValueAtTime(pulse, now);
      }
    }
  }

  /**
   * 設定騎樓遮蔽 (進入騎樓時低通濾波變悶)
   */
  public setOcclusion(occluded: boolean): void {
    if (!this.ctx || !this.occlusionFilter) return;
    this.isOccluded = occluded;
    const targetFreq = occluded ? CONFIG.AUDIO.OCCLUSION_FILTER_FREQ : CONFIG.AUDIO.OPEN_AIR_FILTER_FREQ;
    this.occlusionFilter.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.4);
  }

  public getIsOccluded(): boolean {
    return this.isOccluded;
  }

  public setMasterVolume(vol: number): void {
    this.masterVol = Math.max(0, Math.min(1, vol));
    if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(this.masterVol, this.ctx.currentTime, 0.1);
    }
  }

  public setWeatherVolume(vol: number): void {
    this.weatherVol = Math.max(0, Math.min(1, vol));
    if (this.ctx && this.weatherGain) {
      this.weatherGain.gain.setTargetAtTime(this.weatherVol, this.ctx.currentTime, 0.1);
    }
  }

  public getMasterVolume(): number {
    return this.masterVol;
  }

  public getWeatherVolume(): number {
    return this.weatherVol;
  }
}
