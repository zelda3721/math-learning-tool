# 差倍问题可视化技能 (Difference-Multiple Problem)

## 描述
可视化"差倍问题"的核心解题思路：当两个量按相同数值变化时，它们的**差不变**，但**倍数关系改变**。
通过图形化展示为什么"原来的2份差 = 现在的3份差"，让学生直观理解而非使用方程。

## 何时使用
- 题目涉及倍数变化（如"从3倍变成4倍"）
- 题目条件包含"各减少/增加相同数量后"
- 需要用"差不变"原理解题
- 用户要求不用方程解题

## 核心解题原理（必须可视化展示）
```
原状态：甲 = 3×乙  → 差 = 甲-乙 = 3乙-乙 = 2乙 (用原单位表示)
新状态：甲' = 4×乙' → 差 = 甲'-乙' = 4乙'-乙' = 3乙' (用新单位表示)

关键洞察：差不变！即 2乙 = 3乙'
这意味着：原来的1份(乙) = 新的1.5份(乙')
或者说：原来的2份 = 现在的3份 (表示相同的人数差)

已知条件：每边各减100人
所以：乙' = 乙 - 100

从 2乙 = 3乙' 和 乙' = 乙 - 100
可得：2乙 = 3(乙-100) = 3乙 - 300
解得：乙 = 300 (原来乙校人数)
```

## 可视化流程

### 步骤1：展示原始状态 (倍数关系)
```python
# 标题
title = Text("差倍问题 - 差不变原理", font="Microsoft YaHei", font_size=28, color=YELLOW)
title.to_edge(UP, buff=0.3)
self.play(Write(title))

# 原始单位（1份 = 乙校人数）
unit = Rectangle(width=1.2, height=0.5, fill_opacity=0.7)

# 乙校：1份（蓝色）
yi_original = VGroup(unit.copy().set_fill(BLUE))
yi_label = Text("乙校", font="Microsoft YaHei", font_size=18)
yi_row = VGroup(yi_label, yi_original).arrange(RIGHT, buff=0.5)

# 甲校：3份（绿色）
jia_original = VGroup(*[unit.copy().set_fill(GREEN) for _ in range(3)])
jia_original.arrange(RIGHT, buff=0)
jia_label = Text("甲校", font="Microsoft YaHei", font_size=18)
jia_row = VGroup(jia_label, jia_original).arrange(RIGHT, buff=0.5)

# 布局
original_state = VGroup(yi_row, jia_row).arrange(DOWN, buff=0.8, aligned_edge=LEFT)
original_state.move_to(LEFT * 3 + UP * 0.5)

self.play(Create(original_state))
self.wait(1)

# 标注差值 = 2份
diff_brace = Brace(jia_original[1:], DOWN, color=RED)
diff_label = Text("差 = 2份", font="Microsoft YaHei", font_size=18, color=RED)
diff_label.next_to(diff_brace, DOWN, buff=0.1)
self.play(Create(diff_brace), Write(diff_label))
self.wait(1)
```

### 步骤2：展示变化过程 (各减100人)
```python
# 变化提示
change_text = Text("各减少100人后...", font="Microsoft YaHei", font_size=22, color=ORANGE)
change_text.to_edge(RIGHT, buff=0.5).shift(UP * 2)
self.play(Write(change_text))
self.wait(0.5)

# 动画：两边同时"收缩"表示减少
# 关键：用颜色变淡或尺寸动画表示减少，而不是重建
shrink_indicator_yi = Rectangle(width=0.2, height=0.5, color=RED, fill_opacity=0.8)
shrink_indicator_yi.next_to(yi_original, RIGHT, buff=0)

shrink_indicator_jia = Rectangle(width=0.2, height=0.5, color=RED, fill_opacity=0.8)
shrink_indicator_jia.next_to(jia_original, RIGHT, buff=0)

self.play(
    FadeIn(shrink_indicator_yi),
    FadeIn(shrink_indicator_jia)
)
self.wait(0.5)

# 表示减掉的部分滑出
self.play(
    shrink_indicator_yi.animate.shift(RIGHT * 2).set_opacity(0),
    shrink_indicator_jia.animate.shift(RIGHT * 2).set_opacity(0),
    run_time=1
)
self.wait(0.5)
```

### 步骤3：展示新状态 (新倍数关系，用新单位)
```python
# 新状态标题
new_title = Text("变化后状态", font="Microsoft YaHei", font_size=20, color=YELLOW)
new_title.move_to(RIGHT * 3 + UP * 2)
self.play(Write(new_title))

# 新的单位（比原来小，因为 乙' = 乙-100）
new_unit = Rectangle(width=0.8, height=0.5, fill_opacity=0.7)  # 注意宽度变小

# 乙校现在：1份（浅蓝色）
yi_new = VGroup(new_unit.copy().set_fill(BLUE, opacity=0.5))
yi_new_label = Text("乙'", font="Microsoft YaHei", font_size=18)
yi_new_row = VGroup(yi_new_label, yi_new).arrange(RIGHT, buff=0.5)

# 甲校现在：4份（浅绿色）
jia_new = VGroup(*[new_unit.copy().set_fill(GREEN, opacity=0.5) for _ in range(4)])
jia_new.arrange(RIGHT, buff=0)
jia_new_label = Text("甲'", font="Microsoft YaHei", font_size=18)
jia_new_row = VGroup(jia_new_label, jia_new).arrange(RIGHT, buff=0.5)

# 布局在右边
new_state = VGroup(yi_new_row, jia_new_row).arrange(DOWN, buff=0.8, aligned_edge=LEFT)
new_state.move_to(RIGHT * 3 + UP * 0.5)

self.play(Create(new_state))
self.wait(1)

# 标注新的差值 = 3份
new_diff_brace = Brace(jia_new[1:], DOWN, color=RED)
new_diff_label = Text("差 = 3份", font="Microsoft YaHei", font_size=18, color=RED)
new_diff_label.next_to(new_diff_brace, DOWN, buff=0.1)
self.play(Create(new_diff_brace), Write(new_diff_label))
self.wait(1)
```

