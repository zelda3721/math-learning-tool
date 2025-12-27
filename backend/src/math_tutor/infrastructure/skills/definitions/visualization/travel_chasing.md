# Travel Chasing Problem Skill (行程追及问题)

## 描述
可视化行程问题中的追及问题，快者追慢者直到追上。

## 何时使用
- 题目中包含"追及"、"追上"、"同向"、"超过"等关键词
- 两个物体同向运动，速度不同
- 需要计算追及时间或追及距离

## 可视化原则
1. **同向移动** - 两物体朝同一方向移动，快者逐渐接近慢者
2. **距离变化** - 动态显示两者之间的距离缩短
3. **速度差** - 强调速度差是追及的关键
4. **追上瞬间** - 高亮追上时刻

## 核心公式
- 追及时间 = 初始距离差 ÷ 速度差
- 速度差 = 快速度 - 慢速度
- 追及路程 = 追者速度 × 追及时间

## 标准流程

### 步骤1：设置场景
```python
# 画一条路线
road = Line(LEFT * 6, RIGHT * 6, color=GRAY, stroke_width=3)
road.move_to(DOWN * 0.5)

# 起点标记
start = Dot(LEFT * 5.5, color=WHITE)
start_label = Text("起点", font="Noto Sans CJK SC", font_size=18)
start_label.next_to(start, DOWN, buff=0.2)

self.play(Create(road))
self.play(FadeIn(start), Write(start_label))
self.wait(1)
```

### 步骤2：创建运动物体（慢者在前，快者在后）
```python
# 慢者（在前面）
slow = VGroup(
    Circle(radius=0.2, color=RED, fill_opacity=0.8),
    Text("慢", font="Noto Sans CJK SC", font_size=14, color=WHITE)
)
slow.move_to(LEFT * 2 + UP * 0.3)

slow_speed_label = Text("{slow_speed}千米/时", font="Noto Sans CJK SC", font_size=16, color=RED)
slow_speed_label.next_to(slow, UP, buff=0.2)

# 快者（在后面）
fast = VGroup(
    Circle(radius=0.2, color=BLUE, fill_opacity=0.8),
    Text("快", font="Noto Sans CJK SC", font_size=14, color=WHITE)
)
fast.move_to(LEFT * 5 + UP * 0.3)

fast_speed_label = Text("{fast_speed}千米/时", font="Noto Sans CJK SC", font_size=16, color=BLUE)
fast_speed_label.next_to(fast, UP, buff=0.2)

# 显示初始距离
distance_line = DashedLine(fast.get_right(), slow.get_left(), color=YELLOW)
distance_label = Text("{initial_distance}千米", font="Noto Sans CJK SC", font_size=18, color=YELLOW)
distance_label.next_to(distance_line, DOWN, buff=0.1)

self.play(FadeIn(slow), Write(slow_speed_label))
self.play(FadeIn(fast), Write(fast_speed_label))
self.play(Create(distance_line), Write(distance_label))
self.wait(2)
```

### 步骤3：分析追及条件
```python
# 显示分析过程
analysis = VGroup(
    Text("追及问题分析：", font="Noto Sans CJK SC", font_size=22, color=YELLOW),
    Text("速度差 = {fast_speed} - {slow_speed} = {speed_diff}千米/时", font="Noto Sans CJK SC", font_size=20),
    Text("追及时间 = {initial_distance} ÷ {speed_diff} = {time}小时", font="Noto Sans CJK SC", font_size=20),
)
analysis.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
analysis.to_edge(UP, buff=0.3)

for line in analysis:
    self.play(Write(line))
    self.wait(0.5)
self.wait(1)

# 移除距离标注
self.play(FadeOut(distance_line), FadeOut(distance_label))
```

### 步骤4：模拟追及过程
```python
# 计算追及后的位置
chase_distance = {fast_speed} * {time}
final_x = -5 + chase_distance * 0.4  # 缩放到屏幕范围

# 同时移动，但速度不同（通过位移差体现）
# 快者移动距离更大
fast_final_x = final_x
slow_final_x = fast_final_x  # 追上时在同一位置

self.play(
    fast.animate.move_to([fast_final_x, 0.3, 0]),
    fast_speed_label.animate.move_to([fast_final_x, 0.8, 0]),
    slow.animate.move_to([slow_final_x, 0.3, 0]),
    slow_speed_label.animate.move_to([slow_final_x, 1.3, 0]),
    run_time=3,
    rate_func=linear
)

# 追上效果
catch_text = Text("追上了！", font="Noto Sans CJK SC", font_size=28, color=GREEN)
catch_text.next_to(fast, RIGHT, buff=0.3)
self.play(Write(catch_text))
self.wait(2)
```

### 步骤5：显示结果
```python
result = VGroup(
    Text(f"快者跑了: {fast_speed}×{time}={fast_distance}千米", font="Noto Sans CJK SC", font_size=20, color=BLUE),
    Text(f"慢者跑了: {slow_speed}×{time}={slow_distance}千米", font="Noto Sans CJK SC", font_size=20, color=RED),
    Text(f"答：{time}小时后追上", font="Noto Sans CJK SC", font_size=24, color=GREEN)
)
result.arrange(DOWN, buff=0.2)
result.to_edge(DOWN, buff=0.5)

self.play(Write(result))
self.wait(3)
```

## 参数说明
- `{initial_distance}`: 初始距离差
- `{fast_speed}`: 追者速度（快）
- `{slow_speed}`: 被追者速度（慢）
- `{speed_diff}`: 速度差 = fast_speed - slow_speed
- `{time}`: 追及时间 = initial_distance ÷ speed_diff
- `{fast_distance}`: 追者总路程 = fast_speed × time
- `{slow_distance}`: 被追者总路程 = slow_speed × time

## 布局要求
- 路线水平放置
- 慢者在前（右），快者在后（左）
- 初始距离用虚线标注
- 分析过程在顶部

## 注意事项
- ⚠️ 开始时要明确显示两者的相对位置
- ⚠️ 用虚线标注初始距离
- ⚠️ 追上时两个物体重合

## 示例
输入：甲在前方20千米，甲速度30千米/时，乙速度50千米/时
输出：速度差20 → 追及时间1小时 → 乙跑50千米，甲跑30千米 → 追上
