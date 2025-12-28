# 极限可视化 - lim(x→0) sin(x)/x

## 关键词：极限, lim, 趋近, x→, sin(x)/x

## 描述
通过**动态逼近**演示极限概念，让学生"看到"当x趋近于0时，sin(x)/x趋近于1。

## 核心理念
> **动态逼近** - 不是静态展示，而是让学生看到数值如何逼近极限值

## 何时使用
- 题目中包含"极限"、"lim"、"趋近"、"x→"等关键词
- 求极限类问题

## ⚠️ 严禁
- **严禁在图像区域内放置公式** - 公式只在右侧
- **严禁静态展示** - 必须有动态点逼近
- **严禁一次性显示所有数值** - 逐步逼近

## 布局规则（左图右文）
```
┌───────────────────────────────────────────────────┐
│  标题：求极限 lim(x→0) sin(x)/x                    │
├──────────────────────┬────────────────────────────┤
│                      │                            │
│   📈 函数图像         │   📝 x 和 f(x) 实时值      │
│   y = sin(x)/x       │   逐步逼近显示              │
│   动态点逼近0         │                            │
│                      │                            │
├──────────────────────┴────────────────────────────┤
│  ✅ 答案：极限 = 1                                 │
└───────────────────────────────────────────────────┘
```

---

## 完整代码模板

