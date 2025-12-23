# Addition Visualization Skill (Enhanced)

## 描述
为小学生可视化加法运算，使用直观的图形和流畅的动画帮助学生理解加法概念。

## 何时使用
- 题目中包含"加"、"+"、"求和"、"一共"等关键词
- 需要展示两个数量合并的过程
- 适用于 1-20 范围内的加法

## 可视化原则
1. **循序渐进** - 一次只展示一个概念，给学生理解时间
2. **数形结合** - 每个圆圈代表1个物品，具体可见
3. **视觉引导** - 用颜色和动画引导学生注意力
4. **平滑过渡** - 使用缓动函数让动画自然流畅

## 颜色编码
- 第一个加数：🔵 BLUE（蓝色）
- 第二个加数：🟢 GREEN（绿色）
- 合并结果：🟡 YELLOW（黄色高亮）
- 最终答案：🟢 GREEN（绿色）

---

## 标准流程

### 步骤1：展示第一个加数（让学生先看到第一组数量）
```python
# 创建第一组圆圈（蓝色代表第一个加数）
group1 = VGroup(*[
    Circle(radius=0.15, color=BLUE, fill_opacity=0.8) 
    for _ in range({num1})
])
group1.arrange(RIGHT, buff=0.2).scale(0.7)
group1.move_to(LEFT * 2.5)

# 数量标签（用大字清晰显示）
label1 = Text("{num1}个", font="Noto Sans CJK SC", font_size=32, color=BLUE)
label1.next_to(group1, UP, buff=0.4)

# 🎬 动画：错开出现，有节奏感
self.play(LaggedStart(
    *[GrowFromCenter(c) for c in group1],
    lag_ratio=0.15,  # 每个间隔15%
    run_time=1.2
), rate_func=ease_out_sine)

self.play(Write(label1), rate_func=smooth)
self.wait(1.5)  # 给学生数数的时间
```

### 步骤2：展示第二个加数（引入加法的第二部分）
```python
# 加号标志（让学生明确这是加法）
plus_sign = Text("+", font_size=48, color=YELLOW)
plus_sign.move_to(ORIGIN)
self.play(Write(plus_sign), rate_func=smooth)
self.wait(0.5)

# 创建第二组圆圈（绿色代表第二个加数）
group2 = VGroup(*[
    Circle(radius=0.15, color=GREEN, fill_opacity=0.8) 
    for _ in range({num2})
])
group2.arrange(RIGHT, buff=0.2).scale(0.7)
group2.move_to(RIGHT * 2.5)

# 数量标签
label2 = Text("{num2}个", font="Noto Sans CJK SC", font_size=32, color=GREEN)
label2.next_to(group2, UP, buff=0.4)

# 🎬 动画：第二组也错开出现
self.play(LaggedStart(
    *[GrowFromCenter(c) for c in group2],
    lag_ratio=0.15,
    run_time=1.2
), rate_func=ease_out_sine)

self.play(Write(label2), rate_func=smooth)
self.wait(1.5)  # 给学生数第二组的时间
```

### 步骤3：合并过程（这是理解加法的核心！）
```python
# 提示语：告诉学生接下来要做什么
hint = Text("把它们合在一起...", font="Noto Sans CJK SC", font_size=28, color=YELLOW)
hint.to_edge(UP, buff=0.8)

self.play(
    FadeOut(label1),
    FadeOut(label2),
    FadeOut(plus_sign),
    Write(hint),
    run_time=1
)
self.wait(1)

# 🎬 核心动画：两组平滑合并到中央
all_circles = VGroup(*group1, *group2)  # 合并成一个组

# 先缩小间距
self.play(
    group1.animate.shift(RIGHT * 1),
    group2.animate.shift(LEFT * 1),
    rate_func=ease_in_out,
    run_time=1
)
self.wait(0.5)

# 再统一排列（让学生看到合并过程）
self.play(
    all_circles.animate.arrange(RIGHT, buff=0.15).move_to(ORIGIN),
    rate_func=smooth,
    run_time=1.5
)
self.wait(1)

# 统一颜色，表示"变成一组了"
self.play(
    all_circles.animate.set_color(BLUE),
    rate_func=smooth,
    run_time=0.8
)
self.wait(0.5)
```

### 步骤4：强调结果（让学生记住答案）
```python
# 更新提示语
new_hint = Text("数一数，一共有多少个？", font="Noto Sans CJK SC", font_size=28, color=YELLOW)
new_hint.to_edge(UP, buff=0.8)
self.play(Transform(hint, new_hint), rate_func=smooth)
self.wait(1)

# 🎬 逐个高亮计数效果（帮助学生跟着数）
for i, circle in enumerate(all_circles):
    # 短暂高亮每个圆
    self.play(
        circle.animate.set_color(YELLOW).scale(1.2),
        run_time=0.15
    )
    self.play(
        circle.animate.set_color(BLUE).scale(1/1.2),
        run_time=0.1
    )

self.wait(1)

# 显示最终答案（大而醒目）
result_box = Rectangle(width=5, height=1.2, color=GREEN, fill_opacity=0.2, stroke_width=3)
result_box.to_edge(DOWN, buff=0.8)

result = Text("{num1} + {num2} = {result}", font="Noto Sans CJK SC", font_size=44, color=GREEN)
result.move_to(result_box.get_center())

self.play(
    Create(result_box),
    Write(result),
    rate_func=smooth,
    run_time=1.5
)

# 🎬 结果闪烁强调
self.play(
    result.animate.scale(1.1),
    rate_func=there_and_back,
    run_time=0.8
)

self.wait(3)  # 让学生记住结果
```

---

## 参数说明
- `{num1}`: 第一个加数（1-10）
- `{num2}`: 第二个加数（1-10）
- `{result}`: 计算结果 = num1 + num2

## 布局要求
- 初始：group1在左侧(-2.5, 0)，group2在右侧(2.5, 0)
- 合并后：居中(ORIGIN)
- 数量标签：在图形上方0.4单位
- 结果：屏幕底部带背景框

## 动画增强说明
| 动画 | 效果 | 教学目的 |
|------|------|---------|
| `GrowFromCenter` | 从中心生长 | 物品"出现"更自然 |
| `LaggedStart` | 错开出现 | 便于学生逐个数数 |
| `ease_out_sine` | 先快后慢 | 物品"落定"的感觉 |
| `ease_in_out` | 缓入缓出 | 平滑自然的移动 |
| `there_and_back` | 放大再缩回 | 强调结果 |

## 注意事项
- ⚠️ 如果 num1 + num2 > 12，使用 `arrange_in_grid(rows=2)` 
- ⚠️ 每步之间保持1-1.5秒等待时间
- ⚠️ 计数动画帮助低年级学生跟着数
- ⚠️ 最终答案要足够大且醒目

## 易于理解的设计
1. **具象化**: 每个圆圈=1个物品，学生可以数
2. **过程可见**: 合并动画让学生看到"加"的过程
3. **节奏适当**: 等待时间让学生消化
4. **颜色区分**: 不同颜色区分不同的组
5. **高亮强调**: 关键步骤使用高亮
