# Chicken-Rabbit Problem Skill (鸡兔同笼)

## 描述
可视化经典的鸡兔同笼问题，使用假设法动画直观展示解题过程。

## 何时使用
- 题目中包含"鸡"、"兔"、"头"、"脚"、"腿"等关键词
- 涉及两种不同属性物体的混合计数问题
- 需要通过假设法求解的问题

## 可视化原则
1. **假设法动画** - 先假设全是鸡，动态"变换"成兔子
2. **数量对应** - 头数用圆圈，脚数用线条
3. **差异高亮** - 用颜色标注假设与实际的差值
4. **过程展示** - 逐步变换直到满足条件

## 标准流程

### 步骤1：展示题目条件
```python
# 显示题目
title = Text("鸡兔同笼问题", font="Noto Sans CJK SC", font_size=36, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

# 显示条件
condition = Text("共{heads}个头，{legs}只脚", font="Noto Sans CJK SC", font_size=28)
condition.next_to(title, DOWN, buff=0.5)
self.play(Write(condition))
self.wait(2)
```

### 步骤2：假设全是鸡
```python
# 创建"鸡"的图形（用2只脚的图标表示）
chickens = VGroup()
for i in range({heads}):
    chicken = VGroup(
        Circle(radius=0.15, color=ORANGE, fill_opacity=0.8),  # 头
        Line(ORIGIN, DOWN * 0.2, color=ORANGE).shift(LEFT * 0.05),  # 左脚
        Line(ORIGIN, DOWN * 0.2, color=ORANGE).shift(RIGHT * 0.05)  # 右脚
    )
    chickens.add(chicken)

chickens.arrange_in_grid(rows=2, buff=0.3)
chickens.scale(0.6).move_to(ORIGIN)

step1 = Text("假设全是鸡：{heads}×2={assumed_legs}只脚", font="Noto Sans CJK SC", font_size=24)
step1.to_edge(LEFT, buff=0.5).shift(DOWN * 2)

self.play(Write(step1))
self.play(LaggedStart(*[FadeIn(c) for c in chickens], lag_ratio=0.1))
self.wait(2)
```

### 步骤3：计算差值并变换
```python
# 显示差值
diff = {legs} - {assumed_legs}
diff_text = Text(f"实际比假设多 {diff} 只脚", font="Noto Sans CJK SC", font_size=24, color=RED)
diff_text.next_to(step1, DOWN, buff=0.3)
self.play(Write(diff_text))
self.wait(1)

# 每只兔比鸡多2只脚，需要变换的数量
rabbits_count = diff // 2
change_text = Text(f"每只兔比鸡多2只脚，需变{rabbits_count}只", font="Noto Sans CJK SC", font_size=24, color=GREEN)
change_text.next_to(diff_text, DOWN, buff=0.3)
self.play(Write(change_text))
self.wait(1)

# 动画：将部分"鸡"变成"兔"（添加2只脚）
for i in range({rabbits}):
    # 变换颜色并添加脚
    self.play(chickens[i].animate.set_color(BLUE))
    extra_legs = VGroup(
        Line(ORIGIN, DOWN * 0.2, color=BLUE).shift(LEFT * 0.1),
        Line(ORIGIN, DOWN * 0.2, color=BLUE).shift(RIGHT * 0.1)
    )
    extra_legs.scale(0.6).next_to(chickens[i], DOWN, buff=0.05)
    self.play(FadeIn(extra_legs))
    self.wait(0.3)

self.wait(2)
```

### 步骤4：显示结果
```python
# 清理并显示结果
result_box = Rectangle(width=6, height=1.2, color=GREEN, fill_opacity=0.2)
result_box.to_edge(DOWN, buff=0.5)

result = Text("答：鸡{chickens}只，兔{rabbits}只", font="Noto Sans CJK SC", font_size=32, color=GREEN)
result.move_to(result_box.get_center())

self.play(Create(result_box), Write(result))
self.wait(3)
```

## 参数说明
- `{heads}`: 总头数
- `{legs}`: 总脚数
- `{assumed_legs}`: 假设全是鸡时的脚数 = heads × 2
- `{chickens}`: 鸡的数量
- `{rabbits}`: 兔的数量

## 公式
- 兔数 = (实际脚数 - 头数×2) ÷ 2
- 鸡数 = 头数 - 兔数

## 布局要求
- 题目和条件在顶部
- 动物图形在中央
- 计算步骤在左下方
- 结果在底部

## 注意事项
- ⚠️ 动物数量较多时使用网格排列
- ⚠️ 变换动画要逐个进行，突出过程
- ⚠️ 用颜色区分鸡（橙色）和兔（蓝色）

## 示例
输入：共有35个头，94只脚
输出：假设35只鸡(70脚) → 差24脚 → 变12只成兔 → 鸡23只，兔12只
