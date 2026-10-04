# GTA 風格台灣街景開放世界 (GTA Style Taiwan Open-World)

基於 OpenStreetMap (OSM) 真實地理資料與 Three.js 構建之台灣街區 3D 開放世界網頁遊戲。

---

## 交通號誌系統 (Traffic Signal System)

本專案實作了模組化之台灣風格交通號誌系統，作為行人與未來車輛 AI 的控制中樞。

### 1. 核心特色
- **台灣懸臂式號誌桿**：
  - 人行道轉角立柱（高 6.8m）、橫向跨車道懸臂（長 5.5m，高 5.8m）。
  - 車輛橫式三燈（主燈橫臂懸掛、副燈立柱懸掛）。
  - 行人號誌（紅人、快走小綠人與最後 5 秒閃爍動畫）。
  - 動態倒數計時器（Shader UV 映射 Texture Atlas，零額外網格）。
  - 路面停止線與機車兩段式左轉待轉區標線。
- **路口資料管線**：
  - 整合 OSM Overpass 號誌標籤 (`highway=traffic_signals`, `crossing=traffic_signals`)。
  - 自動度數辨識（$\ge 3$ 度節點半徑 30m 聚類）。
  - 主幹道相交路口自動補齊號誌（標記 `auto`），實測路口標記 `osm`。
- **高效能 GPU 批次渲染**：
  - 總計 6 個 `InstancedMesh`（剛好 6 個 Draw Calls）：
    1. `poleMesh`: 懸臂式立柱與橫臂
    2. `housingMesh`: 燈頭箱體與遮光罩
    3. `vehicleLightMesh`: 車輛三燈盤（Shader 發光控制）
    4. `pedSignalMesh`: 行人號誌（小綠人/紅人動態紋理）
    5. `countdownMesh`: 倒數計時數字盤（Texture Atlas 實例 UV 偏移）
    6. `roadMarkingMesh`: 路面停止線與待轉區
  - 200m 半徑外動態剔除，逐幀更新邏輯耗時 $\le 0.15$ms。
- **相位狀態機與綠波協同**：
  - A/B 雙相位循環（綠燈 $\rightarrow$ 黃燈 $\rightarrow$ 全紅清空 $\rightarrow$ 垂直向綠燈）。
  - 相鄰路口綠波偏移。
  - 深夜離峰模式（次要路口閃黃燈/閃紅燈）。
  - 行人清空保障（秒數不足禁止過街，已過街者提速 1.4 倍）。

---

### 2. 公開介面規格 (Public APIs)

其他系統（車輛 AI、行人 AI、通緝系統）僅能透過公開介面與號誌系統交互：

```typescript
// 1. 車輛 AI 查詢進入道路之燈號狀態
const vehicleSignal: VehicleSignalInfo = trafficSignalSystem.getVehicleState(intersectionId, approachId);
// => { state: 'green' | 'yellow' | 'red' | 'flashingYellow', remainingSec: number }

// 2. 行人系統查詢穿越道之號誌狀態
const pedSignal: PedestrianSignalInfo = trafficSignalSystem.getPedestrianState(intersectionId, crossingId);
// => { state: 'walk' | 'flashing' | 'dontWalk', remainingSec: number }

// 3. 通緝系統 (WantedSystem) 闖紅燈違規判定
const isViolating: boolean = trafficSignalSystem.isRunningRedLight(entityPosition, entityHeadingRad);
// => true: 於紅燈期間越過停止線闖入路口

// 4. 全域號誌相位變更事件訂閱
trafficSignalSystem.on('signal:changed', ({ intersectionId, groupAState, groupBState }) => {
  // 處理相位切換連動邏輯
});
```

---

## 操作快捷鍵

| 按鍵 | 功能說明 |
|---|---|
| **WASD** | 角色前後左右移動 |
| **Shift** | 衝刺奔跑 |
| **空白鍵** | 跳躍 |
| **滑鼠** | 環繞視角 (點擊畫面鎖定) |
| **Tab** | 開啟/關閉全螢幕導航地圖 |
| **N** | 切換小地圖尺寸 |
| **M** | 開啟地點選擇選單 |
| **R** | 切換濕潤路面 (雨後反光) |
| **T** | 切換夜間霓虹氛圍 (深夜號誌閃光模式) |
| **F3** | 店家招牌除錯標記 |
| **F4** | 清除 IndexedDB 快取並重載 |
| **F5** | 建築輪廓幾何線框 |
| **F6** | 建築檢視校正模式 |
| **F7** | 3D 浮動樓層數字標籤 |
| **F8** | 行人路網與狀態除錯視覺化 |
| **F9** | **交通號誌路口與停止線除錯視覺化** |
