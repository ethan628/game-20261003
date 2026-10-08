/**
 * InputManager.ts - 全域輸入管理（鍵盤、滑鼠、指標鎖定 Pointer Lock）
 */

export class InputManager {
  private keys = new Set<string>();
  private _mouseDeltaX = 0;
  private _mouseDeltaY = 0;
  private _wheelDelta = 0;
  private isLocked = false;
  private domElement: HTMLElement;

  public onToggleMenu?: () => void;
  public onToggleStreetView?: () => void;
  public onToggleSplitMode?: () => void;
  public onToggleMinimap?: () => void;
  public onToggleFullscreenMap?: () => void;
  public onToggleSignboardDebug?: () => void;
  public onClearCacheAndReload?: () => void;
  public onToggleBuildingDebug?: () => void;
  public onToggleBuildingInspector?: () => void;
  public onToggleFloorLabels?: () => void;
  public onTogglePedestrianDebug?: () => void;
  public onToggleTrafficSignalDebug?: () => void;
  public onCycleTrafficSignalTeleport?: () => void;
  public onToggleWetMode?: () => void;
  public onToggleNightMode?: () => void;
  public onToggleWeatherModal?: () => void;
  public onToggleWeatherDebug?: () => void;
  public onToggleNightAnalysis?: () => void;
  public onToggleTrafficDebug?: () => void;
  public onToggleStopLineMeasurement?: () => void;
  public onTogglePoliceDebug?: () => void;
  private isSuspended = false;

  constructor(domElement: HTMLElement) {
    this.domElement = domElement;
    this.attachEvents();
  }

  private attachEvents(): void {
    // 讓 Canvas 容器具備焦點屬性，接收滑鼠點擊焦點
    this.domElement.tabIndex = -1;
    this.domElement.style.outline = 'none';

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    document.addEventListener('pointerlockchange', this.onPointerLockChange);

    // 點擊畫面自動請求鎖定滑鼠並恢復遊戲鍵盤控制（若非點擊在對話框或街景 UI 上）
    this.domElement.addEventListener('click', () => {
      this.resumeKeyboard();
      // 點擊畫布時主動釋放任何殘留按鈕焦點
      if (document.activeElement && document.activeElement !== document.body && document.activeElement !== this.domElement) {
        (document.activeElement as HTMLElement).blur();
      }
      this.domElement.focus();
      if (!this.isLocked) {
        this.requestPointerLock();
      }
    });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // 若在輸入框中打字，不觸發遊戲內快捷鍵
    const targetTag = (e.target as HTMLElement)?.tagName;
    if (targetTag === 'INPUT' || targetTag === 'TEXTAREA') {
      return;
    }

    // 關鍵保護：防止空白鍵 (跳躍) 或方向鍵觸發瀏覽器對已聚焦按鈕的預設 click 行為或捲動頁面
    if (
      e.code === 'Space' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight'
    ) {
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body && document.activeElement !== this.domElement) {
        (document.activeElement as HTMLElement).blur();
      }
    }

    if (e.code === 'F3' || e.key === 'F3') {
      e.preventDefault();
      this.onToggleSignboardDebug?.();
      return;
    }
    if (e.code === 'F4' || e.key === 'F4') {
      e.preventDefault();
      this.onClearCacheAndReload?.();
      return;
    }
    if (e.code === 'F5' || e.key === 'F5') {
      e.preventDefault();
      this.onToggleBuildingDebug?.();
      return;
    }
    if (e.code === 'F6' || e.key === 'F6') {
      e.preventDefault();
      this.onToggleBuildingInspector?.();
      return;
    }
    if (e.code === 'F7' || e.key === 'F7') {
      e.preventDefault();
      this.onToggleFloorLabels?.();
      return;
    }
    if (e.code === 'F8' || e.key === 'F8') {
      e.preventDefault();
      this.onTogglePedestrianDebug?.();
      return;
    }
    if (e.code === 'F9' || e.key === 'F9') {
      e.preventDefault();
      this.onToggleTrafficSignalDebug?.();
      return;
    }
    if (e.code === 'F10' || e.key === 'F10') {
      e.preventDefault();
      this.onCycleTrafficSignalTeleport?.();
      return;
    }
    if (e.code === 'F11' || e.key === 'F11') {
      e.preventDefault();
      this.onToggleWeatherDebug?.();
      return;
    }
    if (e.code === 'F12' || e.key === 'F12') {
      e.preventDefault();
      this.onToggleNightAnalysis?.();
      return;
    }
    if (e.code === 'F13' || e.key === 'F13' || (e.shiftKey && e.code === 'F1')) {
      e.preventDefault();
      this.onToggleTrafficDebug?.();
      return;
    }
    if (e.code === 'F14' || e.key === 'F14' || (e.shiftKey && e.code === 'F2')) {
      e.preventDefault();
      this.onToggleStopLineMeasurement?.();
      return;
    }
    if (e.code === 'F15' || e.key === 'F15' || (e.shiftKey && (e.code === 'Backquote' || e.key === '`' || e.key === '~'))) {
      e.preventDefault();
      this.onTogglePoliceDebug?.();
      return;
    }

