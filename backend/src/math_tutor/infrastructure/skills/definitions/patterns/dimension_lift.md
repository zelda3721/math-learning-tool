# Dimension Lift Pattern (维度跃迁)

## 描述
当一个数学对象在低维难以理解时，**升一个维度**让它的本质显形。3Blue1Brown 经典手法（线性代数本质、欧拉公式）。

## 适用场景
- 复数（1D 实数 → 2D 复平面）
- 向量（1D 数 → 2D/3D 箭头）
- 函数图象（数 → 平面曲线）
- 面积 → 体积（2D 圆 → 3D 圆柱）
- 旋转矩阵（代数 → 几何旋转）

## 关键词
向量, 复数, 立体, 体积, 旋转, 投影, 维度

## ⚠️ 视觉契约
- 必须有**两个空间**（低维 + 高维）的清晰对应展示
- 升维必须是**动画过程**（move_camera / rotate / 平移），而不是 cut 切换
- 升维后必须**回到原问题**展示新解法（否则只是炫技）
- 至少出现一次 **3D Scene** 或 **2D NumberPlane** 的镜头切换

## 核心代码

```python
class LiftScene(ThreeDScene):
    """模板：先在 2D 演示，再 move_camera 拉到 3D 看本质。"""
    pass


def lift_2d_to_3d(scene, mob_2d, height=2.0):
    """把一个 2D 图形拉成 3D（z 方向）。返回 3D 拉伸后的对象。"""
    # 简化思路：复制并向 OUT 方向偏移
    top_copy = mob_2d.copy().shift(OUT * height)
    pillars = VGroup(*[
        Line(p, p + OUT * height, color=GRAY, stroke_width=1)
        for p in mob_2d.get_vertices()[:8]  # 只画几条立柱避免过密
    ])
    scene.play(Create(pillars), Create(top_copy), run_time=1.5)
    return VGroup(mob_2d, top_copy, pillars)


def show_complex_plane_from_real_line(scene):
    """把数轴升到复平面：1D NumberLine → 2D NumberPlane。"""
    line = NumberLine(x_range=[-3, 3], length=6, color=WHITE).move_to(ORIGIN)
    scene.play(Create(line))
    scene.wait(1)
    plane = NumberPlane(x_range=[-3, 3], y_range=[-3, 3]).move_to(ORIGIN)
    scene.play(Transform(line, plane))
    return plane
```

## 使用示例 — 复数 i² = −1 的几何解释

```python
title = Text("为什么 i² = −1？升维到复平面就明白了", font="Microsoft YaHei", font_size=22).to_edge(UP, buff=0.3)
self.play(Write(title))

# 第 1 阶：1D 数轴上看不见 i
line = NumberLine(x_range=[-3, 3], length=8, color=WHITE).move_to(ORIGIN)
self.play(Create(line))
question = Text("在数轴上，平方负一的数在哪？", font="Microsoft YaHei", font_size=20, color=GRAY).next_to(line, DOWN, buff=0.5)
self.play(Write(question))
self.wait(1.5)
shrug = Text("找不到 ¯\\_(ツ)_/¯", font="Microsoft YaHei", font_size=20, color=RED).move_to(question.get_center())
self.play(Transform(question, shrug))
self.wait(1)
self.play(FadeOut(question))

# 第 2 阶：升维 — 数轴变平面
plane = NumberPlane(x_range=[-3, 3], y_range=[-3, 3], background_line_style={"stroke_opacity": 0.4}).move_to(ORIGIN)
self.play(Transform(line, plane))
self.wait(1)

# 第 3 阶：1 在 (1, 0)，i 在 (0, 1)
arrow_1 = Arrow(ORIGIN, [1.5, 0, 0], buff=0, color=GREEN, stroke_width=4)
arrow_i = Arrow(ORIGIN, [0, 1.5, 0], buff=0, color=YELLOW, stroke_width=4)
label_1 = Text("1", font="Microsoft YaHei", font_size=22, color=GREEN).next_to(arrow_1, RIGHT, buff=0.1)
label_i = Text("i", font="Microsoft YaHei", font_size=22, color=YELLOW).next_to(arrow_i, UP, buff=0.1)
self.play(GrowArrow(arrow_1), Write(label_1))
self.play(GrowArrow(arrow_i), Write(label_i))
self.wait(1)

# 第 4 阶：核心 — 乘 i = 旋转 90°
explain = Text("乘 i = 逆时针旋转 90°", font="Microsoft YaHei", font_size=22, color=WHITE).to_edge(DOWN, buff=0.8)
self.play(Write(explain))
arrow_demo = Arrow(ORIGIN, [1.5, 0, 0], buff=0, color=BLUE, stroke_width=4)
self.play(Create(arrow_demo))
# 旋转 90°，到 i
self.play(Rotate(arrow_demo, angle=PI/2, about_point=ORIGIN), run_time=1.5)
# 再旋转 90°，到 −1
self.play(Rotate(arrow_demo, angle=PI/2, about_point=ORIGIN), run_time=1.5)
self.wait(0.5)

# 揭示
result = Text("i × i = −1（两次 90° = 180°，朝向反向）", font="Microsoft YaHei", font_size=22, color=GREEN).to_edge(DOWN, buff=0.3)
self.play(Transform(explain, result))
self.wait(3)
```

## 关键原则
1. **升维要有理由**——先展示低维的"困境"再升
2. **升维过程是动画**——用 Transform 把 NumberLine 变 NumberPlane
3. 升维后**用新空间解决原问题**——回到题目，展示新解法
4. 高维不是炫技——是降低认知负担
