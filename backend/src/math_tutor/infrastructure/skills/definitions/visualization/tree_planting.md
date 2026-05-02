# Tree Planting Problem Skill (植树问题)

## 描述
可视化植树问题，展示在一定长度上按间隔植树的计算方法。


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
- 题目中包含"植树"、"间隔"、"路灯"、"电线杆"等关键词
- 涉及等距排列的计算
- 需要考虑两端是否放置的问题

## 可视化原则
1. **线段+点** - 用线段表示路，用点表示树
2. **间隔标注** - 明确显示间隔距离
3. **情况分类** - 区分两端都种、都不种、只种一端

## 核心公式
- 两端都种：树数 = 间隔数 + 1 = 总长÷间隔 + 1
- 两端都不种：树数 = 间隔数 - 1 = 总长÷间隔 - 1
- 只种一端：树数 = 间隔数 = 总长÷间隔

## 标准流程

### 步骤1：绘制路线
```python
title = Text("植树问题", font="Noto Sans CJK SC", font_size=36, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

# 路线
road = Line(LEFT * 5, RIGHT * 5, color=GRAY, stroke_width=5)
road.move_to(ORIGIN)

# 长度标注
length_brace = Brace(road, DOWN)
length_text = Text(f"{total_length}米", font="Noto Sans CJK SC", font_size=20)
length_text.next_to(length_brace, DOWN, buff=0.1)

self.play(Create(road))
self.play(Create(length_brace), Write(length_text))
self.wait(1)
```

### 步骤2：标记间隔
```python
# 计算间隔数
intervals = {total_length} // {interval}

# 绘制间隔点
points = []
for i in range(intervals + 1):
    x = -5 + i * (10 / intervals)
    point = Dot([x, 0, 0], color=GREEN, radius=0.1)
    points.append(point)

# 根据种植方式选择显示的点
if "{plant_type}" == "both":
    # 两端都种
    display_points = points
elif "{plant_type}" == "neither":
    # 两端都不种
    display_points = points[1:-1]
else:
    # 只种一端
    display_points = points[:-1]

# 显示树（用绿色三角形表示）
trees = []
for pt in display_points:
    tree = Triangle(color=GREEN, fill_opacity=0.8).scale(0.2)
    tree.next_to(pt, UP, buff=0.1)
    trees.append(tree)

for tree in trees:
    self.play(FadeIn(tree), run_time=0.2)

self.wait(1)

# 标注间隔
if len(trees) > 1:
    interval_line = Line(trees[0].get_center(), trees[1].get_center(), color=YELLOW)
    interval_text = Text(f"{interval}米", font="Noto Sans CJK SC", font_size=16, color=YELLOW)
    interval_text.next_to(interval_line, UP, buff=0.3)
    self.play(Create(interval_line), Write(interval_text))

self.wait(2)
```

### 步骤3：计算并显示结果
```python
# 显示计算过程
calc = VGroup(
    Text(f"总长度: {total_length}米", font="Noto Sans CJK SC", font_size=20),
    Text(f"间隔: {interval}米", font="Noto Sans CJK SC", font_size=20),
    Text(f"间隔数: {total_length}÷{interval} = {intervals}", font="Noto Sans CJK SC", font_size=20),
    Text(f"树的棵数: {intervals} + 1 = {len(trees)}", font="Noto Sans CJK SC", font_size=20, color=GREEN),
)
calc.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
calc.to_edge(DOWN, buff=0.5)

for line in calc:
    self.play(Write(line), run_time=0.5)

self.wait(3)
```

## 参数说明
- `{total_length}`: 总长度
- `{interval}`: 间隔距离
- `{plant_type}`: 种植方式（both/neither/one）
- `{tree_count}`: 树的棵数

## 三种情况
1. **两端都种**：棵数 = 间隔数 + 1
2. **两端都不种**：棵数 = 间隔数 - 1
3. **只种一端**：棵数 = 间隔数

## 注意事项
- ⚠️ 用小树图标代替点更直观
- ⚠️ 明确说明两端的种植情况
- ⚠️ 间隔用虚线或箭头标注

## 示例
输入：100米长的路，每10米种一棵树，两端都种
输出：间隔数=10 → 树数=10+1=11棵
