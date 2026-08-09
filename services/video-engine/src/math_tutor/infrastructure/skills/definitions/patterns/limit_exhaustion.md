# Limit by Exhaustion Pattern (穷竭法 / 极限可视)

## 描述
用"逐步逼近"动画把极限/积分/导数从抽象符号变成可见过程。3Blue1Brown 的代表性手法。

## 适用场景
- 圆面积 = πr²（割圆术：n 边形 → 圆）
- 定积分 = 矩形条求和的极限
- 导数 = 割线变切线的极限
- 数列收敛（等比级数 1/2 + 1/4 + ... = 1）
- 阿基米德求抛物线下面积

## 关键词
极限, 趋近, 逼近, 越来越, 无限, 求和, 积分, 导数, 切线

## ⚠️ 视觉契约
- 必须有 **ValueTracker** 控制参数 n（切片数 / 步长 / 角度）
- 必须有 **always_redraw**（或循环 Transform）让图形随 n 变化**连续动**
- 必须显示 **n 的当前值** + **当前误差/和值**（同步更新的 Text）
- 不允许跳跃式展示（n=4 突然到 n=100），要"看见趋近的过程"

## 核心代码

```python
def make_polygon_in_circle(n_sides: int, radius=2.0, color=BLUE):
    """造一个内接 n 边形（半径 = radius）。"""
    points = [
        radius * np.array([np.cos(2 * PI * i / n_sides), np.sin(2 * PI * i / n_sides), 0])
        for i in range(n_sides)
    ]
    return Polygon(*points, color=color, fill_opacity=0.4, stroke_width=2)


def make_riemann_rects(func, x_min, x_max, n_rects, color=GREEN):
    """造黎曼矩形（左端点法）。"""
    dx = (x_max - x_min) / n_rects
    rects = VGroup()
    for i in range(n_rects):
        x = x_min + i * dx
        h = func(x)
        rect = Rectangle(width=dx, height=abs(h), color=color, fill_opacity=0.5, stroke_width=1)
        rect.move_to([x + dx / 2, h / 2, 0])
        rects.add(rect)
    return rects
```

## 使用示例 — 割圆术求 π

```python
title = Text("割圆术：内接多边形 → 圆", font="Microsoft YaHei", font_size=24).to_edge(UP, buff=0.3)
self.play(Write(title))

# 主舞台：圆 + 多边形
circle = Circle(radius=2, color=WHITE, stroke_width=3).move_to(LEFT * 2)
self.play(Create(circle))

# n_tracker 控制边数
n_tracker = ValueTracker(3)
poly = always_redraw(lambda: make_polygon_in_circle(int(n_tracker.get_value()), radius=2).move_to(circle.get_center()))
self.add(poly)

# 右侧：n 与近似面积同步显示
n_label = always_redraw(lambda: Text(
    f"n = {int(n_tracker.get_value())}",
    font="Microsoft YaHei", font_size=28, color=YELLOW
).move_to(RIGHT * 3 + UP * 1))

area_label = always_redraw(lambda: Text(
    f"面积 ≈ {0.5 * int(n_tracker.get_value()) * np.sin(2*PI/int(n_tracker.get_value())) * 2**2:.4f}",
    font="Microsoft YaHei", font_size=22, color=GREEN
).move_to(RIGHT * 3 + DOWN * 0))

pi_label = Text(f"π × r² = {PI * 4:.4f}", font="Microsoft YaHei", font_size=22, color=BLUE).move_to(RIGHT * 3 + DOWN * 1.5)
self.play(Write(n_label), Write(area_label), Write(pi_label))

# === 关键动画：n 从 3 平滑增到 100 ===
self.play(n_tracker.animate.set_value(6), run_time=1.5)
self.wait(0.5)
self.play(n_tracker.animate.set_value(12), run_time=1.5)
self.wait(0.5)
self.play(n_tracker.animate.set_value(30), run_time=1.5)
self.wait(0.5)
self.play(n_tracker.animate.set_value(100), run_time=2)
self.wait(2)

# 收尾
conclusion = Text("当 n → ∞，多边形 → 圆，面积 → π r²", font="Microsoft YaHei", font_size=22, color=YELLOW).to_edge(DOWN, buff=0.5)
self.play(Write(conclusion))
self.wait(3)
```

## 关键原则
1. **ValueTracker 是核心**——参数连续变，画面连续变
2. **always_redraw 比循环 Transform 更顺滑**——避免抽帧时的跳跃感
3. 同步显示 **n** 和 **当前值**，让"趋近"是可计数的
4. 速度要先慢后快——前几步让学生看清形状变化，后面快进到大 n
