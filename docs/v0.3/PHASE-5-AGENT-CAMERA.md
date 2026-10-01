# v0.3 PHASE 5 — AGENT CAMERA INTEGRATION

Baseline: `fedbba0` (Phase 4.5 LIVE VERIFIED, 1131/1131 tests green).

## Architecture BEFORE

```
Agent v3: prompt → Creative Director → cameraIntent{shot,angle,lens,requiresRedraw}
  → cameraSemantics 自己判 requiresRedraw + 生成 generationHint
  → compileTaskMap: requiresRedraw 时把 generationHint 只注入 pose generation   ← legacy
  → set_camera → doSetCamera: dispatch set-panel-camera(✓ canonical) 但 verify
    假设 staging 必发生,与 Phase 4.5 generative 收口冲突;无 focus、无 perspective
```

两条 legacy 路径(任务书 §4 点名,均已拆除):

1. Agent 自己判断 LOCAL/GENERATIVE(`requiresRedraw` / `generationHint`)。
2. generationHint → 只注入 pose generation(而非整幅 Panel unified generation)。

## Architecture AFTER

```
User → Manga Agent (Creative Director)
  → cameraIntent{shot?, angle?, lens?, perspective?, focusSubject?, dramaticIntent?}   ← INTENT ONLY
  → cameraSemantics.normalize()         纯归一化,无 redraw 判断,无 generation hint
  → resolveCameraTargetPanel()          explicit → selection → single-panel,否则 clarify
  → compileTaskMap: ONE set_camera step(+ set_focal_character / set_perspective)
  → doSetCamera (agent-v2):
      1. dispatch set-panel-camera  —— canonical command,undo 边界
      2. planPanelCamera()          —— 与 UI Generate 按钮读同一个 CameraResolver verdict
      3. LOCAL_TRANSFORM     → 命令内 deterministic staging 已完成,verify 几何,ZERO API
         GENERATIVE_REDRAW   → applyPanelCamera() —— Phase 4.5 整幅 Panel unified generation
```

UI 与 Agent 在 **Camera Application Service 汇合**;Agent 不持有任何 Camera logic。

## Agent Camera Intent Boundary

- `cameraSemantics.ts`:Creative words → editor enums,SOFT normalization(fallback + warning)。
  删除了 `requiresRedraw` / `generationHint` —— Agent 永远不再判断 redraw。
- `creativeTaskMap.cameraIntentSchema`:移除 `requiresRedraw`(zod strip 旧输出,兼容);
  新增 optional `focusSubject`(按名)与 `perspective`(creative string)。additive only。
- `systemPrompt`:规则 4 改为"只陈述意图;camera 属于 Panel;focusSubject 不是 generation target;
  目标 panel 不明就 clarificationNeeded"。

## Panel Target Resolution

`src/agent-v3/resolution/cameraTarget.ts`,确定性阶梯:

1. `map.target.panel` 显式指定
2. 当前页选中的 panel(selection → 1-based 序号)
3. 当前页只有一个 panel

其余 → `clarify`("Camera target is ambiguous…"),**不猜** first/last/largest。
`run.ts` 在 compile 前解析并把序号注入 `target.panel`;context line 现在告诉 director 选中 panel 的序号。

## Camera Service Boundary / LOCAL / GENERATIVE ownership

- LOCAL/GENERATIVE 的唯一裁判:`planPanelCamera` → `resolveCameraExecution`(frozen)。
- LOCAL:命令内 staging,A4 断言 `generateImage` 调用 = 0。
- GENERATIVE:`applyPanelCamera`(frozen Phase 4.5 路径):participants 解析、reference 合并、
  整幅 Panel 一次生成、non-destructive render、evidence `route: "panel-shot"`。
- Requested vs Applied、fake staging 禁止,全部由 frozen domain `setPanelCamera` §19 收口保证,
  Agent 层无任何重新实现。

## 多意图单执行

一句话多意图(angle+lens+shot+focus)→ ONE set_camera step(+1 focal/perspective step)
→ ONE plan 判决 → 最多 ONE generation(A3 断言 `generationCalls: 1`)。

## Undo/Redo

