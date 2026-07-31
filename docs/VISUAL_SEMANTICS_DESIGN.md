# 数学表达质量设计：让数量变化可见（v2，经对抗评审修订）

状态：设计稿 v2（2026-07-31）。v1 经 3 视角 × 22 条批评、19 条成立后修订；
成立批评已全部吸收，关键修订用【修订】标注。
目标：视频用图形变化承载数学逻辑（3Blue1Brown 式），而不是元素堆叠 + 字幕宣读结论。

## 1. 实证诊断（会话 5178eb9d，"小明有5个苹果，吃了2个，还剩几个？"）

成片 12/12 通过门禁，但减法从未被展示。逐层取证：

| 层 | 应该发生 | 实际发生 |
| --- | --- | --- |
| Math IR | 提取运算结构：5 分成 2 和 3 | 只有 `evaluate("5-2")=3`，结构丢失 |
| 视觉计划 | 2 个苹果移入"吃掉"区，3 个归组计数 | 意图正确，但 `move` 无目的地字段；verify 验证的是两个**空**矩形 |
| 确定性模板 | 数量迁移动画 | `move` 降级为 `shift(UP*0.35)`；矩形 = 贴标签的空框 |
| 成片审查 | 发现"数量从未变化" | VLM 帧描述连写 8 次"保持不变"，却给 B2/B4 满分 |

结构性事实：`build_grounded_math_visual_plan` 只覆盖"方程求根/表达式邻域"两种
形状，纯算术 `evaluate` 不匹配 → 走 LLM 导演；更强的确定性算术链
（`_verified_arithmetic_candidate`，unit_grid + partition 机制）只在 LLM 计划
失败时兜底。**最简单的算术题拿到的是最弱的视觉路径。**

根因不是某一层的 bug，而是**动作语义在每一层都不被强制**：计划可以写出
不可执行的动作，模板可以把动作降级成装饰，审查不必对照自己的观察打分。

## 2. 设计原则

1. **数量即对象**。离散数量是可逐个追踪的单位 mobject 群，同一单位从出现到
   结束是同一对象——移动、变色、划掉，但永不销毁重画。对象连续性是 3b1b
   可读性的核心。
2. **运算即动词**。动作词汇表按运算语义设计，不按题型设计。
   【修订】封闭性声明的真实边界：动词集覆盖"可提取出小自然数关系结构的
   数量故事"；边界之外（负数、大数、分数、连续量、复杂多步）**设计上**走
   LLM 导演路径——这是边界不是缺陷。确定性路径的触发条件是可观察的 IR 结构
   谓词（见 §4），不是题面分类；禁止以"新增 kind"作为修 bug 手段——新情境
   要么由既有关系组合表达，要么走导演路径。
3. **参数强制，且路径无关**。【修订】每个动词必须携带执行所需的全部语义参数
   （数量、来源、去向），对确定性路径和 LLM 导演路径**无条件同等生效**；
   缺参数在 `_validate_plan` 拒绝，模板永不默默降级。
4. **数字由计数产生（可数区间内）**。【修订】单位数在可数区间（≤ 约 24）时，
   屏幕数字必须"从图形里数出来"（逐个点亮 + 计数器 + brace 锚定）；区间外
   数字由**可见测量**产生（quantity_bar 长度、数轴位置锚定），避免把该原则
   变成大数题的不可赢门禁。
5. **验证即逆运算或重计数**。verify 必须做可见的逆运算/重计数。
   【修订】"拒绝空容器"限定于：目标是容器类图元（rectangle/zone 语义为容器）
   且 repeat_units 为空且计划含 quantity_story；连续图元（function_curve/axes/
   polygon）的 verify 沿用既有确定性核验（鞋带面积、逐点变换重算），不受影响。

## 3. 动作词汇表升级（Visual IR v2）

### 3.1 Schema 演进方式【修订，blocking 批评 #2】

