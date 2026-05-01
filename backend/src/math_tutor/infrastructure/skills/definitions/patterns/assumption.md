# 假设法模式 (Assumption Pattern)

## 描述
先假设极端情况，发现矛盾，逐步调整。最经典的应用是鸡兔同笼。

## 适用场景
- 鸡兔同笼及一切"两类物品 + 两个总量"问题
- 龟兔、自行车三轮车、大小桶之类的同构题
- 钱币组合（5 元 / 10 元、邮票面值组合）

## 关键词
鸡兔同笼, 假设, 全部是, 头, 脚, 腿, 都看作

## 核心代码

```python
def assumption_visualization(scene, total_heads, total_legs, legs_a=2, legs_b=4, label_a="鸡", label_b="兔"):
    """通用假设法可视化：先假设全是 A，发现脚少了，再换成 B"""
    # 第一步：画 N 个头 (Circle)
    heads = VGroup(*[Circle(radius=0.18, color=YELLOW, fill_opacity=0.8) for _ in range(total_heads)])
    heads.arrange_in_grid(rows=max(1, total_heads // 7), buff=0.2).scale(0.7)
    heads.to_edge(UP, buff=0.6)
    title = Text(f"共 {total_heads} 个头", font="Microsoft YaHei", font_size=22)
    title.next_to(heads, DOWN, buff=0.3)
    scene.play(LaggedStart(*[FadeIn(h) for h in heads], lag_ratio=0.05))
    scene.play(Write(title))
    scene.wait(1.5)

    # 第二步：假设全是 A，每个头下画 legs_a 条线
    assume_label = Text(f"假设全是 {label_a}（每只 {legs_a} 条腿）",
                        font="Microsoft YaHei", font_size=20, color=BLUE)
    assume_label.next_to(title, DOWN, buff=0.4)
    scene.play(Write(assume_label))

    legs_groups = []
    for h in heads:
        legs = VGroup(*[Line(h.get_center() + DOWN * 0.2, h.get_center() + DOWN * 0.5, color=BLUE)
                        for _ in range(legs_a)])
        legs.arrange(RIGHT, buff=0.04).next_to(h, DOWN, buff=0.05)
        legs_groups.append(legs)
    scene.play(LaggedStart(*[Create(l) for l in legs_groups], lag_ratio=0.05))
    scene.wait(1)

    # 第三步：算出差额
    assumed_legs = total_heads * legs_a
    diff = total_legs - assumed_legs
    diff_per = legs_b - legs_a
    extra_per_swap = diff_per
    swap_count = diff // diff_per

    diff_text = Text(
        f"假设腿 {assumed_legs}，实际 {total_legs}，差 {diff} 条；每换一只补 {diff_per} 条",
        font="Microsoft YaHei", font_size=18, color=ORANGE,
    )
    diff_text.to_edge(DOWN, buff=1.0)
    scene.play(Write(diff_text))
    scene.wait(2)

    # 第四步：把 swap_count 个 A 换成 B（再补 legs_b - legs_a 条腿）
    for i in range(min(swap_count, len(heads))):
        target = heads[i]
        scene.play(target.animate.set_color(RED), run_time=0.2)
        new_legs = VGroup(*[Line(target.get_center() + DOWN * 0.2, target.get_center() + DOWN * 0.5, color=RED)
                            for _ in range(diff_per)])
        new_legs.arrange(RIGHT, buff=0.04).next_to(legs_groups[i], RIGHT, buff=0.02)
        scene.play(Create(new_legs), run_time=0.15)

    answer = Text(
        f"{label_b} {swap_count} 只，{label_a} {total_heads - swap_count} 只",
        font="Microsoft YaHei", font_size=26, color=GREEN,
    )
    answer.to_edge(DOWN, buff=0.4)
    scene.play(FadeOut(diff_text), Write(answer))
    scene.wait(3)
```

## 关键原则
1. **可视化"假设"过程**：先全画 A，看到结果再调整
2. **颜色区分**：YELLOW = 头，BLUE = A 的腿，RED = 换成 B 后补的腿
3. **差额显式呈现**：用 Text 把 "差几条腿" 这一步写清楚
4. **节奏**：第一阶段慢（让学生数），调整阶段快（节奏感）
