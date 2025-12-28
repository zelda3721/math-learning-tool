# 二次函数最值可视化

## 关键词：二次函数, 最小值, 最大值, 顶点, x², 抛物线

## 描述
动态点演示二次函数最值。

## 完整代码模板

```python
from manim import *
import numpy as np

class SolutionScene(Scene):
    def construct(self):
        # 参数（从题目提取）
        a, b, c = 1, -4, 3  # f(x) = x² - 4x + 3
        vertex_x = -b / (2 * a)
        vertex_y = a * vertex_x**2 + b * vertex_x + c
        
        # ========== 标题 ==========
        title = Text("求函数 f(x) = x² - 4x + 3 的最小值", font="Microsoft YaHei", font_size=26)
        title.to_edge(UP, buff=0.4)
        self.play(Write(title))
        self.wait(1)
        
        # ========== 坐标系 + 抛物线 ==========
        axes = Axes(
            x_range=[-1, 5, 1],
            y_range=[-2, 5, 1],
            x_length=5,
            y_length=4,
            axis_config={"color": WHITE},
        )
        axes.shift(LEFT * 2 + DOWN * 0.3)
        
        def f(x):
            return a * x**2 + b * x + c
        
        curve = axes.plot(f, x_range=[-0.5, 4.5], color=YELLOW)
        
        self.play(Create(axes), run_time=1)
        self.play(Create(curve), run_time=1)
        self.wait(0.5)
        
        # ========== 动态点演示 ==========
        dot = Dot(axes.c2p(0, f(0)), color=RED, radius=0.1)
        self.play(FadeIn(dot))
        
        # 右侧显示值
        info = Text("f(0) = 3", font="Microsoft YaHei", font_size=16)
        info.move_to(RIGHT * 4 + UP * 2)
        self.play(Write(info))
        
        # 点移动到顶点
        for x in [0.5, 1, 1.5, 2]:
            y = f(x)
            new_info = Text(f"f({x:.1f}) = {y:.1f}", font="Microsoft YaHei", font_size=16)
            new_info.move_to(RIGHT * 4 + UP * 2)
            self.play(
                dot.animate.move_to(axes.c2p(x, y)),
                Transform(info, new_info),
                run_time=0.4
            )
        
        # 高亮顶点
        vertex_dot = Dot(axes.c2p(vertex_x, vertex_y), color=GREEN, radius=0.15)
        self.play(FadeIn(vertex_dot))
        
        min_text = Text("← 最低点！", font="Microsoft YaHei", font_size=16, color=GREEN)
        min_text.next_to(vertex_dot, RIGHT, buff=0.2)
        self.play(Write(min_text))
        self.wait(1)
        
        # ========== 公式解释 ==========
        self.play(FadeOut(info), FadeOut(dot))
        
        explain = VGroup(
            Text("顶点公式：", font="Microsoft YaHei", font_size=14, color=YELLOW),
            Text("x = -b/(2a) = 2", font="Microsoft YaHei", font_size=14),
            Text("f(2) = -1", font="Microsoft YaHei", font_size=14, color=GREEN),
        ).arrange(DOWN, buff=0.2, aligned_edge=LEFT)
        explain.move_to(RIGHT * 4 + UP * 1)
        self.play(Write(explain))
        self.wait(1.5)
        
        # ========== 答案 ==========
        answer = Text(f"最小值 = {vertex_y:.0f}", font="Microsoft YaHei", font_size=32, color=GREEN)
        answer.to_edge(DOWN, buff=0.5)
        self.play(Write(answer))
        self.wait(2)
```