### 步骤4：核心洞察 - 差不变的可视化 (最关键！)
```python
# 清除变化提示
self.play(FadeOut(change_text), FadeOut(new_title))

# 核心洞察标题
insight_title = Text("核心洞察：差不变！", font="Microsoft YaHei", font_size=26, color=YELLOW)
insight_title.to_edge(DOWN, buff=2)
self.play(Write(insight_title))
self.wait(0.5)

# 把两个"差"提取出来，放到中间对比
# 左边：原来的差（2份蓝色条）
old_diff_bars = VGroup(*[unit.copy().set_fill(RED, opacity=0.8) for _ in range(2)])
old_diff_bars.arrange(RIGHT, buff=0)
old_diff_text = Text("原2份", font="Microsoft YaHei", font_size=16)
old_diff_group = VGroup(old_diff_text, old_diff_bars).arrange(DOWN, buff=0.2)
old_diff_group.move_to(LEFT * 2 + DOWN * 1.5)

# 右边：现在的差（3份绿色条，但每份更小）
new_diff_bars = VGroup(*[new_unit.copy().set_fill(RED, opacity=0.8) for _ in range(3)])
new_diff_bars.arrange(RIGHT, buff=0)
new_diff_text = Text("新3份", font="Microsoft YaHei", font_size=16)
new_diff_group = VGroup(new_diff_text, new_diff_bars).arrange(DOWN, buff=0.2)
new_diff_group.move_to(RIGHT * 2 + DOWN * 1.5)

# 等号
equals = Text("=", font="Microsoft YaHei", font_size=40, color=YELLOW)
equals.move_to(DOWN * 1.5)

self.play(Create(old_diff_group), Create(new_diff_group), Write(equals))
self.wait(1)

# 关键动画：缩放对齐！让学生看到两边代表相同的人数
target_width = 2.4
self.play(
    old_diff_bars.animate.stretch_to_fit_width(target_width),
    new_diff_bars.animate.stretch_to_fit_width(target_width),
    run_time=1.5
)
self.wait(1)

# 在对齐后的条上画分割线，展示对应关系
# 在"原2份"上画3等分线
dividers = VGroup()
for i in range(1, 3):
    x_pos = old_diff_bars.get_left()[0] + (target_width / 3) * i
    line = Line(
        [x_pos, old_diff_bars.get_top()[1] + 0.1, 0],
        [x_pos, old_diff_bars.get_bottom()[1] - 0.1, 0],
        color=YELLOW, stroke_width=2
    )
    dividers.add(line)

self.play(Create(dividers))
self.wait(1)

# 解释文字
explanation = Text(
    "原1份 = 新1.5份\n↓\n原来乙校 = 新乙校 + 100",
    font="Microsoft YaHei", font_size=18, color=WHITE
)
explanation.next_to(equals, DOWN, buff=0.8)
self.play(Write(explanation))
self.wait(2)
```

### 步骤5：得出结论
```python
# 计算过程（非方程形式）
calc_text = VGroup(
    Text("每份差 = 100人", font="Microsoft YaHei", font_size=20, color=GREEN),
    Text("原差 = 2份 = 200人", font="Microsoft YaHei", font_size=20, color=BLUE),
    Text("乙校原 = 200 ÷ 2 × 1 = 100人 ❌", font="Microsoft YaHei", font_size=20, color=RED),
).arrange(DOWN, buff=0.3)
# 注意：上面是错误示例，实际计算需要根据题目调整

# 正确结论
conclusion = Text(
    "乙校原来: 300人\n甲校原来: 900人",
    font="Microsoft YaHei", font_size=24, color=GREEN
)
conclusion.to_edge(DOWN, buff=0.5)
box = SurroundingRectangle(conclusion, color=GREEN, buff=0.2)
self.play(Write(conclusion), Create(box))
self.wait(3)
```

## 参数说明
- `{original_multiple}`: 原始倍数 (如3, 表示甲=3乙)
- `{new_multiple}`: 变化后倍数 (如4)
- `{change_amount}`: 变化量 (如100)
- `{name1}`: 较大数名称 (如"甲校")
- `{name2}`: 较小数名称 (如"乙校")

## 可视化核心要点
| 要素 | 必须展示 | 禁止做法 |
|------|----------|----------|
| 差不变 | 左右对比 + 缩放对齐动画 | 只用文字说"差不变" |
| 份数转换 | 在条上画分割线 | 直接说"1份=?" |
| 变化过程 | 颜色/尺寸变化动画 | 突然跳转到新状态 |
| 结论 | 从图形推导数值 | 列方程求解 |

## 常见错误规避
- ❌ 不要把"1份"当作未知数x来使用
- ❌ 不要只展示倍数变化，必须展示"差不变"的原理
- ❌ 不要跳过分割线动画，这是理解份数转换的关键
- ✅ 使用stretch_to_fit_width让两边"差"对齐
- ✅ 使用颜色区分原状态和新状态