现有 constrained-decoding schema 是 strict + additionalProperties:false，
action 只有 {op, targets, result, meaning}。**不采用** per-op 判别联合
（anyOf 分支在本地运行时的 grammar 编译脆弱、小模型选支不稳）；改为
**平铺可空字段**：action 增加 `source, destination, count, style, parts,
expect, expect_total` 类型化可空键，键名仍受 grammar 约束，**逐动词的必填
检查放在 `_validate_plan`**，违规信息逐条指名（"take_from 缺少 destination"）。
落地前先用本地模型（qwen3.6-35b）实测扩展 schema 的服从率，再决定 P1 绑定。
计划增加 `plan_version` 字段；旧版本存量计划走旧 lowering，不进新校验器。

### 3.2 数量动词

```
take_from   {source, count, destination, style: cross_out|fade|fly}
combine     {sources(targets), result}
partition_into {source, parts: [k...], results}
replicate   {source, times(count), result}
count       {target, expect}
recount_verify {targets(groups), expect_total}
```

【修订，blocking #3】lowering 硬性规定：
- `destination` 必须是**已声明的容器/组对象 id**，不允许自由 zone 字符串
  （确定性 IR 提取会丢 anchor_zone，模板也没有 zone→坐标映射）；
- 单位迁移是**显式 re-parent**：从 source VGroup 移除、加入 destination，
  编译器维护逐 beat 单位台账（unit ledger），relayout/fit 按台账工作，
  杜绝"迁走的单位还在源组包围盒里被一起拖动/缩放"；
- 空位政策：**beat 进行中保留空位**（空位是减法的可见证据），
  **beat 退出时收拢**（exit_condition 达成后 relayout）；
- 守恒断言是**逐动词局部断言**【修订 #12】：每个动词只校验自身声明的
  source/destination 计数收支——不依赖 quantity_story，导演路径同样执行。
  全局不变量由计划自己用结构化 invariant 声明（group_id + 期望计数），
  校验器只验证被声明的不变量。

### 3.3 旧动作收紧【修订 #5】

- `move` 必须带 destination；坐标扫描类 move（height_models 驱动
  scan_tracker）改为**类型化目的地** `destination: {x: value}`，
  不破坏现有函数扫描计划；
- count 组之间的 `transform(count_a → count_b)`（现在算术链兜底和 LLM 计划
  的惯用形）在 normalize 层**改写为 take_from/combine** 并合成缺失的
  容器对象——守恒因此对旧词汇也是全覆盖的，堵住绕行通道；
- 逐个声明的同类对象（apple_1..apple_5）**不做静默合并**【修订 #4】：
  校验器给出专用违规信息引导 schema/prompt 产出 count 组；仅当成员引用
  构成干净分割（如 move[apple_4,apple_5] ≡ take_from(count=2)）时才自动
  合并并同步改写全部动作引用；合并产生的 unknown-id 违规**排除**在
  direct_video 的 lowering_only 判定之外，防止误路由到自由写码。

## 4. Math IR：关系型 quantity_story【修订，blocking #9】

v1 的线性故事（initial→operation→result）无法表达关系型算术，会把
"小红比小明多 3 个"错误渲染成合并动画。改为**关系型结构**：

```json
{
  "quantities": [
    {"id": "q_total",  "entity": "苹果", "role": "小明持有", "value": 5},
    {"id": "q_eaten",  "entity": "苹果", "role": "吃掉",     "value": 2},
    {"id": "q_left",   "entity": "苹果", "role": "剩余",     "value": 3}
  ],
  "relations": [
    {"kind": "evolves_by", "from": "q_total", "delta": "q_eaten", "to": "q_left", "direction": "decrease"},
    {"kind": "part_of", "parts": ["q_eaten", "q_left"], "whole": "q_total"}
  ]
}
```