    if (e.code === 'Tab') {
      e.preventDefault();
      this.onToggleFullscreenMap?.();
      return;
    }

    if (e.code === 'KeyM') {
      this.onToggleMenu?.();
      return;
    }
    if (e.code === 'KeyK') {
      this.onToggleWeatherModal?.();
      return;
    }
    if (e.code === 'KeyG') {
      this.onToggleStreetView?.();
      return;
    }
    if (e.code === 'KeyH') {
      this.onToggleSplitMode?.();
      return;
    }
    if (e.code === 'KeyN') {
      this.onToggleMinimap?.();
      return;
    }
    if (e.code === 'KeyR') {
      this.onToggleWetMode?.();
      return;
    }
    if (e.code === 'KeyT') {
      this.onToggleNightMode?.();
      return;
    }

    if (!this.isSuspended) {
      this.keys.add(e.code);
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.isLocked) {
      this._mouseDeltaX += e.movementX;
      this._mouseDeltaY += e.movementY;
    }
  };

  private onWheel = (e: WheelEvent): void => {
    this._wheelDelta += Math.sign(e.deltaY);
  };

  private onPointerLockChange = (): void => {
    this.isLocked = document.pointerLockElement === this.domElement;
  };

  public requestPointerLock(): void {
    try {
      this.domElement.requestPointerLock();
    } catch (err) {
      // 忽略部分瀏覽器策略阻擋
    }
  }

  public exitPointerLock(): void {
    if (document.exitPointerLock) {
      document.exitPointerLock();
    }
  }

  public getPointerLocked(): boolean {
    return this.isLocked;
  }

  public suspendKeyboard(): void {
    this.isSuspended = true;
    this.keys.clear();
  }

  public resumeKeyboard(): void {
    this.isSuspended = false;
  }

  public isKeyboardSuspended(): boolean {
    return this.isSuspended;
  }

  // 取得滑鼠增量並歸零
  public consumeMouseDelta(): { dx: number; dy: number; wheel: number } {
    const res = {
      dx: this._mouseDeltaX,
      dy: this._mouseDeltaY,
      wheel: this._wheelDelta
    };
    this._mouseDeltaX = 0;
    this._mouseDeltaY = 0;
    this._wheelDelta = 0;
    return res;
  }

  public isForward(): boolean {
    if (this.isSuspended) return false;
    return this.keys.has('KeyW') || this.keys.has('ArrowUp');
  }

  public isBackward(): boolean {
    if (this.isSuspended) return false;
    return this.keys.has('KeyS') || this.keys.has('ArrowDown');
  }

  public isLeft(): boolean {
    if (this.isSuspended) return false;
    return this.keys.has('KeyA') || this.keys.has('ArrowLeft');
  }

  public isRight(): boolean {
    if (this.isSuspended) return false;
    return this.keys.has('KeyD') || this.keys.has('ArrowRight');
  }

  public isSprint(): boolean {
    if (this.isSuspended) return false;
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  public isJump(): boolean {
    if (this.isSuspended) return false;
    return this.keys.has('Space');
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }
}
