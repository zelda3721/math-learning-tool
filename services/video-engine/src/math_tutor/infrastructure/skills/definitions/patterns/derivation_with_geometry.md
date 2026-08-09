# Derivation with Geometry Pattern (代数推导 + 几何同步)

## 描述
适合代数推导（解方程、化简、因式分解、公式推导）的可视化模式。
**核心硬约束**：每一步代数变形必须有对应的几何图变化——不允许"几行代数公式上下排列"的纯符号链条。
（旧名 `formula_step` 因为名字本身鼓励"光列公式"反模式，已弃用。）

## 适用场景
- 解方程（一元一次、一元二次、方程组）
- 代数式化简
- 因式分解（首选用 area_model 矩形切片表达）
- 公式推导（首选用 dissection_proof 拼图表达）

## 关键词
方程, 解方程, 化简, 移项, 代入, 因式分解, 推导, 等式

## ⚠️ 视觉契约（违反即重写）
- 不允许只用 `Text(equation_n)` 上下罗列；至少要让一组**几何图形**和方程并列演化
- 每个代数动作（移项 / 合并 / 同除）必须**配一个图形动作**：天平倾斜→平衡、矩形切分、长度变换
- 即使所有 Text 关掉，画面仍能从图形看出"在做什么"
- 不允许出现"等号左右两边都是 Text"且**屏幕没有任何图形动画**的连续 ≥2 帧

## 推荐几何配套（按题型）
| 代数运算 | 推荐几何映射 |
|---|---|
| 解一元一次方程 `2x + 3 = 11` | 天平：左盘 2 个 x 块 + 3 个 1 块；右盘 11 个 1 块 |
| 因式分解 `x² + 5x + 6 = (x+2)(x+3)` | 长方形面积：宽 (x+2)，高 (x+3)，面积切成 4 块对应展开式 |
| 完全平方 `(a+b)²` | 大正方形拼接 a²+ab+ab+b² |
| 平方差 `a² − b²` | 从 a × a 正方形里挖去 b × b 正方形再重排 |
| 解方程组（消元） | 两条直线在坐标系上相交，交点即解 |
| 一元二次（配方） | 矩形 x²+px 拼成 (x+p/2)²−(p/2)² |

## 核心代码

```python
def stack_equations(equations: list[str], font_size=24, line_buff=0.4):
    """把一组等式上下排列，居中。等式只是辅助；主舞台留给几何图。"""
    lines = VGroup(*[Text(eq, font="Microsoft YaHei", font_size=font_size) for eq in equations])
    lines.arrange(DOWN, buff=line_buff, aligned_edge=LEFT)
    return lines


def reveal_with_geometry(scene, lines: VGroup, geometry_steps: list, hint_texts: list = None):
    """每揭示一行等式，同步播放对应的几何动画。
    geometry_steps[i] 是一个 callable(scene)→None，专门画/变这一步的图。"""
    for i, line in enumerate(lines):
        if i == 0:
            scene.play(Write(line))
        else:
            prev = lines[i - 1]
            scene.play(TransformFromCopy(prev, line))
        # ★ 关键：代数 + 几何同步
        if i < len(geometry_steps) and geometry_steps[i] is not None:
            geometry_steps[i](scene)
        if hint_texts and i < len(hint_texts) and hint_texts[i]:
            hint = Text(hint_texts[i], font="Microsoft YaHei", font_size=18, color=YELLOW)
            hint.next_to(line, RIGHT, buff=0.5)
            scene.play(FadeIn(hint, shift=LEFT * 0.2))
            scene.wait(1.0)
            scene.play(FadeOut(hint))
        else:
            scene.wait(0.8)


def balance_scale(scene, left_blocks, right_blocks, position=ORIGIN):
    """天平：演示等式两边等价。返回 (beam, left_pan, right_pan)."""
    beam = Line(LEFT * 2.5, RIGHT * 2.5, color=GRAY).move_to(position + UP * 1.0)
    pivot = Triangle(color=GRAY, fill_opacity=1).scale(0.3).next_to(beam, DOWN, buff=0)
    left_pan = VGroup(*left_blocks).arrange(RIGHT, buff=0.1).next_to(beam.get_left(), UP, buff=0.1)
    right_pan = VGroup(*right_blocks).arrange(RIGHT, buff=0.1).next_to(beam.get_right(), UP, buff=0.1)
    scene.play(Create(beam), Create(pivot))
    scene.play(LaggedStart(*[FadeIn(b) for b in left_pan], lag_ratio=0.1))
    scene.play(LaggedStart(*[FadeIn(b) for b in right_pan], lag_ratio=0.1))
    return beam, left_pan, right_pan
```

## 使用示例 — 解方程 2x + 3 = 11（带天平动画）

```python
title = Text("解方程：2x + 3 = 11", font="Microsoft YaHei", font_size=24).to_edge(UP, buff=0.4)
self.play(Write(title))

# 主视觉：天平 (核心动画载体，不是装饰！)
x_block = lambda: Rectangle(width=0.6, height=0.4, color=BLUE, fill_opacity=0.7)
unit = lambda: Square(side_length=0.3, color=YELLOW, fill_opacity=0.7)
left = [x_block(), x_block(), unit(), unit(), unit()]
right = [unit() for _ in range(11)]
beam, lp, rp = balance_scale(self, left, right, position=DOWN * 0.5)
self.wait(1)

# 步骤同步：每移项一次，天平上对应的方块也消失
def step_subtract_3(scene):
    """两边减 3：左盘移走 3 个 unit，右盘移走 3 个 unit"""
    scene.play(*[FadeOut(b, shift=DOWN) for b in lp[2:]])
    scene.play(*[FadeOut(b, shift=DOWN) for b in rp[-3:]])
    scene.wait(0.5)

def step_divide_2(scene):
    """两边除 2：每边只留一半"""
    scene.play(*[FadeOut(b) for b in (lp[1], *rp[4:8])])
    scene.wait(0.3)

steps = ["2x + 3 = 11", "2x = 8", "x = 4"]
geos = [None, step_subtract_3, step_divide_2]
hints = ["", "两边减 3（天平左右各拿走 3 个）", "两边除 2（每边只留一半）"]

lines = stack_equations(steps).to_edge(LEFT, buff=0.5).shift(UP * 0.5)
reveal_with_geometry(self, lines, geometry_steps=geos, hint_texts=hints)

answer = Text("x = 4", font="Microsoft YaHei", font_size=30, color=GREEN).to_edge(DOWN, buff=0.5)
self.play(Write(answer))
self.wait(3)
```

## 关键原则
1. **几何先行**：先画天平/矩形/坐标系，再开始写公式
2. **每代数步骤 = 一次几何动作**：不能让屏幕上只有公式在变
3. **TransformFromCopy 比 FadeIn 强**：让学生看到"是从上一行变来的"
4. **不要用 MathTex**（除非确认 LaTeX 已装）
5. 若题目本身就是抽象推导，没法配几何，则回退到 `area_model` / `dissection_proof` / `bar_model` 之一
