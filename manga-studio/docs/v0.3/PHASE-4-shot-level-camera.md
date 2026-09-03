# v0.3 Phase 4 — Shot-Level Generative Camera (Interaction + Camera)

**Status**: ✅ completed, tested(见 commit 记录)
**Date**: 2026-09-04
**Depends on**: Phase 1 Resolver,Phase 2 Character Camera,Phase 3 Scene Camera,v0.2 Interaction joint generation(冻结基线)

## 核心原则

Camera belongs to the SHOT,not to an asset。一个 panel 里存在正式 interaction 时,camera redraw 必须走 v0.2 joint generation 产出**一张统一画面**;禁止 characterCamera + sceneCamera + overlay(perspective/lighting/scale/contact 必然错位)。

## Architecture

```
✨ Generate Camera View (UI,无 routing 分支)
  → applyCameraToShot({ panelId, instanceId?, camera, perspective? })   [services/shotCamera.ts]
     1. CameraResolver 五门禁(angle/yaw/mangaPerspective/perspective/shot 拉宽)
        全 LOCAL → throw,ZERO API
     2. GENERATIVE → 读正式记录路由(禁猜测 panel 内容):
        - doc.interactions 中本 panel 的 composite interaction
          (选中实例参与者命中,或无选中时 panel 唯一 interaction)
          → rerenderInteraction(interactionId, cameraIntent) —— Phase 4 joint path
        - 否则单资产:selected/唯一 cast → Phase 2;selected/唯一 scene → Phase 3
        - 独立 object 无单资产 camera 路径(known limitation,显式报错)
        - 无选中且目标不唯一 → 显式报错,NEVER silently merge
```

## cameraContext 注入(optional addition,STEP 3)

`renderInteraction(interactionId, expressions?, cameraIntent?)`:

- **absent → byte-identical v0.2 baseline**(interactionBaseline.test.ts 6/6 快照锁定)
- present → `cameraContextForPanel(camera, perspective)`(cameraResolver 新增共享 builder,组合 cameraGenerationContext + perspectiveGenerationContext + shot≠wide 的 shotGenerationContext)append 到 joint prompt 末尾(identity/fidelity lock 之后)
- 禁止项遵守:未重写 prompt builder / participant resolution / reference collection / composition profiles / interaction resolver;无第二套摄影词汇

## Cache identity(STEP 2 审计结论 + 扩展)

`interactionCacheKey` 已有 `shot`/`angle` 槽位(v0.2 时 `c=any/any`)。Phase 4 仅做兼容新增:`lens`/`yaw`/`perspective` 可选字段,存在时并入 `c=` 段;缺失时 key 与 v0.2 逐字节一致。Hug+Overhead ≠ Hug+EyeLevel,无第二个 camera cache。

## Result lifecycle(沿用 v0.2)

一张 merged derivative asset;metadata 记录 interactionId/referenceAssetIds/cameraShot/cameraAngle/cameraLens + style;原 participants hide 不 delete;undo 恢复;regenerate 可带新 cameraIntent 再生成。

## Golden Cases(6/6 通过)

| Case | 内容 | 结果 |
|---|---|---|
| C | C↔S walk + low + full | route=interaction,ONE call,refs=[char,street],prompt 含 walking+low-angle+full-shot+双 fidelity,assetType background 无 cutout 词,opaque composite |
| D | C↔C hug + overhead | route=interaction,ONE call,双 identity refs,character cutout/portrait 契约不变 |
| E | C↔O eat + close-up high | ONE call,object fidelity/contact/no-floating/exactly-once 全部保留 |
| F | full→medium crop | LOCAL,ZERO API(存在 interaction 不强制重生成) |
| G | 两角色无 interaction | 显式报错 "never merged",ZERO API,不发明 interaction |
| Cache | overhead×2 + high | 相同 camera cache hit 零调用;不同 camera 重新生成 |

## 回归

- NO-CAMERA v0.2 baseline:interactionBaseline 6/6 快照不变(byte-stable)
- Phase 2 A1–A5、Phase 3 B1–B5:全部通过
- 全量 1101/1101;typecheck clean;lint 0 error;build 通过
- 注:一次全量跑中出现过 1 个历史用例的瞬时失败,两次重跑均全绿,与本次改动文件无关(flaky,记录待观察)

## Known limitations

- 独立 object(不在 interaction 中)无单资产 camera 路径
- synchronized(puppet-local)interaction 不走 joint camera,落回单资产路径
- 无选中且 panel 有多个 composite interaction 时需用户显式选择目标
- `services/interaction.ts` 私有 `panelAspect` 与 `panelAspectFor` 重复(v0.2 freeze 未合并)

## Freeze 声明

未触碰:provider 层、Agent 架构、v0.2 interaction baseline 行为、composition profiles、持久化架构;无新 camera enum、无平行生成 pipeline、无 mask/panel duplication/cross-panel。
