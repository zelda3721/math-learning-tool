# Division Visualization Skill

## 描述
为小学生可视化除法运算，使用平均分组的方式直观展示除法概念。


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
- 题目中包含"除"、"÷"、"平均分"、"分成"等关键词
- 需要展示将物品平均分配的过程
- 适用于整除运算和有余数的除法

## 可视化原则
1. **先展示总数** - 清晰显示被除数
2. **分组过程** - 动态展示分成若干组的过程
3. **结果高亮** - 强调每组的数量（商）
4. **余数处理** - 如有余数，单独标注

## 标准流程

### 步骤1：展示被除数（总数）
```python
# 创建被除数个物品
total = VGroup(*[Circle(radius=0.12, color=BLUE, fill_opacity=0.8) for _ in range({dividend})])
total.arrange_in_grid(rows=2, buff=0.12)
total.scale(0.7).move_to(UP * 0.5)

# 显示标题
title = Text("一共有{dividend}个", font="Noto Sans CJK SC", font_size=28)
title.to_edge(UP, buff=0.8)

self.play(Write(title))
self.play(LaggedStart(*[FadeIn(item) for item in total], lag_ratio=0.05))
self.wait(1.5)
```

### 步骤2：展示分组过程
```python
# 更新标题
title2 = Text("平均分成{divisor}组", font="Noto Sans CJK SC", font_size=28, color=YELLOW)
title2.to_edge(UP, buff=0.8)
self.play(Transform(title, title2))
self.wait(0.5)

# 计算每组数量
per_group = {dividend} // {divisor}
groups = VGroup()

# 将物品分组
for i in range({divisor}):
    group = VGroup(*[total[i * per_group + j] for j in range(per_group)])
    group.set_color([RED, GREEN, YELLOW, PURPLE, ORANGE][i % 5])
    groups.add(group)

# 分开各组
self.play(groups.animate.arrange(RIGHT, buff=0.8).move_to(ORIGIN))
self.wait(1)
```

### 步骤3：显示结果
```python
# 高亮一组展示商
highlight_box = SurroundingRectangle(groups[0], color=GREEN, buff=0.1)
self.play(Create(highlight_box))

# 显示结果
result = Text("{dividend} ÷ {divisor} = {quotient}", font="Noto Sans CJK SC", font_size=40, color=GREEN)
result.to_edge(DOWN, buff=1.0)
self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{dividend}`: 被除数（总数）
- `{divisor}`: 除数（分成几组）
- `{quotient}`: 商（每组多少个）

## 布局要求
- 初始：物品居中偏上
- 分组后：各组水平排列居中
- 结果：屏幕底部
- 所有组合scale(0.7)

## 注意事项
- ⚠️ 如果 dividend > 20，使用更小的圆圈和更多行
- ⚠️ 确保分组后不会超出屏幕宽度
- ⚠️ 有余数时，余数元素用灰色单独放置

## 示例
输入：12 ÷ 3 = 4
输出：12个蓝色圆圈 → 分成3组 → 每组4个（不同颜色）
