# Animation Enhancement Guidelines (动画增强指南)

## 描述
这是一个系统级技能，定义了高质量Manim动画的最佳实践和易于学生理解的可视化原则。


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
- 所有生成Manim代码时自动应用
- 作为其他技能的基础动画规范

---

## ⚠️ 强制执行规则（MANDATORY - 违反任何一条即为失败）

### 规则1：禁止元素重叠
```python
# ❌ 失败：手动坐标容易重叠
circle.move_to([0, 0, 0])
text.move_to([0.1, 0, 0])  # 会重叠！

# ✅ 必须：使用自动布局
group = VGroup(circle, text).arrange(DOWN, buff=0.3)
group.scale(0.6).move_to(ORIGIN)  # 缩放防溢出
```

### 规则2：禁止一次性呈现多个元素
```python
# ❌ 失败：所有元素同时出现
self.play(FadeIn(a), FadeIn(b), FadeIn(c))

# ✅ 必须：逐个错开出现
self.play(LaggedStart(
    *[FadeIn(item, shift=UP*0.1) for item in [a, b, c]],
    lag_ratio=0.15
))
```

### 规则3：必须有渐进变换过程
```python
# ❌ 失败：直接显示结果
self.play(FadeIn(result))

# ✅ 必须：展示变化过程
for i in range(change_count):
    self.play(item[i].animate.set_color(NEW_COLOR), run_time=0.2)
    self.play(GrowFromCenter(new_part), run_time=0.3)
```

### 规则4：必须有充足等待时间
```python
# ❌ 失败：连续播放无等待
self.play(Write(step1))
self.play(Write(step2))

# ✅ 必须：给理解时间
self.play(Write(step1))
self.wait(1.5)  # 步骤等待
self.play(Write(step2))
self.wait(1.5)

# 等待时间标准：
# - 题目展示后: self.wait(2)
# - 每个步骤后: self.wait(1.5) 
# - 最终答案后: self.wait(3)
```

### 规则5：必须使用VGroup组织元素
```python
# ❌ 失败：散落的元素难以管理
circle1 = Circle()
circle2 = Circle()
self.play(FadeIn(circle1), FadeIn(circle2))

# ✅ 必须：用VGroup统一管理
circles = VGroup(*[Circle() for _ in range(n)])
circles.arrange_in_grid(rows=3, buff=0.2)
circles.scale(0.5)  # 统一缩放
self.play(LaggedStart(*[FadeIn(c) for c in circles]))
```

### 规则6：场景切换必须清理旧元素
```python
# ❌ 失败：旧元素遮挡新内容
self.play(FadeIn(new_group))  # 旧的还在！

# ✅ 必须：先清理再显示
self.play(FadeOut(old_group))
self.wait(0.3)
self.play(FadeIn(new_group))
```

---

## 📐 通用屏幕布局（Universal Screen Layout）

**所有可视化必须遵循此布局，确保文字与图形不重叠：**

```
┌─────────────────────────────────────────────────┐
│  🏷️ 标题区 (y ≈ 3.2)                            │
│     title.to_edge(UP, buff=0.3)                 │
├─────────────────────────────────────────────────┤
│  📝 步骤文字区 (y ≈ 2.5)                         │
│     step_text.next_to(title, DOWN, buff=0.2)    │
├─────────────────────────────────────────────────┤
│                                                 │
│  🔵 图形区 (y ∈ [-1.5, 1.5])                    │
│     graphics.move_to(ORIGIN)                    │
│     graphics.scale(0.5~0.7)                     │
│                                                 │
├─────────────────────────────────────────────────┤
│  ✅ 答案/计数器区 (y ≈ -2.5)                     │
│     answer.to_edge(DOWN, buff=0.5)              │
└─────────────────────────────────────────────────┘
```

### 规则：
1. **文字永远在图形上方或下方** - 不得在同一Y坐标
2. **步骤文字跟随标题** - 使用 `next_to(title, DOWN)`
3. **图形居中并缩放** - `scale(0.5~0.7).move_to(ORIGIN)`
4. **答案在底部** - `to_edge(DOWN, buff=0.5)`

### 代码模板：
```python
# 标题区
title = Text("题目", font="Microsoft YaHei", font_size=28)
title.to_edge(UP, buff=0.3)

# 步骤文字区
step = Text("第一步：...", font="Microsoft YaHei", font_size=20)
step.next_to(title, DOWN, buff=0.2)

# 图形区
graphics = VGroup(...)
graphics.scale(0.6).move_to(ORIGIN)

# 答案区
answer = Text("答案：...", font="Microsoft YaHei", font_size=24)
answer.to_edge(DOWN, buff=0.5)
```

---

## 一、动画流畅性原则

### 1.1 缓动函数（rate_func）
**永远不要使用线性动画！** 使用缓动函数让动画更自然。

