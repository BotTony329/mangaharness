# v0.3 Phase 1 — Camera Resolver

**Status**: ✅ completed, tested, merged (commit `363e9d8`)
**Date**: 2026-09-03

## 目标

为 v0.3 Generative Camera 建立唯一的决策边界：一个 panel camera 的变更，到底该 **LOCAL_TRANSFORM**（零 API,移动/裁剪现有画面）还是 **GENERATIVE_REDRAW**（调生成服务重画）。所有上层 surface(character、scene、后续其他目标)共用这个 resolver,不允许各自发明判断逻辑。

## 产出

- `src/services/cameraResolver.ts`
  - `resolveCameraExecution({ change, camera, fromShot?, toShot? })` — 返回 `{ execution, reason }`,复用 `domain/staging` 的判定(`LOCAL_TRANSFORM` / `GENERATIVE_REDRAW`)。
  - shot 变更按"取景范围是否变大"区分：变窄 = 裁剪(LOCAL),变宽 = 需要画面外内容(GENERATIVE);`fromShot` 缺省视为当前渲染的 shot。
  - `panelAspectFor(panel)`(Phase 3 新增)— 由 panel 顶点 bbox 推导 `portrait | landscape | square`,供生成请求继承画幅。

## 决策规则(冻结)

| 变更 | 判定 |
|---|---|
| angle ≠ eye-level | GENERATIVE |
| yaw 大到看到背面/侧面结构 | GENERATIVE |
| mangaPerspective ≥ 2 | GENERATIVE |
| perspective rig(three-point 等) | GENERATIVE |
| shot 变宽(如 close-up → wide) | GENERATIVE |
| shot 变窄(裁剪)、平移、缩放 | LOCAL,零 API |

## 测试

契约级测试随 Phase 2/3 的 Golden Cases 落地(A 系列、B 系列都经 resolver 门禁验证 GENERATIVE/LOCAL 路径)。

## Freeze 声明

Phase 1 只新增文件,不触碰 v0.2 interaction 链路、provider 层、Agent 架构、持久化架构。resolver 规则表为后续 Phase 的硬约束,修改属破坏性变更,需显式确认。

## 已知技术债

- `services/interaction.ts` 内有私有 `panelAspect` 与 `panelAspectFor` 逻辑重复;因 v0.2 freeze 未合并,后续统一收口到 cameraResolver。
