# Travel Meeting Problem Skill (行程相遇问题)

## 描述
可视化行程问题中的相遇问题，两个物体从两端相向而行直到相遇。

## 何时使用
- 题目中包含"相遇"、"相向"、"面对面"、"迎面"等关键词
- 两个物体从不同地点出发相向运动
- 需要计算相遇时间或相遇地点

## 可视化原则
1. **双向移动** - 两物体从两端同时向中间移动
2. **速度可视** - 用移动速度体现不同速度
3. **路程标注** - 显示各自走过的路程
4. **相遇瞬间** - 高亮相遇时刻

## 核心公式
- 相遇时间 = 总路程 ÷ 速度和
- 速度和 = 速度1 + 速度2
- 各自路程 = 各自速度 × 相遇时间

## 标准流程

### 步骤1：设置场景
```python
# 画一条路线
road = Line(LEFT * 5, RIGHT * 5, color=GRAY, stroke_width=3)
road.move_to(ORIGIN)

# 标注两端
point_a = Dot(LEFT * 5, color=BLUE)
point_b = Dot(RIGHT * 5, color=RED)
label_a = Text("A地", font="Noto Sans CJK SC", font_size=20)
label_a.next_to(point_a, DOWN, buff=0.2)
label_b = Text("B地", font="Noto Sans CJK SC", font_size=20)
label_b.next_to(point_b, DOWN, buff=0.2)

# 显示总路程
distance_label = Text("相距{distance}千米", font="Noto Sans CJK SC", font_size=24)
distance_label.next_to(road, UP, buff=0.5)

self.play(Create(road))
self.play(FadeIn(point_a), FadeIn(point_b), Write(label_a), Write(label_b))
self.play(Write(distance_label))
self.wait(1)
```

### 步骤2：创建运动物体
```python
# 物体1（从A出发）
obj1 = VGroup(
    Circle(radius=0.2, color=BLUE, fill_opacity=0.8),
    Text("甲", font="Noto Sans CJK SC", font_size=16, color=WHITE)
)
obj1.move_to(LEFT * 5 + UP * 0.3)

# 速度标签
speed1_label = Text("{speed1}千米/时", font="Noto Sans CJK SC", font_size=18, color=BLUE)
speed1_label.next_to(obj1, UP, buff=0.2)

# 物体2（从B出发）
obj2 = VGroup(
    Circle(radius=0.2, color=RED, fill_opacity=0.8),
    Text("乙", font="Noto Sans CJK SC", font_size=16, color=WHITE)
)
obj2.move_to(RIGHT * 5 + UP * 0.3)

# 速度标签
speed2_label = Text("{speed2}千米/时", font="Noto Sans CJK SC", font_size=18, color=RED)
speed2_label.next_to(obj2, UP, buff=0.2)

self.play(FadeIn(obj1), FadeIn(obj2), Write(speed1_label), Write(speed2_label))
self.wait(1)
```

### 步骤3：同时移动直到相遇
```python
# 计算相遇位置（根据速度比例）
total_speed = {speed1} + {speed2}
meet_ratio = {speed1} / total_speed
meet_x = -5 + 10 * meet_ratio  # 从A点开始计算

meet_point = Dot([meet_x, 0, 0], color=GREEN, radius=0.1)

# 显示分析
analysis = Text("速度和 = {speed1} + {speed2} = {total_speed}千米/时", font="Noto Sans CJK SC", font_size=22)
analysis.to_edge(UP, buff=0.3)
self.play(Write(analysis))

time_calc = Text("相遇时间 = {distance} ÷ {total_speed} = {time}小时", font="Noto Sans CJK SC", font_size=22)
time_calc.next_to(analysis, DOWN, buff=0.2)
self.play(Write(time_calc))
self.wait(1)

# 同时移动（模拟相向运动）
self.play(
    obj1.animate.move_to([meet_x, 0.3, 0]),
    speed1_label.animate.move_to([meet_x, 0.8, 0]),
    obj2.animate.move_to([meet_x, 0.3, 0]),
    speed2_label.animate.move_to([meet_x, 1.3, 0]),
    run_time=3,
    rate_func=linear
)

# 相遇效果
self.play(Create(meet_point))
meet_text = Text("相遇！", font="Noto Sans CJK SC", font_size=28, color=GREEN)
meet_text.next_to(meet_point, DOWN, buff=0.5)
self.play(Write(meet_text))
self.wait(2)
```

### 步骤4：显示结果
```python
# 显示各自走的路程
dist1 = {speed1} * {time}
dist2 = {speed2} * {time}

result = VGroup(
    Text(f"甲走了: {speed1}×{time}={dist1}千米", font="Noto Sans CJK SC", font_size=22, color=BLUE),
    Text(f"乙走了: {speed2}×{time}={dist2}千米", font="Noto Sans CJK SC", font_size=22, color=RED),
    Text(f"{time}小时后相遇", font="Noto Sans CJK SC", font_size=26, color=GREEN)
)
result.arrange(DOWN, buff=0.3)
result.to_edge(DOWN, buff=0.5)

self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{distance}`: 两地之间的总距离
- `{speed1}`: 甲的速度
- `{speed2}`: 乙的速度
- `{total_speed}`: 速度和 = speed1 + speed2
- `{time}`: 相遇时间 = distance ÷ total_speed

## 布局要求
- 路线水平居中
- 两物体分别在两端
- 速度标签跟随物体
- 分析过程在顶部

## 注意事项
- ⚠️ 移动动画使用 linear rate_func 模拟匀速
- ⚠️ 相遇位置根据速度比例计算
- ⚠️ 用颜色区分两个物体

## 示例
输入：AB两地相距120千米，甲从A以30千米/时出发，乙从B以50千米/时出发
输出：速度和80 → 时间1.5小时 → 甲走45千米，乙走75千米 → 相遇
