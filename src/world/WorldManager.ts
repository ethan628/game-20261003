/**
 * WorldManager.ts - 3D 世界生成與生命週期管理器 (GTA 風格升級)
 * 協調環境、道路、建物、自然地貌、街道雜物與招牌系統，支援濕潤/夜間模式與空間檢索
 */

import * as THREE from 'three';
import { BuildingFeature, BuildingPipelineStats, OsmWorldData, SignboardPipelineStats } from '../geo/OsmTypes.ts';
import { EnvironmentGenerator } from './EnvironmentGenerator.ts';
import { RoadGenerator } from './RoadGenerator.ts';
import { BuildingCollisionData, BuildingGenerator } from './BuildingGenerator.ts';
import { TerrainFeatureGenerator } from './TerrainFeatureGenerator.ts';
import { PropGenerator } from './PropGenerator.ts';
import { SignboardGenerator } from './SignboardGenerator.ts';

export class WorldManager {
  private scene: THREE.Scene;
  private renderer?: THREE.WebGLRenderer;
  private environmentGen: EnvironmentGenerator;
  private roadGen: RoadGenerator;
  private buildingGen: BuildingGenerator;
  private terrainGen: TerrainFeatureGenerator;
  private propGen: PropGenerator;
  private signboardGen: SignboardGenerator;

  private currentData: OsmWorldData | null = null;
  private buildingColliders: BuildingCollisionData[] = [];

  constructor(scene: THREE.Scene, renderer?: THREE.WebGLRenderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.environmentGen = new EnvironmentGenerator();
    this.roadGen = new RoadGenerator();
    this.buildingGen = new BuildingGenerator();
    this.terrainGen = new TerrainFeatureGenerator();
    this.propGen = new PropGenerator();
    this.signboardGen = new SignboardGenerator();

    // 初始化基礎環境地面、PMREM 與大氣微粒 (天空與動態光影由 WeatherRenderer 接管)
    this.environmentGen.setupSceneEnvironment(this.scene, this.renderer, false);
  }

  /**
   * 根據標準化 OsmWorldData 生成全城 3D 幾何物件 (含店家招牌與街道雜物)
   */
  public async buildWorld(data: OsmWorldData): Promise<void> {
    this.currentData = data;

    // 1. 自然地貌多邊形（水域、綠地）
    this.terrainGen.generate(data.features, this.scene);

    // 2. 道路、立體人行道、路緣石與路面標線 (單一資料來源：斑馬線、停止線與機慢車停等區)
    this.roadGen.generate(data.roads, this.scene, data.intersections || []);

    // 3. 建築物 (含 PBR 牆面、反射窗戶、屋頂水塔/冷氣機/天線) 並取得碰撞資料
    this.buildingColliders = this.buildingGen.generate(
      data.buildings,
      this.scene,
      data.buildingStats,
      data.buildingDebugFootprints
    );

    // 4. 街道雜物與環境物 (行道樹、街燈、機車、汽車、交通錐、消防栓、垃圾桶、電桿等 InstancedMesh)
    this.propGen.generate(data.roads, this.scene);

    // 5. 3D 店家招牌系統 (臨街牆面招牌、路邊立柱、補生成店面街屋全數合併)
    const { stats: sbStats, extraBuildingColliders } = await this.signboardGen.generate(
      data.shops || [],
      data.buildings,
      data.roads,
      data.features,
      this.scene,
      data.stats
    );
    if (extraBuildingColliders.length > 0) {
      this.buildingColliders.push(...extraBuildingColliders);
    }

    // 若當前處於濕潤或夜間模式，同步套用至新生成的幾何體
    if (this.environmentGen.getIsWet()) {
      this.roadGen.setWetMode(true);
    }
    if (this.environmentGen.getIsNight()) {
      this.signboardGen.setNightMode(true);
    }

    console.log(
      `[WorldManager] 3D 世界建構完成！道路: ${data.roads.length} 條, 建物: ${data.buildings.length + sbStats.onProceduralShop} 棟, 店家招牌: ${(data.shops || []).length} 家`
    );
  }

