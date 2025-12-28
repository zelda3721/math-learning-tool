# 一元一次方程可视化 (Linear Equation Visualization)

## 描述
使用天平模型可视化一元一次方程的求解过程，帮助学生理解"等式两边同时操作"的原理。

## 何时使用
- 题目中包含"解方程"、"求x"、"方程"等关键词
- 形如 ax + b = c 的一元一次方程

## ⚠️ 严禁
- **严禁使用 MathTex/Tex** - 所有公式用 Text 显示
- **严禁文字与图形重叠** - 文字必须在图形上方或下方
- **严禁在图形变换过程中标注临时数字** - 容易重叠

## 布局规则（4区固定）
```
┌─────────────────────────────────────┐
│  标题：解方程 ax + b = c            │  to_edge(UP, buff=0.3)
├─────────────────────────────────────┤
│  当前步骤说明                        │  next_to(title, DOWN, buff=0.3)
├─────────────────────────────────────┤
│                                     │
│     天平左盘        =      天平右盘   │  move_to(ORIGIN)
│     [x方块+圆圈]          [圆圈]     │
│                                     │
├─────────────────────────────────────┤
│  当前等式（代数形式）                 │  to_edge(DOWN, buff=0.5)
└─────────────────────────────────────┘
```

## 核心设计原则
1. **天平模型** - 左右两盘必须视觉平衡
2. **x用方块表示** - 未知数用带x标记的方块
3. **常数用圆圈表示** - 每个圆圈代表1
4. **两边同时操作** - 减去的圆圈从两边同时消失
5. **分组清晰** - VGroup 组织，scale 防溢出

## 参数
- `{a}`: x的系数
- `{b}`: 常数项
- `{c}`: 等式右边的值
- `{x}`: 解

---

## 完整代码模板

