# Chicken-Rabbit Problem Skill (鸡兔同笼)

## 描述
可视化经典的鸡兔同笼问题，使用**假设法动画**直观展示解题过程。


## 视觉契约（Visual Contract — 违反即重写）
本 skill 必须遵守以下硬约束。inspect_video 评审时会按此打分；违反任一即触发 generate_manim_code 重新生成。

### 必须出现的 mobject 类型
- 至少 1 个非 Text 图形（Circle / Rectangle / Line / Arrow / NumberLine / Polygon 之一），数学概念必须用图形对应
- 图形数量 ≥ Text 数量（不能让屏幕只剩文字）

### 必须出现的动画类型
- 至少 1 次 **变换/位移类** 动画（Transform / TransformFromCopy / animate.shift / animate.move_to / Rotate / GrowFromCenter）——不仅仅 Write 和 FadeIn/FadeOut
- 至少 1 个动画的"前后状态"承载数学含义（颜色/位置/大小变化必须对应数量/关系/守恒的变化）

### 禁用反模式（命中即 bad）
- 连续 ≥3 个 `Write(Text(...))` + `FadeOut` 的翻页式步骤（PPT 翻页）
- 屏幕同时存在 ≥3 行 Text/MathTex（公式墙）
- 全片只有 Text，没有 Circle/Rectangle/Line 等图形（文字搬运）
- 关键运算只用 Text 写出来而无图形动画对应（应该让"变化"看得见）

### 三阶段教学锚点（每段必须出现且语义对应）
- **setup**：把题目里的对象用图形表达（圆点/线段/方块），让学生先"看见"
- **core/transform**：用动画展示数学关系——变换、增减、对比、守恒、对应
- **verify/reveal**：用图形或动画回到题目，确认答案的合理性

## 何时使用
- 题目中包含"鸡"、"兔"、"头"、"脚"、"腿"等关键词
- 涉及两种不同属性物体的混合计数问题
- 需要通过假设法求解的问题

## ⚠️ 严禁（ABSOLUTELY FORBIDDEN）
- **严禁使用 MathTex、Tex、Matrix** - 所有公式和计算用 Text 显示
- **严禁纯文字解题** - 必须用图形动画展示逻辑

## 核心原则：图形解释数学

| 数学概念 | 图形表达 |
|----------|----------|
| 头的数量 | Circle（能数出来的圆圈） |
| 鸡的脚 | 2条 Line（从圆圈向下延伸） |
| 兔的脚 | 4条 Line（从圆圈向下延伸） |
| 鸡变兔 | 2条脚的动画增长 → 4条脚 |
| 脚数增加 | 新脚的 GrowFromCenter 动画 |

## 参数说明
- `{heads}`: 总头数
- `{legs}`: 总脚数

---

## 完整代码模板（严格遵循）

