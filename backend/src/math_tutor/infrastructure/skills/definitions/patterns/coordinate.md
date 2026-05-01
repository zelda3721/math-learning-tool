# 坐标系模式 (Coordinate Pattern)

## 描述
在坐标系上画函数、点、轨迹，用直角坐标系展示数学关系。

## 适用场景
- 一次/二次函数图象
- 点的位置变化
- 解方程组的"图形交点"
- 不等式区域

## 关键词
函数, 坐标, x, y, 图象, 抛物线, 直线, 交点

## 核心代码

```python
def make_axes(x_range=(-4, 4, 1), y_range=(-3, 3, 1)):
    axes = Axes(
        x_range=list(x_range),
        y_range=list(y_range),
        x_length=8,
        y_length=5,
        axis_config={"include_tip": True, "stroke_width": 2},
        tips=False,
    ).to_edge(DOWN, buff=0.5).scale(0.85)
    return axes


def plot_func(axes, func, color=BLUE, x_range=None):
    """func: 一元函数 lambda x: ..."""
    if x_range is None:
        x_range = axes.x_range[:2]
    return axes.plot(func, x_range=x_range, color=color, stroke_width=4)


def emphasize_point(axes, x, y, label_text=None, color=YELLOW):
    """画一个点 + 引出标签"""
    pt = axes.coords_to_point(x, y)
    dot = Dot(pt, color=color, radius=0.08)
    items = [dot]
    if label_text:
        label = Text(label_text, font="Microsoft YaHei", font_size=18, color=color)
        label.next_to(dot, UR, buff=0.15)
        items.append(label)
    return VGroup(*items)


def trace_motion(scene, axes, func, x_range, color=ORANGE, run_time=3):
    """点沿曲线移动"""
    dot = Dot(color=color, radius=0.1)
    dot.move_to(axes.coords_to_point(x_range[0], func(x_range[0])))
    scene.add(dot)
    path = TracedPath(dot.get_center, stroke_color=color, stroke_width=3)
    scene.add(path)
    scene.play(MoveAlongPath(dot, axes.plot(func, x_range=x_range)),
               run_time=run_time)
```

## 使用示例

### 二次函数 y = x² - 2 的最小值
```python
title = Text("y = x² - 2", font="Microsoft YaHei", font_size=24).to_edge(UP, buff=0.3)
self.play(Write(title))

axes = make_axes(x_range=(-3, 3, 1), y_range=(-3, 5, 1))
self.play(Create(axes))
self.wait(0.5)

curve = plot_func(axes, lambda x: x**2 - 2, color=BLUE)
self.play(Create(curve), run_time=2)
self.wait(0.5)

vertex = emphasize_point(axes, 0, -2, label_text="最低点 (0,-2)", color=RED)
self.play(FadeIn(vertex))
self.wait(2)
```

## 关键原则
1. **坐标轴有刻度**：include_tip + 合理的 range
2. **曲线和点不同色**：BLUE 曲线 + YELLOW/RED 点
3. **标注紧贴**：next_to(dot, UR, buff=0.15)，别飘远
4. **移动用 TracedPath**：留下轨迹比裸点直观
