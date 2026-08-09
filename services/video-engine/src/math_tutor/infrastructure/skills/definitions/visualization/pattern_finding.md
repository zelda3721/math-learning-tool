# Pattern Finding Problem Skill (找规律)

## 描述
可视化找规律问题，通过序列动画展示数列或图形的规律。


## 视觉契约（Visual Contract — 违反即重写）
本 skill 必须遵守以下硬约束。inspect_video 评审时会按此打分；违反任一即触发 generate_manim_code 重新生成。

### 必须出现的 mobject 类型
- 至少 1 个非 Text 图形（Circle / Rectangle / Line / Arrow / NumberLine / Polygon 之一），数学概念必须用图形对应
- 图形数量 ≥ Text 数量（不能让屏幕只剩文字）

### 必须出现的动画类型
- 至少 1 次 **变换/位移类** 动画（Transform / TransformFromCopy / animate.shift / animate.move_to / Rotate / GrowFromCenter）——不仅仅 Write 和 FadeIn/FadeOut
- 至少 1 个动画的"前后状态"承载数学含义（颜色/位置/大小变化必须对应数量/关系/守恒的变化）

### 禁用反模式（命中即 bad）
- 连续 ≥3 个 `Write(Text(...))` + `FadeOut` 的翻页式步骤（PPT 翻页）
- 屏幕同时存在 ≥3 行 Text/MathTex（公式墙）
- 全片只有 Text，没有 Circle/Rectangle/Line 等图形（文字搬运）
- 关键运算只用 Text 写出来而无图形动画对应（应该让"变化"看得见）

### 三阶段教学锚点（每段必须出现且语义对应）
- **setup**：把题目里的对象用图形表达（圆点/线段/方块），让学生先"看见"
- **core/transform**：用动画展示数学关系——变换、增减、对比、守恒、对应
- **verify/reveal**：用图形或动画回到题目，确认答案的合理性

## 何时使用
- 题目中包含"规律"、"第n个"、"数列"、"接下来"等关键词
- 涉及数字或图形序列的规律发现
- 需要根据规律预测后续项

## 可视化原则
1. **逐项展示** - 一个个显示序列中的项
2. **规律高亮** - 用颜色和箭头标注变化规律
3. **差值/比值** - 显示相邻项之间的关系
4. **预测验证** - 用规律推导下一项

## 标准流程

### 步骤1：展示已知序列
```python
title = Text("找规律", font="Noto Sans CJK SC", font_size=36, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

# 序列项
sequence = [{seq}]
items = VGroup()

for i, num in enumerate(sequence):
    item = VGroup(
        Square(side_length=0.8, color=BLUE, fill_opacity=0.3),
        Text(str(num), font="Noto Sans CJK SC", font_size=28)
    )
    items.add(item)

items.arrange(RIGHT, buff=0.3)
items.move_to(UP * 0.5)

for item in items:
    self.play(FadeIn(item), run_time=0.5)
    self.wait(0.3)

self.wait(1)
```

### 步骤2：分析规律（显示变化）
```python
# 显示相邻项的差值
differences = []
arrows = VGroup()
diff_labels = VGroup()

for i in range(len(sequence) - 1):
    diff = sequence[i+1] - sequence[i]
    differences.append(diff)
    
    # 箭头
    arrow = Arrow(
        items[i].get_bottom() + DOWN * 0.2,
        items[i+1].get_bottom() + DOWN * 0.2,
        color=YELLOW,
        buff=0.1
    )
    arrows.add(arrow)
    
    # 差值标签
    diff_label = Text(f"+{diff}" if diff > 0 else str(diff), font="Noto Sans CJK SC", font_size=18, color=YELLOW)
    diff_label.next_to(arrow, DOWN, buff=0.1)
    diff_labels.add(diff_label)

self.play(Create(arrows), Write(diff_labels))
self.wait(1)

# 总结规律
if len(set(differences)) == 1:
    rule_text = Text(f"规律：每次增加{differences[0]}", font="Noto Sans CJK SC", font_size=24, color=GREEN)
else:
    rule_text = Text("规律：差值依次为" + ", ".join(map(str, differences)), font="Noto Sans CJK SC", font_size=24, color=GREEN)

rule_text.to_edge(LEFT, buff=0.5).shift(DOWN * 1.5)
self.play(Write(rule_text))
self.wait(2)
```

### 步骤3：预测下一项
```python
# 计算下一项
if len(set(differences)) == 1:
    next_val = sequence[-1] + differences[0]
else:
    # 二阶差值
    second_diff = differences[-1] - differences[-2] if len(differences) > 1 else differences[-1]
    next_diff = differences[-1] + second_diff
    next_val = sequence[-1] + next_diff

# 显示预测
next_item = VGroup(
    Square(side_length=0.8, color=GREEN, fill_opacity=0.3),
    Text(str(next_val), font="Noto Sans CJK SC", font_size=28, color=GREEN)
)
next_item.next_to(items[-1], RIGHT, buff=0.3)

question = Text("?", font="Noto Sans CJK SC", font_size=36, color=RED)
question.move_to(next_item[0].get_center())

self.play(FadeIn(next_item[0]), Write(question))
self.wait(1)

# 揭示答案
self.play(Transform(question, next_item[1]))
self.wait(2)

# 最终答案
result = Text(f"答：下一个数是{next_val}", font="Noto Sans CJK SC", font_size=28, color=GREEN)
result.to_edge(DOWN, buff=0.8)
self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{seq}`: 数列，如 [2, 5, 8, 11]
- `{rule_type}`: 规律类型（等差/等比/其他）
- `{next_val}`: 下一项的值

## 规律类型
1. **等差数列**：相邻项差值相同
2. **等比数列**：相邻项比值相同
3. **二阶等差**：差值本身是等差数列
4. **斐波那契型**：每项等于前两项之和

## 注意事项
- ⚠️ 每个数字放在方框中更清晰
- ⚠️ 用箭头连接相邻项
- ⚠️ 差值用黄色标注

## 示例
输入：2, 5, 8, 11, ?
输出：每次+3 → 规律是等差数列 → 下一个是14
