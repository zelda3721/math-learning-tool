# Dissection Proof Pattern (拼图证明 / Proof Without Words)

## 描述
把图形切片重排，**不写一个字**就证明数学等式。源自 MAA "proof without words" 系列，是几何视觉化教学的高峰。

## 适用场景
- 勾股定理 a² + b² = c²（Bhāskara 拼图、欧几里得平移）
- 完全平方差 (a−b)² = a² − 2ab + b²
- 几何级数 1/2 + 1/4 + 1/8 + … = 1（拼成完整正方形）
- 三角形面积 = 底×高/2（剪一半拼成长方形）
- 圆面积 = πr²（割成扇形拼成长方形）

## 关键词
证明, 等于, ², 平方, 面积, 拼, 切, 等价, =

## ⚠️ 视觉契约
- 必须有 **起始图形** 和 **目标图形** 两个状态，并通过 Transform / 平移动画**严丝合缝**地拼接
- 至少有 1 次 `MoveAlongPath` 或 `animate.shift` 让切片**移动**到新位置
- 不允许仅用 Text 写"a²+b²=c²"——这就是 PWW 的反面
- 切片**着色不变**（同一片在前后两个状态颜色相同），让学生能"追踪"它

## 核心代码

```python
def split_and_translate(scene, original: VMobject, pieces: list[VMobject], targets: list[np.ndarray], run_time=2.0):
    """把 original 切成 pieces 列表，每片移动到 targets[i] 位置。"""
    scene.play(FadeOut(original))
    scene.play(*[FadeIn(p) for p in pieces], run_time=0.5)
    anims = [p.animate.move_to(t) for p, t in zip(pieces, targets)]
    scene.play(*anims, run_time=run_time)


def make_right_triangle(a, b, *, color=BLUE, fill_opacity=0.6):
    """造一个直角三角形（直角在原点，两腿沿 +X +Y）。"""
    return Polygon(ORIGIN, [a, 0, 0], [0, b, 0], color=color, fill_opacity=fill_opacity)
```

## 使用示例 — Bhāskara 风格的勾股定理证明

```python
title = Text("勾股定理：a² + b² = c²", font="Microsoft YaHei", font_size=24).to_edge(UP, buff=0.3)
self.play(Write(title))

a, b = 1.5, 2.0
c = (a**2 + b**2) ** 0.5

# === 第 1 阶：在边长 c 的大正方形里塞 4 个直角三角形，中间留一个 (b−a)² 小正方形 ===
big_square = Square(side_length=c, color=WHITE, stroke_width=2).move_to(LEFT * 3)
self.play(Create(big_square))

# 4 个直角三角形（着色：蓝橙红绿）
tri_colors = [BLUE, ORANGE, RED, GREEN]
tris = []
positions = [
    big_square.get_corner(DOWN+LEFT),
    big_square.get_corner(DOWN+RIGHT),
    big_square.get_corner(UP+RIGHT),
    big_square.get_corner(UP+LEFT),
]
rotations = [0, 90, 180, 270]
for i, (pos, rot) in enumerate(zip(positions, rotations)):
    t = make_right_triangle(a, b, color=tri_colors[i]).move_to(pos).rotate(rot * DEGREES, about_point=pos)
    tris.append(t)
    self.play(FadeIn(t), run_time=0.4)

inner = Square(side_length=abs(b - a), color=YELLOW, fill_opacity=0.4, stroke_width=1).move_to(big_square.get_center())
self.play(Create(inner))
caption_left = Text("c² 的正方形 = 4△ + (b−a)²", font="Microsoft YaHei", font_size=18, color=WHITE).next_to(big_square, DOWN, buff=0.3)
self.play(Write(caption_left))
self.wait(2)

# === 第 2 阶：把 4 个三角形重新拼成一个 a² + b² 的图形 ===
big_square_right = Square(side_length=c, color=WHITE, stroke_width=2).move_to(RIGHT * 3)
self.play(Create(big_square_right))

# 把 4 个三角形分别 Transform 到右图新位置（拼成两个矩形围出 a² 和 b²）
new_positions = [
    big_square_right.get_corner(DOWN+LEFT) + RIGHT*(a/2),
    big_square_right.get_corner(DOWN+LEFT) + RIGHT*(a) + UP*(b/2),
    big_square_right.get_corner(UP+RIGHT) + LEFT*(a/2),
    big_square_right.get_corner(UP+RIGHT) + LEFT*(a) + DOWN*(b/2),
]
self.play(*[
    Transform(tris[i].copy(), tris[i].copy().move_to(new_positions[i]))
    for i in range(4)
], run_time=2)

# 中间露出 a² 和 b² 两块
square_a = Square(side_length=a, color=PURPLE, fill_opacity=0.4).align_to(big_square_right, DOWN+LEFT)
square_b = Square(side_length=b, color=TEAL, fill_opacity=0.4).align_to(big_square_right, UP+RIGHT)
self.play(Create(square_a), Create(square_b))
caption_right = Text("c² 的正方形 = 4△ + a² + b²", font="Microsoft YaHei", font_size=18, color=WHITE).next_to(big_square_right, DOWN, buff=0.3)
self.play(Write(caption_right))
self.wait(2)

# === 第 3 阶：等量代换得出 a² + b² = c² ===
conclusion = Text("∴ a² + b² = c²", font="Microsoft YaHei", font_size=32, color=GREEN).to_edge(DOWN, buff=0.5)
self.play(Write(conclusion))
self.wait(3)
```

## 关键原则
1. **同一片切片颜色不变**——这是 dissection proof 的灵魂，让学生能追踪它的运动
2. **Transform 不是 FadeOut+FadeIn**——必须看到"它从哪里来到哪里去"
3. 两个状态**并列展示**（左右两个画面），等量关系一目了然
4. 切片数尽量少（4 个三角形比 8 个干净）
