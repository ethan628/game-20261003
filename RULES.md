# 專案架構規則 (RULES.md)

本文件定義本專案（GTA 風格低多邊形開放世界網頁遊戲）的核心架構規則，後續所有功能擴充與程式碼修改均須嚴格遵守。

---

## 1. 模組分層架構 (Layered Architecture)

專案原始碼統一置於 `src/` 目錄，依下列職責嚴格分層：

- **`core/`**
  - **職責**：底層遊戲系統。
  - **內容**：
    - 固定時間步長遊戲迴圈 (`GameLoop.ts`)
    - 輸入管理器 (`InputManager.ts`)
    - 第三人稱視角追蹤與防穿牆鏡頭控制器 (`CameraController.ts`)
    - 渲染器與場景初始化 (`GameEngine.ts`)

- **`geo/`**
  - **職責**：地理資料獲取、快取、搜尋與標準化資料模型。
  - **內容**：
    - 經緯度與 3D 世界座標（公尺）投影轉換 (`Projection.ts`)
    - OpenStreetMap / Overpass API 抓取與重試/錯誤處理機制 (`OsmFetcher.ts`)
    - Nominatim 地點搜尋 API 封裝 (`NominatimSearch.ts`)
    - IndexedDB 快取層 (`GeoCache.ts`)
    - 標準化幾何資料介面型別定義 (`OsmTypes.ts`)

- **`world/`**
  - **職責**：將標準化地理資料轉換為 Three.js 3D 幾何網格與環境呈現。
  - **內容**：
    - 道路網格與人行道生成 (`RoadGenerator.ts`)
    - 建築輪廓擠出與高度配色生成 (`BuildingGenerator.ts`)
    - 水域多邊形與綠地多邊形生成 (`TerrainFeatureGenerator.ts`)
    - 基礎地面、光影與天空霧效 (`EnvironmentGenerator.ts`)
    - 世界管理器整合入口 (`WorldManager.ts`)

- **`entities/`**
  - **職責**：實體物件生命週期與物理碰撞。
  - **內容**：
    - 角色基底與方塊人形實體 (`Player.ts`)
    - 方塊人形動作動畫 (`CharacterRig.ts`)
    - （未來擴充）載具實體 (`Vehicle.ts`)、行人實體 (`Pedestrian.ts`)

- **`systems/`**
  - **職責**：全域系統邏輯（M1 預留，後續里程碑擴充）。
  - **內容**：
    - AI 行為系統 (`AISystem.ts`)
    - 戰鬥系統 (`CombatSystem.ts`)
    - 通緝等級與治安系統 (`WantedSystem.ts`)
    - 空間碰撞檢索系統 (`CollisionSystem.ts`)

- **`ui/`**
  - **職責**：使用者介面、儀表板與狀態反饋。
  - **內容**：
    - 畫面左上角 HUD（FPS、座標、地點名稱、快捷鍵指引）(`HUD.ts`)
    - 地點選擇與搜尋對話框（常用預設、Nominatim 搜尋、M 鍵切換）(`LocationModal.ts`)
    - 載入狀態與錯誤提示通知 (`LoadingOverlay.ts`)
    - （未來擴充）小地圖 (`Minimap.ts`)

---

## 2. 地圖生成與遊戲邏輯分離原則

- **`geo` 模組職責**：僅負責產出純粹、標準化的資料物件結構（如道路折線點串列、建築 2D 輪廓與高度屬性、水域/綠地多邊形頂點）。**嚴禁在此模組引用 Three.js 或建立 3D Object3D/Mesh**。
- **`world` 模組職責**：接收 `geo` 產出的標準資料結構，負責計算頂點、法向量、UV，並使用 Three.js 建立 3D Mesh 與 Material。
- 資料流向：`Nominatim / Preset` $\rightarrow$ `OsmFetcher (IndexedDB Cache)` $\rightarrow$ `Standard Geo Data` $\rightarrow$ `World Generators` $\rightarrow$ `Three.js Scene`。

---

## 3. 數值配置集中化

- 所有世界參數、實體數值、物理重力、顏色主題、網路逾時、預設地點清單等可調數值，**必須統一收斂在 `src/config.ts`**。
- 業務程式碼嚴禁 Hardcode 魔術數字 (Magic Numbers)。

---

## 4. 固定時間步長 (Fixed Timestep)

- 物理計算、角色移動、碰撞檢測一律採用**固定時間步長**（如 60Hz，即 $\Delta t = 1/60 \approx 0.01667\text{s}$）。
- 採用累加器 (accumulator) 機制，確保不同螢幕更新率（60Hz、120Hz、144Hz 等）與掉幀情況下，物理模擬與移動手感完全一致且穩定。

---

## 5. 資產與視覺風格原則

- **不使用任何外部付費或專案依賴的外部 3D 模型檔案**（如 glTF/FBX/OBJ）。
- 人物角色採用程式化生成之低多邊形（Low-Poly）方塊人形（Box Character）。
- 建築、道路與自然景觀均由幾何圖元動態建立，搭配扁平色調（Flat Shading）材質與柔和陰影。

---

## 6. 交通號誌系統模組化與對外公開介面規範 (Traffic Signal System Architecture)

交通號誌系統為開放世界中行人、未來車輛 AI、以及通緝違規系統之**核心控制中樞**。遵循低耦合、單一職責與安全封裝原則：

- **獨立模組與封裝**：
  - 號誌控制器與雙相位時間狀態機封裝於 `src/systems/traffic-signals/`。
  - 外部模組（車輛、行人、玩家、通緝系統）**嚴禁直接修改號誌內部計時器或相位**，只能透過公開介面進行狀態查詢或訂閱事件。
- **公開查詢介面**：
  1. **車輛號誌查詢 (供車輛 AI 與車流模擬使用)**：
     - `getVehicleState(intersectionId: string, approachId: string): VehicleSignalInfo`
     - 回傳 `{ state: 'green' | 'yellow' | 'red' | 'flashingYellow', remainingSec: number }`。
  2. **行人號誌查詢 (供行人穿越道 AI 使用)**：
     - `getPedestrianState(intersectionId: string, crossingId: string): PedestrianSignalInfo`
     - 回傳 `{ state: 'walk' | 'flashing' | 'dontWalk', remainingSec: number }`。
  3. **闖紅燈違規檢測 (供通緝系統 WantedSystem 與警方 AI 使用)**：
     - `isRunningRedLight(position: Point2D, headingRad: number): boolean`
     - 當車輛或玩家於紅燈期間越過停止線進入路口時回傳 `true`，可直接觸發違規通緝星級提升。
  4. **全域狀態廣播事件**：
     - `trafficSignalSystem.on('signal:changed', ({ intersectionId, groupAState, groupBState }) => void)`
- **GPU 渲染要求**：
  - 號誌系統全部使用 `InstancedMesh` 批次渲染，Draw Calls 嚴格不超過 6 個。
  - 僅對 200 公尺半徑內的路口更新視覺與倒數數字，遠處路口純邏輯運算。

