/**
 * PoliceDebugVisualizer.ts - 警察執法系統 3D 視覺化與 F15 (Shift+`) 除錯操作面板
 * 遵循 RULES.md：
 * 1. 3D 視覺化：
 *    - 警車前方 140 度視角扇形 (半透明藍色) 與 60 公尺偵測圓
 *    - 視線遮擋射線 (未擋住: 綠色，被建築物擋住: 灰色)
 *    - 追捕目標動態連線 (橙色) 與 A* 規劃路徑線 (青色)
 * 2. 除錯面板 (F15 / Shift+`)：
 *    - 生成警車在附近
 *    - 強制最近車輛搶紅燈
 *    - 強制最近車輛超速
 *    - 強制最近行人穿越馬路
 *    - 開始 60 秒執法抽樣評估與彈出指標報告
 * 3. 程式化測試接口：window.startPoliceSampling60s(), window.getPoliceSamplingReport()
 */

import * as THREE from 'three';
import { CONFIG } from '../config.ts';
import { PoliceSystem } from '../systems/police/PoliceSystem.ts';
import { TrafficSystem } from '../systems/traffic/TrafficSystem.ts';
import { PedestrianSystem } from '../systems/PedestrianSystem.ts';
import { Point2D } from '../geo/OsmTypes.ts';
import { PoliceSamplingReport } from '../systems/police/PoliceTypes.ts';

export class PoliceDebugVisualizer {
  private group: THREE.Group;
  private isVisible = false;

  private policeSystem: PoliceSystem;
  private trafficSystem: TrafficSystem;
  private pedestrianSystem: PedestrianSystem;

  // 3D 視覺化物件
  private fovSectors: THREE.Mesh[] = [];
  private detectionCircles: THREE.LineLoop[] = [];
  private losLines: THREE.Line[] = [];
  private pursuitLines: THREE.Line[] = [];
  private astarPathLines: THREE.Line[] = [];
  private committedSegmentLines: THREE.Line[] = [];
  private predictedTargetMarkers: THREE.Mesh[] = [];
  private replanMarkers: THREE.Mesh[] = [];

  // DOM 面板元素
  private panelElement: HTMLElement | null = null;
  private reportModalElement: HTMLElement | null = null;

  constructor(
    scene: THREE.Scene,
    policeSystem: PoliceSystem,
    trafficSystem: TrafficSystem,
    pedestrianSystem: PedestrianSystem
  ) {
    this.policeSystem = policeSystem;
    this.trafficSystem = trafficSystem;
    this.pedestrianSystem = pedestrianSystem;

    this.group = new THREE.Group();
    this.group.name = 'PoliceDebugVisualizerGroup';
    this.group.visible = false;

    this.init3DHelpers();
    scene.add(this.group);

    this.initDomPanel();
    this.registerGlobalWindowApi();
  }