关系集：`evolves_by / part_of / more_than_by / times_of`。比较关系
（more_than_by）lowering 到既有 **map 配对机制**（两组对齐、逐对连线、
剩余高亮），不是 combine。

**确定性路径触发谓词**（可观察，非题面分类）【修订 #6/#10/#11】：
- quantity_story 提取成功，且其全部数值被**已执行的 Math IR 操作精确复现**、
  覆盖最终答案 claim（数值不匹配 = 提取不可信 → abstain）；
- 所有值为非负整数且单位总数 ≤ 24（与逐个动画节奏预算匹配）；
- 关系全部落在关系集内。
任一不满足 → **显式 abstain** → LLM 导演路径（负数→number_line 图元，
大数/分数→quantity_bar 测量锚定）。`kind/relations` 是 LLM 产出的语义判断，
在既有 `audit_visual_plan` 审计阶段与题面交叉核对。

**路径优先级与修复**【修订，blocking #1】：
- DirectVideoTool 优先级：quantity_story 确定性计划（离散故事）>
  curve-grounded 计划 > LLM 导演；
- **`_verified_arithmetic_candidate` / `build_safe_visual_plan` 必须同步
  改造为产出新动词**——兜底构建器是最便宜的"词汇表保证点"，否则校验收紧
  只会提高兜底率而不提高质量（v1 的旗舰路径将几乎不被执行）；
- 确定性数量计划评审失败后走**参数化修复**（调节奏/布局参数重编译同一计划），
  不回落 LLM 重导演。

## 5. 编译模板：take_from 的标准 lowering

以 `take_from(source=apples, count=2, destination=eaten_box, style=fly)` 为例：

1. 高亮将被拿走的 2 个单位（逐个 Indicate，0.4s/个）；
2. 每个单位 re-parent 后按 style 迁移（fly 入容器 / cross_out 变灰划斜杠留位）；
   源组保留空位直至 beat 退出；
3. destination 随单位到达逐个计数（1、2），brace 标"2"；
4. 源组剩余单位逐个点亮计数（1、2、3），brace 标"3"。

节奏预算：题目卡 ≤3s；setup ≤20% 时长；数量动词 ≥50% 时长；逐个动画
0.3–0.5s/单位（count>8 分批）。消除 7 秒黑屏等待。

## 6. 审查闭环：从"打分"到"对照核数"

### 6.1 beat manifest【修订 #7/#13】

- manifest 的**语义内容从通过校验的计划推导**（计划是两条编译路径的共同
  输入）；**时间戳在渲染时记录**（生成的 Scene 在每个 beat 边界记录
  `self.renderer.time`，作为渲染产物由 run_manim 收集）——编译器无法静态
  预知实际时长（本次实际时长是计划的 194%）。
- model_codegen 路径的生成代码按契约调用注入的 `beat_marker(beat_id)`，
  使 manifest 时间轴对模型代码同样可用；不打点的代码不通过校验。
- manifest 每 beat 记录：结束时间戳、各组**语义计数与可见计数两列**
  （划掉但留位的单位属于可见计数）、各组 zone 包围盒（帧坐标）、单位填充色。
- inspect_video 按 manifest 的 beat 边界（+定帧 epsilon）抽帧，取代或补充
  固定比例抽帧。

### 6.2 确定性数量指标【修订 #8/#17/#18】

连通域计数**按 zone × 单位色**执行，不做全画面计数（全画面总数在守恒下
恒定，全局指标自我失效）：
- 在 854 宽抽帧上按 manifest 的 zone 包围盒裁剪，按声明的单位填充色做
  色距掩膜，连通域按"期望单位像素面积带"过滤（排除 brace/数字/斜杠）；
- 判据：**某 zone 的期望计数序列跨 beat 变化而实测序列持平** → 数量变化
  未发生，技术性判失败；全画面总量只用作守恒核对；
