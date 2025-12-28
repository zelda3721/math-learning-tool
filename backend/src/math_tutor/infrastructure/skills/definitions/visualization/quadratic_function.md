# 二次函数最值可视化 (Quadratic Function Min/Max)

## 关键词：二次函数, 最小值, 最大值, 顶点, x², 抛物线

## 描述
通过**图形动态演示**帮助学生理解二次函数的最值，让学生"看到"为什么顶点处取得最小/最大值，并理解公式的来源。

## 核心理念
> **图形理解 → 公式推导 → 解题方法** 三步走

## 何时使用
- 题目中包含"函数"、"最小值"、"最大值"、"顶点"、"二次"等关键词
- 形如 f(x) = ax² + bx + c 的二次函数求极值

## ⚠️ 严禁
- **严禁在图像区域内放置公式** - 公式只能在图像右侧
- **严禁箭头和文字重叠** - 所有文字要有足够间距
- **严禁静态展示** - 必须有动态点在曲线上移动

## 布局规则（严格Y坐标）
```
Y坐标:
  3.5  标题
  3.0  -----
  2.5  右侧标题区
  1.5  右侧信息1
  0.5  右侧信息2
 -0.5  右侧信息3（不要更低！）
 -2.5  图形标注区（顶点标签在这里）
 -3.0  底部答案区
```

---

## 完整代码模板

