/**
 * TrafficDebugVisualizer.ts - NPC 交通車流與駕駛/乘客 F13 視覺化除錯工具
 * 遵循 RULES.md：
 * 1. 3D 浮動標籤：個性縮寫 (謹/常/急/慢/計)、心情色標 (平靜/煩躁/生氣)、乘客數、目前狀態、車速
 * 2. 喇叭聲波與對話氣泡視覺化：車頂浮現音波符號 📢 與氣泡對話框 💬
 * 3. 一鍵切換顯示/隱藏，未開啟時零效能負擔
 */

import * as THREE from 'three';
import { TrafficVehicle } from '../geo/TrafficTypes.ts';
import { IntersectionFeature } from '../geo/OsmTypes.ts';

const PERSONALITY_MAP: Record<string, { label: string; color: string }> = {
  cautious: { label: '謹', color: '#38bdf8' },
  normal: { label: '常', color: '#4ade80' },
  hurried: { label: '急', color: '#f97316' },
  slow: { label: '慢', color: '#c084fc' },
  taxi: { label: '計', color: '#facc15' }
};

const MOOD_MAP: Record<string, { icon: string; color: string; label: string }> = {
  calm: { icon: '🟢', color: '#22c55e', label: '平靜' },
  annoyed: { icon: '🟡', color: '#eab308', label: '煩躁' },
  angry: { icon: '🔴', color: '#ef4444', label: '生氣' }
};

const STATE_MAP: Record<string, string> = {
  DRIVING: '行駛中',
  STOPPED_SIGNAL: '停等紅燈',
  STOPPED_OBSTACLE: '前車阻擋',
  STOPPED_PEDESTRIAN: '禮讓行人',
  PICKING_UP: '靠邊接客',
  DROPPING_OFF: '靠邊下車',
  UNMANNED: '無人熄火'
};

interface VehicleLabelSprite {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  lastHash: string;
}

export class TrafficDebugVisualizer {
  private group: THREE.Group;
  private isVisible = false;
  private sprites: VehicleLabelSprite[] = [];
  private maxVehicles = 45;
  private groundOverlayMesh: THREE.Mesh | null = null;

  constructor(scene: THREE.Scene) {
    this.group = new THREE.Group();
    this.group.name = 'TrafficDebugVisualizerGroup';
    this.group.visible = false;

    this.initSprites();
    scene.add(this.group);
  }