```python
from manim import *

# ❌ 错误：生硬的线性动画
self.play(Write(text))

# ✅ 正确：平滑的缓动动画
self.play(Write(text), rate_func=smooth)

# 常用缓动函数：
# - smooth: 默认平滑（适合大多数场景）
# - ease_in_out: 缓入缓出
# - ease_in_sine: 缓入（适合物体到达）
# - ease_out_sine: 缓出（适合物体离开）
# - there_and_back: 往返效果
# - rush_into: 急速进入
# - rush_from: 急速离开
```

### 1.2 动画时长（run_time）
根据内容复杂度调整：

```python
# 简单元素出现：0.5-1秒
self.play(FadeIn(dot), run_time=0.5)

# 普通变换：1-1.5秒
self.play(Transform(shape1, shape2), run_time=1.2)

# 复杂过程展示：2-3秒
self.play(MoveAlongPath(obj, path), run_time=2.5)

# 重要结论出现：1.5-2秒（给学生反应时间）
self.play(Write(result), run_time=1.8, rate_func=smooth)
```

### 1.3 错开动画（LaggedStart）
让多个元素有节奏地出现：

```python
# ❌ 错误：所有元素同时出现（混乱）
self.play(*[FadeIn(item) for item in items])

# ✅ 正确：错开出现（有层次感）
self.play(LaggedStart(
    *[FadeIn(item, shift=UP * 0.2) for item in items],
    lag_ratio=0.15,  # 每个元素间隔15%的时间
    run_time=1.5
))

# 错开比例建议：
# - 3-5个元素：lag_ratio=0.2
# - 6-10个元素：lag_ratio=0.1
# - 10+个元素：lag_ratio=0.05
```

### 1.4 等待时间（wait）
给学生理解时间：

```python
# 题目展示后：等待2秒让学生读题
self.play(Write(problem))
self.wait(2)

# 步骤之间：等待1-1.5秒
self.play(Write(step1))
self.wait(1.5)

# 重要结论：等待3秒
self.play(Write(answer))
self.wait(3)

# 场景切换前：短暂等待0.5秒
self.wait(0.5)
```

---

## 二、易于学生理解的原则

### 2.1 循序渐进
**一次只展示一个概念！**

```python
# ❌ 错误：一次性展示所有内容
self.play(
    Write(title), Write(step1), Write(step2), 
    Create(circle), Create(arrow)
)

# ✅ 正确：逐步展示
self.play(Write(title))
self.wait(1)

self.play(Write(step1))
self.wait(1.5)

self.play(Create(circle))
self.wait(1)

self.play(Write(step2))
self.wait(1.5)
```

### 2.2 视觉焦点
引导学生注意力：

```python
# 高亮当前重点
highlight = SurroundingRectangle(current_step, color=YELLOW, buff=0.1)
self.play(Create(highlight))
self.wait(1)

# 淡化非重点内容
self.play(others.animate.set_opacity(0.3))

# 使用指示箭头
arrow = Arrow(start=LEFT, end=item.get_left(), color=YELLOW)
self.play(GrowArrow(arrow))

# 放大重要内容
self.play(important.animate.scale(1.3))
self.wait(1)
self.play(important.animate.scale(1/1.3))
```

### 2.3 颜色编码
用颜色区分不同含义：

```python
# 颜色约定：
QUESTION_COLOR = YELLOW    # 问题/题目
STEP_COLOR = WHITE         # 步骤说明
NUMBER_COLOR = BLUE        # 数字
RESULT_COLOR = GREEN       # 结果/答案
ERROR_COLOR = RED          # 错误/减少
ADD_COLOR = GREEN          # 增加/正确
HIGHLIGHT_COLOR = YELLOW   # 高亮

# 示例
problem = Text("题目", color=QUESTION_COLOR)
number = Text("5", color=NUMBER_COLOR)
answer = Text("答案：8", color=RESULT_COLOR)
```

### 2.4 空间组织
清晰的布局让信息易于理解：

```python
# 三区布局
TOP_ZONE = UP * 2.5      # 题目区
CENTER_ZONE = ORIGIN      # 主要内容区
BOTTOM_ZONE = DOWN * 2.5  # 结果区

# 题目放顶部
problem.to_edge(UP, buff=0.5)

# 主要演示在中间
visualization.move_to(ORIGIN)

# 答案放底部
answer.to_edge(DOWN, buff=0.5)
```

### 2.5 图形对应数量
数形结合的核心：

```python
# 每个圆圈代表1个物品
items = VGroup(*[
    Circle(radius=0.15, color=BLUE, fill_opacity=0.8)
    for _ in range(count)
])

# 规整排列
items.arrange_in_grid(rows=2, buff=0.2)
items.scale(0.7)  # 确保不超出边界

# 数量标注
label = Text(f"{count}个", font="Noto Sans CJK SC", font_size=20)
label.next_to(items, DOWN, buff=0.3)
```

