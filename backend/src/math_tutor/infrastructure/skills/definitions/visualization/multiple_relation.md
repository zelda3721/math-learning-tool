# Multiple Relation Problem Skill (倍数问题)

## 描述
可视化倍数问题，通过线段图展示倍数关系。


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
- 题目中包含"倍"、"几倍"、"是...的多少倍"等关键词
- 涉及倍数关系的计算
- 需要通过线段图理解倍数概念

## 可视化原则
1. **布局规范** - 严禁使用绝对坐标! 使用 `VGroup` + `.arrange()` + `.next_to()`。
2. **基准对齐** - 多倍线段必须与1倍线段左对齐。
3. **字体规范** - Windows系统必须使用 "Microsoft YaHei"。
4. **颜色规范** - 只使用标准颜色: BLUE, RED, GREEN, YELLOW, ORANGE。

## 标准流程

### 步骤1：展示基准（1倍）
```python
# 1. 标题
title = Text("倍数关系分析", font="Microsoft YaHei", font_size=32, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

# 2. 创建基准线段 (1倍)
# 使用VGroup包裹方便后续布局
unit_bar_group = VGroup(
    Rectangle(width=1.5, height=0.4, color=BLUE, fill_opacity=0.6)
)
# 放在屏幕中心偏上
unit_bar_group.move_to(UP * 0.5)

# 3. 标签
# 左侧标签
unit_label = Text("{base_name} (1倍)", font="Microsoft YaHei", font_size=20)
unit_label.next_to(unit_bar_group, LEFT, buff=0.3)

# 内部数值
unit_value = Text("{base_value}", font="Microsoft YaHei", font_size=18, color=WHITE)
unit_value.move_to(unit_bar_group.get_center())

# 4. 动画
self.play(
    Create(unit_bar_group), 
    Write(unit_label), 
    Write(unit_value)
)
self.wait(1)
```

### 步骤2：展示倍数关系
```python
# 1. 创建多倍线段
multiple_bar = VGroup()
for i in range({multiple}):
    segment = Rectangle(width=1.5, height=0.4, color=RED, fill_opacity=0.6)
    # 添加内部数值标记
    val = Text(f"{base_value}", font="Microsoft YaHei", font_size=16)
    val.move_to(segment.get_center())
    # 组合线段和文字
    seg_group = VGroup(segment, val)
    multiple_bar.add(seg_group)

# 2. 内部排列
multiple_bar.arrange(RIGHT, buff=0)

# 3. 整体布局
# 位于基准线段下方，左对齐
multiple_bar.next_to(unit_bar_group, DOWN, buff=1.0, aligned_edge=LEFT)

# 4. 左侧标签
multiple_label = Text("{multiple_name} ({multiple}倍)", font="Microsoft YaHei", font_size=20)
multiple_label.next_to(multiple_bar, LEFT, buff=0.3)

# 5. 动画展示 (逐段出现)
self.play(Write(multiple_label))
self.play(LaggedStart(
    *[Create(seg) for seg in multiple_bar],
    lag_ratio=0.2, run_time=2
))
self.wait(1)

# 6. 标注倍数总和
# 严禁使用 brace.get_text()
brace = Brace(multiple_bar, DOWN)
brace_label = Text(f"{base_value} × {multiple} = {result}", font="Microsoft YaHei", font_size=20, color=GREEN)
brace_label.next_to(brace, DOWN, buff=0.1)

self.play(Create(brace), Write(brace_label))
self.wait(2)
```

### 步骤2.5：状态变化过渡（可选，用于变化问题）
```python
# 当题目涉及状态变化时（如"各减少100人后"），使用Transform展示
# 示例：从3倍变为4倍的平滑过渡

# 1. 变化提示
change_text = Text("现在各减少100人...", font="Microsoft YaHei", font_size=24, color=ORANGE)
change_text.to_edge(UP, buff=0.3)
self.play(Write(change_text))
self.wait(1)

# 2. 用动画展示"收缩"效果（而不是重建）
# 方法A：颜色/透明度变化表示减少
self.play(
    unit_bar_group[0].animate.set_fill(RED, opacity=0.3),  # 基准也减少
    multiple_bar[-1].animate.set_fill(RED, opacity=0.3)    # 最后一段变淡
)
self.wait(0.5)

# 方法B：如果需要新的倍数关系，用Transform转换
# new_multiple_bar = VGroup(*[...])  # 新的N份
# self.play(ReplacementTransform(multiple_bar, new_multiple_bar))

# 3. 更新标签
new_label = Text("变化后比例", font="Microsoft YaHei", font_size=20, color=YELLOW)
new_label.next_to(multiple_bar, LEFT, buff=0.3)
self.play(ReplacementTransform(multiple_label, new_label))
self.wait(1)

# 4. 淡出提示文字
self.play(FadeOut(change_text))
```

### 步骤3：显示结果
```python
# 结论文字
result_text = Text(f"答：{multiple_name}有 {result}", font="Microsoft YaHei", font_size=28, color=GREEN)
result_text.to_edge(DOWN, buff=1.0)
self.play(Write(result_text))
self.wait(3)
```

## 参数说明
- `{base_name}`: 基准对象名称 (str)
- `{base_value}`: 基准数值 (int/float)
- `{multiple_name}`: 倍数对象名称 (str)
- `{multiple}`: 倍数 (int)
- `{result}`: 结果 (int/float)

## 常见错误规避
- ❌ 不要手动计算坐标! 使用 `.next_to(..., aligned_edge=LEFT)`
- ❌ 不要使用非标准颜色，Manim默认支持 BLUE, RED, GREEN, YELLOW 等
- ❌ 必须使用 "Microsoft YaHei" 避免中文乱码

## 示例
输入：{base_name: "苹果", base_value: 5, multiple_name: "梨", multiple: 3, result: 15}
输出：
1. 上方蓝色矩形(5)。
2. 下方3个红色矩形(5,5,5)左对齐。
3. 标注算式 5x3=15。
