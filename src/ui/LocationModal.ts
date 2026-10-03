/**
 * LocationModal.ts - 地點選擇與 Nominatim 搜尋對話框
 * 支援預設常用地點、即時全球地名搜尋、自訂經緯度輸入與 M 鍵切換
 */

import { PRESET_LOCATIONS } from '../config.ts';
import { NominatimSearch, SearchResult } from '../geo/NominatimSearch.ts';

export class LocationModal {
  private el: HTMLDivElement;
  private searchEngine: NominatimSearch;

  private selectedLat = PRESET_LOCATIONS[0].lat;
  private selectedLon = PRESET_LOCATIONS[0].lon;
  private selectedName = PRESET_LOCATIONS[0].name;
  private selectedPresetFile: string | undefined = PRESET_LOCATIONS[0].presetFile;

  private inputSearch: HTMLInputElement;
  private btnSearch: HTMLButtonElement;
  private searchResultsList: HTMLDivElement;
  private presetContainer: HTMLDivElement;

  private inputLat: HTMLInputElement;
  private inputLon: HTMLInputElement;
  private inputCustomName: HTMLInputElement;

  private btnConfirm: HTMLButtonElement;
  private btnClose: HTMLButtonElement;

  private onSelectLocationCallback?: (lat: number, lon: number, name: string, presetFile?: string) => void;
  private hasActiveWorld = false;

  constructor() {
    this.searchEngine = new NominatimSearch();

    this.el = document.createElement('div');
    this.el.id = 'location-modal';
    this.el.className = 'overlay-backdrop hidden';
    this.el.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <h2>🌍 開放世界地點選擇</h2>
          <button id="modal-close-btn" class="close-btn" title="關閉">&times;</button>
        </div>

        <div class="modal-body">
          <!-- 常用預設地點 -->
          <div class="section-title">熱門推薦預設（點選即選定）</div>
          <div class="preset-grid" id="preset-list"></div>

          <!-- 線上地名搜尋 -->
          <div class="section-title">搜尋全球任意地點 (Nominatim)</div>
          <div class="search-box">
            <input type="text" id="search-input" placeholder="輸入任意地名（例如：板橋車站、逢甲夜市、東京鐵塔...）" />
            <button id="btn-search-exec" class="btn secondary">搜尋</button>
          </div>
          <div id="search-results" class="search-results hidden"></div>

          <!-- 自訂精準經緯度 -->
          <details class="custom-coord-details">
            <summary>自訂座標數值 (經緯度)</summary>
            <div class="coord-inputs">
              <label>名稱：<input type="text" id="coord-name" value="${this.selectedName}" /></label>
              <label>緯度 (Lat)：<input type="number" step="0.0001" id="coord-lat" value="${this.selectedLat}" /></label>
              <label>經度 (Lon)：<input type="number" step="0.0001" id="coord-lon" value="${this.selectedLon}" /></label>
            </div>
          </details>

          <!-- 當前選擇預覽 -->
          <div class="selection-preview">
            目前選定：<b id="preview-name">${this.selectedName}</b>
            <span id="preview-coords">(${this.selectedLat.toFixed(4)}, ${this.selectedLon.toFixed(4)})</span>
          </div>
        </div>

        <div class="modal-footer">
          <button id="btn-confirm-loc" class="btn primary btn-large">🚀 進入開放世界</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.el);

    this.inputSearch = this.el.querySelector('#search-input')!;
    this.btnSearch = this.el.querySelector('#btn-search-exec')!;
    this.searchResultsList = this.el.querySelector('#search-results')!;
    this.presetContainer = this.el.querySelector('#preset-list')!;

    this.inputLat = this.el.querySelector('#coord-lat')!;
    this.inputLon = this.el.querySelector('#coord-lon')!;
    this.inputCustomName = this.el.querySelector('#coord-name')!;

    this.btnConfirm = this.el.querySelector('#btn-confirm-loc')!;
    this.btnClose = this.el.querySelector('#modal-close-btn')!;

