# Area Transform Problem Skill (等积变形)

## 描述
可视化等积变形问题，通过割补法展示图形变换过程，证明面积不变。


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
- 题目中包含"面积"、"割补"、"剪拼"、"等积"等关键词
- 需要通过图形变换简化面积计算
- 涉及复杂图形的面积求解

## 可视化原则
1. **原图展示** - 展示原始图形
2. **切割动画** - 展示如何切割图形
3. **移动拼接** - 动态展示移动和拼接过程
4. **面积对比** - 证明变换前后面积相等

## 标准流程

### 步骤1：展示原始图形
```python
title = Text("等积变形", font="Noto Sans CJK SC", font_size=36, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

# 原始图形（例如：平行四边形）
original = Polygon(
    [-2, -1, 0], [2, -1, 0], [3, 1, 0], [-1, 1, 0],
    color=BLUE, fill_opacity=0.5
)
original.scale(0.7).move_to(LEFT * 2.5)

original_label = Text("原图形", font="Noto Sans CJK SC", font_size=20)
original_label.next_to(original, DOWN, buff=0.3)

self.play(Create(original), Write(original_label))
self.wait(1)
```

### 步骤2：标注切割线
```python
# 画切割线（高）
cut_line = DashedLine(
    original.get_vertices()[3] + DOWN * 0.2,
    original.get_vertices()[3] + DOWN * original.height,
    color=RED
)

cut_text = Text("沿高切割", font="Noto Sans CJK SC", font_size=18, color=RED)
cut_text.next_to(cut_line, LEFT, buff=0.2)

self.play(Create(cut_line), Write(cut_text))
self.wait(1)
```

### 步骤3：切割并移动
```python
# 切割成两部分
triangle = Polygon(
    original.get_vertices()[0],
    original.get_vertices()[3],
    original.get_vertices()[3] + DOWN * 1.4,
    color=RED, fill_opacity=0.5
)

# 移动三角形到另一边
arrow = CurvedArrow(
    triangle.get_center(),
    triangle.get_center() + RIGHT * 4,
    color=YELLOW
)

self.play(Create(arrow))
self.play(triangle.animate.shift(RIGHT * 4))
self.wait(1)

# 拼接成矩形
result_rect = Rectangle(width={width}, height={height}, color=GREEN, fill_opacity=0.3)
result_rect.move_to(RIGHT * 2.5)

result_label = Text("变换后：矩形", font="Noto Sans CJK SC", font_size=20)
result_label.next_to(result_rect, DOWN, buff=0.3)

self.play(Transform(VGroup(original.copy(), triangle), result_rect), Write(result_label))
self.wait(2)
```

### 步骤4：证明面积相等
```python
equal_text = Text("面积不变！", font="Noto Sans CJK SC", font_size=28, color=GREEN)
equal_text.move_to(ORIGIN)
self.play(Write(equal_text))
self.wait(1)

# 计算面积
calc = VGroup(
    Text(f"矩形面积 = 底 × 高", font="Noto Sans CJK SC", font_size=22),
    Text(f"        = {width} × {height} = {area}平方厘米", font="Noto Sans CJK SC", font_size=22, color=GREEN),
)
calc.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
calc.to_edge(DOWN, buff=0.5)

for line in calc:
    self.play(Write(line), run_time=0.6)

self.wait(3)
```

## 参数说明
- `{width}`: 变换后图形的底
- `{height}`: 变换后图形的高
- `{area}`: 面积 = width × height

## 常见变换
1. **平行四边形** → 矩形（割补三角形）
2. **三角形** → 等宽矩形的一半
3. **梯形** → 矩形（上下底平均）
4. **不规则图形** → 分割成多个规则图形

## 核心原理
- 切割后移动，面积不变
- 找到高，沿高切割
- 变换成易于计算的规则图形

## 注意事项
- ⚠️ 用虚线标注切割线
- ⚠️ 用箭头显示移动方向
- ⚠️ 变换前后放在左右对比

## 示例
输入：平行四边形，底8厘米，高5厘米
输出：沿高切割三角形 → 移到另一边 → 变成8×5矩形 → 面积40平方厘米