Agent camera 命令走 `set-panel-camera` / `set-panel-focal-item` / `set-panel-perspective`
+ `set-panel-camera-render`,全部在 run transaction 内;`endTransaction` 压一条历史,
undo 恢复 camera 与 composition(A8)。与 UI 操作同一 history 语义。

## Golden Tests(A1–A13)

`src/agent-v3/agentCameraGolden.test.ts`,13 个新测试:

- A1 高机位 → angle=high 落在 PANEL,GENERATIVE,整幅生成 ×1,character+scene 共同参与 ✓
- A2 focusSubject=Yuri → set_focal_character 先于 set_camera;prompt 含 "focal subject is Yuri";
  生成范围仍整幅 Panel ✓
- A3 多意图 → 恰好 ONE set_camera step,generation ×1,evidence route=panel-shot ✓
- A4 拉近(收紧 shot)→ LOCAL,generateImage 0 次 ✓
- A5 overhead → GENERATIVE,整幅 ×1 ✓
- A6 无选中+多 panel → ambiguous clarify;selection/单 panel/显式 panel 各自解析 ✓
- A7 Yuri 同现两个 panel → 只改 target panel,B 完全不动 ✓
- A8 undo 恢复 camera + composition,redo 重做 ✓
- A9 源码契约:agent camera 文件无 `@/services/generation` / providers / generateImage 引用 ✓
- A10 源码契约:无 projectInstance/applyCameraPatch/frameSubject 等 staging 投影 ✓
- A11 route=panel-shot,participants=2(Yuri+Tokyo Street),generation=1 ✓
- A12 v0.2 Interaction baseline:interactionBaseline.test.ts 全绿(回归套内) ✓
- A13 Phase 4.5 camera baseline:panelCamera.test.ts 全绿(回归套内) ✓
- 附加:perspective intent → set_perspective;§11 中文词汇表(v1 parser)映射 ✓

更新的旧测试(行为变更属本 Phase 授权范围):

- `cameraSemantics.test.ts` CASE 7:不再断言 camera 词注入 pose generation,改为断言
  ONE canonical set_camera step 且 pose instruction 不含 camera 词。
- `goldenV3.test.ts` CASE 5:同上。
- `sequenceGolden.test.ts` CASE D:低机位由"永不生成"的旧教义改为
  Resolver 判 GENERATIVE → panel-shot ×1;CASE C(特写收紧= LOCAL,零 API)不变;
  CASE F/undo 随生成 mock 接入恢复。

## Regression

- tests: **1144 / 1144**(baseline 1131 + 13)
- typecheck: PASS
- lint: 0 error / 4 warning(历史基线,未新增)
- build: PASS

## Files Changed

- `src/agent-v3/routing/cameraSemantics.ts` — 纯归一化;删 requiresRedraw/generationHint;+perspective
- `src/agent-v3/contract/creativeTaskMap.ts` — cameraIntent schema:+focusSubject/+perspective/−requiresRedraw
- `src/agent-v3/routing/capabilityRouter.ts` — 拆 cameraForGeneration 注入;+focal/perspective step;ONE set_camera
- `src/agent-v3/resolution/cameraTarget.ts` — NEW:panel target 确定性解析 + 歧义
- `src/agent-v3/run.ts` — 接入 cameraTarget;context line 报告选中 panel 序号
- `src/agent-v3/director/systemPrompt.ts` — 规则 4:INTENT ONLY,无 requiresRedraw
- `src/agent-v2/process/cameraProcess.ts` — doSetCamera 成为 Camera Application Service 客户端
- `src/agent/cameraIntent.ts` — 词汇 +"从上面看"(additive)
- tests:`agentCameraGolden.test.ts`(新)、`cameraSemantics.test.ts`、`goldenV3.test.ts`、`noDefaultScene.test.ts`、`sequenceGolden.test.ts`

## Files That Must NOT Change(未动)

`services/panelCamera.ts`、`services/cameraResolver.ts`、`domain/stageOps.ts`、`domain/staging.ts`、
`domain/commands.ts`、v0.2 interaction 全部、editor store、Phase 4.5 测试。

## Live Verification

UNVERIFIED — 待人工按任务书 §24 执行(选中 Yuri+Tokyo Street panel,输入
"改成高机位中景,以 Yuri 为主体",核验 12 项)。