    this.renderPresets();
    this.attachEvents();
  }

  private renderPresets(): void {
    this.presetContainer.innerHTML = '';
    PRESET_LOCATIONS.forEach((preset, idx) => {
      const btn = document.createElement('button');
      btn.className = `preset-card ${idx === 0 ? 'selected' : ''}`;
      btn.innerHTML = `
        <div class="preset-name">${preset.name}</div>
        <div class="preset-desc">${preset.desc}</div>
        <div class="preset-coords">${preset.lat.toFixed(4)}, ${preset.lon.toFixed(4)}</div>
      `;
      btn.addEventListener('click', () => {
        this.selectLocation(preset.lat, preset.lon, preset.name, preset.presetFile);
        this.highlightPreset(btn);
      });
      this.presetContainer.appendChild(btn);
    });
  }

  private highlightPreset(selectedEl: HTMLElement): void {
    const all = this.presetContainer.querySelectorAll('.preset-card');
    all.forEach((el) => el.classList.remove('selected'));
    selectedEl.classList.add('selected');
  }

  private selectLocation(lat: number, lon: number, name: string, presetFile?: string): void {
    this.selectedLat = lat;
    this.selectedLon = lon;
    this.selectedName = name;
    this.selectedPresetFile = presetFile;

    this.inputLat.value = lat.toString();
    this.inputLon.value = lon.toString();
    this.inputCustomName.value = name;

    const pName = this.el.querySelector('#preview-name')!;
    const pCoords = this.el.querySelector('#preview-coords')!;
    pName.textContent = name;
    pCoords.textContent = `(${lat.toFixed(4)}, ${lon.toFixed(4)})`;
  }

  private attachEvents(): void {
    // 搜尋功能
    const executeSearch = async () => {
      const q = this.inputSearch.value.trim();
      if (!q) return;

      this.btnSearch.textContent = '搜尋中...';
      this.btnSearch.disabled = true;

      try {
        const results = await this.searchEngine.search(q);
        this.renderSearchResults(results);
      } catch (err: any) {
        this.searchResultsList.innerHTML = `<div class="search-error">搜尋失敗: ${err.message}</div>`;
        this.searchResultsList.classList.remove('hidden');
      } finally {
        this.btnSearch.textContent = '搜尋';
        this.btnSearch.disabled = false;
      }
    };

    this.btnSearch.addEventListener('click', executeSearch);
    this.inputSearch.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        executeSearch();
      }
    });

    // 手動座標異動
    const onManualChange = () => {
      const lat = parseFloat(this.inputLat.value);
      const lon = parseFloat(this.inputLon.value);
      const name = this.inputCustomName.value.trim() || '自訂座標';
      if (!isNaN(lat) && !isNaN(lon)) {
        this.selectedLat = lat;
        this.selectedLon = lon;
        this.selectedName = name;
        this.selectedPresetFile = undefined;
        const pName = this.el.querySelector('#preview-name')!;
        const pCoords = this.el.querySelector('#preview-coords')!;
        pName.textContent = name;
        pCoords.textContent = `(${lat.toFixed(4)}, ${lon.toFixed(4)})`;
      }
    };

    this.inputLat.addEventListener('input', onManualChange);
    this.inputLon.addEventListener('input', onManualChange);
    this.inputCustomName.addEventListener('input', onManualChange);

    // 確認載入世界
    this.btnConfirm.addEventListener('click', () => {
      this.hide();
      this.hasActiveWorld = true;
      this.onSelectLocationCallback?.(
        this.selectedLat,
        this.selectedLon,
        this.selectedName,
        this.selectedPresetFile
      );
    });

    // 關閉按鈕
    this.btnClose.addEventListener('click', () => {
      if (this.hasActiveWorld) {
        this.hide();
      }
    });

    // 點擊遮罩外關閉
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && this.hasActiveWorld) {
        this.hide();
      }
    });
  }

  private renderSearchResults(results: SearchResult[]): void {
    this.searchResultsList.innerHTML = '';
    if (results.length === 0) {
      this.searchResultsList.innerHTML = '<div class="no-result">查無此地點，請嘗試更具體的關鍵字</div>';
      this.searchResultsList.classList.remove('hidden');
      return;
    }

    results.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'search-item';
      row.innerHTML = `
        <div class="search-item-title">${item.displayName}</div>
        <div class="search-item-meta">${item.type} | 座標: ${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}</div>
      `;
      row.addEventListener('click', () => {
        // 從 display_name 取簡短地名
        const shortName = item.displayName.split(',')[0];
        this.selectLocation(item.lat, item.lon, shortName, undefined);
        this.searchResultsList.classList.add('hidden');
      });
      this.searchResultsList.appendChild(row);
    });

    this.searchResultsList.classList.remove('hidden');
  }

  public onSelectLocation(
    handler: (lat: number, lon: number, name: string, presetFile?: string) => void
  ): void {
    this.onSelectLocationCallback = handler;
  }

  public show(): void {
    this.el.classList.remove('hidden');
    this.btnClose.style.display = this.hasActiveWorld ? 'block' : 'none';
  }

  public hide(): void {
    this.el.classList.add('hidden');
  }

  public isVisible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  public toggle(): void {
    if (this.isVisible()) {
      if (this.hasActiveWorld) this.hide();
    } else {
      this.show();
    }
  }
}
