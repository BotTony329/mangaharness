# v0.3 Phase 2 — Generative Character Camera

**Status**: ✅ completed, tested, merged (commit `fa10ee7`)
**Date**: 2026-09-03
**Depends on**: Phase 1 Camera Resolver

## 目标

让已上画的角色在新镜头角度/景别下被**重画**(而非变形):panel camera 变化 → resolver 门禁 → 以角色 canonical 全身参考为锚的 GENERATIVE_REDRAW → 非破坏性 panel 替换。LOCAL 变更零 API 调用。

## Data Flow

```
Panel camera (angle / yaw / shot / mangaPerspective / perspective rig)
  → cameraResolver.resolveCameraExecution × 各维度
  → 任一 GENERATIVE_REDRAW?
     ├─ 否 → throw(零 API,现有画面即可达成)
     └─ 是 → characterCameraContext(camera) 镜头语义句
             + 角色 identity lock(身份/服装锁定)
             + canonical 全身参考图(硬锚,close-up 拉宽也不拉伸裁剪图)
             → generateImage(assetType "character-pose")
             → registerGeneratedAsset(metadata: cameraShot/cameraAngle/...)
             → dispatch swap-instance-asset(原资产保留,undo 可回)
```

## 产出

- `src/services/characterCamera.ts` — `redrawCharacterForCamera({ instanceId, camera, perspective? })`
- `src/services/characterCamera.test.ts` — Golden Cases A1–A5 + no-camera baseline
- `src/components/inspector/PanelStageControls.tsx` — "Generate Camera View" 按钮接入(character 目标)

## Golden Cases(全部通过)

| Case | 内容 | 验证点 |
|---|---|---|
| Baseline | 无 camera 的角色生成 | 请求 byte-stable 快照,prompt 不含 camera 语义 |
| A1 | high + medium | 镜头句 + identity lock + canonical 锚 + 非破坏替换;full-body 句不与景别冲突 |
| A2 | overhead | prompt 显式 "Overhead bird's-eye view" |
| A3 | yaw 45° | GENERATIVE,prompt 带旋转语义(无 schema 变更) |
| A4 | close-up → full | 拉宽锚定 canonical 全身参考,不拉伸裁剪图 |
| A5 | LOCAL / 无参考 | 零 API 抛错;失败抠图不作 identity 参考,显式失败 |

## Freeze 声明

未触碰:v0.2 三条 interaction baseline、SceneryService、provider 层、Agent 架构、持久化。camera enum 无新增。
