# Subtraction Visualization Skill (减法可视化)

## 描述
为低年级学生可视化减法运算，通过"拿走"动画帮助直观理解。

## 何时使用
- 题目中包含"减"、"-"、"拿走"、"吃掉"、"剩下"等关键词
- 需要展示从总数中移除一部分的过程

## ⚠️ 严禁
- **严禁使用 MathTex、Tex** - 所有公式用 Text 显示
- **严禁文字与图形重叠** - 文字必须在图形上方或下方
- **严禁在图形上标注数字** - 数字标签要放在图形外侧

## 布局规则
```
┌─────────────────────────────────────┐
│  标题区 (to_edge(UP, buff=0.3))    │
├─────────────────────────────────────┤
│  步骤文字 (标题下方 DOWN, buff=0.2) │
├─────────────────────────────────────┤
│                                     │
│  图形区 (ORIGIN)                    │
│  图形必须 scale(0.6) 并居中         │
│                                     │
├─────────────────────────────────────┤
│  答案区 (to_edge(DOWN, buff=0.5))   │
└─────────────────────────────────────┘
```

## 参数
- `{minuend}`: 被减数（总数）
- `{subtrahend}`: 减数（拿走的数量）
- `{difference}`: 差

---

## 完整代码模板

```python
from manim import *

class SolutionScene(Scene):
    def construct(self):
        # ========== 计算 ==========
        minuend = {minuend}
        subtrahend = {subtrahend}
        difference = minuend - subtrahend
        
        # ========== 第1幕：显示题目 ==========
        title = Text(f"小明有{minuend}个苹果，吃了{subtrahend}个，还剩几个？", 
                    font="Microsoft YaHei", font_size=24)
        title.to_edge(UP, buff=0.3)
        self.play(Write(title))
        self.wait(2)
        
        # ========== 第2幕：展示全部 ==========
        step1 = Text(f"一共有 {minuend} 个", font="Microsoft YaHei", font_size=20, color=BLUE)
        step1.next_to(title, DOWN, buff=0.3)
        self.play(Write(step1))
        
        # 创建圆圈表示苹果
        apples = VGroup(*[
            Circle(radius=0.2, color=RED, fill_opacity=0.8)
            for _ in range(minuend)
        ])
        
        # 排列：一行或两行
        if minuend <= 8:
            apples.arrange(RIGHT, buff=0.25)
        else:
            apples.arrange_in_grid(rows=2, buff=0.2)
        
        apples.scale(0.6).move_to(ORIGIN)
        
        # 逐个出现
        self.play(LaggedStart(
            *[GrowFromCenter(a) for a in apples],
            lag_ratio=0.1, run_time=1.5
        ))
        self.wait(1)
        
        # ========== 第3幕：标记并拿走 ==========
        self.play(FadeOut(step1))
        
        step2 = Text(f"吃掉 {subtrahend} 个", font="Microsoft YaHei", font_size=20, color=YELLOW)
        step2.next_to(title, DOWN, buff=0.3)
        self.play(Write(step2))
        
        # 标记要拿走的（前 subtrahend 个）
        to_remove = apples[:subtrahend]
        remaining = apples[subtrahend:]
        
        # 变灰表示要被吃掉
        self.play(to_remove.animate.set_color(GRAY), run_time=0.5)
        self.wait(0.5)
        
        # 拿走动画
        self.play(
            to_remove.animate.shift(UP * 2 + RIGHT * 3).set_opacity(0),
            run_time=1
        )
        self.play(FadeOut(to_remove))
        self.wait(0.5)
        
        # 剩余的重新居中
        self.play(remaining.animate.move_to(ORIGIN), run_time=0.5)
        
        # ========== 第4幕：计数剩余 ==========
        self.play(FadeOut(step2))
        
        step3 = Text(f"还剩 {difference} 个", font="Microsoft YaHei", font_size=20, color=GREEN)
        step3.next_to(title, DOWN, buff=0.3)
        self.play(Write(step3))
        
        # 高亮剩余的
        self.play(remaining.animate.set_color(GREEN), run_time=0.5)
        self.wait(1)
        
        # ========== 第5幕：显示答案 ==========
        self.play(FadeOut(step3), FadeOut(remaining))
        self.wait(0.3)
        
        # 答案框
        answer_box = Rectangle(width=5, height=1.5, color=GREEN, fill_opacity=0.1, stroke_width=2)
        answer_box.move_to(ORIGIN)
        
        answer = VGroup(
            Text(f"{minuend} - {subtrahend} = {difference}", font="Microsoft YaHei", font_size=32, color=GREEN),
            Text(f"答案：{difference} 个", font="Microsoft YaHei", font_size=28, color=YELLOW)
        ).arrange(DOWN, buff=0.3)
        answer.move_to(answer_box.get_center())
        
        self.play(Create(answer_box))
        self.play(Write(answer[0]))
        self.wait(0.5)
        self.play(Write(answer[1]))
        self.wait(3)
```

## 关键设计
1. **文字在图形上方** - `next_to(title, DOWN)` 而不是和图形重叠
2. **图形居中** - `move_to(ORIGIN)` 保证不偏移
3. **分幕清晰** - 每幕清理旧文字再显示新文字
4. **颜色变化** - 红→灰→消失，剩余变绿
