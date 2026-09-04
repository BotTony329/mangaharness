# PHASE 4.5 — Panel-Level Unified Generative Camera

状态:代码完成,自动化全绿,等待人工 LIVE TEST。

## 架构转向

**Camera owner = Panel。** GENERATIVE_REDRAW 时,生成对象是整个 Panel 的一张统一画面(ONE joint generation),不再按 selection/fallback route 到 character/scene/interaction 单目标。旧的 `services/shotCamera.ts`(target routing)已删除,由 `services/panelCamera.ts` 取代。

```
CameraResolver gate(LOCAL → 零 API,永远)
  └─ GENERATIVE → resolvePanelVisualParticipants(Panel→Instances→Assets 结构化收集)
                → reference policy(character canonical / scene·object lineage root /
                  interaction = 原始 participant refs + 语义,绝不拿旧 composite)
                → ONE generateImage → Panel Camera Render asset
                → panel.activeCameraRenderAssetId(非破坏:源实例保留,undo 恢复)
```

## 关键决策

- **Participant resolver**(`resolvePanelVisualParticipants`):只收 `kind:"asset"` 实例 → bubble/effect/tone/text/border 结构性排除;跳过 `metadata.panelCameraRender` / `metadata.interactionId` 的生成产物(它们不是 source);隐藏实例仍参与(composite interaction 的 retired sprites 正是 source graph);未放置的 composite interaction 参与者也会被收进来(canonical/root 锚定)。
- **Reference budget**:`MAX_PANEL_REFERENCES = 3`(两个已接入 provider 的 maxImages 都是 3;client capability 表面没有 count,保守取值)。超限不 silent drop:优先级 interaction participants > focus > scene > 其他角色 > objects;omitted 记入 runtime evidence + asset metadata + prompt 文字提及。
- **Prompt**:新 `buildPanelShotPrompt`(promptTemplates)复用 joint pipeline 的 style/aspect 机制,内置 no-text 条款;camera 权威语句("Do not preserve the camera orientation…/Do not merely crop, translate or scale…");Focus 只进 composition 语义,不决定生成谁。
- **Non-destructive**:`Panel.activeCameraRenderAssetId` 是最小 schema 改动;PanelRenderer 在 active render 存在时绘制它并 supersede 源 asset 实例(bubble/effect/tone 照常渲染可编辑);`set-panel-camera-render` 走既有 command 架构,undo/redo 免费获得。
- **§19(原 PATCH A)并入**:`setPanelCamera` 逐 dimension 判定——GENERATIVE 维度(angle≥redraw、yaw≥20°、mangaPerspective≥2、shot widening)只记录 requested camera,不做 fake framing/restage;混合 patch 的 LOCAL 部分照常执行(stagingCamera 覆写法,不是粗暴 total skip);generative 变更会清除 stale 的 active render。requested/applied 正式分离记入 backlog,未做大 schema 分离。
- **UI**:`PanelStageControls` 按钮回到 `✨ Generate Camera View`(无 target 名);active render 时显示 "Camera view active — sources kept" + "Show composition" 返回入口;Focus On 保留;未加 per-asset camera UI。

## 冻结确认

- v0.2 interaction baseline:`interactionBaseline.test.ts` 6/6 快照未动,`services/interaction.ts` 未改;P14 锁定无 camera intent 的 baseline contract。
- 未触碰:Agent、Mask、panel 复制/排序、provider 架构、Pose Rig、Expression、无关 Editor UX。

## 验证

- Golden P1–P14:`src/services/panelCamera.test.ts` 15 tests 全绿。
- 组件契约:`PanelStageControls.test.ts` 9 tests(按钮无 target 名、未放置 interaction 参与者进 panel shot、Show composition 回退)。
- §19 契约更新:`cameraStage.test.ts` / `cameraIntegrity.test.ts` 对应测试改写为新语义。
- 全量:**1129/1129 tests**,tsc 0 error,lint 0 error(4 历史 warning),build 绿。

## Runtime evidence

`window.__kumangaGenerationLog` 新增 `camera-route: panel-shot` 记录:panelId、camera(shot/angle/lens/perspective)、focusSubject、participantCount、participants(type/instanceId/lineage)、referenceCount、referenceSources、omittedParticipants、assetId、generationCalls。

## LIVE TEST(人工,待做)

Panel: Yuri + Tokyo Street;Camera: Medium / High / Natural;Focus: Yuri。预期 ROUTE panel-shot、PARTICIPANTS 2、REFERENCES canonical Yuri + root Tokyo Street、GENERATION CALL 1;视觉验收 9 条(见任务书 §25)。通过后 = PANEL GENERATIVE CAMERA LIVE VERIFIED。

## Backlog

- `panel.camera` requested/applied 正式分离(§19 明确推迟)。
- ProviderCapabilities client 表面暴露 maxImages 后,替换保守常量 3。