```python
from manim import *
import numpy as np

class SolutionScene(Scene):
    def construct(self):
        # ========== 参数 ==========
        a = {a}  # x²系数
        b = {b}  # x系数
        c = {c}  # 常数项
        
        # 计算顶点
        vertex_x = -b / (2 * a)
        vertex_y = a * vertex_x**2 + b * vertex_x + c
        
        # ========== 第1幕：显示题目 ==========
        title = Text(f"求函数 f(x) = x² - 4x + 3 的最小值", font="Microsoft YaHei", font_size=24)
        title.to_edge(UP, buff=0.3)
        self.play(Write(title))
        self.wait(1)
        
        # ========== 第2幕：画坐标系和抛物线 ==========
        # 坐标系（左侧区域，不要太大）
        axes = Axes(
            x_range=[-1, 5, 1],
            y_range=[-2, 4, 1],
            x_length=4.5,
            y_length=3.5,
            axis_config={"color": WHITE, "include_tip": True},
        )
        axes.shift(LEFT * 2 + DOWN * 0.5)
        
        # 函数曲线
        def f(x):
            return a * x**2 + b * x + c
        
        curve = axes.plot(f, x_range=[-0.5, 4.5], color=YELLOW)
        
        self.play(Create(axes), run_time=1)
        self.play(Create(curve), run_time=1.5)
        self.wait(1)
        
        # ========== 第3幕：动态演示 - 点沿曲线移动 ==========
        # 右侧标题
        info_title = Text("观察 y 值变化：", font="Microsoft YaHei", font_size=16, color=YELLOW)
        info_title.move_to(RIGHT * 4.5 + UP * 2.5)
        self.play(Write(info_title))
        
        # 创建移动的点
        dot = Dot(color=RED, radius=0.08)
        dot.move_to(axes.c2p(0, f(0)))
        
        # y值显示
        y_label = Text(f"f(0) = {f(0):.0f}", font="Microsoft YaHei", font_size=14, color=WHITE)
        y_label.move_to(RIGHT * 4.5 + UP * 1.8)
        
        self.play(FadeIn(dot), Write(y_label))
        
        # 点移动
        x_values = np.linspace(0, 4, 15)
        vertex_dot = None
        
        for i, x in enumerate(x_values):
            if i == 0:
                continue
            
            new_pos = axes.c2p(x, f(x))
            new_label = Text(f"f({x:.1f}) = {f(x):.1f}", font="Microsoft YaHei", font_size=14, color=WHITE)
            new_label.move_to(RIGHT * 4.5 + UP * 1.8)
            
            # 到达顶点时
            if abs(x - vertex_x) < 0.3 and vertex_dot is None:
                self.play(
                    dot.animate.move_to(new_pos),
                    Transform(y_label, new_label),
                    run_time=0.2
                )
                # 顶点高亮
                vertex_dot = Dot(axes.c2p(vertex_x, vertex_y), color=GREEN, radius=0.12)
                self.play(FadeIn(vertex_dot), run_time=0.3)
                
                # 最低点提示（在右侧，足够高的位置）
                min_info = Text("↓ 这里最低！", font="Microsoft YaHei", font_size=14, color=GREEN)
                min_info.move_to(RIGHT * 4.5 + UP * 1.0)
                self.play(Write(min_info))
                self.wait(0.8)
            else:
                self.play(
                    dot.animate.move_to(new_pos),
                    Transform(y_label, new_label),
                    run_time=0.06
                )
        
        self.wait(1)
        
        # ========== 第4幕：解释公式来源 ==========
        # 清理动态元素
        self.play(FadeOut(dot), FadeOut(y_label), FadeOut(info_title), FadeOut(min_info))
        self.wait(0.3)
        
        # 右侧显示配方法
        method_title = Text("为什么 x = 2 ？", font="Microsoft YaHei", font_size=16, color=YELLOW)
        method_title.move_to(RIGHT * 4.5 + UP * 2.5)
        self.play(Write(method_title))
        
        # 配方法解释
        explain1 = Text("f(x) = x² - 4x + 3", font="Microsoft YaHei", font_size=12, color=WHITE)
        explain1.move_to(RIGHT * 4.5 + UP * 1.8)
        self.play(Write(explain1))
        self.wait(0.5)
        
        explain2 = Text("= (x-2)² - 4 + 3", font="Microsoft YaHei", font_size=12, color=WHITE)
        explain2.move_to(RIGHT * 4.5 + UP * 1.2)
        self.play(Write(explain2))
        self.wait(0.5)
        
        explain3 = Text("= (x-2)² - 1", font="Microsoft YaHei", font_size=12, color=GREEN)
        explain3.move_to(RIGHT * 4.5 + UP * 0.6)
        self.play(Write(explain3))
        self.wait(0.5)
        
        # 关键理解
        key_point = Text("(x-2)² ≥ 0 恒成立", font="Microsoft YaHei", font_size=12, color=ORANGE)
        key_point.move_to(RIGHT * 4.5 + DOWN * 0.0)
        self.play(Write(key_point))
        self.wait(0.5)
        
        conclusion = Text("∴ x=2 时最小", font="Microsoft YaHei", font_size=12, color=GREEN)
        conclusion.move_to(RIGHT * 4.5 + DOWN * 0.5)
        self.play(Write(conclusion))
        self.wait(1.5)
        
        # ========== 第5幕：通用公式 ==========
        self.play(
            FadeOut(method_title), FadeOut(explain1), FadeOut(explain2), 
            FadeOut(explain3), FadeOut(key_point), FadeOut(conclusion)
        )
        
        formula_title = Text("📐 通用公式", font="Microsoft YaHei", font_size=16, color=YELLOW)
        formula_title.move_to(RIGHT * 4.5 + UP * 2.5)
        self.play(Write(formula_title))
        
        formula = Text("顶点 x = -b/(2a)", font="Microsoft YaHei", font_size=14, color=WHITE)
        formula.move_to(RIGHT * 4.5 + UP * 1.8)
        self.play(Write(formula))
        
        calc = Text(f"= -({b})/(2×{a}) = {vertex_x:.0f}", font="Microsoft YaHei", font_size=14, color=GREEN)
        calc.move_to(RIGHT * 4.5 + UP * 1.2)
        self.play(Write(calc))
        self.wait(1.5)
        
        # ========== 第6幕：完整答案 ==========
        self.play(
            FadeOut(formula_title), FadeOut(formula), FadeOut(calc),
            FadeOut(axes), FadeOut(curve), FadeOut(vertex_dot)
        )
        self.wait(0.3)
        
        # 答案框
        answer_box = Rectangle(width=7, height=2.5, color=GREEN, fill_opacity=0.05, stroke_width=2)
        answer_box.move_to(ORIGIN)
        
        answer = VGroup(
            Text("解答：", font="Microsoft YaHei", font_size=18, color=YELLOW),
            Text(f"f(x) = (x-{vertex_x:.0f})² + ({vertex_y:.0f})", font="Microsoft YaHei", font_size=16, color=WHITE),
            Text(f"∵ (x-{vertex_x:.0f})² ≥ 0", font="Microsoft YaHei", font_size=16, color=WHITE),
            Text(f"∴ 当 x = {vertex_x:.0f} 时，f(x)最小 = {vertex_y:.0f}", font="Microsoft YaHei", font_size=18, color=GREEN),
        ).arrange(DOWN, buff=0.2, aligned_edge=LEFT)
        answer.move_to(answer_box.get_center())
        
        self.play(Create(answer_box))
        for line in answer:
            self.play(Write(line), run_time=0.5)
        
        self.wait(3)
```

## 设计要点

### 1. 严格的Y坐标分配
- 右侧所有文字从 UP*2.5 开始，每行间隔 0.5-0.6
- 绝不低于 DOWN*0.5（避免和图形重叠）

### 2. 公式来源解释（配方法）
- f(x) = x² - 4x + 3
- = (x-2)² - 4 + 3
- = (x-2)² - 1
- (x-2)² ≥ 0 → x=2时最小

### 3. 三步理解
| 步骤 | 内容 |
|------|------|
| 图形观察 | 点移动，看到y先减后增 |
| 公式推导 | 配方法解释为什么 |
| 通用方法 | x = -b/(2a) |
