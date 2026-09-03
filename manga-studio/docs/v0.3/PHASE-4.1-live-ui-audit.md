# v0.3 Phase 4.1 — Live UI Path Audit & Fix

**Status**: ✅ completed
**Date**: 2026-09-04
**Trigger**: Phase 4 contract tests 全绿,但 live 手测只发生 staging move/crop,无 AI redraw。

## Root cause

部署已确认新鲜(GitHub 推送自动部署,Phase 4 代码在 production)。代码级缺口有两层:

1. **可见性门禁与服务门禁不一致(主根因)**。`PanelStageControls` 决定"✨ Generate Camera View"是否出现时只检查了 `angle` 和 `mangaPerspective` 两个 change kind。Shot 拉宽、yaw ≥ 20°、perspective rig 这些 GENERATIVE 变更**永远不显示按钮**,用户只能看到 staging preview(move/crop),没有任何入口触发 AI redraw。
2. **可路由性判断是 UI 自己的另一套逻辑**(`hasTarget`:cast==1 / scene==1 / interaction 存在…),与 `applyCameraToShot` 的实际 routing 可能不一致——按钮显示了服务却可能拒绝,或服务能路由按钮却不出现。

另有 UX 因素(A 类):staging preview 是即时的,而 redraw 是两步操作;按钮不存在时用户无从得知需要第二步。

## Fix(最小,不动 camera architecture)

- `services/shotCamera.ts` 新增 **`planShotCamera(doc, input)`** 同步判定:同一套五门禁(angle/yaw/mangaPerspective/perspective/shot 拉宽)+ 同一套路由解析,返回 `{ requiresRedraw, reason, routable, route }`。`applyCameraToShot` 改为消费同一个 plan——按钮与服务永不可能分歧。
- `PanelStageControls`:
  - `redraw` 判定从"angle-only"换成 `planShotCamera`;
  - 按钮显示条件换成 `shotPlan.routable`,删除 UI 内的 target/interaction 分支逻辑;
  - 点击行为不变:只传 `panelId / instanceId / camera / perspective`。

## Real button contract tests(新增,真实组件 + 真实 store,仅 mock provider)

`src/components/inspector/PanelStageControls.test.ts`(jsdom + @testing-library/react,4/4):

1. 角色:eye-level → High → 按钮出现 → 点击 → generateImage=1 → instance swap
2. 场景:Low → 按钮 → 点击 → generateImage=1,assetType background,ref=场景自身图
3. Interaction:High → 按钮 → 点击 → ONE joint generation,双参考,prompt 含 camera + Hug
4. **回归缺口**:仅改 Shot full→wide(angle 不变)也显示按钮并能生成

测试基建:新增 devDependencies(jsdom、@testing-library/react、@vitejs/plugin-react),vitest include 增加 `.tsx`(组件测试用 `React.createElement` 写法,rolldown 下不需要 JSX 配置也能跑)。

## 验证

- TESTS: 1105/1105(97→98 files)
- TYPECHECK / LINT(0 error,4 历史 warning)/ BUILD:全绿
- 未触碰:CameraResolver 规则、generation prompt、provider、Phase 2/3/4 服务行为。
