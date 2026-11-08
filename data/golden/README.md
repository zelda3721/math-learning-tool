# 黄金集（阶段 0）

两套基线数据，供后续每个阶段的"行为没变 / 质量没退"有据可查。它们**不是测试用例**——
测试断言的是实现细节，黄金集记录的是**产品承诺**：这道题该解出什么答案、该画成什么样。
真正跑它们的是 `scripts/golden_eval.py`（对活引擎）和 `scripts/golden_check.py`（离线校验结构）。

## 引擎黄金集 `engine/cases.jsonl`

| 字段 | 含义 |
|---|---|
| `id` | 稳定标识，基线报告按它对账 |
| `problem` / `grade` | 原样发给引擎 `/api/v1/chat` 的题面与年级 |
| `figure` | 可选，仓库相对路径的配图（`null` 表示纯文字题） |
| `expect.answer` | **权威答案**，人读的规范写法 |
| `expect.match` | 机器比对规则，见下 |
| `expect.verification` | 按教学宪法的验证等级：`executable` / `reference` / `ai_unverified` |
| `expect.lane` | 期望命中的确定性构造器（`quantity_story` / `linear_mix_swap` / `linear_balance` 等），`null` 表示不限定 |
| `tags` / `source` | 归类与出处 |

`match` 三种形态：

- `{"type":"number","value":3}` —— 解的数值与 `value` 相等（相对误差 1e-6）
- `{"type":"expression","value":"x > 4"}` —— 用 SymPy 判等价
- `{"type":"values","values":[12,23]}` —— 多答案题，所有数值都必须出现在解里

出处：`session:*` 来自 `data/math_tutor.sqlite` 的真实会话（含历史上失败过的高频题），
`bench:*` 来自 `data/bench/throughput-001.json`，`figure_bench:*` 来自带标准答案的图形基准，
`authored` 是按学段补齐的题面（答案在 `golden_check.py` 里用 SymPy 独立复算）。

## 视频黄金集 `video/cases.jsonl`

| 字段 | 含义 |
|---|---|
| `problem` / `grade` / `answer` | 同引擎集 |
| `visual.representation` | **这道题该怎么被看见**（数形结合的第一性原理，不写"配一张图"这种空话） |
| `visual.web_player` | 期望用到的 SceneSpec 图元（词汇见 `packages/schema/src/scenespec.ts`） |
| `visual.manim.needs_manim` | 是否必须走 Manim 高级路线 |
| `visual.manim.features` | Manim 特性类：`formula_transform`（公式逐项变形）/ `param_sweep`（参数连续变化）/ `three_d`（立体）/ `linear_transform`（线性变换） |

规模要求（阶段 0 DoD）：总数 ≥ 30，`needs_manim: true` ≥ 8，且四个特性类都有覆盖。
`golden_check.py` 会强制这几条。

## 怎么用

```bash
# 离线：校验两套黄金集的完整性与答案自洽（CI / pnpm verify 里跑）
python3 scripts/golden_check.py

# 对活引擎跑一遍，落一份基线（需要引擎 + 本地模型都起着）
python3 scripts/golden_eval.py --set engine --base-url http://127.0.0.1:8000

# 只看某几道
python3 scripts/golden_eval.py --only eng-006,eng-010
```

基线报告写到 `data/bench/golden-<日期>-<时分>.json`。换模型（例如切到 oMLX）后重跑一份，
两份报告并排就是"新模型值不值得换"的全部论据：答案准确率、门禁通过率、中位耗时。

## 对齐评测集 `align/cases.jsonl`

教材概念 → 图谱节点，**候选准不准**。跑它的是 `scripts/align_eval.mjs`（已进 `pnpm verify`）。

| 字段 | 含义 |
|---|---|
| `id` | 稳定标识 |
| `title` / `text` | 概念名与概念正文（就是编译产物喂给对齐的那份东西） |
| `expect.nodeId` | 人判定的正确节点；`null` 表示**这个词不该进数学图谱**（反向题） |
| `expect.alsoAccept` | 可以接受的等价节点（「圆的周长」既可以算 `circle` 也可以算 `circle-geometry`） |

口径：

- **top1**：候选第一名命中 `nodeId` 或 `alsoAccept`；**top3**：前三名里有命中。
  教材对齐本来就该给家长留几个候选，所以 top3 是"可用下限"，top1 衡量"能不能省事"。
- **反向题**（`nodeId: null`）必须一个候选都不给。硬凑一个节点让家长去否决，比空着更糟。
- 门槛写在脚本里：top1 ≥ 75%、top3 ≥ 90%、反向全过。

这份集子不测"划词表调参"那种事——它是**产品承诺**：家长看到的候选里，
十次有九次以上能直接挑中。