  private init3DHelpers(): void {
    const maxCars = CONFIG.POLICE.MAX_CARS;

    for (let i = 0; i < maxCars; i++) {
      // 1. 140 度 FOV 扇形 (半徑 60m)
      const fovRad = (CONFIG.POLICE.DETECTION_FOV_DEG * Math.PI) / 180;
      const radius = CONFIG.POLICE.DETECTION_RADIUS;
      const segments = 24;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);

      const startAngle = Math.PI / 2 - fovRad / 2;
      for (let s = 0; s <= segments; s++) {
        const theta = startAngle + (fovRad * s) / segments;
        shape.lineTo(Math.cos(theta) * radius, Math.sin(theta) * radius);
      }
      shape.lineTo(0, 0);

      const geom = new THREE.ShapeGeometry(shape);
      geom.rotateX(-Math.PI / 2); // 貼平地面
      const mat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      const fovMesh = new THREE.Mesh(geom, mat);
      fovMesh.visible = false;
      this.fovSectors.push(fovMesh);
      this.group.add(fovMesh);

      // 2. 60m 偵測圓 (外環線)
      const circlePts: THREE.Vector3[] = [];
      const circleSegs = 48;
      for (let s = 0; s <= circleSegs; s++) {
        const theta = (s / circleSegs) * Math.PI * 2;
        circlePts.push(new THREE.Vector3(Math.cos(theta) * radius, 0.08, Math.sin(theta) * radius));
      }
      const circleGeom = new THREE.BufferGeometry().setFromPoints(circlePts);
      const circleMat = new THREE.LineBasicMaterial({
        color: 0x0284c7,
        transparent: true,
        opacity: 0.4
      });
      const circleLoop = new THREE.LineLoop(circleGeom, circleMat);
      circleLoop.visible = false;
      this.detectionCircles.push(circleLoop);
      this.group.add(circleLoop);

      // 3. 視線遮擋/無遮擋射線 (2 點)
      const losGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 0)
      ]);
      const losMat = new THREE.LineBasicMaterial({ color: 0x22c55e, linewidth: 2 });
      const losLine = new THREE.Line(losGeom, losMat);
      losLine.visible = false;
      this.losLines.push(losLine);
      this.group.add(losLine);

      // 4. 追捕目標橙色連線
      const purGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 0)
      ]);
      const purMat = new THREE.LineBasicMaterial({ color: 0xf97316, linewidth: 3 });
      const purLine = new THREE.Line(purGeom, purMat);
      purLine.visible = false;
      this.pursuitLines.push(purLine);
      this.group.add(purLine);

      // 5. A* 追捕路徑導引線 (預留最多 30 個頂點)
      const pathPts: THREE.Vector3[] = [];
      for (let p = 0; p < 30; p++) pathPts.push(new THREE.Vector3(0, 0, 0));
      const pathGeom = new THREE.BufferGeometry().setFromPoints(pathPts);
      const pathMat = new THREE.LineBasicMaterial({ color: 0x06b6d4, linewidth: 2 });
      const pathLine = new THREE.Line(pathGeom, pathMat);
      pathLine.visible = false;
      this.astarPathLines.push(pathLine);
      this.group.add(pathLine);

      // 6. 已承諾路段導引線 (深藍/青綠粗線)
      const comGeom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 0)
      ]);
      const comMat = new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 4 });
      const comLine = new THREE.Line(comGeom, comMat);
      comLine.visible = false;
      this.committedSegmentLines.push(comLine);
      this.group.add(comLine);

      // 7. 預測目標標記 (金黃色小球)
      const predGeom = new THREE.SphereGeometry(0.8, 12, 12);
      const predMat = new THREE.MeshBasicMaterial({ color: 0xfacc15, wireframe: true });
      const predMesh = new THREE.Mesh(predGeom, predMat);
      predMesh.visible = false;
      this.predictedTargetMarkers.push(predMesh);
      this.group.add(predMesh);

      // 8. 重新規劃位置標記 (洋紅色圓環)
      const replanGeom = new THREE.RingGeometry(0.6, 1.2, 16);
      replanGeom.rotateX(-Math.PI / 2);
      const replanMat = new THREE.MeshBasicMaterial({ color: 0xd946ef, side: THREE.DoubleSide });
      const replanMesh = new THREE.Mesh(replanGeom, replanMat);
      replanMesh.visible = false;
      this.replanMarkers.push(replanMesh);
      this.group.add(replanMesh);
    }
  }


  private initDomPanel(): void {
    const el = document.createElement('div');
    el.id = 'police-debug-panel';
    el.style.cssText = `
      position: fixed;
      top: 70px;
      right: 20px;
      width: 320px;
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid rgba(56, 189, 248, 0.4);
      border-radius: 8px;
      padding: 14px 16px;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      z-index: 9999;
      display: none;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(8px);
    `;

    el.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 6px;">
        <div style="font-weight: 700; font-size: 14px; color: #38bdf8;">🚔 警察執法除錯面板 (F15 / Shift+\`)</div>
        <button id="btn-police-close" style="background: none; border: none; color: #94a3b8; font-size: 16px; cursor: pointer;">✕</button>
      </div>

      <div id="police-status-content" style="margin-bottom: 12px; line-height: 1.6; font-size: 12px; color: #cbd5e1;">
        載入中...
      </div>

      <div style="display: flex; flex-direction: column; gap: 6px;">
        <button id="btn-spawn-police" style="background: #1e40af; color: #fff; border: 1px solid #3b82f6; border-radius: 4px; padding: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">🚔 生成警車在附近</button>
        <button id="btn-force-red-run" style="background: #991b1b; color: #fff; border: 1px solid #ef4444; border-radius: 4px; padding: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">🚦 強制最近車輛違規 (搶紅燈)</button>
        <button id="btn-force-speeding" style="background: #c2410c; color: #fff; border: 1px solid #f97316; border-radius: 4px; padding: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">⚡ 強制最近車輛違規 (超速)</button>
        <button id="btn-force-jaywalk" style="background: #854d0e; color: #fff; border: 1px solid #eab308; border-radius: 4px; padding: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">🚶 強制最近行人違規 (穿越馬路)</button>
        <button id="btn-list-stuck-jitter" style="background: #4338ca; color: #fff; border: 1px solid #6366f1; border-radius: 4px; padding: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">⚠️ 列出抖動或卡住的警車</button>
        <button id="btn-start-sampling" style="background: #0f766e; color: #fff; border: 1px solid #14b8a6; border-radius: 4px; padding: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">⏱️ 開始 60 秒執法抽樣評估</button>
      </div>
    `;

    document.body.appendChild(el);
    this.panelElement = el;

    // 綁定按鈕事件
    el.querySelector('#btn-police-close')?.addEventListener('click', () => this.toggle());

    el.querySelector('#btn-spawn-police')?.addEventListener('click', () => {
      const p = (window as any).game?.player?.position || { x: 0, z: 0 };
      const ok = this.policeSystem.forceSpawnPoliceNear({ x: p.x, z: p.z });
      this.showToast(ok ? '✅ 已在附近生成巡邏警車' : '⚠️ 生成失敗或道路無效');
    });

    el.querySelector('#btn-force-red-run')?.addEventListener('click', () => {
      const p = (window as any).game?.player?.position || { x: 0, z: 0 };
      const ok = this.trafficSystem.forceNearestVehicleRedRun({ x: p.x, z: p.z });
      this.showToast(ok ? '🚨 已觸發最近車輛搶紅燈！' : '⚠️ 附近無活躍車輛');
    });

    el.querySelector('#btn-force-speeding')?.addEventListener('click', () => {
      const p = (window as any).game?.player?.position || { x: 0, z: 0 };
      const ok = this.trafficSystem.forceNearestVehicleSpeeding({ x: p.x, z: p.z });
      this.showToast(ok ? '⚡ 已觸發最近車輛超速！' : '⚠️ 附近無活躍車輛');
    });

    el.querySelector('#btn-force-jaywalk')?.addEventListener('click', () => {
      const p = (window as any).game?.player?.position || { x: 0, z: 0 };
      const ok = this.pedestrianSystem.forceNearestPedJaywalk({ x: p.x, z: p.z });
      this.showToast(ok ? '🚶 已觸發最近行人違規穿越！' : '⚠️ 附近無活躍行人');
    });

    el.querySelector('#btn-list-stuck-jitter')?.addEventListener('click', () => {
      const list = this.policeSystem.listStuckOrJitteringCars();
      console.log('[PoliceDebug] 抖動或卡住的警車列表:', list);
      if (list.length === 0) {
        this.showToast('✅ 目前無任何抖動或卡住之警車 (0 輛)');
      } else {
        const info = list
          .map(
            (c) =>
              `[${c.id}] 狀態:${c.state} 速度:${c.speed}km/h 原因:${c.stuckReason} 卡住:${c.stuckTimer}s 翻轉:${c.steeringFlipsCount}次`
          )
          .join('\n');
        alert(`⚠️ 抖動/卡住警車 (${list.length} 輛):\n${info}`);
      }
    });

    el.querySelector('#btn-start-sampling')?.addEventListener('click', () => {
      this.policeSystem.startSampling();
      this.showToast('⏱️ 已啟動 60 秒警察執法抽樣評估！');
    });
  }

  private registerGlobalWindowApi(): void {
    (window as any).togglePoliceDebug = () => this.toggle();
    (window as any).startPoliceSampling60s = () => {
      this.policeSystem.startSampling();
      return '警察執法 60 秒抽樣已啟動';
    };
    (window as any).getPoliceSamplingReport = () => {
      return this.policeSystem.getSamplingReport();
    };
    (window as any).listStuckOrJitteringPolice = () => {
      return this.policeSystem.listStuckOrJitteringCars();
    };
  }


  public toggle(): boolean {
    this.isVisible = !this.isVisible;
    this.group.visible = this.isVisible;
    if (this.panelElement) {
      this.panelElement.style.display = this.isVisible ? 'block' : 'none';
    }
    return this.isVisible;
  }

  public getIsVisible(): boolean {
    return this.isVisible;
  }

  /**
   * 逐幀更新 3D 視覺化射線、扇形與 DOM 面板數據
   */
  public update(_dt: number, _playerPos: Point2D): void {
    if (!this.isVisible) return;

    const vehicles = this.policeSystem.getVehicles();
    const stats = this.policeSystem.getStats();

    // 更新 DOM 面板內容
    const statusContent = this.panelElement?.querySelector('#police-status-content');
    if (statusContent) {
      const samplingStatus = this.policeSystem.isSamplingActive()
        ? `<span style="color: #facc15; font-weight: bold;">評估中 (剩餘 ${Math.ceil(this.policeSystem.getSamplingRemainingSec())}s)</span>`
        : `<span style="color: #94a3b8;">未啟動</span>`;

      let carDetails = '';
      for (const c of vehicles) {
        if (!c.active) continue;
        const steerDeg = (((c.steeringAngle || 0) * 180) / Math.PI).toFixed(1);
        const headingDiffDeg = (((c.steeringHeadingDiff || 0) * 180) / Math.PI).toFixed(1);
        const spd = (c.speed * 3.6).toFixed(1);
        carDetails += `<div style="margin-top: 4px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,0.1); font-size: 11px;">
          <b style="color: #38bdf8;">${c.id}</b> [${c.state}] 速度: ${spd}km/h<br/>
          轉向: <b>${steerDeg}°</b> (夾角: <b>${headingDiffDeg}°</b>) | 翻轉: ${c.steeringFlips?.length || 0}次<br/>
          路徑: ${c.pathWaypoints?.length || 0}點 | 段: ${c.committedSegmentIndex || 0} | 雜湊: ${c.pathHash ? c.pathHash.slice(0, 14) : '無'}
        </div>`;
      }

      statusContent.innerHTML = `
        <div>• 警車數: <b>${stats.activeCars}/${CONFIG.POLICE.MAX_CARS}</b> | 巡邏中: <b>${stats.patrollingCars}</b></div>
        <div>• 追捕中: <b>${stats.activePursuits}/${CONFIG.POLICE.MAX_ACTIVE_PURSUITS}</b> | 開罰完成: <b>${stats.totalCitations}</b></div>
        <div>• 逃脫數: <b>${stats.totalEscaped}</b> | 放棄追捕: <b>${stats.totalAbandoned}</b></div>
        <div>• AI 計算耗時: <b>${stats.aiTimeMs.toFixed(3)} ms</b> (預算 0.5ms)</div>
        <div>• 60秒抽樣狀態: ${samplingStatus}</div>
        ${carDetails}
      `;
    }

    // 檢查是否有剛完成的抽樣報告需彈出顯示
    const report = this.policeSystem.getSamplingReport();
    if (report && !this.reportModalElement && !this.policeSystem.isSamplingActive()) {
      this.showReportModal(report);
    }

    // 更新 3D 視覺化幾何體
    for (let i = 0; i < CONFIG.POLICE.MAX_CARS; i++) {
      const fovMesh = this.fovSectors[i];
      const circleLoop = this.detectionCircles[i];
      const losLine = this.losLines[i];
      const purLine = this.pursuitLines[i];
      const pathLine = this.astarPathLines[i];
      const comLine = this.committedSegmentLines[i];
      const predMesh = this.predictedTargetMarkers[i];
      const replanMesh = this.replanMarkers[i];

      const pv = vehicles[i];
      if (!pv || !pv.active) {
        fovMesh.visible = false;
        circleLoop.visible = false;
        losLine.visible = false;
        purLine.visible = false;
        pathLine.visible = false;
        if (comLine) comLine.visible = false;
        if (predMesh) predMesh.visible = false;
        if (replanMesh) replanMesh.visible = false;
        continue;
      }

      // 1. 扇形與圓圈位置對齊
      fovMesh.visible = true;
      circleLoop.visible = true;

      fovMesh.position.set(pv.x, 0.12, pv.z);
      fovMesh.rotation.y = pv.rotationY - Math.PI / 2; // 對齊車頭朝向

      circleLoop.position.set(pv.x, 0.08, pv.z);

      // 2. 視線與追捕目標
      if (pv.targetViolator) {
        const vPos = pv.targetViolator.position;
        const isBlocked = this.policeSystem.checkLineOfSightBlocked(pv.x, pv.z, vPos.x, vPos.z);

        // LOS 射線
        losLine.visible = true;
        const losPosAttr = losLine.geometry.attributes.position;
        losPosAttr.setXYZ(0, pv.x, 0.6, pv.z);
        losPosAttr.setXYZ(1, vPos.x, 0.6, vPos.z);
        losPosAttr.needsUpdate = true;
        (losLine.material as THREE.LineBasicMaterial).color.setHex(isBlocked ? 0x64748b : 0x22c55e);

        // 追捕中連線
        if (pv.state === 'PURSUIT' || pv.state === 'INTERCEPT') {
          purLine.visible = true;
          const purPosAttr = purLine.geometry.attributes.position;
          purPosAttr.setXYZ(0, pv.x, 1.2, pv.z);
          purPosAttr.setXYZ(1, vPos.x, 1.2, vPos.z);
          purPosAttr.needsUpdate = true;
        } else {
          purLine.visible = false;
        }
      } else {
        losLine.visible = false;
        purLine.visible = false;
      }

      // 3. A* 導航路徑線 (若有路徑節點)
      if (pv.pathWaypoints && pv.pathWaypoints.length > 1) {
        pathLine.visible = true;
        const pathPosAttr = pathLine.geometry.attributes.position;
        const count = Math.min(30, pv.pathWaypoints.length);
        for (let p = 0; p < count; p++) {
          pathPosAttr.setXYZ(p, pv.pathWaypoints[p].x, 0.25, pv.pathWaypoints[p].z);
        }
        for (let p = count; p < 30; p++) {
          pathPosAttr.setXYZ(p, pv.pathWaypoints[count - 1].x, 0.25, pv.pathWaypoints[count - 1].z);
        }
        pathPosAttr.needsUpdate = true;
      } else {
        pathLine.visible = false;
      }

      // 4. 已承諾路段導引線
      if (comLine) {
        if (pv.active && (pv.state === 'PURSUIT' || pv.state === 'PATROL') && pv.targetPoint) {
          comLine.visible = true;
          const comPosAttr = comLine.geometry.attributes.position;
          comPosAttr.setXYZ(0, pv.x, 0.35, pv.z);
          comPosAttr.setXYZ(1, pv.targetPoint.x, 0.35, pv.targetPoint.z);
          comPosAttr.needsUpdate = true;
        } else {
          comLine.visible = false;
        }
      }

      // 5. 預測目標標記
      if (predMesh) {
        if (pv.active && pv.predictedTarget && (pv.state === 'PURSUIT' || pv.state === 'INTERCEPT')) {
          predMesh.visible = true;
          predMesh.position.set(pv.predictedTarget.x, 0.8, pv.predictedTarget.z);
        } else {
          predMesh.visible = false;
        }
      }

      // 6. 重新規劃位置標記
      if (replanMesh) {
        if (pv.active && pv.lastReplanPos && pv.state === 'PURSUIT') {
          replanMesh.visible = true;
          replanMesh.position.set(pv.lastReplanPos.x, 0.15, pv.lastReplanPos.z);
        } else {
          replanMesh.visible = false;
        }
      }
    }
  }

  /**
   * 彈出 60 秒抽樣評估報告對話框
   */
  public showReportModal(r: PoliceSamplingReport): void {
    if (this.reportModalElement) {
      this.reportModalElement.remove();
      this.reportModalElement = null;
    }

    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 480px;
      background: #0f172a;
      border: 2px solid #38bdf8;
      border-radius: 12px;
      padding: 24px;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      z-index: 10000;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.8);
    `;

    const compliantTag = r.isCompliant
      ? `<span style="background: #15803d; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold;">✅ 完全合規 COMPLIANT</span>`
      : `<span style="background: #b91c1c; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold;">⚠️ 需持續調優</span>`;

    modal.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="margin: 0; font-size: 18px; color: #38bdf8;">📊 警察執法系統 60 秒抽樣評估報告</h3>
        <button id="btn-close-modal" style="background: none; border: none; color: #94a3b8; font-size: 20px; cursor: pointer;">✕</button>
      </div>

      <div style="background: rgba(30, 41, 59, 0.7); border-radius: 8px; padding: 16px; margin-bottom: 16px; font-size: 13px; line-height: 1.8;">
        <div>抽樣期間: <b>${r.samplingDurationSec} 秒</b> | 評估狀態: ${compliantTag}</div>
        <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 8px 0;" />
        <div>• 總違規次數: <b style="color: #f87171;">${r.totalViolationsCommitted}</b></div>
        <div>• 警察發現次數: <b style="color: #38bdf8;">${r.policeDetectedCount}</b></div>
        <div>• 平均反應時間: <b>${r.averageReactionTimeSec.toFixed(2)} 秒</b> (標準 0.5~1.5s)</div>
        <div>• 發動追捕次數: <b>${r.pursuitsInitiatedCount}</b> (開始次數: <b>${r.pursuitsStartedCount}</b>)</div>
        <div>• 有效追捕比例: <b style="color: ${r.validPursuitRatioPercent >= 90 ? '#4ade80' : '#facc15'};">${r.validPursuitRatioPercent.toFixed(1)}%</b></div>
        <div>• 成功攔下並開罰: <b style="color: #4ade80;">${r.interceptedAndCitedCount}</b></div>
        <div>• 違規者逃脫次數: <b>${r.fledEscapedCount}</b> (配合度約 92%)</div>
        <div>• 攔下成功率: <b style="color: ${r.interceptSuccessRatePercent >= 80 ? '#4ade80' : '#facc15'};">${r.interceptSuccessRatePercent.toFixed(1)}%</b> (目標 ~90%)</div>
        <div>• 轉向抖動次數: <b style="color: ${r.jitterEventsCount === 0 ? '#4ade80' : '#ef4444'};">${r.jitterEventsCount}</b> (目標為 0)</div>
        <div>• 無目標追捕次數: <b style="color: ${r.noTargetPursuitCount === 0 ? '#4ade80' : '#ef4444'};">${r.noTargetPursuitCount}</b> (目標為 0)</div>
        <div>• 警察脫困次數: <b>${r.unstuckEventsCount}</b></div>
        <div>• 警車卡住次數: <b style="color: ${r.stuckEventsCount === 0 ? '#4ade80' : '#ef4444'};">${r.stuckEventsCount}</b> (目標為 0)</div>
        <div>• 追捕事故次數: <b style="color: ${r.collisionEventsCount === 0 ? '#4ade80' : '#ef4444'};">${r.collisionEventsCount}</b> (目標為 0)</div>
      </div>

      <div style="text-align: right;">
        <button id="btn-confirm-modal" style="background: #0284c7; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-weight: bold; cursor: pointer;">確認關閉</button>
      </div>
    `;


    document.body.appendChild(modal);
    this.reportModalElement = modal;

    const closeHandler = () => {
      if (this.reportModalElement) {
        this.reportModalElement.remove();
        this.reportModalElement = null;
      }
    };

    modal.querySelector('#btn-close-modal')?.addEventListener('click', closeHandler);
    modal.querySelector('#btn-confirm-modal')?.addEventListener('click', closeHandler);
  }

  private showToast(msg: string): void {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid #38bdf8;
      color: #f8fafc;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 13px;
      z-index: 10001;
      box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    `;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  }
}
