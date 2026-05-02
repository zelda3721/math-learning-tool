# Bar Model Pattern (线段图 / 条形模型)

## 描述
新加坡数学法/国内小学经典手法。用矩形条的**长度比**直观展示数量关系，是和差倍、行程、分数应用题的杀手锏。

## 适用场景
- 和差问题（甲乙共 50，甲比乙多 10）
- 倍数问题（甲是乙的 3 倍）
- 行程问题（甲乙相遇 / 追及）
- 分数应用题（一筐苹果，吃了 1/3 还剩 20 个）
- 比例题（A:B:C = 2:3:5）
- 工程问题（甲单独做 X 天，乙单独做 Y 天）

## 关键词
和, 差, 倍, 共, 比, 多, 少, 相差, 还剩, 一共, 已经

## ⚠️ 视觉契约
- 主视觉是**水平排列的彩色 Rectangle**，长度严格按数量比
- 每条带必须有**起止刻度** + Brace 标"已知/未知"
- 不允许"全部用 Text 表达数量关系"——必须画出条形
- 同类对象用**相同颜色**，未知量用问号 + 半透明色

## 核心代码

```python
def bar(value: float, *, unit_width=0.5, color=BLUE, height=0.5, label=None, label_pos=DOWN):
    """造一条长度 = value × unit_width 的横条。返回 VGroup(rect, label_text)."""
    w = max(0.05, value * unit_width)
    rect = Rectangle(width=w, height=height, color=color, fill_opacity=0.7, stroke_width=2)
    parts = [rect]
    if label is not None:
        t = Text(str(label), font="Microsoft YaHei", font_size=18, color=WHITE)
        t.next_to(rect, label_pos, buff=0.1)
        parts.append(t)
    return VGroup(*parts)


def stack_bars(bars: list, buff=0.3):
    """上下堆叠多条 bar，左对齐。"""
    g = VGroup(*bars).arrange(DOWN, buff=buff, aligned_edge=LEFT)
    return g


def annotate_brace(scene, target, text, *, direction=DOWN, color=YELLOW):
    """对一段或一组 bar 加大括号 + 文字标注。"""
    brace = Brace(target, direction=direction, color=color)
    label = Text(str(text), font="Microsoft YaHei", font_size=18, color=color)
    label.next_to(brace, direction, buff=0.1)
    scene.play(GrowFromCenter(brace), Write(label))
    scene.wait(0.5)
    return VGroup(brace, label)
```

## 使用示例 — 和差问题：甲乙共 50，甲比乙多 10，求甲乙各几

```python
title = Text("甲乙共 50，甲比乙多 10，求甲乙各多少？", font="Microsoft YaHei", font_size=22).to_edge(UP, buff=0.3)
self.play(Write(title))
self.wait(1)

# 阶段 1: 画两条 bar — 乙的长度未知设 x，甲 = 乙 + 10
yi  = bar(20, color=BLUE, label="乙")     # 假设乙=20（演示）
jia = bar(30, color=ORANGE, label="甲")    # 甲=30，比乙多 10

bars = stack_bars([jia, yi])
self.play(Create(bars))
self.wait(1)

# 阶段 2: 标注"多 10"
diff_part = jia[0]  # 整条甲
# 露出"多出"的那 10 段：甲条比乙条多出来的部分（右侧）
overflow = Rectangle(
    width=10*0.5, height=0.5, color=RED, fill_opacity=0.5
).align_to(jia[0], LEFT).shift(RIGHT * yi[0].get_width()).align_to(jia[0], DOWN)
overflow.move_to(jia[0].get_center() + RIGHT * (yi[0].get_width()/2))
annotate_brace(self, overflow, "多 10", direction=UP, color=RED)
self.wait(1)

# 阶段 3: 标"共 50"
all_bars = VGroup(jia, yi)
annotate_brace(self, all_bars, "共 50", direction=LEFT, color=GREEN)
self.wait(2)

# 阶段 4: 推理 — 把"多出来的 10"砍掉，剩下相等两份 = 40，每份 20
strike = Cross(overflow, color=GRAY, stroke_width=4)
self.play(Create(strike))
explain = Text("减掉多出的 10：50 − 10 = 40，平分得 20", font="Microsoft YaHei", font_size=18).to_edge(DOWN, buff=0.5)
self.play(Write(explain))
self.wait(2)

# 阶段 5: 答案
answer = Text("乙 = 20，甲 = 30", font="Microsoft YaHei", font_size=26, color=GREEN).to_edge(DOWN, buff=0.5)
self.play(Transform(explain, answer))
self.wait(3)
```

## 关键原则
1. **长度严格按数量比例**——长度即真理
2. 多条 bar **左对齐**，"差异"才会一眼看出来
3. 用 **Brace + 数字** 标注已知/未知，比文字解释直观 10 倍
4. "假设法"/"消去法"用动画展示——把"多出来的"用 Cross 划掉，再平分