- cross_out 风格的单位按色掩膜计数而非原始连通性；依赖显式声明
  （opencv-python-headless 或 scipy.ndimage）；上线前用已知良品渲染集
  校准阈值，校准前只作 warning 不作硬判。

### 6.3 VLM 定点核数【修订，blocking #16】

- 精确数数问题仅限 subitizable 组（≤6 个单位）；更大的组问结构化问题
  （几行×几列、哪个区更多）；
- VLM 回答与 manifest 不符：**永不单独硬判**——B5 封顶至 1、记
  `manifest_mismatch` 警告；只有确定性连通域计数**独立确认** manifest
  被违反时才硬判失败；
- best_visual_candidate 资格只与确定性完整性挂钩，不与 VLM 数数挂钩；
  数数问题在 brace+数字锚定出现**之前**的帧上提问，防读字报数。

### 6.4 自一致性门禁【修订 #14/#19】

- 审查模板增加**逐帧结构化字段**："与上一帧相比，图形/数量是否变化:
  是/否/仅文字"，取代散文关键词扫描；
- 判自相矛盾需三重佐证：VLM 说未变 ∧ 该区间 adjacent_frame_difference
  同样静止（或变化仅在字幕带） ∧ manifest 声明该窗口应发生数量变化；
  manifest 声明的合法停顿（讲解 hold）排除在外；
- 后果：**封顶 acceptable + score_inconsistency 警告**，绝不单独翻 bad；
  硬判交给 §6.2 的确定性指标（它能独立拦截本次 12/12 事故）。

## 7. 分期落地

> **P1 已实施（2026-07-31）**：schema 平铺扩展、逐动词账本式校验（含守恒）、
> take_from/combine/count/recount_verify 模板降级（re-parent + 单位台账 + 逐个
> 计数 + 合计算式验证）、move 目的地强制（废除 0.35 位移降级）、verify 拒空容器、
> 数量故事提取（solve 输出 + 确定性复核）、DirectVideo 优先级（story > curve >
> LLM）与参数化修复、两个兜底构建器改产新动词、成员逐个声明违例引导。
> 5−2=3 已通过真实 manim 渲染验收：单位迁移、留空位、双组计数、"3+2=5 ✓"
> 重组验证全部可见。乘除仍走网格重组（倍数结构豁免），P3 升级为 replicate/
> partition_into。
>
> **同日增补**：take_away 默认表达改为**原地消失**（cross_out：单位在总体内
> 变灰划掉并被圈出标注，总数保持为"剩下+划掉"可见），repair 变体切换为
> 物理迁出；比较关系保持迁出表达。计数徽章带避让（排除自身旧徽章，避开
> 其他徽章与对象标签，UP→RIGHT→LEFT→DOWN 换边）；外框罩住源标签时标签
> 自动下移。另按同一次实测修复 IR 格式韧性（通用，非题型分支）：运行时
> 容错 `Eq(..)&Eq(..)` 合取、字典字面量 claim、variable 键放列表、单解列表
> 解包比较；确定性计算 JSON 无法解析时给出可行动的修复反馈；修复后仅剩
> 数学执行类问题时按"弃权不伪造"原则降级为逻辑验证（applicable=false），
> 不再杀死会话。

- **P1（先做）**：
  1. schema 平铺扩展 + plan_version + 本地模型服从率实测；
  2. `_validate_plan`：逐动词必填与局部守恒断言（路径无关）、
     transform(count→count) 改写、成员声明引导、专用违规信息；
  3. 模板：take_from/combine/count/recount_verify lowering（re-parent +
     单位台账 + 空位政策 + 逐个计数）；废除 move 无目的地降级；
  4. 关系型 quantity_story 提取 + 触发谓词 + abstain 回退；
  5. **改造两个确定性兜底构建器产出新动词**；DirectVideoTool 优先级调整；
     确定性计划的参数化修复路径。
  - 验收（按 IR 结构描述，非题面）：
    a) evolves_by(decrease) 故事：成片出现"k 单位迁出 + 空位 + 两组分别
       计数 + part_of 重组验证"；
    b) more_than_by 故事：成片为两组配对对齐 + 剩余高亮，**不得**渲染成
       combine；
    c) abstain 用例：负数/大数故事显式落入 LLM 导演路径不硬失败。
