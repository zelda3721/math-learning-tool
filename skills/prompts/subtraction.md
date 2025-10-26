# Subtraction Visualization Skill

## 描述
为小学生可视化减法运算，使用"重叠表达法"直观展示减去的过程。

## 何时使用
- 题目中包含"减"、"-"、"拿走"、"剩余"等关键词
- 需要展示从总数中移除部分的过程
- 适用于 1-20 范围内的减法

## 核心理念：重叠表达法
**不要分别显示被减数和减数，而是：**
1. 先显示总数（被减数）
2. 标记要减去的部分（变色高亮）
3. 移除标记的部分
4. 显示剩余部分

这样学生能直观看到"从10个中拿走3个，剩7个"的过程。

## 标准流程

### 步骤1：展示总数
```python
# 创建总数的方块（蓝色）
total = VGroup(*[Square(side_length=0.3, color=BLUE, fill_opacity=0.8) for _ in range({minuend})])

# 根据总数选择排列方式
if {minuend} <= 10:
    total.arrange(RIGHT, buff=0.15)
else:
    total.arrange_in_grid(rows=2, cols=({minuend}+1)//2, buff=0.15)

total.scale(0.7).move_to(ORIGIN)

# 标题
title = Text("一共有{minuend}个", font="Noto Sans CJK SC", font_size=32)
title.to_edge(UP, buff=1.0)

self.play(Write(title))
self.play(LaggedStart(*[FadeIn(s) for s in total], lag_ratio=0.05))
self.wait(1.5)
```

### 步骤2：标记要减去的部分
```python
# 更新标题
new_title = Text("拿走{subtrahend}个", font="Noto Sans CJK SC", font_size=32, color=RED)
new_title.to_edge(UP, buff=1.0)
self.play(Transform(title, new_title))

# 将前{subtrahend}个变成红色（标记要拿走的）
self.play(
    *[total[i].animate.set_color(RED) for i in range({subtrahend})]
)
self.play(
    *[Indicate(total[i]) for i in range({subtrahend})]  # 高亮提示
)
self.wait(1)
```

### 步骤3：移除并显示剩余
```python
# 移除红色的部分
to_remove = total[0:{subtrahend}]
self.play(FadeOut(to_remove))
self.wait(0.5)

# 剩余部分高亮为绿色
remaining = total[{subtrahend}:]
self.play(remaining.animate.set_color(GREEN))
self.wait(0.5)

# 显示结果
result = Text("{minuend} - {subtrahend} = {result}", font="Noto Sans CJK SC", font_size=40, color=GREEN)
result.to_edge(DOWN, buff=1.0)
self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{minuend}`: 被减数（总数，1-20）
- `{subtrahend}`: 减数（要拿走的数量，< minuend）
- `{result}`: 计算结果 = minuend - subtrahend

## 布局要求
- 总数位置：屏幕中心(ORIGIN)
- 排列方式：≤10用单行，>10用2行网格
- 标题：屏幕顶部(UP, buff=1.0)
- 结果：屏幕底部(DOWN, buff=1.0)
- 缩放：所有图形 scale(0.7)

## 颜色方案
1. **初始状态**：蓝色（BLUE）- 表示总数
2. **标记状态**：红色（RED）- 表示要减去的
3. **最终状态**：绿色（GREEN）- 表示剩余的

## 为什么用"重叠表达法"？

### ❌ 错误方式（不直观）
```
显示10个  +  显示3个  →  做减法  →  显示7个
（学生：？为什么要加一个3？）
```

### ✅ 正确方式（重叠表达）
```
显示10个  →  标记其中3个  →  拿走3个  →  剩7个
（学生：啊！从10个中拿走3个，剩7个！）
```

## 注意事项
- ⚠️ 必须用索引标记要移除的元素：`total[0:subtrahend]`
- ⚠️ 使用 Transform 更新标题，不要 FadeOut + Write
- ⚠️ 用 Indicate 动画高亮要拿走的部分
- ⚠️ 确保被减数 > 减数（避免负数）

## 示例
输入：10 - 3
流程：
1. 显示10个蓝色方块
2. 前3个变红色并高亮
3. 移除3个红色方块
4. 剩余7个变绿色
5. 显示"10 - 3 = 7"
