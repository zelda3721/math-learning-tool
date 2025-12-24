# Sum and Difference Problem Skill (和差问题)

## 描述
可视化和差问题，通过线段图直观展示两数的和与差关系。

## 何时使用
- 题目中包含"和"、"差"、"相差"、"合计"等关键词
- 已知两数之和与差，求两数
- 涉及大数小数的计算

## 可视化原则
1. **线段图** - 用两条不同长度的线段表示两数
2. **对齐展示** - 线段左对齐以便比较
3. **差值标注** - 明确标出差值部分
4. **公式推导** - 展示计算过程

## 核心公式
- 大数 = (和 + 差) ÷ 2
- 小数 = (和 - 差) ÷ 2

## 标准流程

### 步骤1：展示题目条件
```python
title = Text("和差问题", font="Noto Sans CJK SC", font_size=36, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

condition = Text("两数之和为{sum}，两数之差为{difference}", font="Noto Sans CJK SC", font_size=24)
condition.next_to(title, DOWN, buff=0.5)
self.play(Write(condition))
self.wait(2)
```

### 步骤2：绘制线段图
```python
# 计算线段长度比例
large_num = ({sum} + {difference}) // 2
small_num = ({sum} - {difference}) // 2
max_num = max(large_num, small_num)

# 大数线段
large_bar = Rectangle(width=large_num/max_num * 6, height=0.5, color=BLUE, fill_opacity=0.6)
large_bar.move_to([0, 0.8, 0])

large_label = Text("大数", font="Noto Sans CJK SC", font_size=20)
large_label.next_to(large_bar, LEFT, buff=0.3)

# 小数线段
small_bar = Rectangle(width=small_num/max_num * 6, height=0.5, color=RED, fill_opacity=0.6)
small_bar.move_to([0, -0.2, 0])
small_bar.align_to(large_bar, LEFT)

small_label = Text("小数", font="Noto Sans CJK SC", font_size=20)
small_label.next_to(small_bar, LEFT, buff=0.3)

self.play(Create(large_bar), Write(large_label))
self.play(Create(small_bar), Write(small_label))
self.wait(1)
```

### 步骤3：标注和与差
```python
# 标注差值（大数多出的部分）
diff_part = Rectangle(
    width=(large_num - small_num)/max_num * 6, 
    height=0.5, 
    color=YELLOW, 
    fill_opacity=0.4
)
diff_part.move_to(large_bar.get_right() - RIGHT * diff_part.width/2 + UP * 0)
diff_part.align_to(large_bar, UP)

brace_diff = Brace(diff_part, UP)
diff_text = Text(f"差={difference}", font="Noto Sans CJK SC", font_size=18, color=YELLOW)
diff_text.next_to(brace_diff, UP, buff=0.1)

self.play(Create(diff_part), Create(brace_diff), Write(diff_text))
self.wait(1)

# 标注和
brace_sum = Brace(VGroup(large_bar, small_bar), RIGHT)
sum_text = Text(f"和={sum}", font="Noto Sans CJK SC", font_size=18, color=GREEN)
sum_text.next_to(brace_sum, RIGHT, buff=0.1)

self.play(Create(brace_sum), Write(sum_text))
self.wait(2)
```

### 步骤4：推导公式
```python
formula = VGroup(
    Text("大数 = (和 + 差) ÷ 2", font="Noto Sans CJK SC", font_size=22),
    Text(f"     = ({sum} + {difference}) ÷ 2 = {large_num}", font="Noto Sans CJK SC", font_size=22, color=BLUE),
    Text("小数 = (和 - 差) ÷ 2", font="Noto Sans CJK SC", font_size=22),
    Text(f"     = ({sum} - {difference}) ÷ 2 = {small_num}", font="Noto Sans CJK SC", font_size=22, color=RED),
)
formula.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
formula.to_edge(DOWN, buff=0.5)

for line in formula:
    self.play(Write(line), run_time=0.8)
    self.wait(0.3)

self.wait(3)
```

## 参数说明
- `{sum}`: 两数之和
- `{difference}`: 两数之差
- `{large_num}`: 大数 = (sum + difference) ÷ 2
- `{small_num}`: 小数 = (sum - difference) ÷ 2

## 布局要求
- 两条线段上下排列，左对齐
- 差值用不同颜色高亮
- 公式在底部

## 注意事项
- ⚠️ 线段长度要按比例绘制
- ⚠️ 用括号标注和与差

## 示例
输入：两数之和为50，两数之差为10
输出：线段图 → 大数=(50+10)÷2=30 → 小数=(50-10)÷2=20
