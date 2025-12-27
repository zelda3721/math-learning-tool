# Chicken-Rabbit Problem Skill (鸡兔同笼)

## 描述
可视化经典的鸡兔同笼问题，使用假设法动画直观展示解题过程。
【重要提示】：由于系统环境限制，本技能模板完全使用 Text 类，严禁在生成时自行替换为 MathTex 或 Tex。

## 何时使用
- 题目中包含"鸡"、"兔"、"头"、"脚"、"腿"等关键词
- 涉及两种不同属性物体的混合计数问题
- 需要通过假设法求解的问题

## 可视化原则
1. **假设法动画** - 先假设全是鸡，动态"变换"成兔子
2. **数量对应** - 头数用圆圈，脚数用线条，必须全部显示
3. **差异高亮** - 用颜色标注假设与实际的差值
4. **脚的变化** - 清楚展示每次变换增加2只脚

## 参数说明
- `{heads}`: 总头数
- `{legs}`: 总脚数

## 标准流程

### 步骤1：展示题目条件并计算
```python
# 显示题目
title = Text("鸡兔同笼问题", font="Microsoft YaHei", font_size=36, color=YELLOW)
title.to_edge(UP, buff=0.3)
self.play(Write(title))

# 动态计算
heads = {heads}
legs = {legs}
assumed_legs = heads * 2  # 假设全是鸡
diff = legs - assumed_legs  # 差多少脚
rabbits = diff // 2  # 兔的数量
chickens = heads - rabbits  # 鸡的数量

# 显示条件
condition = Text(f"共 {heads} 个头，{legs} 只脚", font="Microsoft YaHei", font_size=24)
condition.next_to(title, DOWN, buff=0.3)
self.play(Write(condition))
self.wait(1)
```

### 步骤2：假设全是鸡 - 显示所有动物和脚
```python
# 创建所有动物（全部显示！）
# 每只动物：1个头(圆圈) + 2只脚(线条)
animals = VGroup()
feet_groups = VGroup()  # 单独存储脚，方便后续添加

for i in range(heads):
    # 头
    head = Circle(radius=0.12, color=ORANGE, fill_opacity=0.8)
    # 2只脚
    left_foot = Line(ORIGIN, DOWN * 0.15, color=ORANGE, stroke_width=2)
    right_foot = Line(ORIGIN, DOWN * 0.15, color=ORANGE, stroke_width=2)
    left_foot.next_to(head, DOWN, buff=0.02).shift(LEFT * 0.05)
    right_foot.next_to(head, DOWN, buff=0.02).shift(RIGHT * 0.05)
    
    feet = VGroup(left_foot, right_foot)
    animal = VGroup(head, feet)
    animals.add(animal)
    feet_groups.add(feet)

# 网格排列（根据数量自动调整行数）
rows = 5 if heads > 20 else 4 if heads > 10 else 3
animals.arrange_in_grid(rows=rows, buff=0.15)
animals.scale(0.5).move_to(ORIGIN + UP * 0.3)

# 显示假设步骤
step1 = Text(f"假设全是鸡：{heads}×2 = {assumed_legs} 只脚", font="Microsoft YaHei", font_size=22, color=WHITE)
step1.to_edge(DOWN, buff=1.5)

self.play(Write(step1))
self.play(LaggedStart(*[FadeIn(a) for a in animals], lag_ratio=0.02), run_time=2)
self.wait(1)

# 显示当前脚数
current_feet = Text(f"当前: {assumed_legs} 只脚", font="Microsoft YaHei", font_size=20, color=ORANGE)
current_feet.next_to(step1, DOWN, buff=0.3)
self.play(Write(current_feet))
self.wait(1)
```

### 步骤3：计算差值
```python
# 显示差值
diff_text = Text(f"实际需要 {legs} 只脚，还差 {diff} 只脚", font="Microsoft YaHei", font_size=22, color=RED)
diff_text.next_to(current_feet, DOWN, buff=0.3)
self.play(Write(diff_text))
self.wait(1)

# 每只兔比鸡多2只脚
change_text = Text(f"每变1只兔子多2只脚 → 需变 {rabbits} 只", font="Microsoft YaHei", font_size=22, color=GREEN)
change_text.next_to(diff_text, DOWN, buff=0.3)
self.play(Write(change_text))
self.wait(2)
```

