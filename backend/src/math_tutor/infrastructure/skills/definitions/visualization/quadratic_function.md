# 二次函数最值可视化 (Quadratic Function Min/Max)

## 描述
通过**图形动态演示**帮助学生理解二次函数的最值，让学生"看到"为什么顶点处取得最小/最大值。

## 核心理念
> **图形即理解** - 不是画个图再做代数，而是让图形本身解释数学本质

## 何时使用
- 题目中包含"函数"、"最小值"、"最大值"、"顶点"、"二次"等关键词
- 形如 f(x) = ax² + bx + c 的二次函数求极值

## ⚠️ 严禁
- **严禁在图像区域内放置公式** - 公式只能在图像外侧
- **严禁先代数后图形** - 必须先让学生看到图形变化
- **严禁静态展示** - 必须有动态点在曲线上移动

## 布局规则（左右分离）
```
┌────────────────────────────────────────────────────────┐
│  标题：求函数 f(x) = ... 的最小值                        │
├──────────────────────┬─────────────────────────────────┤
│                      │                                 │
│   坐标系+抛物线       │   步骤说明                       │
│   (占2/3宽度)        │   (占1/3宽度)                    │
│   左侧居中            │   右侧靠上                       │
│                      │                                 │
├──────────────────────┴─────────────────────────────────┤
│  底部：当前状态/答案                                     │
└────────────────────────────────────────────────────────┘
```

