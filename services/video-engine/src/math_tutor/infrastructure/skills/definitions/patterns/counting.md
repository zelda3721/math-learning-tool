# 计数展示模式 (Counting Pattern)

## 描述
用图形展示数量，让学生能"数"出来。

## 适用场景
- 加法、减法
- 数数、分组
- 任何涉及数量的问题

## 核心代码

```python
# 创建N个圆圈表示数量
def create_counting_group(count, color=BLUE, label_text=None):
    """创建可数的图形组"""
    items = VGroup(*[
        Circle(radius=0.12, color=color, fill_opacity=0.8)
        for _ in range(count)
    ])
    
    # 自动排列
    if count <= 10:
        items.arrange(RIGHT, buff=0.15)
    elif count <= 30:
        items.arrange_in_grid(rows=3, buff=0.12)
    else:
        items.arrange_in_grid(rows=5, buff=0.1)
    
    items.scale(0.6)
    
    # 添加数量标签
    if label_text:
        label = Text(label_text, font="Microsoft YaHei", font_size=18)
        label.next_to(items, DOWN, buff=0.2)
        return VGroup(items, label)
    
    return items

# 逐个出现动画
def show_counting(scene, items):
    """逐个展示，让学生能数"""
    scene.play(LaggedStart(
        *[GrowFromCenter(item) for item in items],
        lag_ratio=0.08,
        run_time=min(2, len(items) * 0.15)
    ))
    scene.wait(1)

# 合并两组（加法）
def merge_groups(scene, group1, group2):
    """合并动画，展示加法"""
    scene.play(
        group2.animate.next_to(group1, RIGHT, buff=0.15),
        run_time=1
    )
    scene.wait(1)

# 移除部分（减法）
def remove_items(scene, items, remove_count):
    """移除动画，展示减法"""
    remove_items = items[:remove_count]
    remaining = items[remove_count:]
    
    # 变红
    scene.play(remove_items.animate.set_color(RED), run_time=0.5)
    scene.wait(0.5)
    
    # 消失
    scene.play(FadeOut(remove_items, shift=UP), run_time=0.8)
    scene.wait(0.5)
    
    # 重新排列
    scene.play(remaining.animate.move_to(ORIGIN), run_time=0.5)
    
    return remaining
```

## 使用示例

### 加法: 5 + 3 = 8
```python
# 创建两组
group1 = create_counting_group(5, BLUE)
group2 = create_counting_group(3, GREEN)

# 展示
group1.move_to(LEFT * 2)
group2.move_to(RIGHT * 2)

show_counting(self, group1)
show_counting(self, group2)

# 合并
merge_groups(self, group1, group2)

# 显示结果
result = Text("= 8", font="Microsoft YaHei", font_size=24)
result.next_to(VGroup(group1, group2), RIGHT, buff=0.3)
self.play(Write(result))
```

## 关键原则
1. **每个圆圈 = 1个单位** - 学生能数出来
2. **逐个出现** - 用 LaggedStart 展示数量感
3. **合并/分离动画** - 展示运算过程
4. **颜色区分** - 不同组用不同颜色