```python
from manim import *

class SolutionScene(Scene):
    def construct(self):
        # ========== 计算 ==========
        a = {a}  # x的系数
        b = {b}  # 常数项
        c = {c}  # 右边值
        x_value = (c - b) // a  # 解
        
        # ========== 第1幕：显示题目 ==========
        title = Text(f"解方程：{a}x + {b} = {c}", font="Microsoft YaHei", font_size=28)
        title.to_edge(UP, buff=0.3)
        self.play(Write(title))
        self.wait(2)
        
        # ========== 第2幕：建立天平模型 ==========
        step1 = Text("用天平理解方程", font="Microsoft YaHei", font_size=20, color=YELLOW)
        step1.next_to(title, DOWN, buff=0.3)
        self.play(Write(step1))
        
        # 创建天平底座
        base = Line(LEFT*3, RIGHT*3, color=WHITE, stroke_width=2)
        base.move_to(DOWN*0.5)
        pivot = Triangle(color=WHITE, fill_opacity=0.5).scale(0.3)
        pivot.next_to(base, DOWN, buff=0)
        
        # 左盘（ax + b）
        left_x_boxes = VGroup(*[
            VGroup(
                Square(side_length=0.4, color=BLUE, fill_opacity=0.7),
                Text("x", font="Microsoft YaHei", font_size=14, color=WHITE)
            ) for _ in range(a)
        ])
        for box in left_x_boxes:
            box[1].move_to(box[0].get_center())
        left_x_boxes.arrange(RIGHT, buff=0.1)
        
        left_const = VGroup(*[
            Circle(radius=0.15, color=GREEN, fill_opacity=0.8)
            for _ in range(b)
        ])
        left_const.arrange(RIGHT, buff=0.08)
        
        left_side = VGroup(left_x_boxes, left_const).arrange(RIGHT, buff=0.3)
        left_side.scale(0.8).move_to(LEFT*2 + UP*0.5)
        
        # 等号
        equals = Text("=", font="Microsoft YaHei", font_size=32, color=WHITE)
        equals.move_to(UP*0.5)
        
        # 右盘（c个圆圈）
        right_const = VGroup(*[
            Circle(radius=0.15, color=ORANGE, fill_opacity=0.8)
            for _ in range(c)
        ])
        if c <= 8:
            right_const.arrange(RIGHT, buff=0.08)
        else:
            right_const.arrange_in_grid(rows=2, buff=0.08)
        right_const.scale(0.8).move_to(RIGHT*2 + UP*0.5)
        
        # 显示天平
        self.play(Create(base), Create(pivot))
        self.play(
            LaggedStart(*[FadeIn(box, shift=UP*0.2) for box in left_x_boxes], lag_ratio=0.1),
            LaggedStart(*[FadeIn(c, shift=UP*0.2) for c in left_const], lag_ratio=0.1),
            Write(equals),
            LaggedStart(*[FadeIn(c, shift=UP*0.2) for c in right_const], lag_ratio=0.05),
            run_time=2
        )
        self.wait(1.5)
        
        # 当前等式（底部）
        eq_text = Text(f"{a}x + {b} = {c}", font="Microsoft YaHei", font_size=22, color=WHITE)
        eq_text.to_edge(DOWN, buff=0.5)
        self.play(Write(eq_text))
        self.wait(1)
        
        # ========== 第3幕：两边减去b ==========
        self.play(FadeOut(step1))
        step2 = Text(f"两边同时减去 {b}", font="Microsoft YaHei", font_size=20, color=YELLOW)
        step2.next_to(title, DOWN, buff=0.3)
        self.play(Write(step2))
        self.wait(1)
        
        # 标记要移除的（左边b个绿圆，右边b个橙圆）
        left_to_remove = left_const
        right_to_remove = right_const[:b]
        right_remaining = right_const[b:]
        
        # 变灰
        self.play(
            left_to_remove.animate.set_color(GRAY),
            right_to_remove.animate.set_color(GRAY),
            run_time=0.5
        )
        self.wait(0.5)
        
        # 同时移出
        self.play(
            FadeOut(left_to_remove, shift=DOWN),
            FadeOut(right_to_remove, shift=DOWN),
            run_time=1
        )
        self.wait(0.5)
        
        # 右边重新居中
        self.play(right_remaining.animate.move_to(RIGHT*2 + UP*0.5), run_time=0.5)
        
        # 更新等式
        new_eq = Text(f"{a}x = {c - b}", font="Microsoft YaHei", font_size=22, color=GREEN)
        new_eq.to_edge(DOWN, buff=0.5)
        self.play(Transform(eq_text, new_eq))
        self.wait(1.5)
        
        # ========== 第4幕：两边除以a ==========
        self.play(FadeOut(step2))
        step3 = Text(f"两边同时除以 {a}", font="Microsoft YaHei", font_size=20, color=YELLOW)
        step3.next_to(title, DOWN, buff=0.3)
        self.play(Write(step3))
        self.wait(1)
        
        # 只留一个x方块
        x_to_keep = left_x_boxes[0]
        x_to_remove = left_x_boxes[1:] if a > 1 else VGroup()
        
        if len(x_to_remove) > 0:
            self.play(FadeOut(x_to_remove), run_time=0.5)
        
        # 右边分成a组
        items_per_group = (c - b) // a
        right_groups = VGroup()
        for i in range(items_per_group):
            if i < len(right_remaining):
                right_groups.add(right_remaining[i])
        
        # 其他圆圈淡出
        others = VGroup(*[right_remaining[i] for i in range(items_per_group, len(right_remaining))])
        if len(others) > 0:
            self.play(FadeOut(others), run_time=0.5)
        
        # 重新排列
        self.play(
            x_to_keep.animate.move_to(LEFT*1.5 + UP*0.5),
            right_groups.animate.arrange(RIGHT, buff=0.1).move_to(RIGHT*1.5 + UP*0.5),
            run_time=1
        )
        self.wait(1)
        
        # 更新等式
        final_eq = Text(f"x = {x_value}", font="Microsoft YaHei", font_size=24, color=GREEN)
        final_eq.to_edge(DOWN, buff=0.5)
        self.play(Transform(eq_text, final_eq))
        self.wait(1)
        
        # ========== 第5幕：显示答案 ==========
        self.play(
            FadeOut(step3), FadeOut(base), FadeOut(pivot),
            FadeOut(x_to_keep), FadeOut(right_groups), FadeOut(equals), FadeOut(eq_text)
        )
        self.wait(0.3)
        
        # 答案框
        answer_box = Rectangle(width=5, height=1.8, color=GREEN, fill_opacity=0.1, stroke_width=2)
        answer_box.move_to(ORIGIN)
        
        answer = VGroup(
            Text(f"x = {x_value}", font="Microsoft YaHei", font_size=36, color=GREEN),
            Text(f"验证：{a}×{x_value} + {b} = {a*x_value + b} ✓", font="Microsoft YaHei", font_size=22, color=YELLOW)
        ).arrange(DOWN, buff=0.3)
        answer.move_to(answer_box.get_center())
        
        self.play(Create(answer_box))
        self.play(Write(answer[0]))
        self.wait(0.5)
        self.play(Write(answer[1]))
        self.wait(3)
```

## 关键设计
1. **天平模型** - 直观理解等式平衡
2. **分层布局** - 标题/步骤/图形/等式 四区分离
3. **同步操作** - 两边同时减去b，避免操作符重叠
4. **渐进变换** - 灰色标记→移出→重新布局
