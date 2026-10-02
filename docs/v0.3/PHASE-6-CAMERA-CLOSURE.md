# v0.3 PHASE 6 — CAMERA PRODUCTION HARDENING & CLOSURE

Baseline: `0e914b4`(Phase 5 LIVE VERIFIED 文档提交后)。

## A. Legacy Camera Path Audit — dependency map

```
UI Camera (PanelStageControls)
  → dispatch set-panel-camera (domain command)         CANONICAL
  → planPanelCamera / applyPanelCamera (services)      CANONICAL

Agent Camera (doSetCamera, agent-v2)
  → dispatch set-panel-camera                          CANONICAL
  → planPanelCamera → LOCAL verify / applyPanelCamera  CANONICAL

Panel Camera Application Service (services/panelCamera.ts)
  → cameraResolver.resolveCameraExecution              CANONICAL
  → services/generation.generateImage                  CANONICAL(唯一 provider 触点)

CameraResolver (services/cameraResolver.ts)
  → domain/staging.cameraChangeRequiresRedraw          CANONICAL(纯,无 provider)

LOCAL path
  → domain/stageOps.setPanelCamera 逐维度 staging       CANONICAL

GENERATIVE path
  → panelCamera.applyPanelCamera → ONE joint generation CANONICAL

Provider
  → 仅 services/generation 被 panelCamera 调用          CANONICAL

characterCamera.ts / sceneCamera.ts(Phase 2/3)
  → production import: 无。仅被自身历史测试引用。        DEAD → 已删除

shotCamera / applyCameraToShot                          DEAD(Phase 4.5 已删,无残留)

InteractionCameraIntent(interaction.ts 可选参数)
  → production 调用方均不传 camera。                    COMPATIBILITY HELPER,保留并注释

cameraGenerationContext / shotGenerationContext (domain/staging)
  → 被 cameraResolver.cameraContextForPanel 统一消费     CANONICAL(共享词汇)

parseCameraIntent (agent/cameraIntent.ts, v1)
  → sequencePlan / validation 使用,v1 pipeline NL parser CANONICAL(v1 路径)
```

## B. Canonical Boundary Enforcement

- 删除 dead legacy:`characterCamera.ts`、`sceneCamera.ts` 及各自历史测试(-21 tests)。
  其有价值 contract(lineage root 锚定、LOCAL 零 API、camera prompt 权威、aspect 契约)
  已由 `panelCamera.test.ts` P9/P10/P11/P13 与 `cameraResolver.test.ts` 覆盖,无需迁移。
- 新增 `src/services/cameraBoundary.test.ts`(7 tests)守护 §17:
  UI 不碰 provider/staging;Agent 不碰 provider/staging/legacy services;
  camera core 不 import Agent/UI(删 Agent 目录概念下 Camera 完整);
  Resolver 无 provider;generation 唯一触点 = panelCamera;provider-agnostic;evidence 无密钥。
- `InteractionCameraIntent` 标注 COMPATIBILITY HELPER(本文件 §A 与 final doc §8)。

## C. Camera Render Lifecycle Hardening

新增 `src/domain/cameraRender.ts` + `applyDomainCommand` 统一漏斗(复用
ATTACHMENT_AFFECTING 同款架构):

- **VISUAL SOURCE MUTATION**(参与者增删/替换/transform/staging/pose/expression/
  state/puppet/interaction create-update-remove/focus/set-character-reference)
  → active render 失活,source composition 回到视图,待重新 Generate。
- **EDITORIAL OVERLAY MUTATION**(bubble/caption/effect/tone/anchor/tails)→ 不失活。
- `set-panel-camera`:任何 framing 值变化(含 LOCAL)使 render 失活;**roll 例外**——
  renderer 实时旋转 render 节点,Dutch tilt 直接生效,render 保持 current。
- v1 compiler(`sequencePlan`)步骤顺序修正:camera 步骤移到 placement+focus 之后
  (generative camera 需要参与者已就位;原"camera before placement"是 staging 时代遗物)。

### Lifecycle 问题回答(任务书 §6)

- Render 是什么 asset:library asset,category=background,metadata.panelCameraRender=true。
- Panel 如何知道 active:`panel.activeCameraRenderAssetId`。
- supersede:render 激活时 renderer 隐藏 asset 实例;sources 永不删除。
- 旧 render:R2 激活后 R1 保留在 library(retention),永不成 R2 的 canonical reference。
- undo:activation/retirement 随 command 历史恢复(F15/F16)。
- reload:JSON round-trip 完整恢复(F17)。
- delete panel:panel 随 layout 变更销毁,指针随之消失,asset 留 library,无 orphan。

## D. Final Regression + Freeze

- 新增 `cameraFinal.test.ts` 16 tests:F1–F17 全项 + delete-panel + persistence
  (F18–F20 由 agentCameraGolden A1/A4/A11 与 boundary 测试覆盖;F21–F23 为 frozen 套件回归)。
- 新增 `cameraBoundary.test.ts` 7 tests。
- tests:**1146 / 1146**(1144 baseline − 21 legacy + 23 新增)。
- typecheck PASS;lint 0 error / 4 warning(历史基线,未新增);build PASS。

## Files Changed

- NEW `src/domain/cameraRender.ts`、`src/services/cameraFinal.test.ts`、`src/services/cameraBoundary.test.ts`
- `src/domain/commands.ts` — invalidation 漏斗接入
- `src/domain/stageOps.ts` — LOCAL camera change 使 render 失活(roll 例外)
- `src/agent/sequencePlan.ts` — camera 步骤移到 placement/focus 之后
- DELETED `src/services/characterCamera.ts`、`sceneCamera.ts` 及两测试
- docs:`CAMERA-ARCHITECTURE-FINAL.md`(新)、本文件

## Live

INHERITED FROM PHASE 5。generation path 未变(byte-equivalent);本 Phase 改动 =
invalidation、lifecycle、dependency cleanup、tests,不涉及 render 生成路径本身。

## Status

# v0.3 CAMERA SYSTEM = FROZEN