```python
from manim import *
import numpy as np

class SolutionScene(Scene):
    def construct(self):
        # ========== 第1幕：显示题目 ==========
        title = Text("求极限：lim(x→0) sin(x)/x", font="Microsoft YaHei", font_size=26)
        title.to_edge(UP, buff=0.3)
        self.play(Write(title))
        self.wait(1)
        
        # ========== 第2幕：画函数图像 ==========
        # 坐标系（左侧）
        axes = Axes(
            x_range=[-4, 4, 1],
            y_range=[-0.5, 1.5, 0.5],
            x_length=5,
            y_length=3.5,
            axis_config={"color": WHITE, "include_numbers": True},
        )
        axes.shift(LEFT * 2 + DOWN * 0.3)
        
        # 添加坐标轴标签
        x_label = Text("x", font_size=16).next_to(axes.x_axis, RIGHT, buff=0.1)
        y_label = Text("y", font_size=16).next_to(axes.y_axis, UP, buff=0.1)
        
        # 函数 y = sin(x)/x
        def f(x):
            if abs(x) < 0.001:
                return 1  # 极限值
            return np.sin(x) / x
        
        curve = axes.plot(f, x_range=[-4, -0.1], color=YELLOW)
        curve2 = axes.plot(f, x_range=[0.1, 4], color=YELLOW)
        
        # y=1 参考线
        ref_line = DashedLine(
            axes.c2p(-4, 1), axes.c2p(4, 1),
            color=GREEN, dash_length=0.1
        )
        ref_label = Text("y = 1", font="Microsoft YaHei", font_size=12, color=GREEN)
        ref_label.next_to(ref_line, RIGHT, buff=0.1)
        
        self.play(Create(axes), Write(x_label), Write(y_label), run_time=1)
        self.play(Create(curve), Create(curve2), run_time=1.5)
        self.play(Create(ref_line), Write(ref_label), run_time=0.5)
        self.wait(1)
        
        # ========== 第3幕：动态逼近演示 ==========
        # 右侧标题
        approach_title = Text("观察：x 逼近 0", font="Microsoft YaHei", font_size=16, color=YELLOW)
        approach_title.move_to(RIGHT * 4.5 + UP * 2.5)
        self.play(Write(approach_title))
        
        # x值和f(x)值显示
        x_display = Text("x = 2.0", font="Microsoft YaHei", font_size=14, color=WHITE)
        x_display.move_to(RIGHT * 4.5 + UP * 1.8)
        
        fx_display = Text("f(x) = 0.455", font="Microsoft YaHei", font_size=14, color=WHITE)
        fx_display.move_to(RIGHT * 4.5 + UP * 1.2)
        
        self.play(Write(x_display), Write(fx_display))
        
        # 创建移动的点（从右侧逼近0）
        dot = Dot(color=RED, radius=0.08)
        start_x = 2.0
        dot.move_to(axes.c2p(start_x, f(start_x)))
        self.play(FadeIn(dot))
        
        # 逐步逼近0
        x_values = [2.0, 1.5, 1.0, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05, 0.01]
        
        for x in x_values[1:]:
            new_pos = axes.c2p(x, f(x))
            
            new_x = Text(f"x = {x:.2f}", font="Microsoft YaHei", font_size=14, color=WHITE)
            new_x.move_to(RIGHT * 4.5 + UP * 1.8)
            
            fx_val = f(x)
            new_fx = Text(f"f(x) = {fx_val:.4f}", font="Microsoft YaHei", font_size=14, 
                         color=GREEN if abs(fx_val - 1) < 0.01 else WHITE)
            new_fx.move_to(RIGHT * 4.5 + UP * 1.2)
            
            self.play(
                dot.animate.move_to(new_pos),
                Transform(x_display, new_x),
                Transform(fx_display, new_fx),
                run_time=0.4
            )
            
            # x很小时暂停
            if x <= 0.1:
                self.wait(0.5)
        
        # 强调结果
        result_text = Text("→ 趋近于 1！", font="Microsoft YaHei", font_size=16, color=GREEN)
        result_text.move_to(RIGHT * 4.5 + UP * 0.5)
        self.play(Write(result_text))
        self.wait(1)
        
        # ========== 第4幕：解释原理 ==========
        self.play(FadeOut(approach_title), FadeOut(x_display), FadeOut(fx_display), FadeOut(result_text))
        
        explain_title = Text("为什么 = 1 ？", font="Microsoft YaHei", font_size=16, color=YELLOW)
        explain_title.move_to(RIGHT * 4.5 + UP * 2.5)
        self.play(Write(explain_title))
        
        # 泰勒展开解释
        exp1 = Text("当 x→0 时：", font="Microsoft YaHei", font_size=12, color=WHITE)
        exp1.move_to(RIGHT * 4.5 + UP * 1.8)
        self.play(Write(exp1))
        self.wait(0.3)
        
        exp2 = Text("sin(x) ≈ x - x³/6 + ...", font="Microsoft YaHei", font_size=12, color=WHITE)
        exp2.move_to(RIGHT * 4.5 + UP * 1.2)
        self.play(Write(exp2))
        self.wait(0.3)
        
        exp3 = Text("sin(x)/x ≈ 1 - x²/6 + ...", font="Microsoft YaHei", font_size=12, color=WHITE)
        exp3.move_to(RIGHT * 4.5 + UP * 0.6)
        self.play(Write(exp3))
        self.wait(0.3)
        
        exp4 = Text("→ 1  (当x→0)", font="Microsoft YaHei", font_size=14, color=GREEN)
        exp4.move_to(RIGHT * 4.5 + UP * 0.0)
        self.play(Write(exp4))
        self.wait(1.5)
        
        # ========== 第5幕：完整答案 ==========
        self.play(
            FadeOut(dot), FadeOut(axes), FadeOut(curve), FadeOut(curve2),
            FadeOut(ref_line), FadeOut(ref_label), FadeOut(x_label), FadeOut(y_label),
            FadeOut(explain_title), FadeOut(exp1), FadeOut(exp2), FadeOut(exp3), FadeOut(exp4)
        )
        self.wait(0.3)
        
        # 答案框
        answer_box = Rectangle(width=7, height=2.2, color=GREEN, fill_opacity=0.05, stroke_width=2)
        answer_box.move_to(ORIGIN)
        
        answer = VGroup(
            Text("解答：", font="Microsoft YaHei", font_size=18, color=YELLOW),
            Text("lim(x→0) sin(x)/x", font="Microsoft YaHei", font_size=16, color=WHITE),
            Text("= lim(x→0) (x - x³/6 + ...)/x", font="Microsoft YaHei", font_size=14, color=WHITE),
            Text("= lim(x→0) (1 - x²/6 + ...) = 1", font="Microsoft YaHei", font_size=16, color=GREEN),
        ).arrange(DOWN, buff=0.2, aligned_edge=LEFT)
        answer.move_to(answer_box.get_center())
        
        self.play(Create(answer_box))
        for line in answer:
            self.play(Write(line), run_time=0.5)
        
        self.wait(3)
```

## 设计要点

### 1. 动态逼近演示
- 点从 x=2 逐步移动到 x=0.01
- 实时显示 x 和 f(x) 值
- 学生**看到** f(x) 趋近于 1

### 2. 布局分离
- 左侧：坐标系 + 函数曲线 + 移动的点
- 右侧：x 和 f(x) 实时值
- 底部：最终答案

### 3. 原理解释（泰勒展开）
- sin(x) ≈ x - x³/6 + ...
- 当 x→0 时，高阶项趋于0
- 所以 sin(x)/x → 1
