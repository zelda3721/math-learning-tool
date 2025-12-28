# Addition Visualization Skill (加法可视化)

## 描述
为低年级学生可视化加法运算，通过"合并"动画帮助直观理解。

## 何时使用
- 题目中包含"加"、"+"、"求和"、"一共"、"合起来"等关键词
- 需要展示两个数量合并的过程

## ⚠️ 严禁
- **严禁使用 MathTex、Tex** - 所有公式用 Text 显示
- **严禁文字与图形重叠** - 文字必须在图形上方或下方
- **严禁在图形区域标注数字** - 数字标签要放在图形外侧

## 布局规则
```
┌─────────────────────────────────────┐
│  标题区 (to_edge(UP, buff=0.3))    │
├─────────────────────────────────────┤
│  步骤文字 (标题下方 DOWN, buff=0.2) │
├─────────────────────────────────────┤
│                                     │
│  图形区 (ORIGIN)                    │
│  左侧 group1 + 右侧 group2          │
│                                     │
├─────────────────────────────────────┤
│  答案区 (to_edge(DOWN, buff=0.5))   │
└─────────────────────────────────────┘
```

## 参数
- `{num1}`: 第一个加数
- `{num2}`: 第二个加数
- `{result}`: 和

---

## 完整代码模板

```python
from manim import *

class SolutionScene(Scene):
    def construct(self):
        # ========== 计算 ==========
        num1 = {num1}
        num2 = {num2}
        result = num1 + num2
        
        # ========== 第1幕：显示题目 ==========
        title = Text(f"{num1} + {num2} = ?", font="Microsoft YaHei", font_size=32)
        title.to_edge(UP, buff=0.3)
        self.play(Write(title))
        self.wait(2)
        
        # ========== 第2幕：展示第一组 ==========
        step1 = Text(f"第一组：{num1} 个", font="Microsoft YaHei", font_size=20, color=BLUE)
        step1.next_to(title, DOWN, buff=0.3)
        self.play(Write(step1))
        
        # 创建第一组圆圈
        group1 = VGroup(*[
            Circle(radius=0.2, color=BLUE, fill_opacity=0.8)
            for _ in range(num1)
        ])
        
        if num1 <= 5:
            group1.arrange(RIGHT, buff=0.2)
        else:
            group1.arrange_in_grid(rows=2, buff=0.15)
        
        group1.scale(0.6).move_to(LEFT * 2)
        
        # 逐个出现
        self.play(LaggedStart(
            *[GrowFromCenter(c) for c in group1],
            lag_ratio=0.12, run_time=1
        ))
        self.wait(1)
        
        # ========== 第3幕：展示第二组 ==========
        self.play(FadeOut(step1))
        
        step2 = Text(f"第二组：{num2} 个", font="Microsoft YaHei", font_size=20, color=GREEN)
        step2.next_to(title, DOWN, buff=0.3)
        self.play(Write(step2))
        
        # 创建第二组圆圈
        group2 = VGroup(*[
            Circle(radius=0.2, color=GREEN, fill_opacity=0.8)
            for _ in range(num2)
        ])
        
        if num2 <= 5:
            group2.arrange(RIGHT, buff=0.2)
        else:
            group2.arrange_in_grid(rows=2, buff=0.15)
        
        group2.scale(0.6).move_to(RIGHT * 2)
        
        # 逐个出现
        self.play(LaggedStart(
            *[GrowFromCenter(c) for c in group2],
            lag_ratio=0.12, run_time=1
        ))
        self.wait(1)
        
        # ========== 第4幕：合并 ==========
        self.play(FadeOut(step2))
        
        step3 = Text("合在一起", font="Microsoft YaHei", font_size=20, color=YELLOW)
        step3.next_to(title, DOWN, buff=0.3)
        self.play(Write(step3))
        
        # 合并动画
        all_circles = VGroup(*group1, *group2)
        
        # 移动到中间
        self.play(
            group1.animate.shift(RIGHT * 1.5),
            group2.animate.shift(LEFT * 1.5),
            run_time=1
        )
        self.wait(0.5)
        
        # 统一排列
        if result <= 8:
            self.play(all_circles.animate.arrange(RIGHT, buff=0.15).move_to(ORIGIN), run_time=1)
        else:
            self.play(all_circles.animate.arrange_in_grid(rows=2, buff=0.12).move_to(ORIGIN), run_time=1)
        
        # 统一颜色
        self.play(all_circles.animate.set_color(YELLOW), run_time=0.5)
        self.wait(1)
        
        # ========== 第5幕：显示答案 ==========
        self.play(FadeOut(step3))
        
        step4 = Text(f"一共 {result} 个", font="Microsoft YaHei", font_size=22, color=GREEN)
        step4.next_to(title, DOWN, buff=0.3)
        self.play(Write(step4))
        self.wait(1)
        
        # 清理图形显示答案
        self.play(FadeOut(all_circles), FadeOut(step4))
        self.wait(0.3)
        
        # 答案框
        answer_box = Rectangle(width=5, height=1.5, color=GREEN, fill_opacity=0.1, stroke_width=2)
        answer_box.move_to(ORIGIN)
        
        answer = VGroup(
            Text(f"{num1} + {num2} = {result}", font="Microsoft YaHei", font_size=36, color=GREEN),
            Text(f"答案：{result}", font="Microsoft YaHei", font_size=28, color=YELLOW)
        ).arrange(DOWN, buff=0.3)
        answer.move_to(answer_box.get_center())
        
        self.play(Create(answer_box))
        self.play(Write(answer[0]))
        self.wait(0.5)
        self.play(Write(answer[1]))
        self.wait(3)
```

## 关键设计
1. **文字在图形上方** - 统一使用 `next_to(title, DOWN)`
2. **两组分开显示** - 左右对称排列
3. **合并有动画** - 先移动靠近，再统一排列
4. **颜色变化** - 蓝+绿→黄