  private initSprites(): void {
    for (let i = 0; i < this.maxVehicles; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;

      const texture = new THREE.CanvasTexture(canvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;

      const mat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false
      });

      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(3.2, 1.6, 1.0);
      sprite.visible = false;

      this.group.add(sprite);
      this.sprites.push({ sprite, canvas, ctx, texture, lastHash: '' });
    }
  }

  /**
   * 建立 3D 地面標示：紅色停止線與綠色合規停等區 (0.5m ~ 1.0m)
   */
  public setIntersections(intersections: IntersectionFeature[]): void {
    if (this.groundOverlayMesh) {
      this.group.remove(this.groundOverlayMesh);
      this.groundOverlayMesh.geometry.dispose();
      (this.groundOverlayMesh.material as THREE.Material).dispose();
      this.groundOverlayMesh = null;
    }

    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    let offset = 0;
    const yBand = 0.055;

    for (const inter of intersections) {
      for (const app of inter.approaches) {
        const stopLine = app.stopLine;
        if (!stopLine) continue;

        const fwdX = Math.sin(stopLine.azimuthRad);
        const fwdZ = Math.cos(stopLine.azimuthRad);
        const p1 = stopLine.p1;
        const p2 = stopLine.p2;

        // 1. 停止線 (紅色警戒線)
        const rHl = 0.10;
        pos.push(
          p1.x - fwdX * rHl, yBand, p1.z - fwdZ * rHl,
          p2.x - fwdX * rHl, yBand, p2.z - fwdZ * rHl,
          p2.x + fwdX * rHl, yBand, p2.z + fwdZ * rHl,
          p1.x + fwdX * rHl, yBand, p1.z + fwdZ * rHl
        );
        for (let k = 0; k < 4; k++) col.push(0.95, 0.2, 0.2); // 紅色
        idx.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
        offset += 4;

        // 2. 汽車合規停等區 (0.5m ~ 1.0m 綠色帶)
        const nP1x = p1.x - fwdX * 0.5;
        const nP1z = p1.z - fwdZ * 0.5;
        const nP2x = p2.x - fwdX * 0.5;
        const nP2z = p2.z - fwdZ * 0.5;
        const fP2x = p2.x - fwdX * 1.0;
        const fP2z = p2.z - fwdZ * 1.0;
        const fP1x = p1.x - fwdX * 1.0;
        const fP1z = p1.z - fwdZ * 1.0;

        pos.push(
          nP1x, yBand, nP1z,
          nP2x, yBand, nP2z,
          fP2x, yBand, fP2z,
          fP1x, yBand, fP1z
        );
        for (let k = 0; k < 4; k++) col.push(0.13, 0.77, 0.37); // 翡翠綠
        idx.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
        offset += 4;

        // 3. 機慢車停等區前端停等線 (0.5m ~ 1.0m 綠色合規帶)
        if (stopLine.hasScooterWaitingBox && stopLine.scooterStopWorldPosition) {
          const scPos = stopLine.scooterStopWorldPosition;
          const laneHalfW = (stopLine.width || 3.5) * 0.5;
          const rightX = Math.cos(stopLine.azimuthRad);
          const rightZ = -Math.sin(stopLine.azimuthRad);
          const sP1 = { x: scPos.x - rightX * laneHalfW, z: scPos.z - rightZ * laneHalfW };
          const sP2 = { x: scPos.x + rightX * laneHalfW, z: scPos.z + rightZ * laneHalfW };

          // 前端紅線
          pos.push(
            sP1.x - fwdX * rHl, yBand, sP1.z - fwdZ * rHl,
            sP2.x - fwdX * rHl, yBand, sP2.z - fwdZ * rHl,
            sP2.x + fwdX * rHl, yBand, sP2.z + fwdZ * rHl,
            sP1.x + fwdX * rHl, yBand, sP1.z + fwdZ * rHl
          );
          for (let k = 0; k < 4; k++) col.push(0.95, 0.2, 0.2);
          idx.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
          offset += 4;

          // 前端機車合規綠色帶 (0.5m ~ 1.0m)
          pos.push(
            sP1.x - fwdX * 0.5, yBand, sP1.z - fwdX * 0.5,
            sP2.x - fwdX * 0.5, yBand, sP2.z - fwdZ * 0.5,
            sP2.x - fwdX * 1.0, yBand, sP2.z - fwdZ * 1.0,
            sP1.x - fwdX * 1.0, yBand, sP1.z - fwdZ * 1.0
          );
          for (let k = 0; k < 4; k++) col.push(0.13, 0.77, 0.37);
          idx.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
          offset += 4;
        }
      }
    }

    if (pos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);

      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        side: THREE.DoubleSide
      });

      this.groundOverlayMesh = new THREE.Mesh(geo, mat);
      this.groundOverlayMesh.name = 'StopLineGroundOverlays';
      this.group.add(this.groundOverlayMesh);
    }
  }

  public toggle(): boolean {
    this.isVisible = !this.isVisible;
    this.group.visible = this.isVisible;
    return this.isVisible;
  }

  public getVisible(): boolean {
    return this.isVisible;
  }

  public update(vehicles: TrafficVehicle[], cameraPos: THREE.Vector3): void {
    if (!this.isVisible) return;

    let spriteIdx = 0;

    for (const v of vehicles) {
      if (!v.active || spriteIdx >= this.maxVehicles) continue;

      const dist = Math.hypot(v.x - cameraPos.x, v.z - cameraPos.z);
      if (dist > 85) continue;

      const sp = this.sprites[spriteIdx];
      sp.sprite.visible = true;

      const labelY = v.type === 'scooter' ? v.y + 2.05 : v.y + 2.35;
      sp.sprite.position.set(v.x, labelY, v.z);

      const scaleFactor = Math.max(2.4, Math.min(5.5, dist * 0.08 + 2.4));
      sp.sprite.scale.set(scaleFactor, scaleFactor * 0.5, 1.0);

      const pInfo = PERSONALITY_MAP[v.driver.personality] || PERSONALITY_MAP.normal;
      const mInfo = MOOD_MAP[v.driver.mood] || MOOD_MAP.calm;
      const stateStr = STATE_MAP[v.state] || v.state;
      const passCount = v.driver.passengers.length;
      const isHonk = v.driver.isHonking || v.driver.honkSoundTimer > 0;
      const speech = v.driver.speechBubbleText || '';
      const stopDistStr = v.frontBumperDistanceToLine !== undefined ? v.frontBumperDistanceToLine.toFixed(2) : '';
      const queueGapStr = v.distanceToLeadVehicle !== undefined ? v.distanceToLeadVehicle.toFixed(2) : '';

      const hash = `${v.id}_${pInfo.label}_${mInfo.icon}_${v.driver.moodScore.toFixed(0)}_${stateStr}_${passCount}_${isHonk}_${speech}_${v.isLeadStoppedVehicle}_${stopDistStr}_${queueGapStr}_${v.isViolator}_${v.violationType}`;

      if (sp.lastHash !== hash) {
        sp.lastHash = hash;
        this.renderCanvas(sp, v, pInfo, mInfo, stateStr, passCount, isHonk, speech);
        sp.texture.needsUpdate = true;
      }

      spriteIdx++;
    }

    for (let i = spriteIdx; i < this.maxVehicles; i++) {
      this.sprites[i].sprite.visible = false;
    }
  }

  private renderCanvas(
    sp: VehicleLabelSprite,
    v: TrafficVehicle,
    pInfo: { label: string; color: string },
    mInfo: { icon: string; color: string; label: string },
    stateStr: string,
    passCount: number,
    isHonk: boolean,
    speech: string
  ): void {
    const { ctx, canvas } = sp;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. 若有對話氣泡或喇叭鳴笛，繪製頂層突顯橫幅
    if (speech) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(10, 6, 236, 34, 8);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#1e293b';
      ctx.font = 'bold 15px "PingFang TC", "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`💬 "${speech}"`, 128, 23);
    } else if (isHonk) {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.95)';
      ctx.beginPath();
      ctx.roundRect(40, 6, 176, 32, 8);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 18px "PingFang TC", "Microsoft JhengHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('📢 叭叭！！', 128, 22);
    }

    // 2. 主資訊膠囊底框 (違規者繪製亮橘色外框)
    const boxY = speech || isHonk ? 46 : 28;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.strokeStyle = v.isViolator ? '#ff6600' : 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = v.isViolator ? 4 : 2;
    ctx.beginPath();
    ctx.roundRect(12, boxY, 232, 68, 12);
    ctx.fill();
    ctx.stroke();

    // 3. 第一列：個性徽章 + 心情圖示 + 乘客數 + 車速
    ctx.fillStyle = pInfo.color;
    ctx.beginPath();
    ctx.roundRect(22, boxY + 8, 28, 24, 6);
    ctx.fill();

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 16px "PingFang TC", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pInfo.label, 36, boxY + 20);

    // 車種與 ID
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '13px monospace';
    ctx.textAlign = 'left';
    const typeLabel = v.type === 'taxi' ? 'TAXI' : v.type === 'scooter' ? '機車' : '轎車';
    ctx.fillText(`${typeLabel} ${v.id}`, 56, boxY + 20);

    // 心情與乘客
    ctx.textAlign = 'right';
    ctx.fillStyle = mInfo.color;
    ctx.font = '13px "PingFang TC", "Microsoft JhengHei", sans-serif';
    const passStr = passCount > 0 ? `👥+${passCount}` : '👤單人';
    ctx.fillText(`${mInfo.icon}${mInfo.label} ${passStr}`, 234, boxY + 20);

    // 4. 第二列：目前行為狀態或停等量測
    ctx.textAlign = 'left';
    const kmh = (v.speed * 3.6).toFixed(0);

    if (v.isLeadStoppedVehicle && v.frontBumperDistanceToLine !== undefined) {
      const d = v.frontBumperDistanceToLine;
      let badgeCol = '#22c55e';
      let badgeTxt = `停止線: +${d.toFixed(2)}m [合格]`;
      if (d < 0) {
        badgeCol = '#ef4444';
        badgeTxt = `壓線: -${Math.abs(d).toFixed(2)}m [違規]`;
      } else if (d < 0.5) {
        badgeCol = '#eab308';
        badgeTxt = `停止線: +${d.toFixed(2)}m [太近]`;
      }
      ctx.fillStyle = badgeCol;
      ctx.font = 'bold 13px "PingFang TC", "Microsoft JhengHei", monospace';
      ctx.fillText(badgeTxt, 22, boxY + 48);
    } else if (!v.isLeadStoppedVehicle && v.distanceToLeadVehicle !== undefined) {
      const d = v.distanceToLeadVehicle;
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 13px "PingFang TC", "Microsoft JhengHei", monospace';
      ctx.fillText(`排隊車距: +${d.toFixed(2)}m [合格]`, 22, boxY + 48);
    } else {
      ctx.fillStyle = '#38bdf8';
      ctx.font = '13px "PingFang TC", "Microsoft JhengHei", sans-serif';
      ctx.fillText(`狀態: ${stateStr} (${kmh} km/h)`, 22, boxY + 48);
    }

    // 心情指數長條 (右側小進度條)
    const barWidth = 60;
    const barX = 174;
    const barY = boxY + 42;
    ctx.fillStyle = 'rgba(71, 85, 105, 0.6)';
    ctx.beginPath();
    ctx.roundRect(barX, barY, barWidth, 10, 4);
    ctx.fill();

    const moodRatio = Math.max(0, Math.min(1, v.driver.moodScore / 100));
    ctx.fillStyle = mInfo.color;
    ctx.beginPath();
    ctx.roundRect(barX, barY, barWidth * moodRatio, 10, 4);
    ctx.fill();
  }

  public dispose(): void {
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    if (this.groundOverlayMesh) {
      this.groundOverlayMesh.geometry.dispose();
      (this.groundOverlayMesh.material as THREE.Material).dispose();
      this.groundOverlayMesh = null;
    }
    for (const sp of this.sprites) {
      sp.texture.dispose();
      sp.sprite.material.dispose();
    }
    this.sprites = [];
  }
}
