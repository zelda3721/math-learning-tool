# Area Model Pattern (面积模型)

## 描述
用矩形面积可视化乘法、分配律、完全平方、因式分解等代数运算。
**核心思想**：抽象代数 → 具象面积，让学生看见"为什么"成立而不是死记公式。

## 适用场景
- 两位数乘法 12 × 16（拆成 (10+2) × (10+6)）
- 分配律 a × (b + c) = ab + ac
- 完全平方 (a + b)² = a² + 2ab + b²
- 平方差 a² − b² = (a + b)(a − b)
- 因式分解 x² + 5x + 6 = (x+2)(x+3)
- 分数乘法 1/2 × 1/3（在矩形上切片相交）

## 关键词
乘法, 分配, 完全平方, 因式分解, 面积, 矩形, ², 平方

## ⚠️ 视觉契约
- 必须有 **大矩形**作为主舞台，至少切成 2-4 个**不同颜色**的子矩形
- 子矩形的**面积标注**必须用图形（彩色填充 + 标尺线），不许只用 Text 标 a²/ab
- 拆分动作必须有**动画**：matrix splitting / Transform / Create Line 沿切割位置
- 不允许"只用 Text 写公式 a²+2ab+b² 就完事"

## 核心代码

```python
def make_area_grid(a, b, *, scale=1.0, colors=(BLUE, GREEN, YELLOW, RED)):
    """创建 (a+b) × (a+b) 的网格，返回 4 个子矩形 VGroup（左上 a², 右上 ab, 左下 ab, 右下 b²）。"""
    A = a * scale
    B = b * scale
    r_aa = Rectangle(width=A, height=A, color=colors[0], fill_opacity=0.6)
    r_ab1 = Rectangle(width=B, height=A, color=colors[1], fill_opacity=0.6).next_to(r_aa, RIGHT, buff=0)
    r_ab2 = Rectangle(width=A, height=B, color=colors[2], fill_opacity=0.6).next_to(r_aa, DOWN, buff=0)
    r_bb = Rectangle(width=B, height=B, color=colors[3], fill_opacity=0.6).next_to(r_ab1, DOWN, buff=0)
    grid = VGroup(r_aa, r_ab1, r_ab2, r_bb)
    grid.move_to(ORIGIN)
    return grid, (r_aa, r_ab1, r_ab2, r_bb)


def label_area(rect, text, font_size=22, color=WHITE):
    """把面积公式标在矩形中央。"""
    return Text(text, font="Microsoft YaHei", font_size=font_size, color=color).move_to(rect.get_center())


def split_rectangle(scene, big_rect, split_x_ratio: float, color=YELLOW):
    """从大矩形上垂直切一刀，返回切割线（动画化）。"""
    left, right, top, bottom = big_rect.get_left(), big_rect.get_right(), big_rect.get_top(), big_rect.get_bottom()
    cx = left[0] + (right[0] - left[0]) * split_x_ratio
    line = Line([cx, bottom[1], 0], [cx, top[1], 0], color=color, stroke_width=4)
    scene.play(Create(line), run_time=0.8)
    return line
```

## 使用示例 — (a+b)² 展开

```python
title = Text("(a + b)² 是什么？", font="Microsoft YaHei", font_size=28).to_edge(UP, buff=0.4)
self.play(Write(title))

# 第 1 阶：先画一个 (a+b) × (a+b) 的大正方形（设 a=2, b=1）
a, b = 2.0, 1.0
big = Rectangle(width=a+b, height=a+b, color=WHITE, stroke_width=3).move_to(ORIGIN)
side_label = Text(f"(a+b)", font="Microsoft YaHei", font_size=22, color=YELLOW).next_to(big, DOWN, buff=0.2)
self.play(Create(big), Write(side_label))
self.wait(1)

# 第 2 阶：切两刀，露出 4 个子矩形
grid, (r_aa, r_ab1, r_ab2, r_bb) = make_area_grid(a, b)
self.play(Transform(big, grid))
self.wait(0.5)

# 第 3 阶：每块标 a²/ab/ab/b²
labels = VGroup(
    label_area(r_aa, "a²", color=WHITE),
    label_area(r_ab1, "ab", color=WHITE),
    label_area(r_ab2, "ab", color=WHITE),
    label_area(r_bb, "b²", color=WHITE),
)
self.play(LaggedStart(*[Write(l) for l in labels], lag_ratio=0.3))
self.wait(2)

# 第 4 阶：揭示总和 = 大正方形面积
result = Text("(a+b)² = a² + 2ab + b²", font="Microsoft YaHei", font_size=26, color=GREEN).to_edge(DOWN, buff=0.5)
self.play(Write(result))
self.wait(3)
```

## 关键原则
1. 先画整体（大正方形），再切片——次序很重要
2. 每子矩形用**不同颜色**，让学生看出"展开式 = 颜色总和"
3. 中间的两个 `ab` 矩形**颜色对称**，强化"有两份"的感觉
4. 数字案例（a=2, b=1）和字母标签**同时存在**：数字给具象，字母给抽象
