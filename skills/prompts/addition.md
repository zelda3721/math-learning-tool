# Addition Visualization Skill

## 描述
为小学生可视化加法运算，使用直观的图形并排展示。

## 何时使用
- 题目中包含"加"、"+"、"求和"等关键词
- 需要展示两个数量合并的过程
- 适用于 1-20 范围内的加法

## 可视化原则
1. **并列展示** - 两组元素分别放在左右两侧
2. **不同颜色** - 用颜色区分两个加数
3. **动画合并** - 通过动画展示合并过程
4. **保持元素** - 不要清空，让学生看到总数

## 标准流程

### 步骤1：展示第一个加数
```python
# 创建第一组圆圈（蓝色）
group1 = VGroup(*[Circle(radius=0.15, color=BLUE, fill_opacity=0.8) for _ in range({num1})])
group1.arrange(RIGHT, buff=0.2).scale(0.7)
group1.move_to([-2.5, 0, 0])

# 添加标签
label1 = Text("{num1}个", font="Noto Sans CJK SC", font_size=28)
label1.next_to(group1, UP, buff=0.5)

self.play(LaggedStart(*[FadeIn(c) for c in group1], lag_ratio=0.1))
self.play(Write(label1))
self.wait(1)
```

### 步骤2：展示第二个加数
```python
# 创建第二组圆圈（红色）
group2 = VGroup(*[Circle(radius=0.15, color=RED, fill_opacity=0.8) for _ in range({num2})])
group2.arrange(RIGHT, buff=0.2).scale(0.7)
group2.move_to([2.5, 0, 0])

# 添加标签
label2 = Text("{num2}个", font="Noto Sans CJK SC", font_size=28)
label2.next_to(group2, UP, buff=0.5)

self.play(LaggedStart(*[FadeIn(c) for c in group2], lag_ratio=0.1))
self.play(Write(label2))
self.wait(1)
```

### 步骤3：合并展示总数
```python
# 移动标签到顶部
step_label = Text("把它们合在一起", font="Noto Sans CJK SC", font_size=32)
step_label.to_edge(UP, buff=1.0)
self.play(
    FadeOut(label1),
    FadeOut(label2),
    Write(step_label)
)

# 将两组合并到中心
all_circles = VGroup(group1, group2)
self.play(all_circles.animate.arrange(RIGHT, buff=0.2).move_to(ORIGIN))
self.wait(1)

# 统一颜色表示合并
self.play(all_circles.animate.set_color(GREEN))
self.wait(0.5)

# 显示结果
result = Text("{num1} + {num2} = {result}", font="Noto Sans CJK SC", font_size=40, color=GREEN)
result.to_edge(DOWN, buff=1.0)
self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{num1}`: 第一个加数（1-10）
- `{num2}`: 第二个加数（1-10）
- `{result}`: 计算结果 = num1 + num2

## 布局要求
- 初始位置：group1在左侧(-2.5, 0)，group2在右侧(2.5, 0)
- 合并后：居中(ORIGIN)
- 标签：在图形上方0.5单位
- 结果：屏幕底部(DOWN, buff=1.0)

## 注意事项
- ⚠️ 如果 num1 + num2 > 15，使用网格排列而非单行
- ⚠️ 确保所有元素 scale(0.7) 避免超出边界
- ⚠️ 使用 LaggedStart 让圆圈逐个出现，更生动

## 示例
输入：5 + 3
输出：5个蓝色圆圈 + 3个红色圆圈 → 8个绿色圆圈
