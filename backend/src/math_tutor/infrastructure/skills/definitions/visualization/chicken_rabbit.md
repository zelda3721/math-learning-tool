# 鸡兔同笼问题
这是一类经典的数学问题，通常给出头和脚的总数，求两种动物（鸡和兔）的数量。

关键词：鸡兔同笼, 假设法, 头脚问题

```python
class ChickenRabbitScene(Scene):
    def construct(self):
        # 1. 标题
        title = Text("鸡兔同笼问题", font_size=48, color=BLUE).to_edge(UP)
        self.play(Write(title))
        
        # 2. 题目展示
        problem = Text("题目：笼子里有若干只鸡和兔", font_size=32).next_to(title, DOWN, buff=0.5)
        conditions = Text("从上面数，有35个头；从下面数，有94只脚。", font_size=32).next_to(problem, DOWN)
        self.play(FadeIn(problem), FadeIn(conditions))
        self.wait(1)
        
        # 3. 假设法演示（可视化核心）
        # 假设全是鸡
        assumption_text = Text("假设全是鸡...", font_size=36, color=YELLOW).next_to(conditions, DOWN, buff=1.0)
        self.play(Write(assumption_text))
        
        # 显示35个圆代表头
        heads = VGroup(*[Circle(radius=0.2, color=WHITE, fill_opacity=0.5) for _ in range(35)])
        heads.arrange_in_grid(rows=5, buff=0.1).next_to(assumption_text, DOWN, buff=0.5)
        self.play(Create(heads))
        
        # 给每个头添上2只脚
        feet_text = Text("每只鸡2只脚，共 35 × 2 = 70 只脚", font_size=28).next_to(heads, DOWN)
        self.play(Write(feet_text))
        
        # 计算多出来的脚
        diff_text = Text("实际有94只脚，多了 94 - 70 = 24 只脚", font_size=28, color=RED).next_to(feet_text, DOWN)
        self.play(Write(diff_text))
        
        # 解释为什么多出来：因为把兔当成了鸡
        explain_text = Text("每只兔少算了 4 - 2 = 2 只脚", font_size=28).next_to(diff_text, DOWN)
        self.play(Write(explain_text))
        
        # 计算兔的数量
        rabbit_calc = Text("兔的数量 = 24 ÷ 2 = 12 (只)", font_size=36, color=GREEN).next_to(explain_text, DOWN, buff=0.5)
        self.play(Transform(assumption_text, rabbit_calc))
        
        # 计算鸡的数量
        chicken_calc = Text("鸡的数量 = 35 - 12 = 23 (只)", font_size=36, color=BLUE).next_to(rabbit_calc, DOWN)
        self.play(Write(chicken_calc))
        
        self.wait(2)
```

## 解题思路（假设法）
1.  **假设**全是鸡（或全是兔）。
2.  **计算**在假设情况下的总脚数。
3.  **比较**假设脚数与实际脚数的差额。
4.  **调整**：利用每只兔比鸡多2只脚（或反之），将差额分配给兔子，求出兔的数量。
5.  **求解**出另一种动物的数量。
