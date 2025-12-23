# Geometry Visualization Skill

## 描述
为小学生可视化几何图形问题，包括周长、面积、图形变换等概念的直观展示。

## 何时使用
- 题目中包含"长方形"、"正方形"、"三角形"、"圆"、"周长"、"面积"等关键词
- 需要展示几何图形的测量
- 需要展示图形分割或组合

## 可视化原则
1. **图形先行** - 先绘制几何图形
2. **标注清晰** - 标注边长、角度等关键尺寸
3. **公式可视** - 将计算公式与图形对应
4. **动态演示** - 用动画展示计算过程

## 标准流程

### 矩形（长方形/正方形）周长和面积

#### 步骤1：绘制图形并标注
```python
# 创建矩形
rect = Rectangle(width={length} * 0.4, height={width} * 0.4, color=BLUE, fill_opacity=0.3)
rect.scale(0.7).move_to(ORIGIN)

# 标题
title = Text("长方形的{calc_type}", font="Noto Sans CJK SC", font_size=32)
title.to_edge(UP, buff=0.8)

self.play(Write(title))
self.play(Create(rect))
self.wait(1)

# 标注边长
length_label = Text("{length}厘米", font="Noto Sans CJK SC", font_size=20)
length_label.next_to(rect, DOWN, buff=0.2)

width_label = Text("{width}厘米", font="Noto Sans CJK SC", font_size=20)
width_label.next_to(rect, RIGHT, buff=0.2)

self.play(Write(length_label), Write(width_label))
self.wait(1)
```

#### 步骤2：展示周长计算
```python
# 周长公式
formula = MathTex(r"周长 = (长 + 宽) \times 2", font_size=32)
formula.next_to(rect, UP, buff=0.8)

self.play(Write(formula))
self.wait(1)

# 高亮各边（动态展示）
sides = [
    rect.get_edge_center(DOWN),
    rect.get_edge_center(RIGHT),
    rect.get_edge_center(UP),
    rect.get_edge_center(LEFT)
]

# 循环绘制周长
perimeter_path = VMobject(color=RED, stroke_width=4)
perimeter_path.set_points_as_corners([
    rect.get_corner(DL),
    rect.get_corner(DR),
    rect.get_corner(UR),
    rect.get_corner(UL),
    rect.get_corner(DL)
])

self.play(Create(perimeter_path), run_time=2)
self.wait(1)

# 显示计算
calc = Text("= ({length} + {width}) × 2 = {perimeter}厘米", font="Noto Sans CJK SC", font_size=28, color=GREEN)
calc.to_edge(DOWN, buff=1.0)
self.play(Write(calc))
self.wait(3)
```

#### 步骤3：展示面积计算
```python
# 面积公式
area_formula = MathTex(r"面积 = 长 \times 宽", font_size=32)
area_formula.next_to(rect, UP, buff=0.8)

self.play(Transform(formula, area_formula))
self.wait(1)

# 填充矩形表示面积
self.play(rect.animate.set_fill(YELLOW, opacity=0.6))
self.wait(1)

# 显示计算
area_calc = Text("= {length} × {width} = {area}平方厘米", font="Noto Sans CJK SC", font_size=28, color=GREEN)
area_calc.to_edge(DOWN, buff=1.0)
self.play(Transform(calc, area_calc))
self.wait(3)
```

### 三角形面积

```python
# 创建三角形
triangle = Polygon(
    [-{base}/2 * 0.3, -{height}/2 * 0.3, 0],
    [{base}/2 * 0.3, -{height}/2 * 0.3, 0],
    [0, {height}/2 * 0.3, 0],
    color=BLUE, fill_opacity=0.3
)
triangle.scale(0.7).move_to(ORIGIN)

# 标注底和高
base_line = Line(triangle.get_vertices()[0], triangle.get_vertices()[1], color=RED)
height_line = DashedLine(triangle.get_vertices()[2], [0, -{height}/2 * 0.3, 0], color=GREEN)

base_label = Text("{base}厘米", font="Noto Sans CJK SC", font_size=20)
base_label.next_to(base_line, DOWN, buff=0.2)

height_label = Text("{height}厘米", font="Noto Sans CJK SC", font_size=20)
height_label.next_to(height_line, RIGHT, buff=0.2)

self.play(Create(triangle))
self.play(Create(base_line), Write(base_label))
self.play(Create(height_line), Write(height_label))
self.wait(2)

# 公式和计算
formula = Text("面积 = 底 × 高 ÷ 2", font="Noto Sans CJK SC", font_size=28)
formula.to_edge(UP, buff=0.8)
self.play(Write(formula))

result = Text("= {base} × {height} ÷ 2 = {area}平方厘米", font="Noto Sans CJK SC", font_size=28, color=GREEN)
result.to_edge(DOWN, buff=1.0)
self.play(Write(result))
self.wait(3)
```

### 圆的周长和面积

```python
# 创建圆
circle = Circle(radius={radius} * 0.3, color=BLUE, fill_opacity=0.3)
circle.scale(0.7).move_to(ORIGIN)

# 标注半径
radius_line = Line(circle.get_center(), circle.get_right(), color=RED)
radius_label = Text("半径={radius}厘米", font="Noto Sans CJK SC", font_size=20)
radius_label.next_to(radius_line, UP, buff=0.2)

self.play(Create(circle))
self.play(Create(radius_line), Write(radius_label))
self.wait(2)

# 周长公式
formula = MathTex(r"周长 = 2\pi r", font_size=32)
formula.to_edge(UP, buff=0.8)
self.play(Write(formula))

result = Text("= 2 × 3.14 × {radius} = {circumference}厘米", font="Noto Sans CJK SC", font_size=28, color=GREEN)
result.to_edge(DOWN, buff=1.0)
self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{length}`: 长度（长方形的长）
- `{width}`: 宽度（长方形的宽）
- `{base}`: 底边长度（三角形）
- `{height}`: 高度
- `{radius}`: 半径（圆）
- `{perimeter}`: 周长
- `{area}`: 面积
- `{circumference}`: 圆周长
- `{calc_type}`: 计算类型（"周长"或"面积"）

## 布局要求
- 图形居中，scale(0.7)
- 标注紧贴图形边
- 公式在图形上方
- 计算结果在底部

## 注意事项
- ⚠️ 几何图形必须按比例绘制
- ⚠️ 使用虚线标注高（三角形）
- ⚠️ 周长用红色路径动态绘制
- ⚠️ 面积用填充色表示

## 示例
输入：长方形长8厘米，宽5厘米，求周长
输出：绘制长方形 → 标注边长 → 动态绘制周长路径 → 显示(8+5)×2=26厘米
