# Continuous Operation Skill

## 描述
为小学生可视化连续运算问题，强调在同一组元素上进行连续操作，保持视觉连贯性。

## 何时使用
- 题目包含多个连续运算（如 20-3+2）
- 涉及"先...再..."、"然后"等连续动作描述
- 需要展示数量的多次变化过程

## 可视化原则（核心！）
1. **一组元素贯穿始终** - 创建的VGroup不要清空，持续在其上操作
2. **Transform而非重建** - 更新标签用Transform，不用FadeOut+Write
3. **变化可追踪** - 每次变化用颜色/位置变化表达
4. **数量同步** - 视觉元素数量与计算结果始终一致

## 标准流程

### 步骤1：创建初始数量（创建后将一直使用）
```python
# 创建初始元素组（这个VGroup将贯穿整个动画！）
items = VGroup(*[Circle(radius=0.12, color=BLUE, fill_opacity=0.8) for _ in range({initial})])
items.arrange_in_grid(rows=4, buff=0.1)
items.scale(0.65).move_to(ORIGIN)

# 初始标签
step_label = Text("一共有{initial}个{item_name}", font="Noto Sans CJK SC", font_size=26)
step_label.to_edge(UP, buff=0.8)

self.play(Write(step_label))
self.play(LaggedStart(*[FadeIn(item) for item in items], lag_ratio=0.03))
self.wait(2)
```

### 步骤2：执行减法操作（在原VGroup上操作）
```python
# 更新标签（使用Transform！）
step_label_2 = Text("{operation1_desc}", font="Noto Sans CJK SC", font_size=26, color=YELLOW)
step_label_2.to_edge(UP, buff=0.8)
self.play(Transform(step_label, step_label_2))
self.wait(0.5)

# 高亮要移除的元素
remove_count = {subtract_count}
remove_items = items[:remove_count]

# 先变色标记
self.play(remove_items.animate.set_color(RED))
self.wait(0.5)

# 移动到边缘
self.play(remove_items.animate.shift(RIGHT * 4))
self.wait(0.5)

# 淡出移除
self.play(FadeOut(remove_items))
self.wait(0.5)

# 剩余元素重新排列（保持在items中）
remaining_items = items[remove_count:]
self.play(remaining_items.animate.arrange_in_grid(rows=3, buff=0.1).move_to(ORIGIN))
self.wait(1.5)
```

### 步骤3：执行加法操作（继续在场景中添加）
```python
# 更新标签（继续Transform！）
step_label_3 = Text("{operation2_desc}", font="Noto Sans CJK SC", font_size=26, color=GREEN)
step_label_3.to_edge(UP, buff=0.8)
self.play(Transform(step_label, step_label_3))
self.wait(0.5)

# 创建新元素（从屏幕外进入）
new_items = VGroup(*[Circle(radius=0.12, color=GREEN, fill_opacity=0.8) for _ in range({add_count})])
new_items.arrange(RIGHT, buff=0.1)
new_items.move_to(LEFT * 5)  # 屏幕左侧外

self.play(FadeIn(new_items))
self.wait(0.5)

# 移动到主区域旁边
self.play(new_items.animate.next_to(remaining_items, DOWN, buff=0.3))
self.wait(0.5)

# 合并并统一颜色
all_items = VGroup(remaining_items, new_items)
self.play(
    all_items.animate.arrange_in_grid(rows=4, buff=0.1).move_to(ORIGIN),
    remaining_items.animate.set_color(BLUE),
    new_items.animate.set_color(BLUE)
)
self.wait(2)
```

### 步骤4：展示最终结果（同一场景继续）
```python
# 更新标签显示结果
final_label = Text("现在一共有{result}个{item_name}", font="Noto Sans CJK SC", font_size=26, color=GREEN)
final_label.to_edge(UP, buff=0.8)
self.play(Transform(step_label, final_label))

# 所有元素变绿表示完成
self.play(all_items.animate.set_color(GREEN))
self.wait(1)

# 显示计算等式
equation = Text("{initial} - {subtract_count} + {add_count} = {result}", font="Noto Sans CJK SC", font_size=32, color=GREEN)
equation.to_edge(DOWN, buff=1.0)
self.play(Write(equation))
self.wait(3)
```

## 参数说明
- `{initial}`: 初始数量
- `{subtract_count}`: 减去的数量
- `{add_count}`: 加上的数量
- `{result}`: 最终结果
- `{item_name}`: 物品名称（如"苹果"）
- `{operation1_desc}`: 第一个操作描述（如"送出了3个"）
- `{operation2_desc}`: 第二个操作描述（如"又买了2个"）

## 关键代码模式

### ❌ 错误方式（清空重建）
```python
# 不要这样做！
self.play(FadeOut(all_elements))  # 清空
self.wait(0.5)
new_elements = VGroup(...)  # 重新创建
self.play(Create(new_elements))  # 又从头来
```

### ✅ 正确方式（连续操作）
```python
# 始终在原有元素上操作
self.play(items[0:3].animate.set_color(RED))  # 高亮
self.play(items[0:3].animate.shift(RIGHT * 4))  # 移动
self.play(FadeOut(items[0:3]))  # 只移除这几个
# items[3:] 仍然可见且可继续操作
```

## 布局要求
- 元素始终在中心区域
- 移除的元素向右侧移出再消失
- 新增的元素从左侧进入
- 标签始终在顶部，使用Transform更新

## 注意事项
- ⚠️ **绝对禁止**中途FadeOut所有元素后重建
- ⚠️ 标签更新必须使用Transform
- ⚠️ 元素移除时要有"移出"动画，不是直接消失
- ⚠️ 新元素加入时要有"进入"动画
- ⚠️ 每次变化后重新arrange保持整齐

## 示例
输入：小明有20个苹果，给了小红3个，又买了2个，现在有多少个？
输出：
1. 显示20个蓝色圆圈
2. 3个变红 → 移到右边 → 消失（剩17个）
3. 2个绿色圆圈从左边进入 → 并入队列（共19个）
4. 全部变蓝 → 显示"20-3+2=19"
