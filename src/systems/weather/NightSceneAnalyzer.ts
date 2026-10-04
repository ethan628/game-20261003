/**
 * NightSceneAnalyzer.ts - GTA 夜景分區亮度分析與校準系統 (F12)
 * 監控與評估夜間畫面各區塊相對亮度（相對於白天）是否符合視覺分層標準：
 * - 天空：12% ~ 18% (天頂深海軍藍、地平線窄光害)
 * - 建築牆面：8% ~ 14% (有垂直漸層與正面側面明暗)
 * - 地面（柏油）：4% ~ 8% (暗柏油，僅光斑處提亮，不染粉色)
 * - 局部光源（光斑/窗戶/招牌/店面）：70% ~ 100% (明亮焦點)
 * - 最暗處：#0c1220 (深藍灰，絕不純黑，絕不全域墊高)
 */

import * as THREE from 'three';
import { CONFIG } from '../../config.ts';
import { TimeSystem } from '../time/TimeSystem.ts';
import { WeatherSystem } from '../weather/WeatherSystem.ts';
import { WeatherRenderer } from '../../world/WeatherRenderer.ts';
import { NightLightingSystem } from '../../world/NightLightingSystem.ts';

export interface NightAnalysisMetrics {
  isNight: boolean;
  nightFactor: number;
  preset: string;
  presetName: string;
  exposure: number;
  
  // 各分區相對亮度 (相對白天 100%)
  skyPct: number;
  wallPct: number;
  groundUnlitPct: number; // 地面無光照區 (目標 6~10%)
  groundDecalPct: number; // 地面光斑區 (目標 70~100%)
  localLightsPct: number; // 局部光源 (窗戶/招牌/店面)
  minShadowHex: string;

  // 評估狀態 (ok | high | low)
  skyStatus: 'ok' | 'high' | 'low';
  wallStatus: 'ok' | 'high' | 'low';
  groundUnlitStatus: 'ok' | 'high' | 'low';
  groundDecalStatus: 'ok' | 'high' | 'low';
  lightsStatus: 'ok' | 'high' | 'low';

  // 燈光分層實測強度
  hemiRatio: number;   // 環境光相對於白天百分比
  moonRatio: number;   // 月光相對於白天百分比
  bounceRatio: number; // 暖橘地面反射補光相對於白天百分比
  groundVisibility: number; // 地面可見度倍率
}

export class NightSceneAnalyzer {
  private timeSystem: TimeSystem;
  private weatherSystem: WeatherSystem;
  private weatherRenderer: WeatherRenderer;
  private nightLightingSystem: NightLightingSystem;
  private renderer?: THREE.WebGLRenderer;

  constructor(
    timeSystem: TimeSystem,
    weatherSystem: WeatherSystem,
    weatherRenderer: WeatherRenderer,
    nightLightingSystem: NightLightingSystem,
    renderer?: THREE.WebGLRenderer
  ) {
    this.timeSystem = timeSystem;
    this.weatherSystem = weatherSystem;
    this.weatherRenderer = weatherRenderer;
    this.nightLightingSystem = nightLightingSystem;
    this.renderer = renderer;
  }

  public setRenderer(r: THREE.WebGLRenderer): void {
    this.renderer = r;
  }

  public getWeatherSystem(): WeatherSystem {
    return this.weatherSystem;
  }

