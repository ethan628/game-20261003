/**
 * BuildingInspectorModal.ts - F6 開發者模式：建築資料檢視與人工校正互動視窗
 * 顯示：OSM ID、現有來源、目前樓層與高度、輪廓面積；支援直接修改樓層/高度/屋頂形式、即時預覽與儲存至 overrides.json
 */

import { BuildingFeature, BuildingRoofShape } from '../geo/OsmTypes.ts';
import { BuildingInferenceService } from '../geo/BuildingInferenceService.ts';
import { BuildingOverrideService } from '../geo/BuildingOverrideService.ts';

export class BuildingInspectorModal {
  private container: HTMLDivElement;
  private currentBuilding: BuildingFeature | null = null;
  private isVisible = false;

  public onLivePreview?: (building: BuildingFeature) => void;
  public onSaveOverride?: (building: BuildingFeature) => void;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'building-inspector-modal';
    this.container.className = 'building-inspector-modal hidden';
    this.container.innerHTML = `
      <div class="inspector-card">
        <div class="inspector-header">
          <div class="inspector-title-group">
            <span class="inspector-icon">🏢</span>
            <div>
              <div class="inspector-title">建築資料檢視與校正</div>
              <div class="inspector-subtitle" id="insp-osm-id">OSM ID: --</div>
            </div>
          </div>
          <button class="inspector-close-btn" id="insp-btn-close">&times;</button>
        </div>

        <div class="inspector-body">
          <div class="inspector-meta-grid">
            <div class="meta-item">
              <span class="meta-label">建築名稱</span>
              <span class="meta-val" id="insp-name">--</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">資料來源</span>
              <span class="meta-val" id="insp-source-badge">--</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">信心等級</span>
              <span class="meta-val" id="insp-confidence">--</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">占地面積</span>
              <span class="meta-val" id="insp-area">-- m²</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">幾何中心</span>
              <span class="meta-val" id="insp-center">--</span>
            </div>
            <div class="meta-item">
              <span class="meta-label">建築類型</span>
              <span class="meta-val" id="insp-type">--</span>
            </div>
          </div>

          <div class="inspector-divider"></div>

          <form id="inspector-edit-form" class="inspector-form" onsubmit="return false;">
            <div class="form-row">
              <label for="insp-input-levels">樓層數 (Levels)</label>
              <div class="input-with-suffix">
                <input type="number" id="insp-input-levels" min="1" max="60" step="1" required />
                <span class="suffix">層</span>
              </div>
            </div>

            <div class="form-row">
              <label for="insp-input-height">建築總高 (Height)</label>
              <div class="input-with-suffix">
                <input type="number" id="insp-input-height" min="3" max="300" step="0.1" required />
                <span class="suffix">公尺 (m)</span>
              </div>
            </div>

            <div class="form-row">
              <label for="insp-input-minheight">懸空起始高 (minHeight)</label>
              <div class="input-with-suffix">
                <input type="number" id="insp-input-minheight" min="0" max="60" step="0.5" value="0" />
                <span class="suffix">公尺 (m)</span>
              </div>
            </div>

            <div class="form-row">
              <label for="insp-select-roof">屋頂形式 (Roof Shape)</label>
              <select id="insp-select-roof">
                <option value="flat">平頂 (Flat，含女兒牆)</option>
                <option value="gabled">雙坡 / 山牆 (Gabled)</option>
                <option value="pyramidal">金字塔錐頂 (Pyramidal)</option>
                <option value="hipped">四坡頂 (Hipped)</option>
                <option value="skillion">單坡斜頂 (Skillion)</option>
              </select>
            </div>

            <div class="form-row">
              <label for="insp-input-note">校正備註 (Note)</label>
              <input type="text" id="insp-input-note" placeholder="例：礁溪火車站實際 2 層樓" />
            </div>

            <div class="inspector-feedback" id="insp-feedback"></div>

            <div class="inspector-actions">
              <button type="button" class="btn-insp preview" id="insp-btn-preview">👁️ 即時預覽</button>
              <button type="button" class="btn-insp save" id="insp-btn-save">💾 儲存至 overrides.json</button>
              <button type="button" class="btn-insp download" id="insp-btn-download">📥 下載 JSON</button>
            </div>
          </form>
        </div>
      </div>
    `;

