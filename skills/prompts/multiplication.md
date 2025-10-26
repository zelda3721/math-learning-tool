# Multiplication Visualization Skill

## 描述
为小学生可视化乘法运算，使用"倍数关系"直观展示"几个几"的概念。

## 何时使用
- 题目中包含"乘"、"×"、"倍"、"几个几"等关键词
- 需要展示重复累加的概念
- 适用于 1-10 范围内的乘法

## 核心理念：倍数关系
**3 × 4 不是"3乘以4"，而是"3个4"：**
- 创建3组
- 每组有4个元素
- 逐组展示，强化"重复"的概念
- 最后合并显示总数

## 标准流程

### 步骤1：说明乘法含义
```python
# 标题说明
title = Text("{multiplier} × {multiplicand} = {multiplier}个{multiplicand}",
             font="Noto Sans CJK SC", font_size=32)
title.to_edge(UP, buff=1.0)
self.play(Write(title))
self.wait(1.5)
```

### 步骤2：逐组展示
```python
# 创建{multiplier}组，每组{multiplicand}个圆圈
groups = VGroup()

for i in range({multiplier}):
    # 创建一组
    group = VGroup(*[Circle(radius=0.12, color=BLUE, fill_opacity=0.8)
                     for _ in range({multiplicand})])
    group.arrange(RIGHT, buff=0.1)

    # 添加组标签
    label = Text(f"第{i+1}组", font="Noto Sans CJK SC", font_size=20)
    label.next_to(group, LEFT, buff=0.3)

    group_with_label = VGroup(group, label)
    groups.add(group_with_label)

# 垂直排列所有组
groups.arrange(DOWN, buff=0.4).scale(0.65).move_to(ORIGIN)

# 逐组展示（强调"重复"）
for i, group_with_label in enumerate(groups):
    self.play(LaggedStart(*[FadeIn(obj) for obj in group_with_label], lag_ratio=0.1))
    self.wait(0.5)

self.wait(1)
```

### 步骤3：合并并计数
```python
# 移除组标签
labels_to_remove = VGroup(*[g[1] for g in groups])
self.play(FadeOut(labels_to_remove))

# 提取所有圆圈
all_circles = VGroup(*[circle for g in groups for circle in g[0]])

# 重新排列成网格（视觉上更紧凑）
cols = min({multiplicand}, 5)
rows = ({multiplier} * {multiplicand} + cols - 1) // cols
self.play(
    all_circles.animate.arrange_in_grid(rows=rows, cols=cols, buff=0.1).move_to(ORIGIN)
)

# 统一颜色
self.play(all_circles.animate.set_color(GREEN))
self.wait(0.5)

# 显示结果
result = Text("{multiplier} × {multiplicand} = {result}",
              font="Noto Sans CJK SC", font_size=40, color=GREEN)
result.to_edge(DOWN, buff=1.0)
self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{multiplier}`: 乘数（有几组，1-10）
- `{multiplicand}`: 被乘数（每组有几个，1-10）
- `{result}`: 计算结果 = multiplier × multiplicand

## 布局要求
- 初始排列：垂直排列各组，每组水平排列
- 最终排列：网格排列所有元素
- 标题：屏幕顶部(UP, buff=1.0)
- 结果：屏幕底部(DOWN, buff=1.0)
- 缩放：整体 scale(0.65) 确保不超出边界

## 颜色方案
1. **初始状态**：蓝色（BLUE）- 表示各组
2. **合并后**：绿色（GREEN）- 表示总数

## 为什么强调"几个几"？

### 小学数学教学原则
乘法的本质是**重复累加**：
- 3 × 4 = 4 + 4 + 4（3个4相加）
- 不是抽象的"3和4相乘"

### 可视化策略
1. **分组展示** - 让学生看到"3组"
2. **逐组出现** - 强化"重复"的概念
3. **每组相同** - 理解"每组都是4个"
4. **最后合并** - 看到总数

## 动画节奏
- 每组展示间隔：0.5秒
- 组内元素：LaggedStart，lag_ratio=0.1
- 合并动画：1秒
- 总等待时间：根据组数调整

## 特殊情况处理

### 当 multiplier × multiplicand > 30
```python
# 使用更小的圆圈
Circle(radius=0.08, ...)  # 而非 0.12

# 更紧凑的排列
group.arrange(RIGHT, buff=0.05)  # 而非 0.1
groups.arrange(DOWN, buff=0.2)  # 而非 0.4
```

### 当 multiplier = 1 或 multiplicand = 1
```python
# 添加特殊说明
if {multiplier} == 1:
    note = Text("1个{multiplicand}就是{multiplicand}", font="Noto Sans CJK SC", font_size=24)
elif {multiplicand} == 1:
    note = Text("{multiplier}个1就是{multiplier}", font="Noto Sans CJK SC", font_size=24)
```

## 注意事项
- ⚠️ 必须逐组展示，不能一次性显示所有
- ⚠️ 组标签要在合并前移除
- ⚠️ 最终网格排列要居中
- ⚠️ 确保总元素数不超过50个

## 示例
输入：3 × 4
流程：
1. 显示"3 × 4 = 3个4"
2. 第1组：4个蓝色圆圈（横排）
3. 第2组：4个蓝色圆圈（横排）
4. 第3组：4个蓝色圆圈（横排）
5. 合并成网格，变绿色
6. 显示"3 × 4 = 12"
