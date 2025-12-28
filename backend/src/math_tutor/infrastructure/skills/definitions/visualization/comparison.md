# Comparison Visualization Skill

## 描述
为小学生可视化比较大小问题，通过并排对比直观展示"谁多谁少"以及差值。

## 何时使用
- 题目中包含"多"、"少"、"比"、"相差"等关键词
- 需要比较两个数量的大小
- 需要计算两个数量的差值

## 可视化原则
1. **布局规范** - 严禁使用绝对坐标! 必须使用 `VGroup` + `.arrange()` + `.next_to()`。
2. **对齐基准** - 两组图形必须左对齐 (`aligned_edge=LEFT`)。
3. **字体规范** - Windows系统必须使用 "Microsoft YaHei" (微软雅黑)。
4. **颜色规范** - 只使用标准颜色: BLUE, RED, GREEN, YELLOW, ORANGE, PURPLE。

## 标准流程

### 步骤1：展示第一组数量
```python
# 1. 创建图形对象
# 使用矩形代表数量，比纯正方形更利于排版
unit_width = 0.8
unit_height = 0.8
group1 = VGroup(*[
    Rectangle(width=unit_width, height=unit_height, color=BLUE, fill_opacity=0.6) 
    for _ in range({num1})
])

# 2. 内部排列
# 必须使用 arrange 自动排列，防止重叠
group1.arrange(RIGHT, buff=0.1)

# 3. 整体布局
# 先放第一组，通常在屏幕上方偏左
group1.move_to(UP * 1.5)

# 4. 添加标签
# 标签放左侧，使用 next_to
label1 = Text("{name1}({num1})", font="Microsoft YaHei", font_size=24)
label1.next_to(group1, LEFT, buff=0.5)

# 5. 动画展示
# 先写标签，再逐个出现图形
self.play(Write(label1))
self.play(LaggedStart(
    *[FadeIn(mob, shift=UP*0.2) for mob in group1], 
    lag_ratio=0.1, run_time=2
))
self.wait(1)
```

### 步骤2：展示第二组数量
```python
# 1. 创建图形对象
group2 = VGroup(*[
    Rectangle(width=unit_width, height=unit_height, color=RED, fill_opacity=0.6) 
    for _ in range({num2})
])

# 2. 内部排列
group2.arrange(RIGHT, buff=0.1)

# 3. 整体布局
# 关键：相对于第一组定位，并左对齐！
group2.next_to(group1, DOWN, buff=1.0, aligned_edge=LEFT)

# 4. 添加标签
label2 = Text("{name2}({num2})", font="Microsoft YaHei", font_size=24)
label2.next_to(group2, LEFT, buff=0.5)

# 5. 动画展示
self.play(Write(label2))
self.play(LaggedStart(
    *[FadeIn(mob, shift=UP*0.2) for mob in group2], 
    lag_ratio=0.1, run_time=2
))
self.wait(1)
```

### 步骤3：高亮差异部分
```python
# 1. 计算差异并高亮
# 注意：这里的 difference 是在运行时计算的，不是模板参数
larger_num = {num1} if {num1} > {num2} else {num2}
smaller_num = {num2} if {num1} > {num2} else {num1}
difference = larger_num - smaller_num

# 找出多出的那部分图形 (VGroup支持切片)
if {num1} > {num2}:
    excess_group = group1[-difference:]
    direction = UP
else:
    excess_group = group2[-difference:]
    direction = DOWN

# 动画：改变颜色以示区别
self.play(excess_group.animate.set_color(YELLOW).set_opacity(1))

# 2. 添加大括号和文字
# 严禁使用 brace.get_text()，因为它默认使用LaTeX不支持中文
brace = Brace(excess_group, direction)
# 使用字符串拼接避免模板解析问题
diff_text = Text("多 " + str(difference) + " 个", font="Microsoft YaHei", font_size=24, color=YELLOW)
diff_text.next_to(brace, direction, buff=0.1)

self.play(Create(brace), Write(diff_text))
self.wait(2)
```

### 步骤4：显示结论
```python
# 1. 结论文本
conclusion = Text("{conclusion}", font="Microsoft YaHei", font_size=32, color=GREEN)
conclusion.to_edge(DOWN, buff=0.5) # 放在底部

# 2. 边框装饰 (可选，增加美观度)
box = SurroundingRectangle(conclusion, color=GREEN, buff=0.2)

self.play(Write(conclusion), Create(box))
self.wait(3)
```

## 参数说明
- `{num1}`: 第一个数量 (int)
- `{num2}`: 第二个数量 (int)
- `{name1}`: 第一个对象名称
- `{name2}`: 第二个对象名称
- `{conclusion}`: 结论文字

## 常见错误规避
- ❌ 不要使用 absolute coordinates (如 `[3, 2, 0]`)
- ❌ 不要使用 `brace.get_text()` (中文乱码风险)
- ❌ 不要使用 `font="Noto Sans CJK SC"` (Windows缺省) -> 用 "Microsoft YaHei"
- ❌ 不要使用非标准颜色名 (如 `ORANGE_E`) -> 用 `ORANGE`

## 示例
输入：{num1: 8, num2: 5, name1: "甲", name2: "乙"}
输出：
1. 蓝色矩形组(8个)和红色矩形组(5个)左对齐排列。
2. 黄色高亮甲多出的3个矩形。
3. 底部显示结论。
