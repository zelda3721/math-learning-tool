# 变换过程模式 (Transformation Pattern)

## 描述
用图形动画展示"变化"的过程，让学生看到变化是怎么发生的。

## 适用场景
- 鸡兔同笼（2脚变4脚）
- 单位换算
- 替换问题
- 任何涉及"变化"的问题

## 核心代码

```python
# 逐个变换
def transform_items_one_by_one(scene, items, transform_count, new_color=BLUE, add_parts=None):
    """
    逐个变换物体
    
    Args:
        items: 要变换的物体组
        transform_count: 变换多少个
        new_color: 变换后的颜色
        add_parts: 可选，每个变换时添加的新部件（如新增的脚）
    """
    for i in range(transform_count):
        # 1. 变色（表示选中）
        scene.play(items[i].animate.set_color(new_color), run_time=0.2)
        
        # 2. 如果有新增部件，展示增长动画
        if add_parts:
            new_parts = add_parts(i, items[i])
            scene.play(
                *[GrowFromCenter(part) for part in new_parts],
                run_time=0.3
            )
            items[i].add(*new_parts)
        
        scene.wait(0.1)

# 创建带脚的动物（用于鸡兔同笼）
def create_animal_with_legs(leg_count=2, head_color=ORANGE):
    """创建带脚的动物图形"""
    head = Circle(radius=0.12, color=head_color, fill_opacity=0.9)
    
    legs = VGroup()
    leg_positions = []
    if leg_count == 2:
        leg_positions = [-0.05, 0.05]
    elif leg_count == 4:
        leg_positions = [-0.1, -0.03, 0.03, 0.1]
    
    for x in leg_positions:
        leg = Line(
            start=[x, -0.12, 0],
            end=[x, -0.28, 0],
            color=head_color,
            stroke_width=2
        )
        legs.add(leg)
    
    return VGroup(head, legs)

# 添加脚动画（鸡变兔）
def add_legs_animation(scene, animal, new_leg_count=2, new_color=BLUE):
    """给动物添加脚的动画"""
    pos = animal.get_center()
    
    new_legs = VGroup()
    # 新脚放在外侧
    offsets = [-0.1, 0.1] if new_leg_count == 2 else [-0.12, -0.04, 0.04, 0.12]
    
    for x in offsets[:new_leg_count]:
        new_leg = Line(
            start=pos + np.array([x, -0.12, 0]),
            end=pos + np.array([x, -0.25, 0]),
            color=new_color,
            stroke_width=2
        )
        new_legs.add(new_leg)
    
    scene.play(
        *[GrowFromCenter(leg) for leg in new_legs],
        run_time=0.3
    )
    animal.add(new_legs)
    
    return new_legs

# 实时计数器
def create_counter(initial_value, label, color=GREEN):
    """创建实时数值计数器"""
    return {"value": initial_value, "label": label, "color": color}

def update_counter(scene, counter_mob, new_value, label):
    """更新计数器"""
    new_counter = Text(f"{label}: {new_value}", font="Microsoft YaHei", font_size=20, color=GREEN)
    new_counter.to_edge(DOWN, buff=1)
    scene.play(Transform(counter_mob, new_counter), run_time=0.15)
```

## 使用示例

### 鸡变兔过程
```python
import numpy as np

# 1. 创建所有鸡
animals = VGroup(*[create_animal_with_legs(2, ORANGE) for _ in range(35)])
animals.arrange_in_grid(rows=5, buff=0.25).scale(0.5).move_to(ORIGIN)

# 2. 展示所有鸡
self.play(LaggedStart(*[FadeIn(a) for a in animals], lag_ratio=0.02))
self.wait(1)

# 3. 逐个变换：鸡 → 兔
rabbits_count = 12
current_feet = 70  # 35 * 2

feet_counter = Text(f"脚数: {current_feet}", font="Microsoft YaHei", font_size=20, color=GREEN)
feet_counter.to_edge(DOWN, buff=1)
self.play(Write(feet_counter))

for i in range(rabbits_count):
    # 变色
    self.play(animals[i][0].animate.set_color(BLUE), run_time=0.15)
    
    # 添加2只脚
    add_legs_animation(self, animals[i], 2, BLUE)
    
    # 更新计数
    current_feet += 2
    update_counter(self, feet_counter, current_feet, "脚数")

self.wait(2)
```

## 关键原则
1. **逐个变换** - 不是一次性全变，让学生看到过程
2. **先变色后添加** - 先标记，再添加新部件
3. **实时计数** - 变一个数一个
4. **GrowFromCenter** - 新增部分用增长动画
