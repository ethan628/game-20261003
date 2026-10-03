/**
 * LoadingOverlay.ts - 載入中進度指示與錯誤提示通知對話框
 */

export class LoadingOverlay {
  private el: HTMLDivElement;
  private messageEl: HTMLElement;
  private subMessageEl: HTMLElement;
  private spinnerEl: HTMLElement;
  private errorContainerEl: HTMLElement;
  private errorTextEl: HTMLElement;
  private retryBtn: HTMLButtonElement;
  private fallbackBtn: HTMLButtonElement;
  private cancelBtn: HTMLButtonElement;

  private onRetryCallback?: () => void;
  private onFallbackCallback?: () => void;
  private onCancelCallback?: () => void;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'loading-overlay';
    this.el.className = 'overlay-backdrop';
    this.el.innerHTML = `
      <div class="overlay-card">
        <div class="spinner" id="loading-spinner"></div>
        <h2 id="loading-title">正在生成世界</h2>
        <p id="loading-sub">連線 OpenStreetMap Overpass API...</p>

        <div id="error-box" class="error-box hidden">
          <div class="error-icon">⚠️</div>
          <div id="error-message">無法取得地圖資料</div>
          <div class="error-actions">
            <button id="btn-retry" class="btn primary">重試</button>
            <button id="btn-fallback" class="btn primary" style="background: #059669;">載入展示街區 (離線備援)</button>
            <button id="btn-change-loc" class="btn secondary">更換地點</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.el);

    this.messageEl = this.el.querySelector('#loading-title')!;
    this.subMessageEl = this.el.querySelector('#loading-sub')!;
    this.spinnerEl = this.el.querySelector('#loading-spinner')!;
    this.errorContainerEl = this.el.querySelector('#error-box')!;
    this.errorTextEl = this.el.querySelector('#error-message')!;
    this.retryBtn = this.el.querySelector('#btn-retry')!;
    this.fallbackBtn = this.el.querySelector('#btn-fallback')!;
    this.cancelBtn = this.el.querySelector('#btn-change-loc')!;

    this.retryBtn.addEventListener('click', () => {
      this.onRetryCallback?.();
    });

    this.fallbackBtn.addEventListener('click', () => {
      this.onFallbackCallback?.();
    });

    this.cancelBtn.addEventListener('click', () => {
      this.onCancelCallback?.();
    });
  }

  public show(title: string = '正在生成世界', sub: string = '準備中...'): void {
    this.messageEl.textContent = title;
    this.subMessageEl.textContent = sub;
    this.spinnerEl.style.display = 'block';
    this.errorContainerEl.classList.add('hidden');
    this.el.classList.remove('hidden');
  }

  public updateMessage(title: string, sub: string): void {
    this.messageEl.textContent = title;
    this.subMessageEl.textContent = sub;
  }

  public showError(
    message: string,
    onRetry: () => void,
    onCancel: () => void,
    onFallback?: () => void
  ): void {
    this.spinnerEl.style.display = 'none';
    this.messageEl.textContent = '地圖載入失敗';
    this.subMessageEl.textContent = '請檢查網路連線或稍後重試';
    this.errorTextEl.textContent = message;
    this.errorContainerEl.classList.remove('hidden');

    this.onRetryCallback = onRetry;
    this.onCancelCallback = onCancel;
    this.onFallbackCallback = onFallback;
    this.fallbackBtn.style.display = onFallback ? 'inline-block' : 'none';
    this.el.classList.remove('hidden');
  }

  public hide(): void {
    this.el.classList.add('hidden');
  }
}
