# Covariation Pair Pattern (双面板同步演化)

## 描述
**左面板**显示几何/物理动作，**右面板**显示其代数图象，两边**同步**演化。3Blue1Brown《微积分本质》经典布局。

## 适用场景
- 函数图象（动点扫过 x 轴 → 曲线上升）
- 相关速率（圆膨胀 → 半径与面积同步图）
- 行程问题（小车运动 → s-t 图）
- 角度变化（旋转 → 三角函数曲线）
- 概率（抽样 → 频率柱状图）

## 关键词
函数, 图象, 速率, 变化, 速度, 时间, 关系, 同步

## ⚠️ 视觉契约
- 必须**真的有两个面板**（屏幕左右两半）
- 两个面板里至少有一个**always_redraw** 的对象，跟随同一个 ValueTracker
- 几何动作和图象动作**同步发生**（不能左动完才右动）
- 不允许只有一边在动——对偶演化的核心是"对偶"

## 核心代码

```python
def make_dual_panels(scene):
    """切左右两半画布，返回 (left_origin, right_origin) 两个中心点。"""
    divider = Line(UP * 4, DOWN * 4, color=GRAY, stroke_width=1).move_to(ORIGIN)
    scene.add(divider)
    left_origin = LEFT * 3
    right_origin = RIGHT * 3
    return left_origin, right_origin


def linked_dot_and_graph(scene, axes_left, axes_right, func, t_tracker, t_range, color=YELLOW):
    """左面板：动点在 x 轴上随 t 移动。右面板：(t, f(t)) 点划出曲线。
    func: t -> y。t_tracker: ValueTracker 控制时间。"""
    moving_dot = always_redraw(lambda: Dot(
        axes_left.coords_to_point(t_tracker.get_value(), 0),
        color=color, radius=0.1
    ))
    graph_dot = always_redraw(lambda: Dot(
        axes_right.coords_to_point(t_tracker.get_value(), func(t_tracker.get_value())),
        color=color, radius=0.1
    ))
    # 已扫过的曲线段
    traced_graph = TracedPath(graph_dot.get_center, stroke_color=color, stroke_width=4)
    scene.add(moving_dot, graph_dot, traced_graph)
    return moving_dot, graph_dot, traced_graph
```

## 使用示例 — 函数 y = x² 的图象（左：x 轴上动点，右：曲线生成）

```python
title = Text("函数 y = x²：x 变 → y 变 → 曲线生成", font="Microsoft YaHei", font_size=22).to_edge(UP, buff=0.3)
self.play(Write(title))

# 左面板：x 轴 + 一个动点
axes_left = NumberLine(x_range=[-3, 3], length=4, color=BLUE).move_to(LEFT * 3.5 + DOWN * 0.5)
left_label = Text("x 在数轴上移动", font="Microsoft YaHei", font_size=18).next_to(axes_left, UP, buff=0.5)
self.play(Create(axes_left), Write(left_label))

# 右面板：完整坐标系（待生成 x²）
axes_right = Axes(
    x_range=[-3, 3, 1], y_range=[0, 9, 1],
    x_length=4, y_length=3.5,
    axis_config={"color": GREEN}
).move_to(RIGHT * 3.5 + DOWN * 0.5)
right_label = Text("(x, x²) 的轨迹", font="Microsoft YaHei", font_size=18).next_to(axes_right, UP, buff=0.3)
self.play(Create(axes_right), Write(right_label))

# 分隔线
divider = DashedLine(UP * 3, DOWN * 3, color=GRAY).move_to(ORIGIN)
self.play(Create(divider))

# === 关键：双向同步 ===
t = ValueTracker(-3)
moving_dot = always_redraw(lambda: Dot(axes_left.n2p(t.get_value()), color=YELLOW, radius=0.1))
graph_dot = always_redraw(lambda: Dot(
    axes_right.coords_to_point(t.get_value(), t.get_value()**2),
    color=YELLOW, radius=0.1
))
trace = TracedPath(graph_dot.get_center, stroke_color=YELLOW, stroke_width=3)
self.add(moving_dot, graph_dot, trace)

# 标签同步显示当前 (x, y)
xy_label = always_redraw(lambda: Text(
    f"({t.get_value():.2f}, {t.get_value()**2:.2f})",
    font="Microsoft YaHei", font_size=18, color=YELLOW
).to_edge(DOWN, buff=0.3))
self.add(xy_label)

# 让 x 从 -3 平滑变到 3
self.play(t.animate.set_value(3), run_time=6, rate_func=linear)
self.wait(2)

# 收尾
conclusion = Text("曲线 y = x² 是 x 与 x² 协变的'轨迹'", font="Microsoft YaHei", font_size=20, color=GREEN).to_edge(DOWN, buff=0.3)
self.play(Transform(xy_label, conclusion))
self.wait(3)
```

## 关键原则
1. **两个面板的尺度要让步**——不一定 1:1，但视觉对称
2. **always_redraw 必须用**——左右同步的灵魂
3. **TracedPath 让"过去"留下来**——学生才能看到完整轨迹
4. 动画速度控制 `rate_func=linear`——前后变化均匀，否则中间会突然加速
