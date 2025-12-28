# Complex Word Problem Skill

## 描述
为小学生可视化复杂的应用题（应用题），包含多步骤计算、多条件分析等。

## 何时使用
- 题目包含多个已知条件
- 需要多步骤计算才能得出答案
- 涉及"倍数关系"、"比例"、"追及问题"、"和差问题"等
- 题目超过50字的复杂情境

## 可视化原则
1. **结构化展示** - 将复杂问题分解为视觉化的条件和步骤
2. **条件提取** - 清晰列出已知条件
3. **关系图示** - 用图形展示数量关系
4. **步骤连贯** - 保持元素在步骤间的连续性

## 标准流程

### 步骤1：展示题目并提取条件
```python
# 显示题目
problem = Text("{problem_short}", font="Noto Sans CJK SC", font_size=24)
problem.to_edge(UP, buff=0.5)
self.play(Write(problem))
self.wait(2)

# 缩小题目
self.play(problem.animate.scale(0.6).to_edge(UP, buff=0.3))
self.wait(0.5)

# 展示已知条件
conditions_title = Text("已知条件：", font="Noto Sans CJK SC", font_size=24, color=YELLOW)
conditions_title.move_to([-4, 2, 0])
self.play(Write(conditions_title))

conditions = VGroup()
condition_texts = ["{condition1}", "{condition2}", "{condition3}"]
for i, cond in enumerate(condition_texts):
    if cond:
        cond_text = Text(f"• {cond}", font="Noto Sans CJK SC", font_size=20)
        cond_text.move_to([-3, 1.5 - i * 0.5, 0])
        conditions.add(cond_text)
        self.play(Write(cond_text), run_time=0.5)

self.wait(2)
```

### 步骤2：构建数量关系图
```python
# 创建关系图（根据题型选择）
# 例如：和差问题的线段图
large_bar = Rectangle(width=4, height=0.4, color=BLUE, fill_opacity=0.6)
large_bar.move_to([0, 0.5, 0])

small_bar = Rectangle(width={small_ratio} * 4 / {large_ratio}, height=0.4, color=RED, fill_opacity=0.6)
small_bar.move_to([0, -0.5, 0])
small_bar.align_to(large_bar, LEFT)

# 标签
label_large = Text("{name1}", font="Noto Sans CJK SC", font_size=20)
label_large.next_to(large_bar, LEFT, buff=0.3)

label_small = Text("{name2}", font="Noto Sans CJK SC", font_size=20)
label_small.next_to(small_bar, LEFT, buff=0.3)

self.play(Create(large_bar), Write(label_large))
self.play(Create(small_bar), Write(label_small))
self.wait(1)

# 标注差异
diff_bracket = Brace(VGroup(large_bar, small_bar), RIGHT)
diff_label = Text("差{difference}", font="Noto Sans CJK SC", font_size=18)
diff_label.next_to(diff_bracket, RIGHT, buff=0.2)

self.play(Create(diff_bracket), Write(diff_label))
self.wait(2)
```

### 步骤3：逐步计算（在同一场景内Transform）
```python
# 步骤标签
step_label = Text("第1步: {step1_desc}", font="Noto Sans CJK SC", font_size=22)
step_label.to_edge(LEFT, buff=0.5).shift(DOWN * 2)
self.play(Write(step_label))

# 计算过程
calc1 = Text("{step1_calc}", font="Noto Sans CJK SC", font_size=20, color=GREEN)
calc1.next_to(step_label, RIGHT, buff=0.5)
self.play(Write(calc1))
self.wait(2)

# 第2步（Transform标签，不清空）
step_label_2 = Text("第2步: {step2_desc}", font="Noto Sans CJK SC", font_size=22)
step_label_2.to_edge(LEFT, buff=0.5).shift(DOWN * 2)
self.play(Transform(step_label, step_label_2))

calc2 = Text("{step2_calc}", font="Noto Sans CJK SC", font_size=20, color=GREEN)
calc2.next_to(step_label, RIGHT, buff=0.5)
self.play(Transform(calc1, calc2))
self.wait(2)
```

### 步骤4：展示最终答案
```python
# 清理计算区域
self.play(FadeOut(step_label), FadeOut(calc1))
self.wait(0.5)

# 最终答案
answer_box = Rectangle(width=5, height=1, color=GREEN, fill_opacity=0.2)
answer_box.to_edge(DOWN, buff=0.8)

answer_text = Text("答：{final_answer}", font="Noto Sans CJK SC", font_size=28, color=GREEN)
answer_text.move_to(answer_box.get_center())

self.play(Create(answer_box), Write(answer_text))
self.wait(3)
```

## 常见题型模板

### 和差问题
- 已知两数之和与差，求两数
- 公式：大数=(和+差)÷2，小数=(和-差)÷2

### 倍数问题
- 已知倍数关系和和/差，求各数
- 使用线段图展示倍数关系

### 追及问题
- 已知速度差和距离，求时间
- 使用动态移动展示追及过程

### 工程问题
- 已知效率和时间，求工作量
- 使用进度条展示工作完成情况

## 参数说明
- `{problem_short}`: 题目简短版本（前60字）
- `{condition1}`, `{condition2}`, `{condition3}`: 已知条件列表
- `{name1}`, `{name2}`: 对象名称
- `{large_ratio}`, `{small_ratio}`: 比例关系
- `{difference}`: 差值
- `{step1_desc}`, `{step1_calc}`: 步骤1描述和计算
- `{step2_desc}`, `{step2_calc}`: 步骤2描述和计算
- `{final_answer}`: 最终答案

## 布局要求
- 题目在最顶部（缩小）
- 条件列表在左侧
- 关系图居中
- 计算步骤在下方
- 答案在底部

## 注意事项
- ⚠️ 关系图必须反映实际比例
- ⚠️ 步骤间使用Transform保持连贯
- ⚠️ 最多展示3-4个主要步骤
- ⚠️ 复杂公式分行展示

## 示例
输入：小明和小红共有糖果50个，小明比小红多10个，两人各有多少个？
输出：
1. 展示条件：共50个，相差10个
2. 画线段图：两条长度不同的线段
3. 步骤计算：大数=(50+10)÷2=30，小数=(50-10)÷2=20
4. 答案：小明30个，小红20个
