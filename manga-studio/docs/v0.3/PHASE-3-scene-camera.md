# v0.3 Phase 3 — Generative Scene Camera

**Status**: ✅ completed, tested(待本 commit 合入)
**Date**: 2026-09-03
**Depends on**: Phase 1 Camera Resolver,Phase 2 Character Camera(模式复用)

## 目标

让已上画的场景(background asset)在新镜头视角下被**重画**:同一条街的俯视/低角度/三点透视版本。复用 SceneryService 同一生成面(`services/generation` + `buildAssetPrompt`),禁平行 pipeline;LOCAL 变更零 API。

## Data Flow

```
Panel camera + scene instance
  → cameraResolver 四门禁(angle / yaw / mangaPerspective / shot 拉宽;
     perspective rig 存在且非 none 时追加 perspective 门禁)
     fromShot = scene.metadata.cameraShot ?? "wide"(场景默认全景建立镜头)
  → 任一 GENERATIVE_REDRAW?
     ├─ 否 → throw "no generation needed"(零 API)
     └─ 是 → sceneCameraContext(camera, sceneName, perspective)
             = cameraGenerationContext + perspectiveGenerationContext
               + shot ≠ wide 时的 shotGenerationContext
               + 场景 identity lock("同一条街道,只有视角移动")
             + 场景自身渲染图作硬参考(assetRenderUrl;无则显式失败,
               禁止凭文本重画出"另一条街")
             → generateImage(assetType "background", size = panelAspectFor(panel))
               —— background 契约 = 服务端不透明/无白底/无抠图
             → registerGeneratedAsset(category "background",
               metadata: referenceAssetIds/cameraShot/cameraAngle/cameraLens + styleMetadata)
             → dispatch swap-instance-asset(非破坏,undo 恢复)
```

## 产出

- `src/services/sceneCamera.ts` — `redrawSceneForCamera({ instanceId, camera, perspective? })`、`sceneCameraContext()`
- `src/services/cameraResolver.ts` — 新增 `panelAspectFor(panel)` 导出
- `src/components/inspector/PanelStageControls.tsx` — "Generate Camera View" 扩展为 character/scene 双目标(selected 优先,唯一 cast/scene 兜底)
- `src/services/sceneCamera.test.ts` — Golden Cases B1–B5 + no-camera scenery baseline

## Golden Cases(7/7 通过)

| Case | 内容 | 验证点 |
|---|---|---|
| Baseline | 无 camera 的 `buildSceneryRequest` | 输出快照不变,证明 scenery.ts 未被碰 |
| B1 | low angle + wide | 镜头句 + 场景 identity lock + 硬参考 = 场景自身图 + assetType background + 画幅继承 panel + 非破坏替换 |
| B2 | overhead | prompt 显式 "Overhead bird's-eye view" |
| B3 | three-point perspective rig | perspective 门禁触发 GENERATIVE,prompt 带 "Three-point perspective" |
| B4 | close-up → wide(拉宽) | GENERATIVE,锚定源场景渲染图 |
| B5 | wide → 更窄裁剪 | LOCAL,零 API 抛错;场景无可用图像时显式失败不臆造 |

## 硬约束遵守

- 复用 SceneryService/GenerationService 同一生成面 — 无平行 pipeline
- 场景参考图为硬要求 — 缺失即 throw,不用文本兜底
- `assetType: "background"` 不透明契约 — 无透明请求/白底/抠图
- 画幅继承 panel(`panelAspectFor`)
- LOCAL 判定零 API 调用

## Freeze 声明

未触碰:v0.2 三条 interaction baseline、Phase 2 character camera、provider 层、Agent 架构、Interaction domain、持久化架构。camera enum 无新增。

## 已知技术债

- `services/interaction.ts` 私有 `panelAspect` 与 `panelAspectFor` 重复(v0.2 freeze 未合并,Phase 1 文档已登记)。