- **P2（已实施，2026-07-31 晚）**：确定性模板渲染时输出 beat manifest
  （stdout `BEAT_MANIFEST_JSON:` 标记 → executor 解析并随渲染缓存持久化 →
  run_manim 写入 state）；每 beat 记录实际时间戳、各组单位数、场景坐标包围盒、
  单位颜色与透明度。inspect_video 消费：zone×颜色连通域计数（纯 PIL 泛洪，
  **校准期只出 warning 不硬判**；调暗的 cross_out 组跳过颜色计数，交给核数
  问题）；VLM 定点核数（仅 ≤6 的 subitizable 组问精确数，答案不符只把 B5 封顶
  为 1 并记 manifest_mismatch，**永不单独判死**）；帧描述强制「｜变化: 是/否/
  仅文字」结构化标记，当评审自己标记静止 ∧ 像素静止 ∧ manifest 声明该窗口应有
  数量变化 ≥3 次时，good 封顶为 acceptable 并记 score_inconsistency。
  model_codegen 路径的 beat 打点契约未做（模板路径已覆盖主交付线）。
- **P3（部分实施，同日）**：`replicate` 动词落地（乘法=同一行的可见盖章复制，
  逐份落位 + 行计数 + 乘法算式徽章；账本守恒 per_row×times，总量 >64 拒绝）；
  除法沿用既有 partition 分组圈选降级（倍数豁免）。同日修复：一致性审计的
  措辞类否决按 `_machine_checkable_blocking_issue` 过滤（只有 BLOCKING+
  observed/expected 数值矛盾才能翻盘，方向措辞两说法不构成矛盾）。
  未做：partition_into 逐个分发动画、分数 bar 切分、节奏预算强制、
  连续动词参数强制收敛、天平确定性降级。

## 7.5 表示法优先级（2026-07-31 增补，已落地）

表示法由数学结构决定、几何优先于代数、年级决定抽象上限：

| 结构 | 表示 | 年级下限 |
| --- | --- | --- |
| 可数数量及变化 | 单位图形 + 数量动词 | 全年级 |
| 相等关系/方程 | 天平隐喻（两盘同时可见、变形同步、平衡可见） | 初中 |
| 函数/连续变化 | 坐标系、曲线、扫描 | 初中 |
| 线性变换/矩阵 | 先几何（网格/基向量被变换），代数作注释 | 高中+ |
| 比例/分数 | 分割条/圆/网格 | 全年级 |

小学解题叙述与画面禁止未知数与方程记号（Math IR 机器验算不受限）；
`build_grounded_math_visual_plan` 对 elementary_* 显式弃权（曲线表示超出小学
抽象上限），由数量图形或年级引导下的导演路径接手。天平隐喻的确定性降级
（balance 图元 + 双侧同步动词）留待 P2/P3；当前由导演提示词约束。

## 8. 与既有原则的关系

- 不违反"不枚举题型"：动词与关系按运算语义封闭枚举，触发条件是 IR 结构
  谓词；封闭集边界之外显式走开放路径。§2 原则 2 明确禁止以扩 kind 修 bug。
- 强化"数学事实来自可执行证据"：quantity_story 数值必须被已执行 Math IR
  复现才可信；守恒是逐动词机器断言；画面数字与计数/测量双向锁定。
- 审查侧延续"确定性优先、分级交付"：manifest/连通域承担硬判据，VLM 判断
  一律软化（封顶、警告），不再造不可赢门禁；每条新失败判据都有可复现的
  确定性证据链，符合策略文档 §5 的结构化回归测试要求。
