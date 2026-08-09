# 分步流程模式 (Process Pattern)

## 描述
将解题过程分成清晰的步骤，用图形和动画逐步展示。

## 适用场景
- 应用题分步解题
- 多步骤计算
- 逻辑推理题

## 核心代码

```python
# 创建步骤标题
def create_step_header(step_num, text, position=UP*2.5):
    """创建步骤标题"""
    header = Text(f"第{step_num}步：{text}", font="Microsoft YaHei", font_size=22, color=YELLOW)
    header.move_to(position)
    return header

# 场景切换
def transition_to_next_step(scene, old_elements, new_step_header):
    """清晰的步骤切换动画"""
    # 淡出旧内容
    scene.play(FadeOut(old_elements), run_time=0.5)
    scene.wait(0.3)
    
    # 显示新步骤标题
    scene.play(Write(new_step_header), run_time=0.5)
    scene.wait(0.5)

# 创建流程图
def create_flow_chart(steps, arrow_color=WHITE):
    """创建简单流程图"""
    boxes = VGroup()
    arrows = VGroup()
    
    for i, step_text in enumerate(steps):
        box = VGroup(
            RoundedRectangle(width=2, height=0.8, corner_radius=0.1, color=BLUE),
            Text(step_text, font="Microsoft YaHei", font_size=14)
        )
        boxes.add(box)
        
        if i > 0:
            arrow = Arrow(
                boxes[i-1].get_right(),
                box.get_left(),
                buff=0.1,
                color=arrow_color
            )
            arrows.add(arrow)
    
    boxes.arrange(RIGHT, buff=0.8)
    
    # 更新箭头位置
    for i, arrow in enumerate(arrows):
        arrow.put_start_and_end_on(
            boxes[i].get_right() + RIGHT*0.1,
            boxes[i+1].get_left() + LEFT*0.1
        )
    
    return VGroup(boxes, arrows)

# 高亮当前步骤
def highlight_step(scene, flow_chart, step_index):
    """高亮当前正在执行的步骤"""
    boxes = flow_chart[0]
    
    # 其他步骤变暗
    for i, box in enumerate(boxes):
        if i == step_index:
            scene.play(box[0].animate.set_color(YELLOW), run_time=0.3)
        else:
            scene.play(box[0].animate.set_color(GRAY), run_time=0.1)

# 创建计算展示区
def create_calculation_area(position=ORIGIN):
    """创建动态计算展示区域"""
    bg = Rectangle(width=5, height=2, color=DARK_GRAY, fill_opacity=0.3)
    bg.move_to(position)
    return bg

# 展示计算过程
def show_calculation(scene, expression, result, position=ORIGIN):
    """用动画展示计算"""
    expr = Text(expression, font="Microsoft YaHei", font_size=24)
    expr.move_to(position)
    
    scene.play(Write(expr), run_time=0.8)
    scene.wait(1)
    
    res = Text(f" = {result}", font="Microsoft YaHei", font_size=24, color=GREEN)
    res.next_to(expr, RIGHT, buff=0.1)
    
    scene.play(Write(res), run_time=0.5)
    scene.wait(1)
    
    return VGroup(expr, res)
```

## 使用示例

### 分步解应用题
```python
# 1. 显示题目
problem = Text("小明有15个苹果，给小红5个后，又买了8个，现有多少？", 
               font="Microsoft YaHei", font_size=20)
problem.to_edge(UP, buff=0.4)
self.play(Write(problem))
self.wait(2)

# 2. 第一步：给出5个
step1 = create_step_header(1, "给小红5个")
self.play(Write(step1))

apples = VGroup(*[Circle(radius=0.1, color=RED, fill_opacity=0.8) for _ in range(15)])
apples.arrange_in_grid(rows=3, buff=0.15).scale(0.8).move_to(ORIGIN)
self.play(LaggedStart(*[FadeIn(a) for a in apples], lag_ratio=0.03))
self.wait(0.5)

# 移除5个
given = apples[:5]
remaining = apples[5:]
self.play(given.animate.set_color(GRAY), run_time=0.5)
self.play(FadeOut(given, shift=RIGHT*2), run_time=0.8)

calc1 = show_calculation(self, "15 - 5", "10", DOWN*2)
self.wait(1)

# 3. 第二步：买8个
transition_to_next_step(self, VGroup(step1, calc1), create_step_header(2, "买8个"))

# 重新排列剩余苹果
self.play(remaining.animate.move_to(LEFT*2))

# 添加8个新苹果
new_apples = VGroup(*[Circle(radius=0.1, color=GREEN, fill_opacity=0.8) for _ in range(8)])
new_apples.arrange_in_grid(rows=2, buff=0.15).scale(0.8).move_to(RIGHT*2)
self.play(LaggedStart(*[GrowFromCenter(a) for a in new_apples], lag_ratio=0.05))

# 合并
self.play(new_apples.animate.next_to(remaining, RIGHT, buff=0.3))

calc2 = show_calculation(self, "10 + 8", "18", DOWN*2)
self.wait(2)

# 4. 最终答案
answer = Text("答案：18个苹果", font="Microsoft YaHei", font_size=28, color=YELLOW)
answer.to_edge(DOWN, buff=0.5)
box = SurroundingRectangle(answer, color=YELLOW, buff=0.2)
self.play(Write(answer), Create(box))
self.wait(3)
```

## 关键原则
1. **分幕结构** - 每个步骤是一幕
2. **清晰切换** - 步骤间用 FadeOut/FadeIn
3. **步骤标题** - 显示"第N步"
4. **图形+计算** - 图形操作后显示对应算式