### 步骤4：变换动画 - 展示脚的增加！
```python
# 变换前rabbits只鸡为兔子
# 关键：清楚展示每只增加2只脚

# 淡出计算文字，腾出空间
self.play(FadeOut(step1), FadeOut(current_feet), FadeOut(diff_text), FadeOut(change_text))
self.wait(0.3)

# 显示变换进度
transform_label = Text("开始变换...", font="Microsoft YaHei", font_size=22, color=YELLOW)
transform_label.to_edge(DOWN, buff=1.0)
self.play(Write(transform_label))

# 脚数计数器
feet_count = assumed_legs
feet_counter = Text(f"当前脚数: {feet_count}", font="Microsoft YaHei", font_size=24, color=GREEN)
feet_counter.next_to(transform_label, DOWN, buff=0.3)
self.play(Write(feet_counter))

# 逐只变换（加速处理）
for i in range(rabbits):
    # 变色：橙色→蓝色
    self.play(animals[i][0].animate.set_color(BLUE), run_time=0.15)
    
    # 添加2只额外的脚（关键！展示脚的增加）
    extra_foot1 = Line(ORIGIN, DOWN * 0.15, color=BLUE, stroke_width=2)
    extra_foot2 = Line(ORIGIN, DOWN * 0.15, color=BLUE, stroke_width=2)
    extra_foot1.next_to(animals[i][1], LEFT, buff=0.02)
    extra_foot2.next_to(animals[i][1], RIGHT, buff=0.02)
    extra_feet = VGroup(extra_foot1, extra_foot2)
    
    self.play(FadeIn(extra_feet), run_time=0.15)
    animals[i].add(extra_feet)  # 添加到动物组
    
    # 更新计数器
    feet_count += 2
    new_counter = Text(f"当前脚数: {feet_count}", font="Microsoft YaHei", font_size=24, color=GREEN)
    new_counter.next_to(transform_label, DOWN, buff=0.3)
    self.play(Transform(feet_counter, new_counter), run_time=0.1)

# 完成变换
complete_text = Text(f"变换完成！共 {legs} 只脚 ✓", font="Microsoft YaHei", font_size=24, color=GREEN)
complete_text.next_to(feet_counter, DOWN, buff=0.3)
self.play(Write(complete_text))
self.wait(2)
```

### 步骤5：清场并显示最终结果
```python
# 清理所有元素
self.play(
    FadeOut(title),
    FadeOut(condition),
    FadeOut(animals),
    FadeOut(transform_label),
    FadeOut(feet_counter),
    FadeOut(complete_text),
    run_time=0.8
)
self.wait(0.3)

# 显示结果
result_box = Rectangle(width=8, height=1.8, color=GREEN, fill_opacity=0.2, stroke_width=3)
result_box.move_to(ORIGIN)

result = VGroup(
    Text(f"鸡: {chickens} 只 (2脚×{chickens} = {chickens*2}脚)", font="Microsoft YaHei", font_size=28, color=ORANGE),
    Text(f"兔: {rabbits} 只 (4脚×{rabbits} = {rabbits*4}脚)", font="Microsoft YaHei", font_size=28, color=BLUE),
    Text(f"共: {chickens*2 + rabbits*4} 只脚 ✓", font="Microsoft YaHei", font_size=28, color=GREEN)
).arrange(DOWN, buff=0.3)
result.move_to(result_box.get_center())

self.play(Create(result_box))
for line in result:
    self.play(Write(line), run_time=0.5)
self.play(Circumscribe(result, color=YELLOW, run_time=1))
self.wait(3)

# 清理为最终答案腾出空间
self.play(FadeOut(result_box), FadeOut(result))
self.wait(0.3)
```

## 公式
- 兔数 = (实际脚数 - 头数×2) ÷ 2
- 鸡数 = 头数 - 兔数
