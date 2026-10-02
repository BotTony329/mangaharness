# v0.3 CAMERA ARCHITECTURE — FINAL (FROZEN)

Status: **v0.3 CAMERA SYSTEM = FROZEN**(Phase 6 closure, baseline `0e914b4`)。

# Panel is the only Camera owner.

# Character, Scene and Object are Camera participants/references, not Camera owners.

## 1. Camera Ownership

Camera lives on the Panel (`panel.camera`, `panel.perspective`, `panel.focalItemId`,
`panel.activeCameraRenderAssetId`)。没有 Character Camera / Scene Camera / Object Camera。
"给 Yuri 一个高机位" = 该 Panel 的 `camera.angle = high` + `focalItemId = Yuri 的实例`。

## 2. PanelCamera Domain

`src/domain/camera.ts` — `PanelCamera{shot, angle, lens, yaw, roll, mangaPerspectiveStrength}`,
`CameraPatch`,`createPanelCamera`,`applyCameraPatch`,`shotCoverage`。
Perspective:`src/domain/perspective.ts`(`none/one-point/two-point/three-point` + horizon)。

## 3. CameraResolver — ONE authority

`src/services/cameraResolver.ts` → `resolveCameraExecution()`:
- **LOCAL_TRANSFORM** — 现有像素足够(crop/pan/tilt/lens staging),ZERO API。
- **GENERATIVE_REDRAW** — 视角必须被画出来(high/low/overhead、yaw、manga perspective、
  perspective rig、shot  widening),transform 会是 fake。
判定规则本体在 `domain/staging.ts cameraChangeRequiresRedraw`;Resolver 是唯一 service 边界,
只加一条:shot widening 的 coverage 判断。Resolver 不 import provider(纯函数)。

## 4. LOCAL execution

`set-panel-camera` command → `domain/stageOps.setPanelCamera`:逐维度收口——
LOCAL 维度 deterministic staging(shot reframe focal、angle/lens 重投影),generative 维度
只记录 REQUESTED camera 不 fake staging。全程 command 边界,undo 可恢复。

## 5. GENERATIVE execution

`src/services/panelCamera.ts applyPanelCamera()` — Phase 4.5 frozen 路径:
resolvePanelVisualParticipants → 身份参考解析/修复 → P15 身份去重 → P16 参考 URL 级合并
→ reference budget → ONE joint prompt(cameraContextForPanel 共享词汇 + "redraw the whole
panel" 权威句)→ ONE generation → 注册 `panelCameraRender` asset(category: background,
metadata 含 panelId/referenceAssetIds/camera 状态)→ `set-panel-camera-render` 激活。
**Requested vs Applied**:requested camera 记录在 panel;render 是 applied 结果,非破坏。

## 6. Panel participant resolution

`resolvePanelVisualParticipants(doc, panelId)`:panel 内 asset 实例(character/scene/object)
+ 未放置的 interaction 参与者;排除 bubble/effect/tone 与一切生成产物(camera render、
interaction composite 不进 references);P15 同 character 多实例 = 一个 participant;
同名不同 character = 两个 participant(身份去重按 ID,不按名字)。

## 7. Reference lineage

participant 参考锚定 canonical/lineage root(`lineageRootAsset` 遇到 `panelCameraRender`
即停,render 永不成链)。同一张图经多个 asset 到达 = P16 参考级合并(名字合并,
interaction 成员保留);两个不同 character 解到同一张图 = 硬失败(身份故障)。

## 8. Interaction semantics

composite interaction 的**语义**(类型/方向/custom instruction)进 joint prompt,
旧 composite 图不进 references。`InteractionCameraIntent`(Phase 4 shot-level)是
**COMPATIBILITY HELPER**:production 调用方均不传 cameraIntent;canonical camera execution
是 panel-level。NOT CANONICAL PANEL CAMERA EXECUTION PATH。

## 9. Panel Camera Render — lifecycle

- **CREATE**:applyPanelCamera 注册 library asset(metadata.panelCameraRender=true)。
- **ACTIVATE**:`set-panel-camera-render` 写 `panel.activeCameraRenderAssetId`。
- **DISPLAY**:PanelRenderer 显示 render 并隐藏 asset 实例;bubble/effect/tone 继续在
  上层渲染、可编辑(无 double-render)。roll 实时旋转 render 节点。
- **REPLACE**:再次 Generate → R2 激活,R1 作为 library asset 保留(retention),
  R2 references = canonical/root sources,绝不含 R1(无 derivative chain)。
- **INVALIDATE**(Phase 6,`src/domain/cameraRender.ts` + `applyDomainCommand` 漏斗):
  VISUAL SOURCE MUTATION(参与者增删/替换/transform/staging/pose/expression/state/
  puppet/interaction/focus/身份参考变更)→ render 失活,composition 回到视图;
  EDITORIAL OVERLAY MUTATION(bubble/caption/effect/tone/anchor)→ 不失活。
  camera 自身变化:任何 framing 值变化(含 LOCAL)使 render 失活;roll 例外(实时应用)。
- **UNDO/REDO**:activation/retirement 都在 command 内,随 history 走(F15/F16)。
- **DELETE PANEL**:panel 随 layout 变更销毁,render 指针随之消失,asset 留 library,
  无 orphan 指针(F-suite)。
- **PERSIST/RELOAD**:doc JSON round-trip 保 camera/render 关联/source graph/overlay(F17)。

## 10. Bubble/Text overlay

Bubble/Text 不属于 AI visual generation source:不进 references、不进 generated bitmap
contract、render active 后继续显示可编辑、编辑不 invalidate render(F9/F10)。

## 11. UI boundary

`PanelStageControls` → dispatch `set-panel-camera`(同 domain 命令)+ `planPanelCamera`
读 verdict 决定 Generate 按钮可见性 + `applyPanelCamera` 执行。UI 不直接碰 provider/staging。

## 12. Agent boundary(Phase 5)

Director cameraIntent(INTENT ONLY)→ cameraSemantics 归一化 → resolveCameraTargetPanel
(explicit→selection→single-panel,否则 clarify)→ ONE `set_camera` step(+
`set_focal_character`/`set_perspective`)→ doSetCamera:canonical command →
`planPanelCamera` verdict → LOCAL 零 API / `applyPanelCamera`。
Agent 无 provider、无 staging 数学、无 character/scene routing(源码契约测试守护)。

## 13. Provider boundary

Camera core provider-agnostic:输出 semantic generation request(`generateImage`),
vendor 名词零引用;adapter 决定实际 API。Observability(`recordGenerationEvidence`):
route=panel-shot、panelId、camera、focus、participant/reference count、lineage、
generation count、render ID;永不记录 key/token/base64。

## 14. Dead paths removed(Phase 6)

`characterCamera.ts` / `sceneCamera.ts`(Phase 2/3 per-participant redraw services)
production-unreachable,其 contract(lineage root、LOCAL zero-API、prompt 权威、aspect)
已由 panelCamera/cameraResolver 测试覆盖——实现与历史测试一并删除。
**0 competing Camera execution paths。**

## 15. Frozen suites

- `interactionBaseline.test.ts` — v0.2 interaction byte-stable
- `panelCamera.test.ts` — Phase 4.5 P1–P16
- `agentCameraGolden.test.ts` — Phase 5 A1–A13
- `cameraFinal.test.ts` — Phase 6 F1–F20 + delete-panel + persistence
- `cameraBoundary.test.ts` — §17 dependency enforcement
- `cameraResolver.test.ts` — LOCAL/GENERATIVE verdicts
