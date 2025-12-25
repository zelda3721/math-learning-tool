# Subtraction Visualization Skill (Enhanced)

## 描述
为小学生可视化减法运算，通过"拿走"动画帮助学生直观理解减法概念。

## 何时使用
- 题目中包含"减"、"-"、"拿走"、"吃掉"、"剩下"等关键词
- 需要展示从总数中移除一部分的过程
- 适用于 1-20 范围内的减法

## 可视化原则
1. **先展示全部** - 让学生先看到完整的数量
2. **标记移除** - 明确标出要"拿走"的部分
3. **动画移出** - 让学生看到东西真的"走了"
4. **强调剩余** - 高亮剩下的数量

## 颜色编码
- 初始总数：🔵 BLUE（蓝色）
- 被减数标记：🔴 RED（红色）- 即将被拿走
- 剩余部分：🟢 GREEN（绿色）
- 最终答案：🟢 GREEN（绿色）

---

## 标准流程

### 步骤1：展示被减数（总数）
```python
# 创建总数的圆圈（蓝色）
total_items = VGroup(*[
    Circle(radius=0.15, color=BLUE, fill_opacity=0.8) 
    for _ in range({minuend})
])
total_items.arrange(RIGHT, buff=0.2).scale(0.7)
total_items.move_to(ORIGIN)

# 总数标签
label = Text("一共有{minuend}个", font="Microsoft YaHei", font_size=32, color=BLUE)
label.next_to(total_items, UP, buff=0.5)

# 🎬 动画：错开出现，让学生能数
self.play(LaggedStart(
    *[GrowFromCenter(item) for item in total_items],
    lag_ratio=0.12,
    run_time=1.5
))

self.play(Write(label), rate_func=smooth)
self.wait(2)  # 给学生数数的时间
```

### 步骤2：标记要"拿走"的部分（帮助学生理解减法含义）
```python
# 提示语
hint = Text("拿走{subtrahend}个...", font="Microsoft YaHei", font_size=28, color=YELLOW)
hint.to_edge(UP, buff=0.5)
self.play(Transform(label, hint), rate_func=smooth)
self.wait(1)

# 标记要移除的部分（前subtrahend个）
remove_items = total_items[:{subtrahend}]
remain_items = total_items[{subtrahend}:]

# 🎬 先变成红色（标记它们）
self.play(
    remove_items.animate.set_color(RED),
    rate_func=smooth,
    run_time=0.8
)
self.wait(0.5)

# 🎬 闪烁强调这些是要拿走的
self.play(
    *[Indicate(item, color=RED, scale_factor=1.2) for item in remove_items],
    run_time=1
)
self.wait(1)
```

### 步骤3："拿走"动画（核心理解步骤）
```python
# 🎬 向右上方移出屏幕（模拟被拿走）
self.play(
    remove_items.animate.shift(RIGHT * 4 + UP * 1).set_opacity(0.3),
    run_time=1.2
)

self.play(FadeOut(remove_items), rate_func=smooth, run_time=0.5)
self.wait(1)

# 剩余部分重新居中排列
self.play(
    remain_items.animate.arrange(RIGHT, buff=0.2).move_to(ORIGIN),
    rate_func=smooth,
    run_time=1
)
self.wait(0.5)

# 🎬 高亮剩余部分（变成绿色）
self.play(
    remain_items.animate.set_color(GREEN),
    rate_func=smooth,
    run_time=0.8
)
self.wait(1)
```

### 步骤4：展示结果（强化记忆）
```python
# 更新提示
result_hint = Text("还剩多少个？", font="Microsoft YaHei", font_size=28, color=YELLOW)
result_hint.to_edge(UP, buff=0.5)
self.play(Transform(hint, result_hint), rate_func=smooth)
self.wait(1)

# 🎬 逐个高亮计数剩余的
for i, item in enumerate(remain_items):
    self.play(
        item.animate.scale(1.3),
        run_time=0.12
    )
    self.play(
        item.animate.scale(1/1.3),
        run_time=0.08
    )

self.wait(0.5)

# 显示最终答案
result_box = Rectangle(width=5, height=1.2, color=GREEN, fill_opacity=0.2, stroke_width=3)
result_box.to_edge(DOWN, buff=0.8)

result = Text("{minuend} - {subtrahend} = {difference}", font="Microsoft YaHei", font_size=44, color=GREEN)
result.move_to(result_box.get_center())

self.play(
    Create(result_box),
    Write(result),
    rate_func=smooth,
    run_time=1.5
)

# 🎬 强调结果
self.play(Circumscribe(result, color=YELLOW, run_time=1))
self.wait(3)
```

---

## 参数说明
- `{minuend}`: 被减数（总数，1-15）
- `{subtrahend}`: 减数（拿走的数量）
- `{difference}`: 差 = minuend - subtrahend

## 动画增强说明
| 动画 | 效果 | 教学目的 |
|------|------|---------|
| `set_color(RED)` | 变红标记 | 明确哪些要被拿走 |
| `Indicate` | 闪烁高亮 | 吸引注意力 |
| `ease_in_sine` | 加速离开 | 模拟"拿走"动作 |
| `Circumscribe` | 圈出强调 | 突出最终答案 |

## 易于理解的设计
1. **具象拿走**: 动画模拟真实的"拿走"动作
2. **颜色编码**: 红色=要拿走，绿色=剩下的
3. **计数强化**: 对剩余部分逐个高亮帮助计数
4. **过程完整**: 标记→移出→重排→结果

## 注意事项
- ⚠️ 被拿走的物品向右上方移出更自然
- ⚠️ 移出后要重新居中排列剩余项
- ⚠️ 如果数量大，使用网格排列