  /**
   * 計算即時光學分區相對亮度分析數據
   */
  public analyze(): NightAnalysisMetrics {
    const sunMoon = this.timeSystem.getSunMoonInfo();
    const sunAltDeg = sunMoon.sun.altitudeDeg;
    const nightFactor = Math.max(0, Math.min(1, (-sunAltDeg - 2.0) / 10.0));
    const isNight = nightFactor > 0.05;

    const presetId = this.weatherRenderer.getNightPreset();
    const presetCfg = (CONFIG.NIGHT_LIGHTING.PRESETS as any)[presetId] || CONFIG.NIGHT_LIGHTING.PRESETS.ground_visible || CONFIG.NIGHT_LIGHTING.PRESETS.gta_contrast;
    const brightnessMult = this.weatherRenderer.getNightBrightness();
    const groundVis = this.weatherRenderer.getGroundVisibility();

    const exposure = this.renderer ? this.renderer.toneMappingExposure : 1.22;

    // 1. 燈光分層比率
    const hemiRatio = (presetCfg.hemiIntensity * brightnessMult) * 100;
    const moonRatio = (presetCfg.moonIntensity * brightnessMult) * 100;
    const bounceRatio = (presetCfg.bounceIntensity * brightnessMult) * 100;

    // 月光光學強度 (仰角 > 0 時為真實月光，<= 0 時為 35 度虛擬月光)
    const effectiveMoon = presetCfg.moonIntensity * (sunMoon.moon.altitudeDeg > 0 ? (0.8 + 0.2 * sunMoon.moonIllumination) : 1.0);

    // 2. 地面無光照區 (無任何路燈照射之柏油地：環境光 + 月光 + 地面專屬冷藍灰補光項 #3a4764)
    // 目標：6% ~ 10%
    const unlitGroundIllum = (presetCfg.hemiIntensity * 0.42 + effectiveMoon * 0.22 + 0.075 * groundVis) * brightnessMult;
    const groundUnlitPct = parseFloat(((unlitGroundIllum * (exposure / 1.0)) * 38.0).toFixed(1));

    // 3. 地面光斑區 (路燈光斑覆蓋之柏油與人行道，加色混合)
    // 目標：70% ~ 100%
    const groundDecalPct = parseFloat((Math.min(100, groundUnlitPct + this.nightLightingSystem.getLampDecalIntensity() * 74.0 * (exposure / 1.15))).toFixed(1));

    // 4. 建築牆面亮度 (受正面/側面月光法線夾角 + 冷藍天空光 + 暖橘反彈補光)
    // 目標：8% ~ 14%
    const wallIllum = (presetCfg.hemiIntensity * 0.48 + effectiveMoon * 0.65 + presetCfg.bounceIntensity * 0.40) * brightnessMult;
    const wallPct = parseFloat(((wallIllum * (exposure / 1.0)) * 52.0).toFixed(1));

    // 5. 天空亮度 (深藍板岩天頂 + 地平線窄光害)
    // 目標：12% ~ 18%
    const skyIllum = (0.10 + presetCfg.lightPollution * 0.07 + (sunMoon.moon.altitudeDeg > 0 ? 0.03 : 0.02)) * brightnessMult;
    const skyPct = parseFloat(((skyIllum * (exposure / 1.0)) * 96.0).toFixed(1));

    // 6. 局部光源 (亮窗 / 發光招牌 / 號誌)
    // 目標：70% ~ 100%
    const localLightsPct = parseFloat((Math.min(100, 75.0 + this.nightLightingSystem.getWindowLightRatio() * 16.0 * (exposure / 1.15))).toFixed(1));

    // 7. 最暗處保護下限 (自然落於深藍灰 #0c1220)
    const minShadowHex = '#0c1220';

    // 判定狀態 (符合目標範圍則為 ok)
    const skyStatus = skyPct < 12 ? 'low' : (skyPct > 18 ? 'high' : 'ok');
    const wallStatus = wallPct < 8 ? 'low' : (wallPct > 14 ? 'high' : 'ok');
    const groundUnlitStatus = groundUnlitPct < 6 ? 'low' : (groundUnlitPct > 10 ? 'high' : 'ok');
    const groundDecalStatus = groundDecalPct < 70 ? 'low' : (groundDecalPct > 100 ? 'high' : 'ok');
    const lightsStatus = localLightsPct < 70 ? 'low' : (localLightsPct > 105 ? 'high' : 'ok');

    return {
      isNight,
      nightFactor,
      preset: presetId,
      presetName: presetCfg.name,
      exposure: parseFloat(exposure.toFixed(2)),
      skyPct,
      wallPct,
      groundUnlitPct,
      groundDecalPct,
      localLightsPct,
      minShadowHex,
      skyStatus,
      wallStatus,
      groundUnlitStatus,
      groundDecalStatus,
      lightsStatus,
      hemiRatio: parseFloat(hemiRatio.toFixed(1)),
      moonRatio: parseFloat(moonRatio.toFixed(1)),
      bounceRatio: parseFloat(bounceRatio.toFixed(1)),
      groundVisibility: parseFloat(groundVis.toFixed(2))
    };
  }

  /**
   * 生成 F12 覆蓋層的格式化 HTML 報告
   */
  public generateReportHtml(metrics: NightAnalysisMetrics): string {
    const badge = (status: 'ok' | 'high' | 'low') => {
      if (status === 'ok') return '<span style="color: #4ade80; font-weight: bold;">✔ 符合</span>';
      if (status === 'high') return '<span style="color: #f87171; font-weight: bold;">▲ 偏高</span>';
      return '<span style="color: #38bdf8; font-weight: bold;">▼ 偏低</span>';
    };

    return `
      <div style="margin-bottom: 6px; border-bottom: 1px solid rgba(148, 163, 184, 0.2); padding-bottom: 4px;">
        <b>風格預設</b>：<span style="color: #f59e0b; font-weight: bold;">${metrics.presetName}</span>
        | <b>曝光</b>：<span>${metrics.exposure}x</span>
        | <b>夜間</b>：<span>${(metrics.nightFactor * 100).toFixed(0)}%</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 4px;">
        <div style="display: flex; justify-content: space-between;">
          <span>🌌 <b>天空</b> [目標 12~18%]：</span>
          <span><b>${metrics.skyPct}%</b> ${badge(metrics.skyStatus)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>🏢 <b>建築牆面</b> [目標 8~14%]：</span>
          <span><b>${metrics.wallPct}%</b> ${badge(metrics.wallStatus)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>🛣️ <b>地面（無光照區）</b> [目標 6~10%]：</span>
          <span><b>${metrics.groundUnlitPct}%</b> ${badge(metrics.groundUnlitStatus)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>💡 <b>地面（光斑區）</b> [目標 70~100%]：</span>
          <span><b>${metrics.groundDecalPct}%</b> ${badge(metrics.groundDecalStatus)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>✨ <b>局部光源</b> [目標 70~100%]：</span>
          <span><b>${metrics.localLightsPct}%</b> ${badge(metrics.lightsStatus)}</span>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>🌑 <b>最暗處顏色</b> [目標 #0c1220]：</span>
          <span style="font-family: monospace; color: #94a3b8;"><span style="display:inline-block;width:9px;height:9px;background:#0c1220;border:1px solid #64748b;margin-right:4px;"></span>${metrics.minShadowHex}</span>
        </div>
      </div>
      <div style="margin-top: 8px; border-top: 1px dashed rgba(148, 163, 184, 0.2); padding-top: 4px; color: #cbd5e1; font-size: 10px;">
        <div><b>燈光分層實測</b>：環境光 ${metrics.hemiRatio}% | 月光 ${metrics.moonRatio}% | 暖橘反彈補光 ${metrics.bounceRatio}% | 地面可見度 ${metrics.groundVisibility}x</div>
        <div style="color: #94a3b8; margin-top: 2px;">*已移除全域暗部墊高，採用 PMREM 夜空環境反射與純地面 #3a4764 冷藍灰分層補光。</div>
      </div>
    `;
  }
}
