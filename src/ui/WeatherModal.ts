/**
 * WeatherModal.ts - 天氣與時間控制面板 (快捷鍵 K)
 * 遵循 RULES.md：UI 獨立模組、支援現實/虛擬獨立切換、Open-Meteo 版權聲明
 */

import { TimeSystem } from '../systems/time/TimeSystem.ts';
import { WeatherSystem } from '../systems/weather/WeatherSystem.ts';
import { WeatherAudioManager } from '../core/WeatherAudioManager.ts';
import { WeatherStateType } from '../geo/WeatherTypes.ts';
import { NightLightingSystem } from '../world/NightLightingSystem.ts';
import { WeatherRenderer } from '../world/WeatherRenderer.ts';

export class WeatherModal {
  private el: HTMLDivElement;
  private timeSystem: TimeSystem;
  private weatherSystem: WeatherSystem;
  private audioManager?: WeatherAudioManager;
  private nightLightingSystem?: NightLightingSystem;
  private weatherRenderer?: WeatherRenderer;

  private isVisible = false;
  private onToggleVisibilityCallback?: (visible: boolean) => void;

  constructor(
    timeSystem: TimeSystem,
    weatherSystem: WeatherSystem,
    audioManager?: WeatherAudioManager,
    nightLightingSystem?: NightLightingSystem,
    weatherRenderer?: WeatherRenderer
  ) {
    this.timeSystem = timeSystem;
    this.weatherSystem = weatherSystem;
    this.audioManager = audioManager;
    this.nightLightingSystem = nightLightingSystem;
    this.weatherRenderer = weatherRenderer;

    this.el = document.createElement('div');
    this.el.id = 'weather-modal';
    this.el.className = 'overlay-backdrop hidden';
    this.el.innerHTML = `
      <div class="modal-card" style="max-width: 620px; max-height: 90vh; overflow-y: auto;">
        <div class="modal-header">
          <h2>⏱️ 天氣與時間控制面板</h2>
          <button id="weather-modal-close-btn" class="close-btn" title="關閉">&times;</button>
        </div>

        <div class="modal-body" style="display: flex; flex-direction: column; gap: 16px;">
          <!-- 1. 時間系統設定 -->
          <div style="background: rgba(15, 23, 42, 0.6); padding: 14px; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.2);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="font-weight: 600; font-size: 15px; color: #38bdf8;">🕒 時間系統</span>
              <div style="display: flex; gap: 6px;">
                <button id="btn-time-mode-real" class="btn" style="padding: 4px 10px; font-size: 12px;">現實時間</button>
                <button id="btn-time-mode-virtual" class="btn" style="padding: 4px 10px; font-size: 12px;">虛擬時間</button>
              </div>
            </div>

            <!-- 現實時間資訊區 -->
            <div id="time-real-info" style="font-size: 13px; color: #cbd5e1; display: none; line-height: 1.6;">
              <div>當地時間：<b id="lbl-real-time-val" style="color: #f8fafc;">--:--:--</b></div>
              <div>地點時區：<span id="lbl-real-timezone">Asia/Taipei</span> (與使用者電腦獨立)</div>
              <div>太陽高度角：<span id="lbl-sun-altitude">--°</span> | 暮光階段：<span id="lbl-twilight-phase">--</span></div>
            </div>

            <!-- 虛擬時間控制區 -->
            <div id="time-virtual-controls" style="display: none; flex-direction: column; gap: 10px;">
              <div style="display: flex; justify-content: space-between; font-size: 13px; color: #cbd5e1;">
                <span>時間調整 (0~24h)：</span>
                <b id="lbl-virtual-hour-val" style="color: #38bdf8; font-size: 15px;">17:30</b>
              </div>
              <input type="range" id="slider-virtual-hour" min="0" max="23.99" step="0.05" value="17.5" style="width: 100%; accent-color: #38bdf8;" />

              <div style="margin-top: 6px;">
                <div style="font-size: 12px; color: #94a3b8; margin-bottom: 4px;">時間流速：</div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;" id="time-rate-btn-group">
                  <button class="btn rate-btn" data-rate="0" style="padding: 3px 8px; font-size: 11px;">暫停</button>
                  <button class="btn rate-btn" data-rate="1" style="padding: 3px 8px; font-size: 11px;">1x (即時)</button>
                  <button class="btn rate-btn" data-rate="10" style="padding: 3px 8px; font-size: 11px;">10x</button>
                  <button class="btn rate-btn" data-rate="60" style="padding: 3px 8px; font-size: 11px;">60x</button>
                  <button class="btn rate-btn" data-rate="60" data-label="24min" style="padding: 3px 8px; font-size: 11px;">1天=24分</button>
                  <button class="btn rate-btn" data-rate="24" data-label="60min" style="padding: 3px 8px; font-size: 11px;">1天=60分</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 2. 天氣系統設定 -->
          <div style="background: rgba(15, 23, 42, 0.6); padding: 14px; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.2);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
              <span style="font-weight: 600; font-size: 15px; color: #fbbf24;">🌤️ 天候系統</span>
              <div style="display: flex; gap: 6px;">
                <button id="btn-weather-mode-real" class="btn" style="padding: 4px 10px; font-size: 12px;">即時天氣</button>
                <button id="btn-weather-mode-virtual" class="btn" style="padding: 4px 10px; font-size: 12px;">虛擬天氣</button>
              </div>
            </div>

            <!-- 現實天氣資訊區 -->
            <div id="weather-real-info" style="font-size: 13px; color: #cbd5e1; display: none; line-height: 1.6;">
              <div style="display: flex; justify-content: space-between;">
                <div>當前天候：<b id="lbl-live-weather-desc" style="color: #fde047;">晴天</b></div>
                <div>氣溫：<b id="lbl-live-temp" style="color: #f8fafc;">--°C</b></div>
              </div>
              <div style="display: flex; justify-content: space-between; margin-top: 2px;">
                <div>降雨量：<span id="lbl-live-precip">0.0 mm/h</span></div>
                <div>相對濕度：<span id="lbl-live-humidity">--%</span></div>
              </div>
              <div style="display: flex; justify-content: space-between; margin-top: 2px;">
                <div>風速：<span id="lbl-live-wind">-- km/h</span></div>
                <div>雲量：<span id="lbl-live-cloud">--%</span></div>
              </div>
              <div style="margin-top: 6px; padding: 6px 8px; background: rgba(30, 41, 59, 0.7); border-radius: 6px; font-size: 11px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <span id="lbl-weather-source-badge" style="color: #38bdf8; font-weight: 600;">資料來源：連線即時</span>
                    <span id="lbl-weather-age" style="color: #94a3b8; margin-left: 6px;">(剛抓取)</span>
                  </div>
                  <button id="btn-force-refresh-weather" class="btn" style="padding: 2px 8px; font-size: 11px; background: #0284c7; color: white;">🔄 手動更新即時天氣</button>
                </div>
                <div id="lbl-weather-diag" style="color: #94a3b8; margin-top: 3px; font-family: monospace; font-size: 10px;">HTTP 200 OK</div>
              </div>
              <div style="margin-top: 4px; font-size: 10px; color: #64748b; text-align: right;">
                Weather data by Open-Meteo.com
              </div>
            </div>

            <!-- 虛擬天氣控制區 -->
            <div id="weather-virtual-controls" style="display: none; flex-direction: column; gap: 10px;">
              <div>
                <div style="font-size: 12px; color: #94a3b8; margin-bottom: 6px;">天氣預設快捷選擇：</div>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;" id="weather-preset-grid">
                  <button class="btn preset-btn" data-type="clear" style="padding: 4px;">☀️ 晴天</button>
                  <button class="btn preset-btn" data-type="cloudy" style="padding: 4px;">⛅ 多雲</button>
                  <button class="btn preset-btn" data-type="overcast" style="padding: 4px;">☁️ 陰天</button>
                  <button class="btn preset-btn" data-type="fog" style="padding: 4px;">🌫️ 大霧</button>
                  <button class="btn preset-btn" data-type="light_rain" style="padding: 4px;">🌦️ 小雨</button>
                  <button class="btn preset-btn" data-type="heavy_rain" style="padding: 4px;">🌧️ 大雨</button>
                  <button class="btn preset-btn" data-type="thunderstorm" style="padding: 4px;">⛈️ 雷雨</button>
                  <button class="btn preset-btn" data-type="typhoon" style="padding: 4px;">🌀 颱風</button>
                </div>
              </div>

              <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 4px;">
                <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: #cbd5e1; cursor: pointer;">
                  <input type="checkbox" id="chk-weather-auto" style="accent-color: #38bdf8;" />
                  <span>自動隨機天氣變化 (自然過渡)</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: #38bdf8; cursor: pointer;">
                  <input type="checkbox" id="chk-weather-instant-apply" style="accent-color: #38bdf8;" />
                  <span>立即套用 (跳過漸變)</span>
                </label>
                <button type="button" id="btn-instant-dry-road" class="btn" style="padding: 2px 8px; font-size: 11px; background: rgba(56, 189, 248, 0.2); border: 1px solid #38bdf8; color: #38bdf8; border-radius: 4px;">
                  🧹 立即乾燥路面
                </button>
              </div>

              <!-- 自訂細部滑桿 -->
              <details style="margin-top: 4px; font-size: 12px; color: #94a3b8;">
                <summary style="cursor: pointer; color: #38bdf8;">進階手動天候數值微調 (雨/雲/霧/風)</summary>
                <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
                  <div>
                    <div style="display: flex; justify-content: space-between;"><span>雨量強度</span><span id="lbl-slider-rain">0%</span></div>
                    <input type="range" id="slider-rain" min="0" max="1" step="0.02" value="0" style="width: 100%; accent-color: #38bdf8;" />
                  </div>
                  <div>
                    <div style="display: flex; justify-content: space-between;"><span>雲層覆蓋</span><span id="lbl-slider-cloud">10%</span></div>
                    <input type="range" id="slider-cloud" min="0" max="1" step="0.02" value="0.1" style="width: 100%; accent-color: #38bdf8;" />
                  </div>
                  <div>
                    <div style="display: flex; justify-content: space-between;"><span>濃霧倍率</span><span id="lbl-slider-fog">0.2x</span></div>
                    <input type="range" id="slider-fog" min="0" max="3" step="0.05" value="0.2" style="width: 100%; accent-color: #38bdf8;" />
                  </div>
                  <div>
                    <div style="display: flex; justify-content: space-between;"><span>風速</span><span id="lbl-slider-wind">3.0 m/s</span></div>
                    <input type="range" id="slider-wind" min="0" max="30" step="0.5" value="3.0" style="width: 100%; accent-color: #38bdf8;" />
                  </div>
                </div>
              </details>
            </div>
          </div>

          <!-- 3. 音效設定 -->
          <div style="background: rgba(15, 23, 42, 0.6); padding: 14px; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.2);">
            <div style="font-weight: 600; font-size: 15px; color: #a78bfa; margin-bottom: 8px;">🔊 音量控制 (程序合成音效)</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;"><span>主音量</span><span id="lbl-vol-master">80%</span></div>
                <input type="range" id="slider-vol-master" min="0" max="1" step="0.05" value="0.8" style="width: 100%; accent-color: #a78bfa;" />
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;"><span>天候音效</span><span id="lbl-vol-weather">70%</span></div>
                <input type="range" id="slider-vol-weather" min="0" max="1" step="0.05" value="0.7" style="width: 100%; accent-color: #a78bfa;" />
              </div>
            </div>
          </div>

          <!-- 4. GTA 夜景氛圍與假光微調 -->
          <div style="background: rgba(15, 23, 42, 0.6); padding: 14px; border-radius: 8px; border: 1px solid rgba(148, 163, 184, 0.2);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span style="font-weight: 600; font-size: 15px; color: #f59e0b;">🌃 GTA 城市夜景微調</span>
              <span style="font-size: 11px; color: #94a3b8;">即時寫入 localStorage</span>
            </div>

            <!-- 夜景風格預設切換 -->
            <div style="margin-bottom: 10px;">
              <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 4px;">風格預設模式：</div>
              <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;">
                <button type="button" id="btn-night-preset-visible" class="btn" style="font-size: 11px; padding: 5px 2px;">地面可見 (預設)</button>
                <button type="button" id="btn-night-preset-gta" class="btn" style="font-size: 11px; padding: 5px 2px;">GTA 對比</button>
                <button type="button" id="btn-night-preset-soft" class="btn" style="font-size: 11px; padding: 5px 2px;">柔和風格</button>
                <button type="button" id="btn-night-preset-dim" class="btn" style="font-size: 11px; padding: 5px 2px;">昏暗風格</button>
              </div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 8px;">
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;">
                  <span>地面可見度 (無路燈區冷藍灰地表補光)</span>
                  <span id="lbl-ground-visibility">1.00x</span>
                </div>
                <input type="range" id="slider-ground-visibility" min="0.5" max="2.0" step="0.05" value="1.0" style="width: 100%; accent-color: #38bdf8;" />
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;">
                  <span>夜晚亮度 (月光與環境光強度，不拉高全域)</span>
                  <span id="lbl-night-brightness">1.00x</span>
                </div>
                <input type="range" id="slider-night-brightness" min="0.6" max="1.4" step="0.05" value="1.0" style="width: 100%; accent-color: #f59e0b;" />
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;">
                  <span>路燈地面光斑強度</span>
                  <span id="lbl-lamp-decal-intensity">1.0x</span>
                </div>
                <input type="range" id="slider-lamp-decal" min="0.0" max="2.0" step="0.05" value="1.0" style="width: 100%; accent-color: #f59e0b;" />
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;">
                  <span>建築窗戶夜間亮燈比例</span>
                  <span id="lbl-window-light-ratio">50%</span>
                </div>
                <input type="range" id="slider-window-light" min="0.0" max="1.0" step="0.05" value="0.5" style="width: 100%; accent-color: #f59e0b;" />
              </div>
              <div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #cbd5e1;">
                  <span>天空地平線城市光害強度</span>
                  <span id="lbl-urban-pollution">0.6x</span>
                </div>
                <input type="range" id="slider-urban-pollution" min="0.0" max="1.5" step="0.05" value="0.6" style="width: 100%; accent-color: #f59e0b;" />
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer" style="margin-top: 16px; display: flex; justify-content: flex-end;">
          <button id="btn-weather-modal-close" class="btn primary">關閉 (K / Esc)</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.el);
    this.bindEvents();
    this.refreshUI();
  }

  public setOnToggleVisibility(cb: (visible: boolean) => void): void {
    this.onToggleVisibilityCallback = cb;
  }

  public toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  public show(): void {
    this.isVisible = true;
    this.el.classList.remove('hidden');
    this.refreshUI();
    this.onToggleVisibilityCallback?.(true);
  }

  public hide(): void {
    this.isVisible = false;
    this.el.classList.add('hidden');
    this.onToggleVisibilityCallback?.(false);
  }

  public getIsVisible(): boolean {
    return this.isVisible;
  }

  private bindEvents(): void {
    // 關閉按鈕
    this.el.querySelector('#weather-modal-close-btn')?.addEventListener('click', () => this.hide());
    this.el.querySelector('#btn-weather-modal-close')?.addEventListener('click', () => this.hide());

    // 時間模式切換
    const btnTimeReal = this.el.querySelector('#btn-time-mode-real') as HTMLButtonElement;
    const btnTimeVirtual = this.el.querySelector('#btn-time-mode-virtual') as HTMLButtonElement;

    btnTimeReal?.addEventListener('click', () => {
      this.timeSystem.setMode('real');
      this.refreshUI();
    });
    btnTimeVirtual?.addEventListener('click', () => {
      this.timeSystem.setMode('virtual');
      this.refreshUI();
    });

    // 虛擬時間滑桿
    const sliderVirtualHour = this.el.querySelector('#slider-virtual-hour') as HTMLInputElement;
    sliderVirtualHour?.addEventListener('input', () => {
      const h = parseFloat(sliderVirtualHour.value);
      this.timeSystem.setVirtualHour(h);
      this.updateHourLabel(h);
    });

    // 流速按鈕
    const rateBtns = this.el.querySelectorAll('.rate-btn');
    rateBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const rate = parseFloat((btn as HTMLElement).dataset.rate || '1');
        this.timeSystem.setTimeRate(rate);
        this.updateRateButtons();
      });
    });

    // 天氣模式切換
    const btnWeatherReal = this.el.querySelector('#btn-weather-mode-real') as HTMLButtonElement;
    const btnWeatherVirtual = this.el.querySelector('#btn-weather-mode-virtual') as HTMLButtonElement;

    btnWeatherReal?.addEventListener('click', () => {
      this.weatherSystem.setMode('real');
      this.refreshUI();
    });
    btnWeatherVirtual?.addEventListener('click', () => {
      this.weatherSystem.setMode('virtual');
      this.refreshUI();
    });

    // 天氣預設按鈕
    const presetBtns = this.el.querySelectorAll('.preset-btn');
    presetBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const type = (btn as HTMLElement).dataset.type as WeatherStateType;
        this.weatherSystem.setVirtualType(type);
        this.updatePresetButtons();
        const transInfo = this.weatherSystem.getTransitionInfo();
        this.syncManualSlidersWithTarget(transInfo.targetParams);
      });
    });

    // 立即套用核取方塊
    const chkInstant = this.el.querySelector('#chk-weather-instant-apply') as HTMLInputElement;
    chkInstant?.addEventListener('change', () => {
      this.weatherSystem.setInstantApply(chkInstant.checked);
    });

    // 立即乾燥路面按鈕
    const btnDry = this.el.querySelector('#btn-instant-dry-road') as HTMLButtonElement;
    btnDry?.addEventListener('click', () => {
      this.weatherSystem.instantDryRoad();
      btnDry.textContent = '✨ 路面已乾燥';
      setTimeout(() => { btnDry.textContent = '🧹 立即乾燥路面'; }, 1500);
    });

    // 自動隨機變化
    const chkAuto = this.el.querySelector('#chk-weather-auto') as HTMLInputElement;
    chkAuto?.addEventListener('change', () => {
      this.weatherSystem.setAutoChange(chkAuto.checked);
    });

    // 細部滑桿
    const sRain = this.el.querySelector('#slider-rain') as HTMLInputElement;
    const sCloud = this.el.querySelector('#slider-cloud') as HTMLInputElement;
    const sFog = this.el.querySelector('#slider-fog') as HTMLInputElement;
    const sWind = this.el.querySelector('#slider-wind') as HTMLInputElement;

    sRain?.addEventListener('input', () => {
      const v = parseFloat(sRain.value);
      this.weatherSystem.setCustomParams({ rainIntensity: v });
      this.el.querySelector('#lbl-slider-rain')!.textContent = `${Math.round(v * 100)}%`;
    });
    sCloud?.addEventListener('input', () => {
      const v = parseFloat(sCloud.value);
      this.weatherSystem.setCustomParams({ cloudCover: v });
      this.el.querySelector('#lbl-slider-cloud')!.textContent = `${Math.round(v * 100)}%`;
    });
    sFog?.addEventListener('input', () => {
      const v = parseFloat(sFog.value);
      this.weatherSystem.setCustomParams({ fogDensity: v });
      this.el.querySelector('#lbl-slider-fog')!.textContent = `${v.toFixed(2)}x`;
    });
    sWind?.addEventListener('input', () => {
      const v = parseFloat(sWind.value);
      this.weatherSystem.setCustomParams({ windSpeedMps: v });
      this.el.querySelector('#lbl-slider-wind')!.textContent = `${v.toFixed(1)} m/s`;
    });

    // 音量滑桿
    const sVolMaster = this.el.querySelector('#slider-vol-master') as HTMLInputElement;
    const sVolWeather = this.el.querySelector('#slider-vol-weather') as HTMLInputElement;

    sVolMaster?.addEventListener('input', () => {
      const v = parseFloat(sVolMaster.value);
      this.audioManager?.setMasterVolume(v);
      this.el.querySelector('#lbl-vol-master')!.textContent = `${Math.round(v * 100)}%`;
    });
    sVolWeather?.addEventListener('input', () => {
      const v = parseFloat(sVolWeather.value);
      this.audioManager?.setWeatherVolume(v);
      this.el.querySelector('#lbl-vol-weather')!.textContent = `${Math.round(v * 100)}%`;
    });

    // 4. 手動連線更新即時天氣按鈕
    const btnForceRefresh = this.el.querySelector('#btn-force-refresh-weather') as HTMLButtonElement;
    btnForceRefresh?.addEventListener('click', async () => {
      btnForceRefresh.textContent = '⏳ 連線更新中...';
      btnForceRefresh.disabled = true;
      try {
        await this.weatherSystem.forceRefreshLiveWeather();
      } finally {
        btnForceRefresh.textContent = '🔄 手動更新即時天氣';
        btnForceRefresh.disabled = false;
        this.refreshUI();
      }
    });

    // 5. GTA 夜景微調滑桿
    const sGroundVis = this.el.querySelector('#slider-ground-visibility') as HTMLInputElement;
    const sNightBri = this.el.querySelector('#slider-night-brightness') as HTMLInputElement;
    const sLampDecal = this.el.querySelector('#slider-lamp-decal') as HTMLInputElement;
    const sWinLight = this.el.querySelector('#slider-window-light') as HTMLInputElement;
    const sUrbanPol = this.el.querySelector('#slider-urban-pollution') as HTMLInputElement;

    sGroundVis?.addEventListener('input', () => {
      const v = parseFloat(sGroundVis.value);
      this.weatherRenderer?.setGroundVisibility(v);
      this.el.querySelector('#lbl-ground-visibility')!.textContent = `${v.toFixed(2)}x`;
      this.saveNightSettings();
    });

    sNightBri?.addEventListener('input', () => {
      const v = parseFloat(sNightBri.value);
      this.nightLightingSystem?.setBaseNightBrightness(v);
      this.weatherRenderer?.setNightBrightness(v);
      this.el.querySelector('#lbl-night-brightness')!.textContent = `${v.toFixed(2)}x`;
      this.saveNightSettings();
    });

    sLampDecal?.addEventListener('input', () => {
      const v = parseFloat(sLampDecal.value);
      this.nightLightingSystem?.setLampDecalIntensity(v);
      this.el.querySelector('#lbl-lamp-decal-intensity')!.textContent = `${v.toFixed(2)}x`;
      this.saveNightSettings();
    });

    sWinLight?.addEventListener('input', () => {
      const v = parseFloat(sWinLight.value);
      this.nightLightingSystem?.setWindowLightRatio(v);
      this.el.querySelector('#lbl-window-light-ratio')!.textContent = `${Math.round(v * 100)}%`;
      this.saveNightSettings();
    });

    sUrbanPol?.addEventListener('input', () => {
      const v = parseFloat(sUrbanPol.value);
      this.nightLightingSystem?.setUrbanLightPollution(v);
      this.weatherRenderer?.setUrbanLightPollution(v);
      this.el.querySelector('#lbl-urban-pollution')!.textContent = `${v.toFixed(2)}x`;
      this.saveNightSettings();
    });

    // 6. GTA 夜景風格預設按鈕
    const btnPresetVisible = this.el.querySelector('#btn-night-preset-visible') as HTMLButtonElement;
    const btnPresetGta = this.el.querySelector('#btn-night-preset-gta') as HTMLButtonElement;
    const btnPresetSoft = this.el.querySelector('#btn-night-preset-soft') as HTMLButtonElement;
    const btnPresetDim = this.el.querySelector('#btn-night-preset-dim') as HTMLButtonElement;

    const setPreset = (preset: 'ground_visible' | 'gta_contrast' | 'soft' | 'dim') => {
      this.weatherRenderer?.setNightPreset(preset);
      this.refreshNightPresetButtons();
    };

    btnPresetVisible?.addEventListener('click', () => setPreset('ground_visible'));
    btnPresetGta?.addEventListener('click', () => setPreset('gta_contrast'));
    btnPresetSoft?.addEventListener('click', () => setPreset('soft'));
    btnPresetDim?.addEventListener('click', () => setPreset('dim'));
  }

  private syncManualSlidersWithTarget(params: any): void {
    if (!params) return;
    const sRain = this.el.querySelector('#slider-rain') as HTMLInputElement;
    const sCloud = this.el.querySelector('#slider-cloud') as HTMLInputElement;
    const sFog = this.el.querySelector('#slider-fog') as HTMLInputElement;
    const sWind = this.el.querySelector('#slider-wind') as HTMLInputElement;

    if (sRain && params.rainIntensity !== undefined) {
      sRain.value = params.rainIntensity.toString();
      this.el.querySelector('#lbl-slider-rain')!.textContent = `${Math.round(params.rainIntensity * 100)}%`;
    }
    if (sCloud && params.cloudCover !== undefined) {
      sCloud.value = params.cloudCover.toString();
      this.el.querySelector('#lbl-slider-cloud')!.textContent = `${Math.round(params.cloudCover * 100)}%`;
    }
    if (sFog && params.fogDensity !== undefined) {
      sFog.value = params.fogDensity.toString();
      this.el.querySelector('#lbl-slider-fog')!.textContent = `${params.fogDensity.toFixed(2)}x`;
    }
    if (sWind && params.windSpeedMps !== undefined) {
      sWind.value = params.windSpeedMps.toString();
      this.el.querySelector('#lbl-slider-wind')!.textContent = `${params.windSpeedMps.toFixed(1)} m/s`;
    }
  }

  private refreshNightPresetButtons(): void {
    const cur = this.weatherRenderer?.getNightPreset() ?? 'ground_visible';
    const btnVisible = this.el.querySelector('#btn-night-preset-visible');
    const btnGta = this.el.querySelector('#btn-night-preset-gta');
    const btnSoft = this.el.querySelector('#btn-night-preset-soft');
    const btnDim = this.el.querySelector('#btn-night-preset-dim');

    const updateBtn = (btn: Element | null, active: boolean) => {
      if (!btn) return;
      if (active) {
        btn.classList.add('primary');
        (btn as HTMLElement).style.borderColor = '#f59e0b';
        (btn as HTMLElement).style.color = '#fff';
      } else {
        btn.classList.remove('primary');
        (btn as HTMLElement).style.borderColor = 'rgba(148, 163, 184, 0.3)';
        (btn as HTMLElement).style.color = '#cbd5e1';
      }
    };

    updateBtn(btnVisible, cur === 'ground_visible');
    updateBtn(btnGta, cur === 'gta_contrast');
    updateBtn(btnSoft, cur === 'soft');
    updateBtn(btnDim, cur === 'dim');
  }

  public setNightLightingSystem(sys: NightLightingSystem): void {
    this.nightLightingSystem = sys;
    this.loadNightSettings();
  }

  public setWeatherRenderer(r: WeatherRenderer): void {
    this.weatherRenderer = r;
    this.loadNightSettings();
  }

  private saveNightSettings(): void {
    const data = {
      groundVisibility: this.weatherRenderer?.getGroundVisibility() ?? 1.0,
      nightBrightness: this.nightLightingSystem?.getBaseNightBrightness() ?? 1.3,
      lampDecal: this.nightLightingSystem?.getLampDecalIntensity() ?? 1.0,
      windowLight: this.nightLightingSystem?.getWindowLightRatio() ?? 0.5,
      urbanPollution: this.nightLightingSystem?.getUrbanLightPollution() ?? 0.6
    };
    try {
      localStorage.setItem('gta_night_settings_v1', JSON.stringify(data));
    } catch {}
  }

  public loadNightSettings(): void {
    try {
      const raw = localStorage.getItem('gta_night_settings_v1');
      if (raw) {
        const d = JSON.parse(raw);
        if (typeof d.groundVisibility === 'number') {
          this.weatherRenderer?.setGroundVisibility(d.groundVisibility);
        }
        if (typeof d.nightBrightness === 'number') {
          this.nightLightingSystem?.setBaseNightBrightness(d.nightBrightness);
          this.weatherRenderer?.setNightBrightness(d.nightBrightness);
        }
        if (typeof d.lampDecal === 'number') {
          this.nightLightingSystem?.setLampDecalIntensity(d.lampDecal);
        }
        if (typeof d.windowLight === 'number') {
          this.nightLightingSystem?.setWindowLightRatio(d.windowLight);
        }
        if (typeof d.urbanPollution === 'number') {
          this.nightLightingSystem?.setUrbanLightPollution(d.urbanPollution);
          this.weatherRenderer?.setUrbanLightPollution(d.urbanPollution);
        }
      }
    } catch {}
  }

  private updateHourLabel(hour: number): void {
    const h = Math.floor(hour);
    const m = Math.floor((hour - h) * 60);
    const lbl = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    const el = this.el.querySelector('#lbl-virtual-hour-val');
    if (el) el.textContent = lbl;
  }

  private updateRateButtons(): void {
    const currentRate = this.timeSystem.getTimeRate();
    const rateBtns = this.el.querySelectorAll('.rate-btn');
    rateBtns.forEach((btn) => {
      const r = parseFloat((btn as HTMLElement).dataset.rate || '1');
      if (r === currentRate) {
        btn.classList.add('primary');
      } else {
        btn.classList.remove('primary');
      }
    });
  }

  private updatePresetButtons(): void {
    const currentType = this.weatherSystem.getVirtualType();
    const presetBtns = this.el.querySelectorAll('.preset-btn');
    presetBtns.forEach((btn) => {
      const t = (btn as HTMLElement).dataset.type;
      if (t === currentType) {
        btn.classList.add('primary');
      } else {
        btn.classList.remove('primary');
      }
    });
  }

  /**
   * 刷新面板 UI 狀態與文字
   */
  public refreshUI(): void {
    const timeMode = this.timeSystem.getMode();
    const weatherMode = this.weatherSystem.getMode();

    // 1. 時間模式高亮
    const btnTimeReal = this.el.querySelector('#btn-time-mode-real');
    const btnTimeVirtual = this.el.querySelector('#btn-time-mode-virtual');
    const timeRealInfo = this.el.querySelector('#time-real-info') as HTMLElement;
    const timeVirtualControls = this.el.querySelector('#time-virtual-controls') as HTMLElement;

    if (timeMode === 'real') {
      btnTimeReal?.classList.add('primary');
      btnTimeVirtual?.classList.remove('primary');
      timeRealInfo.style.display = 'block';
      timeVirtualControls.style.display = 'none';

      const disp = this.timeSystem.getTimeOfDay();
      const sunMoon = this.timeSystem.getSunMoonInfo();
      this.el.querySelector('#lbl-real-time-val')!.textContent = disp.timeString;
      this.el.querySelector('#lbl-sun-altitude')!.textContent = `${sunMoon.sun.altitudeDeg.toFixed(1)}°`;
      this.el.querySelector('#lbl-twilight-phase')!.textContent = disp.phase;
    } else {
      btnTimeReal?.classList.remove('primary');
      btnTimeVirtual?.classList.add('primary');
      timeRealInfo.style.display = 'none';
      timeVirtualControls.style.display = 'flex';

      const vh = this.timeSystem.getVirtualHour();
      const slider = this.el.querySelector('#slider-virtual-hour') as HTMLInputElement;
      if (slider) slider.value = vh.toString();
      this.updateHourLabel(vh);
      this.updateRateButtons();
    }

    // 2. 天氣模式高亮
    const btnWeatherReal = this.el.querySelector('#btn-weather-mode-real');
    const btnWeatherVirtual = this.el.querySelector('#btn-weather-mode-virtual');
    const weatherRealInfo = this.el.querySelector('#weather-real-info') as HTMLElement;
    const weatherVirtualControls = this.el.querySelector('#weather-virtual-controls') as HTMLElement;

    const weatherData = this.weatherSystem.getWeatherData();

    if (weatherMode === 'real') {
      btnWeatherReal?.classList.add('primary');
      btnWeatherVirtual?.classList.remove('primary');
      weatherRealInfo.style.display = 'block';
      weatherVirtualControls.style.display = 'none';

      this.el.querySelector('#lbl-live-weather-desc')!.textContent = weatherData.weatherState;
      this.el.querySelector('#lbl-live-temp')!.textContent = `${weatherData.temperature.toFixed(1)}°C`;
      this.el.querySelector('#lbl-live-precip')!.textContent = `${weatherData.precipitation.toFixed(1)} mm/h`;
      this.el.querySelector('#lbl-live-humidity')!.textContent = `${weatherData.relativeHumidity}%`;
      this.el.querySelector('#lbl-live-wind')!.textContent = `${weatherData.windSpeed.toFixed(1)} km/h`;
      this.el.querySelector('#lbl-live-cloud')!.textContent = `${weatherData.cloudCover}%`;

      const sourceBadge = this.el.querySelector('#lbl-weather-source-badge');
      if (sourceBadge) {
        if (weatherData.source === 'live') {
          sourceBadge.textContent = '資料來源：連線即時';
        } else if (weatherData.source === 'cache') {
          sourceBadge.textContent = `資料來源：離線快取 (${weatherData.cacheTimeStr || '不久前'})`;
        } else {
          sourceBadge.textContent = '資料來源：展示預設';
        }
      }

      const ageEl = this.el.querySelector('#lbl-weather-age');
      if (ageEl) {
        if (weatherData.cacheAgeSec !== undefined) {
          if (weatherData.cacheAgeSec < 60) ageEl.textContent = `(剛抓取)`;
          else ageEl.textContent = `(${Math.floor(weatherData.cacheAgeSec / 60)} 分鐘前快取)`;
        } else {
          ageEl.textContent = '';
        }
      }

      const diagEl = this.el.querySelector('#lbl-weather-diag');
      if (diagEl) {
        diagEl.textContent = weatherData.diagnostics?.rawSummary || `HTTP 200 OK | WMO 代碼: ${weatherData.weatherCode}`;
      }
    } else {
      btnWeatherReal?.classList.remove('primary');
      btnWeatherVirtual?.classList.add('primary');
      weatherRealInfo.style.display = 'none';
      weatherVirtualControls.style.display = 'flex';

      this.updatePresetButtons();
      const chkAuto = this.el.querySelector('#chk-weather-auto') as HTMLInputElement;
      if (chkAuto) chkAuto.checked = this.weatherSystem.isAutoChangeEnabled();
      const chkInstant = this.el.querySelector('#chk-weather-instant-apply') as HTMLInputElement;
      if (chkInstant) chkInstant.checked = this.weatherSystem.getInstantApply();
      const transInfo = this.weatherSystem.getTransitionInfo();
      this.syncManualSlidersWithTarget(transInfo.targetParams);
    }

    // 3. 同步夜景風格預設與微調滑桿
    this.refreshNightPresetButtons();
    const groundVis = this.weatherRenderer?.getGroundVisibility() ?? 1.0;
    const nightBri = this.weatherRenderer?.getNightBrightness() ?? (this.nightLightingSystem?.getBaseNightBrightness() ?? 1.0);
    const lampDecal = this.nightLightingSystem?.getLampDecalIntensity() ?? 1.0;
    const winLight = this.nightLightingSystem?.getWindowLightRatio() ?? 0.5;
    const urbanPol = this.nightLightingSystem?.getUrbanLightPollution() ?? 0.6;

    const sGroundVis = this.el.querySelector('#slider-ground-visibility') as HTMLInputElement;
    if (sGroundVis) sGroundVis.value = groundVis.toString();
    const lblGroundVis = this.el.querySelector('#lbl-ground-visibility');
    if (lblGroundVis) lblGroundVis.textContent = `${groundVis.toFixed(2)}x`;

    const sNightBri = this.el.querySelector('#slider-night-brightness') as HTMLInputElement;
    if (sNightBri) sNightBri.value = nightBri.toString();
    const lblNightBri = this.el.querySelector('#lbl-night-brightness');
    if (lblNightBri) lblNightBri.textContent = `${nightBri.toFixed(2)}x`;

    const sLampDecal = this.el.querySelector('#slider-lamp-decal') as HTMLInputElement;
    if (sLampDecal) sLampDecal.value = lampDecal.toString();
    const lblLampDecal = this.el.querySelector('#lbl-lamp-decal-intensity');
    if (lblLampDecal) lblLampDecal.textContent = `${lampDecal.toFixed(2)}x`;

    const sWinLight = this.el.querySelector('#slider-window-light') as HTMLInputElement;
    if (sWinLight) sWinLight.value = winLight.toString();
    const lblWinLight = this.el.querySelector('#lbl-window-light-ratio');
    if (lblWinLight) lblWinLight.textContent = `${Math.round(winLight * 100)}%`;

    const sUrbanPol = this.el.querySelector('#slider-urban-pollution') as HTMLInputElement;
    if (sUrbanPol) sUrbanPol.value = urbanPol.toString();
    const lblUrbanPol = this.el.querySelector('#lbl-urban-pollution');
    if (lblUrbanPol) lblUrbanPol.textContent = `${urbanPol.toFixed(2)}x`;
  }
}
