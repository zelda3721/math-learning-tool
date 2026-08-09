# Extremes Sweep Pattern (参数扫描看极端)

## 描述
让一个参数在 `[ε, 大值]` 之间扫描，让画面动态变形，**让"为什么需要这个条件"显而易见**。Bret Victor 的"Ladder of Abstraction"思想。

## 适用场景
- 不等式紧不紧（参数在临界值时 = 等号）
- 函数性态（极值点、单调性）
- 几何题（三角形不等式、四边形性质）
- 参数方程（圆变椭圆变双曲线）
- 检验直觉（"为什么大于零？"试一下小于零会怎样）

## 关键词
极端, 极限, 不等式, 大于, 小于, 临界, 当, 如果, 反例

## ⚠️ 视觉契约
- 必须有 **ValueTracker** 控制可调参数
- 必须扫到至少 **2 个极端值**（最小/最大），让学生看到"过头会怎样"
- 在临界值处必须有**视觉提示**（颜色变红/闪烁/暂停）
- 不允许"只演示一个固定参数"——这就回到了无效讲法

## 核心代码

```python
def sweep_param(scene, tracker: ValueTracker, target_values: list[float], 
                pause_at_critical: list[bool] = None, color_critical=RED, run_time_per_step=1.5):
    """让 tracker 顺序扫到每个目标值，临界点暂停一下。"""
    if pause_at_critical is None:
        pause_at_critical = [False] * len(target_values)
    for v, is_crit in zip(target_values, pause_at_critical):
        scene.play(tracker.animate.set_value(v), run_time=run_time_per_step)
        if is_crit:
            # 临界点：闪烁提示
            scene.wait(0.3)
            scene.wait(1.0)


def make_param_label(tracker, label_prefix="t = ", color=YELLOW, font_size=22):
    """实时显示 tracker 的当前值。"""
    return always_redraw(lambda: Text(
        f"{label_prefix}{tracker.get_value():.2f}",
        font="Microsoft YaHei", font_size=font_size, color=color
    ).to_edge(UP, buff=0.5))
```

## 使用示例 — 三角形不等式：a + b > c

```python
title = Text("为什么三角形必须满足 a + b > c？", font="Microsoft YaHei", font_size=22).to_edge(UP, buff=0.3)
self.play(Write(title))
self.wait(1)

# 三角形 ABC：A 固定在 (-2, -1)，B 固定在 (2, -1)，C 在上方可调
# AB = c = 4，AC = b（左腿），BC = a（右腿）
# 让 c 从 4（合法）扫到 8（退化）
A = np.array([-2, -1, 0])
B = np.array([2, -1, 0])

# c_tracker 控制 AB 的"虚拟长度"——通过保持 a + b = 5 时改变 c
c_tracker = ValueTracker(4.0)
ab_sum = 5.0  # a + b 固定为 5

def get_C(c_val):
    """根据 c 算 C 点。a + b = 5，c 变 → 三角形高变。
    用余弦定理或简化：让 C 在 AB 中垂线上，高度 h = sqrt(b² − (c/2)²)。"""
    # 假设 a = b = ab_sum / 2 = 2.5
    half_c = c_val / 2
    leg = ab_sum / 2
    h_sq = leg**2 - half_c**2
    h = np.sqrt(max(0, h_sq))
    return np.array([0, -1 + h, 0])

# 三角形 + 边长标签
def make_triangle():
    C = get_C(c_tracker.get_value())
    return Polygon(
        np.array([-c_tracker.get_value()/2, -1, 0]),
        np.array([ c_tracker.get_value()/2, -1, 0]),
        C,
        color=BLUE, fill_opacity=0.4, stroke_width=3,
    )

triangle = always_redraw(make_triangle)
self.add(triangle)

# 边长 c 的实时显示
c_label = always_redraw(lambda: Text(
    f"c = {c_tracker.get_value():.2f}（a + b = {ab_sum}）",
    font="Microsoft YaHei", font_size=20, color=YELLOW
).to_edge(DOWN, buff=1.0))
self.add(c_label)

# === 扫参数：c 从 4（合法）扫到 5（退化为线段） ===
explain1 = Text("c 越大，三角形越扁", font="Microsoft YaHei", font_size=18).to_edge(DOWN, buff=0.3)
self.play(Write(explain1))
self.play(c_tracker.animate.set_value(4.5), run_time=2)
self.wait(0.5)

# 临界值：c → 5（a + b = c 时退化为线段）
self.play(c_tracker.animate.set_value(4.95), run_time=2)
self.wait(0.5)
critical = Text("c → 5 时三角形退化为线段！", font="Microsoft YaHei", font_size=20, color=RED).to_edge(DOWN, buff=0.3)
self.play(Transform(explain1, critical))
self.play(c_tracker.animate.set_value(4.99), run_time=1.5)
self.wait(2)

# 收尾：揭示原因
conclusion = VGroup(
    Text("如果 a + b ≤ c，三个点共线（不是三角形）", font="Microsoft YaHei", font_size=18, color=ORANGE),
    Text("∴ 必须 a + b > c", font="Microsoft YaHei", font_size=22, color=GREEN),
).arrange(DOWN, buff=0.2).to_edge(DOWN, buff=0.3)
self.play(Transform(explain1, conclusion))
self.wait(3)
```

## 关键原则
1. **扫到极端**——不要保守地停在"中间值"，要让学生看到"再过去就崩了"
2. **临界点有提示**——颜色变红、文字变化、画面暂停
3. **回到题目**——扫完之后说清楚"所以条件是 X"
4. **速度可变**——平常区域快扫，临界附近慢动作
