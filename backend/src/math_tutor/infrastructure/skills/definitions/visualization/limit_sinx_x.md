# 极限可视化 - lim(x→0) sin(x)/x（几何夹逼证明）

## 关键词：极限, lim, 趋近, x→, sin(x)/x

## 描述
用几何夹逼法解释为什么 lim(x→0) sin(x)/x = 1

## 数学原理
在单位圆中：
- 三角形OAB面积 = (1/2)sin(x)
- 扇形OAB面积 = (1/2)x  
- 三角形OAC面积 = (1/2)tan(x)

由 sin(x) < x < tan(x) 推出：
sin(x)/x < 1 < 1/cos(x)
当 x→0 时，cos(x)→1，由夹逼定理得 sin(x)/x → 1

## 完整代码模板

```python
from manim import *
import numpy as np

class SolutionScene(Scene):
    def construct(self):
        # ========== 第1幕：标题 ==========
        title = Text("求极限：lim(x→0) sin(x)/x", font="Microsoft YaHei", font_size=28)
        title.to_edge(UP, buff=0.3)
        self.play(Write(title))
        self.wait(1)
        
        # ========== 第2幕：建立几何模型 ==========
        step1 = Text("Step 1: 几何模型", font="Microsoft YaHei", font_size=18, color=YELLOW)
        step1.next_to(title, DOWN, buff=0.3)
        self.play(Write(step1))
        
        # 单位圆（半径=2方便展示）
        r = 2
        circle = Circle(radius=r, color=WHITE)
        circle.shift(LEFT * 2)
        center = circle.get_center()
        
        # 角度 x（用30度作为示例）
        angle = 30 * DEGREES
        
        # 点 A（圆上，角度x处）
        point_a = center + r * np.array([np.cos(angle), np.sin(angle), 0])
        # 点 B（A在x轴上的投影）
        point_b = center + r * np.array([np.cos(angle), 0, 0])
        # 点 C（切线与y轴的交点）
        point_c = center + r * np.array([1, np.tan(angle), 0])
        # 原点 O
        point_o = center
        # 点 D（圆与x轴的交点）
        point_d = center + r * np.array([1, 0, 0])
        
        self.play(Create(circle))
        
        # 标注原点和单位圆
        o_label = Text("O", font_size=16).next_to(point_o, DOWN + LEFT, buff=0.1)
        self.play(Write(o_label))
        
        # ========== 第3幕：三个区域 ==========
        # 三角形 OAB（面积 = 1/2 * sin(x)）
        triangle_oab = Polygon(point_o, point_a, point_b, 
                               fill_color=BLUE, fill_opacity=0.3, stroke_color=BLUE)
        
        # 扇形 OAD（面积 = 1/2 * x）- 用 Arc + Lines 代替 Sector
        arc_oad = Arc(radius=r, angle=angle, arc_center=center, color=GREEN)
        line_od = Line(point_o, point_d, color=GREEN)
        line_oa = Line(point_o, point_a, color=GREEN)
        
        # 三角形 OCD（面积 = 1/2 * tan(x)）
        triangle_ocd = Polygon(point_o, point_c, point_d,
                               fill_color=RED, fill_opacity=0.3, stroke_color=RED)
        
        # 依次显示三个区域
        self.play(FadeIn(triangle_oab))
        area1 = Text("△OAB = ½sin(x)", font="Microsoft YaHei", font_size=14, color=BLUE)
        area1.move_to(RIGHT * 3 + UP * 1.5)
        self.play(Write(area1))
        self.wait(0.5)
        
        self.play(Create(arc_oad), Create(line_od), Create(line_oa))
        area2 = Text("扇形 = ½x", font="Microsoft YaHei", font_size=14, color=GREEN)
        area2.move_to(RIGHT * 3 + UP * 0.7)
        self.play(Write(area2))
        self.wait(0.5)
        
        self.play(FadeIn(triangle_ocd))
        area3 = Text("△OCD = ½tan(x)", font="Microsoft YaHei", font_size=14, color=RED)
        area3.move_to(RIGHT * 3 + DOWN * 0.1)
        self.play(Write(area3))
        self.wait(1)
        
        # ========== 第4幕：建立不等式 ==========
        self.play(FadeOut(step1))
        step2 = Text("Step 2: 面积不等式", font="Microsoft YaHei", font_size=18, color=YELLOW)
        step2.next_to(title, DOWN, buff=0.3)
        self.play(Write(step2))
        
        # 不等式
        ineq = Text("sin(x) < x < tan(x)", font="Microsoft YaHei", font_size=20, color=WHITE)
        ineq.move_to(RIGHT * 3 + DOWN * 1)
        self.play(Write(ineq))
        self.wait(1)
        
        # ========== 第5幕：推导结论 ==========
        self.play(FadeOut(step2))
        step3 = Text("Step 3: 推导极限", font="Microsoft YaHei", font_size=18, color=YELLOW)
        step3.next_to(title, DOWN, buff=0.3)
        self.play(Write(step3))
        
        # 清理几何图形，保留不等式
        self.play(
            FadeOut(circle), FadeOut(triangle_oab), FadeOut(triangle_ocd),
            FadeOut(arc_oad), FadeOut(line_od), FadeOut(line_oa),
            FadeOut(area1), FadeOut(area2), FadeOut(area3), FadeOut(o_label)
        )
        
        # 移动不等式到中间
        ineq.generate_target()
        ineq.target.move_to(UP * 0.5)
        self.play(MoveToTarget(ineq))
        
        # 推导步骤
        derive1 = Text("除以 sin(x)：", font="Microsoft YaHei", font_size=16)
        derive1.move_to(LEFT * 3 + DOWN * 0.3)
        derive2 = Text("1 < x/sin(x) < 1/cos(x)", font="Microsoft YaHei", font_size=18)
        derive2.move_to(DOWN * 0.3)
        self.play(Write(derive1), Write(derive2))
        self.wait(0.5)
        
        derive3 = Text("取倒数：", font="Microsoft YaHei", font_size=16)
        derive3.move_to(LEFT * 3 + DOWN * 1.1)
        derive4 = Text("cos(x) < sin(x)/x < 1", font="Microsoft YaHei", font_size=18, color=GREEN)
        derive4.move_to(DOWN * 1.1)
        self.play(Write(derive3), Write(derive4))
        self.wait(0.5)
        
        derive5 = Text("当 x→0：cos(x)→1", font="Microsoft YaHei", font_size=16)
        derive5.move_to(LEFT * 3 + DOWN * 1.9)
        self.play(Write(derive5))
        self.wait(0.5)
        
        # ========== 第6幕：最终答案 ==========
        self.play(FadeOut(step3))
        
        answer = Text("∴ lim(x→0) sin(x)/x = 1", font="Microsoft YaHei", font_size=28, color=GREEN)
        answer.move_to(DOWN * 2.5)
        
        # 框住答案
        answer_box = SurroundingRectangle(answer, color=GREEN, buff=0.2)
        self.play(Write(answer), Create(answer_box))
        self.wait(2)
```