```python
from manim import *

class SolutionScene(Scene):
    def construct(self):
        # ========== 动态计算 ==========
        heads = {heads}
        legs = {legs}
        assumed_legs = heads * 2
        diff = legs - assumed_legs
        rabbits = diff // 2
        chickens = heads - rabbits
        
        # ========== 第1幕：显示题目 ==========
        title = Text("鸡兔同笼问题", font="Microsoft YaHei", font_size=32, color=YELLOW)
        title.to_edge(UP, buff=0.3)
        
        condition = Text(f"共 {heads} 个头，{legs} 只脚，求鸡兔各几只？", 
                        font="Microsoft YaHei", font_size=20)
        condition.next_to(title, DOWN, buff=0.3)
        
        self.play(Write(title))
        self.play(Write(condition))
        self.wait(2)
        
        # ========== 第2幕：假设全是鸡 - 用图形表示 ==========
        step_text = Text("第一步：假设全是鸡", font="Microsoft YaHei", font_size=18, color=WHITE)
        step_text.to_edge(LEFT, buff=0.5).shift(UP * 1.5)
        self.play(Write(step_text))
        self.wait(1)
        
        # 创建所有动物（每只显示：1个头 + 2只脚）
        animals = VGroup()
        for i in range(heads):
            # 头（圆圈）
            head = Circle(radius=0.15, color=ORANGE, fill_opacity=0.8)
            
            # 2只脚（线条）- 使用相对于头部中心的固定偏移
            leg_length = 0.2
            leg_offset_y = 0.15  # 头部半径
            leg_spread = 0.08   # 左右间距
            
            left_leg = Line(
                start=[- leg_spread, -leg_offset_y, 0],
                end=[- leg_spread, -leg_offset_y - leg_length, 0],
                color=ORANGE, stroke_width=3
            )
            right_leg = Line(
                start=[leg_spread, -leg_offset_y, 0],
                end=[leg_spread, -leg_offset_y - leg_length, 0],
                color=ORANGE, stroke_width=3
            )
            
            animal = VGroup(head, left_leg, right_leg)
            animals.add(animal)
        
        # 自动排列防重叠
        rows = min(5, max(2, heads // 7 + 1))
        animals.arrange_in_grid(rows=rows, buff=0.2)
        animals.scale(0.45).move_to(ORIGIN + DOWN * 0.3)
        
        # 逐个出现
        self.play(LaggedStart(
            *[FadeIn(a, shift=UP * 0.1) for a in animals],
            lag_ratio=0.02, run_time=2
        ))
        self.wait(1)
        
        # 显示当前脚数（用 Text，不是 MathTex！）
        feet_count_text = Text(f"当前脚数：{heads} × 2 = {assumed_legs} 只", 
                              font="Microsoft YaHei", font_size=18, color=ORANGE)
        feet_count_text.to_edge(DOWN, buff=1.2)
        self.play(Write(feet_count_text))
        self.wait(1.5)
        
        # ========== 第3幕：发现差距 - 用图形对比 ==========
        # 清理旧文字
        self.play(FadeOut(step_text))
        self.wait(0.3)
        
        step_text2 = Text("第二步：发现脚不够", font="Microsoft YaHei", font_size=18, color=WHITE)
        step_text2.to_edge(LEFT, buff=0.5).shift(UP * 1.5)
        self.play(Write(step_text2))
        
        # 用红色标注差距
        diff_text = Text(f"还差 {diff} 只脚！", font="Microsoft YaHei", font_size=20, color=RED)
        diff_text.next_to(feet_count_text, DOWN, buff=0.3)
        self.play(Write(diff_text))
        self.wait(1.5)
        
        # ========== 第4幕：鸡变兔 - 核心图形动画！==========
        self.play(FadeOut(step_text2), FadeOut(feet_count_text), FadeOut(diff_text))
        self.wait(0.3)
        
        step_text3 = Text("第三步：把鸡变成兔（每只多2脚）", font="Microsoft YaHei", font_size=18, color=WHITE)
        step_text3.to_edge(LEFT, buff=0.5).shift(UP * 1.5)
        self.play(Write(step_text3))
        
        # 脚数计数器
        current_feet = assumed_legs
        feet_counter = Text(f"脚数：{current_feet}", font="Microsoft YaHei", font_size=20, color=GREEN)
        feet_counter.to_edge(DOWN, buff=1.2)
        self.play(Write(feet_counter))
        
        # 逐只变换：鸡 → 兔（关键动画！）
        for i in range(rabbits):
            # 1. 头变蓝色
            self.play(animals[i][0].animate.set_color(BLUE), run_time=0.15)
            
            # 2. 添加2只新脚（这是核心：用图形展示脚的增加！）
            new_leg1 = Line(ORIGIN, DOWN * 0.12, color=BLUE, stroke_width=2)
            new_leg2 = Line(ORIGIN, DOWN * 0.12, color=BLUE, stroke_width=2)
            new_leg1.next_to(animals[i][1], LEFT, buff=0.02)
            new_leg2.next_to(animals[i][2], RIGHT, buff=0.02)
            
            # 脚的生长动画（不是直接出现！）
            self.play(
                GrowFromCenter(new_leg1), 
                GrowFromCenter(new_leg2), 
                run_time=0.2
            )
            animals[i].add(new_leg1, new_leg2)
            
            # 3. 更新计数器
            current_feet += 2
            new_counter = Text(f"脚数：{current_feet}", font="Microsoft YaHei", font_size=20, color=GREEN)
            new_counter.to_edge(DOWN, buff=1.2)
            self.play(Transform(feet_counter, new_counter), run_time=0.1)
        
        self.wait(1)
        
        # 完成提示
        done_text = Text(f"达到 {legs} 只脚！", font="Microsoft YaHei", font_size=20, color=GREEN)
        done_text.next_to(feet_counter, DOWN, buff=0.3)
        self.play(Write(done_text))
        self.wait(2)
        
        # ========== 第5幕：显示答案 ==========
        self.play(
            FadeOut(title), FadeOut(condition), FadeOut(step_text3),
            FadeOut(animals), FadeOut(feet_counter), FadeOut(done_text)
        )
        self.wait(0.5)
        
        # 结果框
        result_box = Rectangle(width=7, height=2, color=GREEN, fill_opacity=0.1, stroke_width=2)
        result_box.move_to(ORIGIN)
        
        result = VGroup(
            Text(f"鸡：{chickens} 只", font="Microsoft YaHei", font_size=28, color=ORANGE),
            Text(f"兔：{rabbits} 只", font="Microsoft YaHei", font_size=28, color=BLUE),
            Text(f"验证：{chickens}×2 + {rabbits}×4 = {chickens*2 + rabbits*4} 脚 ✓", 
                 font="Microsoft YaHei", font_size=22, color=GREEN)
        ).arrange(DOWN, buff=0.3)
        result.move_to(result_box.get_center())
        
        self.play(Create(result_box))
        self.play(LaggedStart(*[Write(r) for r in result], lag_ratio=0.3))
        self.wait(3)
```

## 关键设计要点

1. **完全不使用 MathTex** - 所有公式都用 Text 显示
2. **脚的变化用图形动画** - GrowFromCenter 展示新脚的生长
3. **颜色区分** - 鸡（橙色）vs 兔（蓝色）
4. **实时计数器** - 展示脚数的增加过程
5. **逐只变换** - 学生能看到每一步的变化