    this.injectStyles();
    document.body.appendChild(this.container);
    this.setupEvents();
  }

  private setupEvents(): void {
    const closeBtn = this.container.querySelector('#insp-btn-close');
    closeBtn?.addEventListener('click', () => this.hide());

    const levelsInput = this.container.querySelector('#insp-input-levels') as HTMLInputElement;
    const heightInput = this.container.querySelector('#insp-input-height') as HTMLInputElement;

    // 當修改樓層數時，自動計算標準樓高
    levelsInput?.addEventListener('input', () => {
      const lv = parseInt(levelsInput.value, 10);
      if (!isNaN(lv) && lv > 0) {
        const h = BuildingInferenceService.calcHeightFromLevels(lv);
        heightInput.value = h.toString();
      }
    });

    const previewBtn = this.container.querySelector('#insp-btn-preview');
    previewBtn?.addEventListener('click', () => this.handlePreview());

    const saveBtn = this.container.querySelector('#insp-btn-save');
    saveBtn?.addEventListener('click', () => this.handleSave());

    const downloadBtn = this.container.querySelector('#insp-btn-download');
    downloadBtn?.addEventListener('click', () => {
      BuildingOverrideService.getInstance().downloadOverridesJson();
      this.setFeedback('📥 已觸發 overrides.json 瀏覽器下載', 'success');
    });
  }

  public show(building: BuildingFeature): void {
    this.currentBuilding = { ...building };
    this.isVisible = true;

    const osmIdEl = this.container.querySelector('#insp-osm-id')!;
    const nameEl = this.container.querySelector('#insp-name')!;
    const sourceEl = this.container.querySelector('#insp-source-badge')!;
    const confEl = this.container.querySelector('#insp-confidence')!;
    const areaEl = this.container.querySelector('#insp-area')!;
    const centerEl = this.container.querySelector('#insp-center')!;
    const typeEl = this.container.querySelector('#insp-type')!;

    const levelsInput = this.container.querySelector('#insp-input-levels') as HTMLInputElement;
    const heightInput = this.container.querySelector('#insp-input-height') as HTMLInputElement;
    const minHeightInput = this.container.querySelector('#insp-input-minheight') as HTMLInputElement;
    const roofSelect = this.container.querySelector('#insp-select-roof') as HTMLSelectElement;
    const noteInput = this.container.querySelector('#insp-input-note') as HTMLInputElement;

    osmIdEl.textContent = `ID: ${building.id}`;
    nameEl.textContent = building.name || '未命名建築';

    const sourceBadges: Record<string, { label: string; color: string }> = {
      override: { label: '🟣 人工校正 (Override)', color: '#c084fc' },
      osm: { label: '🟢 OSM 實測資料', color: '#4ade80' },
      external: { label: '🔵 外部資料層 (NLSC)', color: '#60a5fa' },
      estimated: { label: '🟠 空間中位數推測', color: '#fb923c' }
    };
    const sb = sourceBadges[building.heightSource] || sourceBadges.estimated;
    sourceEl.textContent = sb.label;
    (sourceEl as HTMLElement).style.color = sb.color;

    confEl.textContent = `${Math.round(building.confidence * 100)}%`;
    areaEl.textContent = `${building.area.toFixed(1)} m²`;
    centerEl.textContent = `X:${building.center.x.toFixed(1)}, Z:${building.center.z.toFixed(1)}`;
    typeEl.textContent = building.type;

    levelsInput.value = building.levels.toString();
    heightInput.value = building.height.toFixed(1);
    minHeightInput.value = (building.minHeight || 0).toString();
    roofSelect.value = building.roofShape || 'flat';
    noteInput.value = building.note || '';

    this.clearFeedback();
    this.container.classList.remove('hidden');
  }

  public hide(): void {
    this.isVisible = false;
    this.container.classList.add('hidden');
    if (document.activeElement && this.container.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }

  public getIsVisible(): boolean {
    return this.isVisible;
  }

  private handlePreview(): void {
    if (!this.currentBuilding) return;

    const levels = parseInt((this.container.querySelector('#insp-input-levels') as HTMLInputElement).value, 10) || 1;
    const height = parseFloat((this.container.querySelector('#insp-input-height') as HTMLInputElement).value) || 3.5;
    const minHeight = parseFloat((this.container.querySelector('#insp-input-minheight') as HTMLInputElement).value) || 0;
    const roofShape = (this.container.querySelector('#insp-select-roof') as HTMLSelectElement).value as BuildingRoofShape;
    const note = (this.container.querySelector('#insp-input-note') as HTMLInputElement).value.trim();

    this.currentBuilding.levels = levels;
    this.currentBuilding.height = height;
    this.currentBuilding.minHeight = minHeight > 0 ? minHeight : undefined;
    this.currentBuilding.roofShape = roofShape;
    this.currentBuilding.heightSource = 'override';
    this.currentBuilding.confidence = 1.0;
    this.currentBuilding.note = note;

    this.onLivePreview?.(this.currentBuilding);
    this.setFeedback('👁️ 已更新即時預覽 (高度與樓層已重新擠出)', 'info');
  }

  private async handleSave(): Promise<void> {
    if (!this.currentBuilding) return;

    this.handlePreview();

    const overrideService = BuildingOverrideService.getInstance();
    const res = await overrideService.setOverride(this.currentBuilding.id, {
      levels: this.currentBuilding.levels,
      height: this.currentBuilding.height,
      minHeight: this.currentBuilding.minHeight,
      roofShape: this.currentBuilding.roofShape,
      note: this.currentBuilding.note
    });

    this.onSaveOverride?.(this.currentBuilding);
    this.setFeedback(`💾 ${res.message}`, res.savedToDisk ? 'success' : 'info');
  }

  private setFeedback(msg: string, type: 'info' | 'success' | 'error'): void {
    const el = this.container.querySelector('#insp-feedback') as HTMLElement;
    if (el) {
      el.textContent = msg;
      el.className = `inspector-feedback ${type}`;
    }
  }

  private clearFeedback(): void {
    const el = this.container.querySelector('#insp-feedback') as HTMLElement;
    if (el) {
      el.textContent = '';
      el.className = 'inspector-feedback';
    }
  }

  private injectStyles(): void {
    const style = document.createElement('style');
    style.textContent = `
      .building-inspector-modal {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 10000;
        width: 380px;
        background: rgba(15, 23, 42, 0.94);
        border: 1px solid rgba(148, 163, 184, 0.35);
        backdrop-filter: blur(16px);
        border-radius: 14px;
        box-shadow: 0 20px 45px rgba(0, 0, 0, 0.65);
        color: #f8fafc;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 13px;
        overflow: hidden;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .building-inspector-modal.hidden {
        opacity: 0;
        pointer-events: none;
        transform: translateY(16px);
        visibility: hidden;
        display: none !important;
      }
      .inspector-card {
        display: flex;
        flex-direction: column;
      }
      .inspector-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 18px;
        background: rgba(30, 41, 59, 0.8);
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .inspector-title-group {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .inspector-icon {
        font-size: 22px;
      }
      .inspector-title {
        font-weight: 700;
        font-size: 15px;
        color: #f1f5f9;
      }
      .inspector-subtitle {
        font-size: 11px;
        color: #94a3b8;
        font-family: monospace;
      }
      .inspector-close-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        font-size: 24px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .inspector-close-btn:hover {
        color: #ffffff;
      }
      .inspector-body {
        padding: 16px 18px;
        max-height: 72vh;
        overflow-y: auto;
      }
      .inspector-meta-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px 14px;
      }
      .meta-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .meta-label {
        font-size: 11px;
        color: #94a3b8;
      }
      .meta-val {
        font-weight: 600;
        color: #e2e8f0;
      }
      .inspector-divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.1);
        margin: 14px 0;
      }
      .inspector-form {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .form-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .form-row label {
        font-size: 11.5px;
        color: #cbd5e1;
        font-weight: 500;
      }
      .input-with-suffix {
        display: flex;
        align-items: center;
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 8px;
        padding: 0 10px;
      }
      .input-with-suffix input {
        flex: 1;
        background: transparent;
        border: none;
        color: #fff;
        padding: 7px 0;
        font-size: 13px;
        font-weight: 600;
      }
      .input-with-suffix .suffix {
        font-size: 11.5px;
        color: #94a3b8;
      }
      .inspector-form select,
      .inspector-form input[type="text"] {
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid rgba(148, 163, 184, 0.3);
        border-radius: 8px;
        padding: 7px 10px;
        color: #fff;
        font-size: 13px;
      }
      .inspector-form input:focus,
      .inspector-form select:focus {
        outline: none;
        border-color: #38bdf8;
      }
      .inspector-feedback {
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 6px;
        display: none;
      }
      .inspector-feedback.info {
        display: block;
        background: rgba(56, 189, 248, 0.15);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.3);
      }
      .inspector-feedback.success {
        display: block;
        background: rgba(74, 222, 128, 0.15);
        color: #4ade80;
        border: 1px solid rgba(74, 222, 128, 0.3);
      }
      .inspector-actions {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 6px;
      }
      .btn-insp {
        padding: 8px 14px;
        border-radius: 8px;
        border: none;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.1s ease, filter 0.15s ease;
      }
      .btn-insp:hover {
        filter: brightness(1.15);
      }
      .btn-insp.preview {
        background: #0284c7;
        color: white;
      }
      .btn-insp.save {
        background: #9333ea;
        color: white;
      }
      .btn-insp.download {
        background: rgba(51, 65, 85, 0.85);
        color: #cbd5e1;
      }
    `;
    document.head.appendChild(style);
  }
}