  /**
   * 逐幀更新環境（太陽陰影追隨、大氣微粒動態流動）
   */
  public updateEnvironment(playerPos: THREE.Vector3, delta = 0.016): void {
    this.environmentGen.updateEnvironment(playerPos, delta);
  }

  /**
   * 切換濕潤模式 (按 R 鍵：路面 roughness 驟降、水光反光)
   */
  public toggleWetMode(): boolean {
    const isWet = this.environmentGen.toggleWetMode();
    this.roadGen.setWetMode(isWet);
    return isWet;
  }

  public getIsWet(): boolean {
    return this.environmentGen.getIsWet();
  }

  /**
   * 切換夜間模式 (按 T 鍵：黃昏魔幻時刻 -> 深夜霓虹繁華)
   */
  public toggleNightMode(): boolean {
    const isNight = this.environmentGen.toggleNightMode(this.scene);
    this.signboardGen.setNightMode(isNight);
    return isNight;
  }

  public getIsNight(): boolean {
    return this.environmentGen.getIsNight();
  }

  public getBuildingColliders(): BuildingCollisionData[] {
    return this.buildingColliders;
  }

  public getBuildingsMesh(): THREE.Mesh | null {
    return this.buildingGen.getBuildingsMesh();
  }

  public getCurrentData(): OsmWorldData | null {
    return this.currentData;
  }

  public getRoadGenerator(): RoadGenerator {
    return this.roadGen;
  }

  public getSignboardGenerator(): SignboardGenerator {
    return this.signboardGen;
  }

  public getPropGenerator(): PropGenerator {
    return this.propGen;
  }

  public getBuildingGenerator(): BuildingGenerator {
    return this.buildingGen;
  }

  public getTerrainFeatureGenerator(): TerrainFeatureGenerator {
    return this.terrainGen;
  }

  /**
   * 逐幀計算招牌在相機視野錐內的數量
   */
  public updateSignboardsFrustum(camera: THREE.PerspectiveCamera): void {
    this.signboardGen.updateFrustumCulling(camera);
  }

  /**
   * 切換 F3 招牌除錯視覺化
   */
  public toggleSignboardDebug(): boolean {
    return this.signboardGen.toggleDebug();
  }

  public getSignboardStats(): SignboardPipelineStats | null {
    return this.signboardGen.getStats();
  }

  public getSignboardItems() {
    return this.signboardGen.getSignboardItems();
  }

  /**
   * 切換 F5 建築輪廓除錯視覺化
   */
  public toggleBuildingDebug(): boolean {
    return this.buildingGen.toggleDebug();
  }

  public toggleFloorLabels(): boolean {
    return this.buildingGen.toggleFloorLabels();
  }

  public getBuildingsList(): BuildingFeature[] {
    return this.buildingGen.getBuildingsList();
  }

  public getBuildingFeatureById(id: string): BuildingFeature | undefined {
    return this.buildingGen.getBuildingFeatureById(id);
  }

  public rebuildBuildings(updatedBuildings: BuildingFeature[]): void {
    if (!this.currentData) return;
    this.currentData.buildings = updatedBuildings;
    this.buildingColliders = this.buildingGen.generate(
      updatedBuildings,
      this.scene,
      this.currentData.buildingStats,
      this.currentData.buildingDebugFootprints
    );
  }

  public getBuildingStats(): BuildingPipelineStats | null {
    return this.buildingGen.getStats();
  }

  public getNearbyBuildingsCount(playerPos: THREE.Vector3, radius = 100): number {
    return this.buildingGen.getNearbyBuildingsCount(playerPos, radius);
  }

  /**
   * 切換地點時清理舊世界物件
   */
  public clear(): void {
    this.signboardGen.dispose(this.scene);
    this.propGen.dispose(this.scene);
    this.terrainGen.dispose(this.scene);
    this.roadGen.dispose(this.scene);
    this.buildingGen.dispose(this.scene);
    this.buildingColliders = [];
    this.currentData = null;
  }

  public dispose(): void {
    this.clear();
    this.environmentGen.dispose(this.scene);
  }
}