## 视觉演示原则
1. **动态轨迹** - 一个点沿抛物线移动
2. **实时y值** - 点移动时显示当前 f(x) 值
3. **顶点高亮** - 到达顶点时特殊标记
4. **最值强调** - 用水平虚线标注最小值位置

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
        # 坐标系（左侧2/3区域）
        axes = Axes(
            x_range=[-1, 5, 1],
            y_range=[-2, 5, 1],
            x_length=5,
            y_length=4,
            axis_config={"color": WHITE, "include_tip": True},
        )
        axes.shift(LEFT * 1.5)
        
        # 函数曲线
        def f(x):
            return a * x**2 + b * x + c
        
        curve = axes.plot(f, x_range=[-0.5, 4.5], color=YELLOW)
        
        # 绘制坐标系
        self.play(Create(axes), run_time=1)
        self.play(Create(curve), run_time=1.5)
        self.wait(1)
        
        # 右侧说明区
        info_title = Text("观察曲线", font="Microsoft YaHei", font_size=18, color=YELLOW)
        info_title.move_to(RIGHT * 4 + UP * 2)
        self.play(Write(info_title))
        
        # ========== 第3幕：动态演示 - 点沿曲线移动 ==========
        # 创建移动的点
        dot = Dot(color=RED, radius=0.1)
        dot.move_to(axes.c2p(0, f(0)))
        
        # y值显示（右侧信息区）
        y_label = Text(f"f(0) = {f(0):.0f}", font="Microsoft YaHei", font_size=16, color=WHITE)
        y_label.move_to(RIGHT * 4 + UP * 1)
        
        self.play(FadeIn(dot), Write(y_label))
        self.wait(0.5)
        
        # 更新y值的函数
        def update_label(x_val):
            new_label = Text(f"f({x_val:.1f}) = {f(x_val):.1f}", font="Microsoft YaHei", font_size=16, color=WHITE)
            new_label.move_to(RIGHT * 4 + UP * 1)
            return new_label
        
        # 点从左向右移动，学生看到y值先减后增
        x_values = np.linspace(0, 4, 20)
        for i, x in enumerate(x_values):
            new_pos = axes.c2p(x, f(x))
            new_label = update_label(x)
            
            if i == 0:
                continue
            
            # 到达顶点附近时特殊处理
            if abs(x - vertex_x) < 0.2:
                self.play(
                    dot.animate.move_to(new_pos),
                    Transform(y_label, new_label),
                    run_time=0.3
                )
                # 顶点高亮
                vertex_dot = Dot(axes.c2p(vertex_x, vertex_y), color=GREEN, radius=0.15)
                vertex_ring = Circle(radius=0.25, color=GREEN).move_to(vertex_dot.get_center())
                self.play(FadeIn(vertex_dot), Create(vertex_ring), run_time=0.5)
                
                # 显示这是最小值
                min_info = Text("这是最低点！", font="Microsoft YaHei", font_size=16, color=GREEN)
                min_info.move_to(RIGHT * 4 + UP * 0.3)
                self.play(Write(min_info))
                self.wait(1)
            else:
                self.play(
                    dot.animate.move_to(new_pos),
                    Transform(y_label, new_label),
                    run_time=0.08
                )
        
        self.wait(1)
        
        # ========== 第4幕：标注顶点和最小值 ==========
        # 顶点坐标
        vertex_label = Text(f"顶点({vertex_x:.0f}, {vertex_y:.0f})", font="Microsoft YaHei", font_size=14, color=GREEN)
        vertex_label.next_to(axes.c2p(vertex_x, vertex_y), DOWN + RIGHT, buff=0.2)
        self.play(Write(vertex_label))
        
        # 水平虚线表示最小值
        min_line = DashedLine(
            axes.c2p(-1, vertex_y),
            axes.c2p(5, vertex_y),
            color=GREEN,
            dash_length=0.1
        )
        self.play(Create(min_line))
        
        # 最小值标注
        min_text = Text(f"最小值 = {vertex_y:.0f}", font="Microsoft YaHei", font_size=18, color=GREEN)
        min_text.next_to(min_line, RIGHT, buff=0.2)
        self.play(Write(min_text))
        self.wait(2)
        
        # ========== 第5幕：连接图形与公式 ==========
        # 清理动态元素
        self.play(
            FadeOut(dot), FadeOut(y_label), FadeOut(info_title), FadeOut(min_info)
        )
        self.wait(0.5)
        
        # 右侧显示解题方法
        method_title = Text("📐 解题方法", font="Microsoft YaHei", font_size=18, color=YELLOW)
        method_title.move_to(RIGHT * 4 + UP * 2)
        self.play(Write(method_title))
        
        # 公式推导（右侧信息区，不在图上）
        step1 = Text("顶点 x = -b/(2a)", font="Microsoft YaHei", font_size=14, color=WHITE)
        step1.move_to(RIGHT * 4 + UP * 1.2)
        self.play(Write(step1))
        self.wait(0.5)
        
        step2 = Text(f"= -({b})/(2×{a})", font="Microsoft YaHei", font_size=14, color=WHITE)
        step2.move_to(RIGHT * 4 + UP * 0.6)
        self.play(Write(step2))
        self.wait(0.5)
        
        step3 = Text(f"= {vertex_x:.0f}", font="Microsoft YaHei", font_size=14, color=GREEN)
        step3.move_to(RIGHT * 4 + UP * 0)
        self.play(Write(step3))
        self.wait(1)
        
        # 指向图上的顶点（连接图形和公式）
        arrow = Arrow(
            step3.get_left() + LEFT * 0.2,
            axes.c2p(vertex_x, vertex_y) + RIGHT * 0.3,
            color=GREEN,
            stroke_width=2
        )
        self.play(Create(arrow))
        self.wait(1)
        
        # ========== 第6幕：完整答案 ==========
        # 清理解题方法区
        self.play(
            FadeOut(method_title), FadeOut(step1), FadeOut(step2), FadeOut(step3), FadeOut(arrow),
            FadeOut(axes), FadeOut(curve), FadeOut(vertex_dot), FadeOut(vertex_ring),
            FadeOut(vertex_label), FadeOut(min_line), FadeOut(min_text)
        )
        self.wait(0.3)
        
        # 完整解题步骤框
        solution_box = Rectangle(width=7, height=3, color=GREEN, fill_opacity=0.05, stroke_width=2)
        solution_box.move_to(ORIGIN)
        
        solution = VGroup(
            Text("解题步骤：", font="Microsoft YaHei", font_size=20, color=YELLOW),
            Text(f"① 识别：a={a}, b={b}, c={c}", font="Microsoft YaHei", font_size=16, color=WHITE),
            Text(f"② 顶点 x = -b/(2a) = {vertex_x:.0f}", font="Microsoft YaHei", font_size=16, color=WHITE),
            Text(f"③ 代入：f({vertex_x:.0f}) = {vertex_y:.0f}", font="Microsoft YaHei", font_size=16, color=WHITE),
            Text(f"④ 答案：最小值 = {vertex_y:.0f}", font="Microsoft YaHei", font_size=18, color=GREEN),
        ).arrange(DOWN, buff=0.25, aligned_edge=LEFT)
        solution.move_to(solution_box.get_center())
        
        self.play(Create(solution_box))
        for line in solution:
            self.play(Write(line), run_time=0.6)
            self.wait(0.3)
        
        self.wait(3)
```

## 关键视觉效果

### 动态理解（不是静态展示）
1. **点沿曲线移动** - 学生看到 y 值先减小后增大
2. **到达顶点时高亮** - 特殊标记+文字提示
3. **水平虚线** - 视觉强调最小值水平线

### 布局分离
- **左侧**: 坐标系 + 抛物线 + 动态点
- **右侧**: 实时 f(x) 值显示
- **底部**: 最终答案

### 为什么这样设计
| 传统方式 | 图形优先方式 |
|----------|--------------|
| 先讲配方法 | 先看曲线形状 |
| 公式推导顶点 | 点移动找最低点 |
| 学生被动接受 | 学生主动观察 |