---

## 三、增强的动画模板

### 3.1 数量变化动画（加法）
```python
# 创建第一组
group1 = VGroup(*[Circle(radius=0.12, color=BLUE, fill_opacity=0.8) for _ in range(num1)])
group1.arrange(RIGHT, buff=0.15).scale(0.65)
group1.move_to(LEFT * 2)

# 逐个出现（有节奏）
self.play(LaggedStart(
    *[GrowFromCenter(item) for item in group1],
    lag_ratio=0.1,
    run_time=1
))
self.wait(1)

# 添加第二组并合并
group2 = VGroup(*[Circle(radius=0.12, color=GREEN, fill_opacity=0.8) for _ in range(num2)])
group2.arrange(RIGHT, buff=0.15).scale(0.65)
group2.move_to(RIGHT * 2)

self.play(LaggedStart(
    *[GrowFromCenter(item) for item in group2],
    lag_ratio=0.1,
    run_time=1
))
self.wait(1)

# 平滑合并（使用ease_in_out）
all_items = VGroup(group1, group2)
self.play(
    all_items.animate.arrange(RIGHT, buff=0.1).move_to(ORIGIN),
    rate_func=ease_in_out,
    run_time=1.5
)
```

### 3.2 数量变化动画（减法）
```python
# 高亮要移除的元素
remove_count = 3
remove_items = items[:remove_count]

# 先变色标记
self.play(
    remove_items.animate.set_color(RED),
    rate_func=there_and_back_with_pause,
    run_time=0.8
)
self.wait(0.5)

# 向边缘移出
self.play(
    remove_items.animate.shift(RIGHT * 4).set_opacity(0.3),
    rate_func=ease_out_sine,
    run_time=1
)

# 淡出
self.play(FadeOut(remove_items), run_time=0.5)

# 剩余元素重新排列
remaining = items[remove_count:]
self.play(
    remaining.animate.arrange(RIGHT, buff=0.15).move_to(ORIGIN),
    rate_func=smooth,
    run_time=1
)
```

### 3.3 比较动画
```python
# 并排展示两组
group1.move_to(UP * 1)
group2.move_to(DOWN * 1)
group2.align_to(group1, LEFT)  # 左对齐便于比较

# 逐行出现
self.play(LaggedStart(*[FadeIn(item) for item in group1], lag_ratio=0.1))
self.wait(0.5)
self.play(LaggedStart(*[FadeIn(item) for item in group2], lag_ratio=0.1))
self.wait(1)

# 用虚线对齐比较
for i in range(min(len(group1), len(group2))):
    line = DashedLine(group1[i].get_bottom(), group2[i].get_top(), color=GRAY)
    self.play(Create(line), run_time=0.1)

# 高亮多出的部分
diff = abs(len(group1) - len(group2))
if len(group1) > len(group2):
    excess = group1[-diff:]
else:
    excess = group2[-diff:]

self.play(
    excess.animate.set_color(YELLOW).scale(1.2),
    rate_func=there_and_back,
    run_time=1
)
```

---

## 五、官方最佳实践补充 (Advanced Best Practices)

### 5.1 智能防遮挡布局 (Smart Layout)
使用 `VGroup` 和 `arrange` 自动管理间距，避免手动计算坐标导致的遮挡。

```python
# ❌ 错误：手动计算坐标，容易重叠
circle.move_to([-2, 0, 0])
square.move_to([0, 0, 0])  # 如果circle太大，会撞上

# ✅ 正确：自动排列
shapes = VGroup(circle, square, triangle)
shapes.arrange(RIGHT, buff=1.0)  # 自动保持1.0的间距
shapes.move_to(ORIGIN)
```

### 5.2 相对定位与缓冲 (Relative Positioning)
使用 `next_to` 和 `buff` 确保元素不贴在一起。

```python
# 文字紧跟图形下方
label.next_to(shape, DOWN, buff=0.5)

# 结果紧跟等号右侧
result.next_to(equals_sign, RIGHT, buff=0.3)
```

### 5.3 无缝场景切换 (Seamless Transitions)
使用 `ReplacementTransform` 实现流体般的变形，而不是生硬的 FadeOut -> FadeIn。

```python
# ❌ 生硬切换
self.play(FadeOut(step1_group))
self.play(FadeIn(step2_group))

# ✅ 流畅切换：旧元素变形为新元素
self.play(ReplacementTransform(step1_group, step2_group))
```

### 5.4 动态高亮框 (Dynamic Highlighting)
使用 `SurroundingRectangle` 聚焦重点，且不遮挡内容。

```python
# 创建对焦框
box = SurroundingRectangle(target_object, color=YELLOW, buff=0.2)
self.play(Create(box))
self.wait()
# 框移动到下一个目标
new_box = SurroundingRectangle(next_object, color=YELLOW, buff=0.2)
self.play(Transform(box, new_box))
```
