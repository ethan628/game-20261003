/**
 * WorldManager.ts - 3D 世界生成與生命週期管理器
 * 協調環境、道路、建物、自然地貌與街景裝飾物生成，並維護空間檢索資料
 */

import * as THREE from 'three';
import { BuildingPipelineStats, OsmWorldData, SignboardPipelineStats } from '../geo/OsmTypes.ts';
import { EnvironmentGenerator } from './EnvironmentGenerator.ts';
import { RoadGenerator } from './RoadGenerator.ts';
import { BuildingCollisionData, BuildingGenerator } from './BuildingGenerator.ts';
import { TerrainFeatureGenerator } from './TerrainFeatureGenerator.ts';
import { PropGenerator } from './PropGenerator.ts';
import { SignboardGenerator } from './SignboardGenerator.ts';

export class WorldManager {
  private scene: THREE.Scene;
  private environmentGen: EnvironmentGenerator;
  private roadGen: RoadGenerator;
  private buildingGen: BuildingGenerator;
  private terrainGen: TerrainFeatureGenerator;
  private propGen: PropGenerator;
  private signboardGen: SignboardGenerator;

  private currentData: OsmWorldData | null = null;
  private buildingColliders: BuildingCollisionData[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.environmentGen = new EnvironmentGenerator();
    this.roadGen = new RoadGenerator();
    this.buildingGen = new BuildingGenerator();
    this.terrainGen = new TerrainFeatureGenerator();
    this.propGen = new PropGenerator();
    this.signboardGen = new SignboardGenerator();

    // 初始化基礎環境光影與地面
    this.environmentGen.setupSceneEnvironment(this.scene);
  }

  /**
   * 根據標準化 OsmWorldData 生成全城 3D 幾何物件 (含店家招牌)
   */
  public async buildWorld(data: OsmWorldData): Promise<void> {
    this.currentData = data;

    // 1. 生成自然地貌多邊形（水域、綠地）
    this.terrainGen.generate(data.features, this.scene);

    // 2. 生成道路、立體人行道、路緣石與路面標線
    this.roadGen.generate(data.roads, this.scene);

    // 3. 生成建築物 (含女兒牆、窗戶、屋頂水塔) 並取得碰撞資料
    this.buildingColliders = this.buildingGen.generate(
      data.buildings,
      this.scene,
      data.buildingStats,
      data.buildingDebugFootprints
    );

    // 4. 生成人行道行道樹與路燈 (InstancedMesh)
    this.propGen.generate(data.roads, this.scene);

    // 5. 生成 3D 店家招牌系統 (臨街牆面招牌、路邊立柱、補生成店面街屋)
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

    console.log(
      `[WorldManager] 3D 世界建構完成！道路: ${data.roads.length} 條, 建物: ${data.buildings.length + sbStats.onProceduralShop} 棟 (真實: ${data.buildings.length}, 補生成店面: ${sbStats.onProceduralShop}), 地貌: ${data.features.length} 塊, 店家招牌: ${(data.shops || []).length} 家`
    );
  }

  /**
   * 逐幀更新環境（如太陽陰影與天空穹頂跟隨玩家）
   */
  public updateEnvironment(playerPos: THREE.Vector3): void {
    this.environmentGen.update(playerPos);
  }

  public getBuildingColliders(): BuildingCollisionData[] {
    return this.buildingColliders;
  }

  public getBuildingsMesh(): THREE.Mesh | null {
    return this.buildingGen.getMesh();
  }

  public getCurrentData(): OsmWorldData | null {
    return this.currentData;
  }

  /**
   * 逐幀計算招牌在相機視野錐內的數量
   */
  public updateSignboardsFrustum(camera: THREE.Camera): number {
    return this.signboardGen.updateFrustum(camera);
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
    return this.signboardGen.getItems();
  }

  /**
   * 切換 F5 建築輪廓除錯視覺化
   */
  public toggleBuildingDebug(): boolean {
    return this.buildingGen.toggleDebug();
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
