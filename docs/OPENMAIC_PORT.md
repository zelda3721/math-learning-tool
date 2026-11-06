# OpenMAIC 移植台账

> 依据：`docs/PLAN.md` 第八部分（移植清单）与第一部分（"互补，不合并"）。
> 上游：OpenMAIC v1.4.0 @ `795420c1`（MIT），https://github.com/THU-MAIC/OpenMAIC
> **2026-11-05 已核对**：上游取到本机（`/tmp/openmaic`，blobless，会话结束可弃），`git checkout 795420c1` 成功。
> 逐项实测下面的数字，**六项全部与 PLAN 记的一致，逐文件分毫不差**（含 generation 那 1258 行的逐文件拆分）。
> 只有一处路径说法不同：PLAN 写作 `@openmaic/generation`，实际在 `packages/@openmaic/generation/src/`。
> 许可确认为 MIT，版权行 `Copyright (c) 2026 THU-MAIC`。

取回方式（可直接复用；`--depth 1` 取不到指定提交，必须先有历史）：

```bash
mkdir -p /tmp/openmaic && cd /tmp/openmaic && git init -q
git remote add origin https://github.com/THU-MAIC/OpenMAIC
git fetch --filter=blob:none origin     # 先拿历史
git checkout 795420c1
```

## 为什么要移植，以及边界

OpenMAIC 的课堂（播放/动作引擎、可交互场景、生成工具链）做得成熟；它没有学习者模型、不守"不喂答案"、不做验证。
所以**只搬与框架无关的那部分**（约 5k 行），搬进来由本项目自己维护，不跟上游同步。

不搬：`@openmaic/renderer`（PPT 式画布）、agent-runtime / pbl-v3（依赖 Postgres；PBL 只参考设计）、
importer、`mathml2omml`（LGPL）、GSAP / Hyperframes、云端媒体 provider。

## 台账（按阶段，不按上游目录）

| # | 来源 | 行数 | 去向 | 阶段 | 状态 |
|---|---|---|---|---|---|
| 1 | `lib/playback/*`（8 个文件） | 1,688（实测一致） | `packages/classroom-runtime` | 3 | ☐ 未开始 |
| 2 | `lib/action/engine.ts` | 912（实测一致） | `packages/classroom-runtime` | 3 | ☐ |
| 3 | `lib/store/interactive-iframe-pool.ts` | 212（实测一致） | `packages/widgets` | 3 | ☐ |
| 4 | `components/scene-renderers/{interactive-renderer,InteractiveIframeHost,InteractiveRuntimeErrorBanner}.tsx` | 按需 | `packages/widgets` | 3 | ☐ |
| 5 | `components/scene-renderers/quiz-*.tsx` | 按需 | 课堂小测（**改成由服务端判定**） | 3 | ☐ |
| 6 | `components/whiteboard/*`（3 个文件） | 899（实测一致） | 课堂白板（可选） | 3 | ☐ |
| 7 | `packages/@openmaic/generation/src/`：`json-repair` 278、`generation-retry` 235、`interactive-post-processor` 252、`interactive-script-validator` 156、`interactive-library-mapper` 250、`interactive-libraries` 87 | 1,258（实测一致） | `packages/generation` | 3 | ☐ |
| 8 | `@openmaic/generation/templates/{simulation,diagram,game}-content` | 提示词 | 组件自由生成的兜底（**改写为各学科专用版本**） | 3 / 7 | ☐ |

## 每条移植的验收标准（不是"搬过来了"，是"搬过来还能被信"）

1. **播放/动作引擎**：给定同一份课堂脚本，`playback` 的逐拍状态与 OpenMAIC 一致；本项目额外要求 `seek(t)` 确定性（阶段 2 的播放器契约）。
2. **interactive 宿主**：沙箱有测试锁住（阶段 3 DoD 明文要求），跨域脚本不能逃逸；库版本锁定。
3. **quiz 组件**：判定**必须**回到服务端判卷器（`subjects/*/judges`），前端只做输入与展示。上游是前端判定，这一条是明确的反向改动。
4. **generation 工具链**：json-repair / 重试 / 后处理 / 脚本校验逐项有单测；产出必须过 zod 与我们的门禁，失败退回 compose（确定性路径）。
5. **提示词模板**：不能直接搬通用模板——数学的模板必须带"数形结合 + 可验证"的约束，否则等于把上游的表达力接进来、等于把它的不可靠也接进来。

## 纪律

- 每个移植文件头写 `Adapted from OpenMAIC <path> @795420c1 (MIT)`；根目录 `THIRD_PARTY_NOTICES.md` 同步登记。
- 移植后**由本项目维护**，不回推上游、不跟上游 rebase。
- 引进前先问一句：这件东西和阶段 2 的时间轴播放器是不是同一个职责？同一件事只留一种实现（PLAN 第二部分的唯一原则）。

## 与本项目现有能力的关系

- 我们的 `packages/explainer-web` 已有 17 种图元与 SceneSpec 渲染，**不要**用 OpenMAIC 的 renderer 替换它——那是 PPT 式画布，职责不同。
- 课堂运行时消费的是 SceneSpec 与动作通道，因此阶段 2 播放器的 `seek`/补间契约要先于阶段 3 的课堂落地。
