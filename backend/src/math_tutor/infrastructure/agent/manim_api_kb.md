# Manim API 知识库（RITL-DOC 检索源）

> 基于 [Manim Community Edition](https://docs.manim.community/) 文档 + 官方 examples + 我们项目里实际反复用到的 API 整理。
> 每条条目用 `### API名` 起，带 `**关键词**:` 行供检索匹配。
> 检索器按错误信息里的 token 匹配每条 keywords，命中数高的注入到下一次 generate_manim_code 的 prompt。

---

## 创建图形对象（Mobjects）

### Circle
**签名**: `Circle(radius=1.0, color=WHITE, fill_opacity=0.0, stroke_width=4, **kwargs)`
**用法**:
```python
c = Circle(radius=0.3, color=BLUE, fill_opacity=0.7)
```
**坑**: `radius` 是浮点单位，画布范围 ±7×±4，不是像素。`fill_opacity=0` 时只有描边。
**关键词**: circle, 圆, 圆圈, 圆点

### Rectangle
**签名**: `Rectangle(width=4.0, height=2.0, color=WHITE, fill_opacity=0.0, **kwargs)`
**用法**:
```python
r = Rectangle(width=3, height=0.5, color=BLUE, fill_opacity=0.6)
```
**坑**: 用 `Square(side_length=...)` 不是 `Rectangle(width=x, height=x)`，更语义化。
**关键词**: rectangle, square, 矩形, 长方形, 正方形, 条形

### Line
**签名**: `Line(start=LEFT, end=RIGHT, color=WHITE, stroke_width=4, **kwargs)`
**用法**:
```python
seg = Line(LEFT * 2, RIGHT * 2, color=YELLOW, stroke_width=3)
arrow_like = Line(ORIGIN, UP, stroke_width=2)
```
**坑**: start/end 必须是 3D 坐标（np.array 或常量如 LEFT、UP、ORIGIN）。
**关键词**: line, 线, 线段, 直线

### Arrow
**签名**: `Arrow(start, end, buff=0.25, stroke_width=6, max_tip_length_to_length_ratio=0.25, color=WHITE)`
**用法**:
```python
a = Arrow(ORIGIN, UP * 2, color=RED, buff=0)
self.play(GrowArrow(a))
```
**坑**: `buff` 默认会让箭头**离起终点都缩进一点**——演示精确指向时设 `buff=0`。`GrowArrow` 是专用入场动画。
**关键词**: arrow, 箭头, 指向

### Polygon / Triangle
**签名**: `Polygon(*vertices, color=WHITE, fill_opacity=0.0, **kwargs)`
**用法**:
```python
tri = Polygon(ORIGIN, [3, 0, 0], [0, 4, 0], color=BLUE, fill_opacity=0.4)
```
**坑**: `Triangle()` 是默认正三角；任意三角形用 `Polygon`。`get_vertices()` 拿到顶点列表。
**关键词**: polygon, triangle, 三角形, 多边形

### Square
**签名**: `Square(side_length=2.0, **kwargs)`
**用法**:
```python
s = Square(side_length=1, color=GREEN, fill_opacity=0.5)
```
**关键词**: square, 正方形, 方块

---

## 文本与公式

### Text
**签名**: `Text(text, font="Sans", font_size=48, color=WHITE, weight=NORMAL, slant=NORMAL, **kwargs)`
**用法**:
```python
title = Text("鸡兔同笼", font="Microsoft YaHei", font_size=32, color=YELLOW)
```
**坑**: **中文必须指定 `font="Microsoft YaHei"`**（macOS / Windows 自带）；否则方块字。`font_size` 是像素相关，不是 TeX point。
**关键词**: text, 文字, 标题, 中文

### MathTex / Tex
**签名**: `MathTex(*tex_strings, color=WHITE, **kwargs)`
**用法**:
```python
eq = MathTex(r"a^2 + b^2 = c^2")
```
**坑**: **依赖系统 LaTeX 安装**！没装 LaTeX → 直接挂。中文请用 `Text` 不要用 `Tex`。我们项目默认 `MANIM_USE_LATEX=false`，**严禁 MathTex/Tex/Matrix**。
**关键词**: mathtex, tex, latex, 公式, mathematical, equation

### MarkupText
**签名**: `MarkupText(text, font="Sans", font_size=48, **kwargs)`
**用法**:
```python
t = MarkupText('<span foreground="blue">蓝色</span>普通')
```
**坑**: 支持 Pango Markup（HTML-like），可单段彩色；中文同样要 `font=`。
**关键词**: markuptext, 富文本, 彩色文字

---

## 组合与布局（VGroup / arrange）

### VGroup
**签名**: `VGroup(*mobjects)` / `VGroup.add(mob)` / `VGroup.remove(mob)`
**用法**:
```python
group = VGroup(circle1, circle2, circle3)
group.set_color(BLUE)  # 整组改色
group[0]  # 索引访问
```
**坑**: VGroup 自身也是 Mobject，可以再嵌套。`Group` 类似但允许非 VMobject（图片、视频等）。
**关键词**: vgroup, 组, 群组, 分组

### arrange
**签名**: `mob.arrange(direction=RIGHT, buff=MED_SMALL_BUFF, center=True, aligned_edge=ORIGIN)`
**用法**:
```python
items = VGroup(*[Circle(radius=0.2) for _ in range(5)])
items.arrange(RIGHT, buff=0.15)  # 横排，间距 0.15
items.arrange(DOWN, buff=0.3, aligned_edge=LEFT)  # 纵排，左对齐
```
**坑**: 调用后整组**自动居中到 ORIGIN**，要单独 `move_to(...)` 或 `to_edge(...)` 重定位。`aligned_edge=LEFT/RIGHT/UP/DOWN/ORIGIN` 控制对齐基准。
**关键词**: arrange, 排列, 横排, 纵排, 一字排开

### arrange_in_grid
**签名**: `mob.arrange_in_grid(rows=None, cols=None, buff=MED_SMALL_BUFF, **kwargs)`
**用法**:
```python
group = VGroup(*[Square(side_length=0.4) for _ in range(20)])
group.arrange_in_grid(rows=4, buff=0.2).scale(0.7)
```
**坑**: 只指定 `rows` 或 `cols` 之一即可，另一个自动算。**整组先排再 scale 比单个 scale 后再排好**——比例容易控。
**关键词**: arrange_in_grid, 网格, 排成方阵, grid, 重叠, anchor, 布局

---

## 定位（Positioning）

### move_to
**签名**: `mob.move_to(point_or_mob, aligned_edge=ORIGIN, coor_mask=...)`
**用法**:
```python
title.move_to(np.array([0, 3.3, 0]))
group.move_to(ORIGIN + DOWN * 0.5)
label.move_to(circle.get_center())
```
**坑**: 改的是中心点，不是左下角。坐标可以是 `np.array([x,y,z])` 或方向常量组合（`UP * 2 + LEFT * 1`）。**多个对象同时 move_to(ORIGIN) 会重叠**——必须 arrange / next_to / shift 错开。
**关键词**: move_to, 移动到, 位置, position, 重叠, anchor, 布局, overlap, 堆叠

### to_edge / to_corner
**签名**: `mob.to_edge(direction, buff=DEFAULT_MOBJECT_TO_EDGE_BUFFER)` / `to_corner(direction, buff=...)`
**用法**:
```python
title.to_edge(UP, buff=0.4)        # 顶部居中
note.to_corner(UR, buff=0.3)       # 右上角
```
**坑**: 默认 `buff=0.5`；想贴边设小一点（0.2-0.4）。`to_corner(UR/UL/DR/DL)` 是 to_edge 的二维版本。
**关键词**: to_edge, to_corner, 顶部, 底部, 边缘, 角落

### next_to
**签名**: `mob.next_to(other, direction=RIGHT, buff=DEFAULT_MOBJECT_TO_MOBJECT_BUFFER, aligned_edge=ORIGIN)`
**用法**:
```python
label = Text("3").next_to(circle, DOWN, buff=0.1)
arrow.next_to(box, RIGHT, buff=0.2)
```
**坑**: 静态版本；如果 `circle` 后面动了，label 不跟随。要跟随用 `always_redraw` 或 `add_updater`。
**关键词**: next_to, 旁边, 紧邻, 跟随

### shift / animate.shift
**签名**: `mob.shift(*vectors)` / `mob.animate.shift(...)`
**用法**:
```python
mob.shift(UP * 2 + RIGHT)              # 静态偏移
self.play(mob.animate.shift(LEFT * 3)) # 动画化偏移
```
**关键词**: shift, 偏移, 移位

### scale
**签名**: `mob.scale(scale_factor, about_point=None, about_edge=ORIGIN)`
**用法**:
```python
group.scale(0.7)             # 整组缩 70%
mob.scale(1.5, about_point=mob.get_top())  # 以顶部为锚点放大
```
**关键词**: scale, 缩放, 放大, 缩小

### align_to
**签名**: `mob.align_to(other, direction=ORIGIN)`
**用法**:
```python
label.align_to(circle, LEFT)   # 左边缘对齐
```
**关键词**: align_to, 对齐, alignment

---

## 坐标系与方向常量

### 方向常量
- **基本**: `ORIGIN=(0,0,0)`、`UP=(0,1,0)`、`DOWN=(0,-1,0)`、`LEFT=(-1,0,0)`、`RIGHT=(1,0,0)`
- **斜向**: `UR=UP+RIGHT`、`UL=UP+LEFT`、`DR=DOWN+RIGHT`、`DL=DOWN+LEFT`
- **可乘标量**: `UP * 2`（向上 2 单位）、`LEFT * 3 + UP * 1`（左 3 上 1）
- **画布范围**: x ∈ [-7, 7]、y ∈ [-4, 4]
**关键词**: ORIGIN, UP, DOWN, LEFT, RIGHT, 方向, 坐标

### get_center / get_corner / get_top / get_bottom
**用法**:
```python
center = circle.get_center()       # np.array([x, y, z])
top_left = box.get_corner(UL)
y_top = title.get_top()[1]         # 取 y 分量
```
**关键词**: get_center, get_corner, get_top, 中心点, 边界

### NumberLine
**签名**: `NumberLine(x_range=[-1,1,1], length=8, color=GREY, include_numbers=False, **kwargs)`
**用法**:
```python
nl = NumberLine(x_range=[-3, 3, 1], length=6, color=BLUE)
dot = Dot(nl.n2p(2), color=YELLOW)  # 数轴上 x=2 的点
```
**坑**: `n2p(value)` 数 → 点（np.array），最常用；反向 `p2n(point)`。
**关键词**: numberline, 数轴, n2p, 数轴上的点

### Axes
**签名**: `Axes(x_range, y_range, x_length=12, y_length=6, axis_config={...})`
**用法**:
```python
axes = Axes(x_range=[-3,3,1], y_range=[0,9,1], x_length=4, y_length=3.5)
graph = axes.plot(lambda x: x**2, color=YELLOW)
dot = Dot(axes.coords_to_point(2, 4))
```
**坑**: `coords_to_point(x, y)` 把数学坐标转画布坐标，必用。`axes.plot(f)` 画函数图象。
**关键词**: axes, 坐标系, plot, 函数图象, coords_to_point

### NumberPlane
**签名**: `NumberPlane(x_range=[-7,7,1], y_range=[-4,4,1], **kwargs)`
**用法**:
```python
plane = NumberPlane(x_range=[-3, 3], y_range=[-3, 3])
```
**关键词**: numberplane, 平面, 坐标平面, 网格

---

## 入场动画

### Write
**签名**: `Write(mob, run_time=2)`
**用法**: `self.play(Write(title))`
**坑**: 适合 Text / MathTex / 路径类对象；用在大块图形上不自然，改 `Create` 或 `FadeIn`。
**关键词**: write, 写出, 入场

### FadeIn / FadeOut
**用法**: `self.play(FadeIn(mob, shift=UP * 0.2))` / `self.play(FadeOut(mob))`
**坑**: `shift=` 给一个轻微入场偏移更生动；`FadeIn` 通用，不挑对象类型。
**关键词**: fadein, fadeout, 淡入, 淡出

### Create
**用法**: `self.play(Create(circle, run_time=1.5))`
**坑**: 描边类对象（Circle/Polygon/Line）的最自然入场；填充对象上效果一般。
**关键词**: create, 创建, 描边出现

### GrowFromCenter / GrowFromPoint / GrowArrow
**用法**:
```python
self.play(GrowFromCenter(circle))
self.play(GrowArrow(arrow))
```
**关键词**: grow, growfromcenter, growarrow, 生长出现

### DrawBorderThenFill
**用法**: `self.play(DrawBorderThenFill(square))`
**坑**: 先画边界再填色，质感最好；专给 fill_opacity > 0 的对象用。
**关键词**: drawborderthenfill, 边界后填充

---

## 变换动画（关键）

### Transform
**签名**: `Transform(start_mob, target_mob)`
**用法**:
```python
square = Square()
circle = Circle()
self.add(square)
self.play(Transform(square, circle))   # square 现在变成 circle 的形态
```
**坑**: 起点必须已在 scene 里。结束后 `square` 这个变量**仍引用原 mob 但视觉是 circle**——容易踩。需要"换身份"用 `ReplacementTransform`。
**关键词**: transform, 变换, 变成, morph

### ReplacementTransform
**用法**: `self.play(ReplacementTransform(square, circle))`
**坑**: 变换后 `square` 不在 scene 里，`circle` 在。逻辑更清晰，**首选**。
**关键词**: replacementtransform, 替换, 真正变成

### TransformFromCopy
**用法**: `self.play(TransformFromCopy(eq1, eq2))`
**坑**: `eq1` 留着，`eq2` 从 `eq1` 复制后变化过来。**写公式推导一行变下一行用这个**。
**关键词**: transformfromcopy, 复制变换, 推导, 等式变换

### FadeTransform
**用法**: `self.play(FadeTransform(old, new))`
**坑**: 旧的淡出 + 新的淡入，比 Transform 自然但少了"形变"语义。
**关键词**: fadetransform, 淡入淡出变换

---

## 移动 / 路径 / 旋转

### MoveAlongPath
**用法**:
```python
path = Arc(radius=2, start_angle=0, angle=PI)
dot = Dot(path.get_start())
self.play(MoveAlongPath(dot, path), run_time=2)
```
**关键词**: movealongpath, 沿路径, 轨迹

### Rotate
**签名**: `Rotate(mob, angle, axis=OUT, about_point=None, run_time=1)`
**用法**:
```python
self.play(Rotate(square, PI/2))                    # 旋转 90°
self.play(Rotate(arrow, PI/2, about_point=ORIGIN)) # 绕原点
```
**坑**: 角度用弧度（PI/2 = 90°）。`DEGREES` 常量：`90 * DEGREES = PI/2`。
**关键词**: rotate, 旋转, 转动

### animate.shift / animate.move_to / animate.scale
**用法**:
```python
self.play(mob.animate.shift(UP * 2))
self.play(mob.animate.move_to(LEFT * 3))
self.play(mob.animate.scale(1.5))
```
**坑**: `.animate` 把任意 mob 方法变成动画。多个 `.animate.x().y().z()` 链式调用是同一动画里多个属性同步变化。
**关键词**: animate, .animate, 链式动画

### animate.set_color / animate.set_fill / animate.set_opacity
**用法**:
```python
self.play(circle.animate.set_color(RED))
self.play(group.animate.set_fill(BLUE, opacity=0.6))
```
**坑**: **没有 `set_fill_opacity`**——是 `set_fill(color, opacity=)` 或 `set_opacity(...)`。
**关键词**: set_color, set_fill, set_opacity, 改色, 改透明度

---

## 组合动画

### LaggedStart
**签名**: `LaggedStart(*animations, lag_ratio=0.05, run_time=1)`
**用法**:
```python
self.play(LaggedStart(*[GrowFromCenter(c) for c in items], lag_ratio=0.1, run_time=2))
```
**坑**: lag_ratio ∈ [0, 1]：0=同时，1=完全串行。**多个动画用 `*[..]` unpack**，不是传 list。`LaggedStartMap(Animation, group)` 更简洁。
**关键词**: laggedstart, 错峰, 逐个出现, 一个一个

### AnimationGroup
**用法**:
```python
self.play(AnimationGroup(FadeIn(a), FadeIn(b), FadeIn(c), lag_ratio=0))
```
**坑**: 默认所有动画**同时**进行（lag_ratio=0），等价于 `self.play(FadeIn(a), FadeIn(b), FadeIn(c))`。
**关键词**: animationgroup, 同时动画

### Succession
**用法**: `self.play(Succession(FadeIn(a), FadeIn(b)))`
**坑**: 严格串行（一个完了下一个）。等价于连续两次 self.play。
**关键词**: succession, 串行, 一个接一个

---

## 动态对象（核心高级用法）

### ValueTracker
**签名**: `ValueTracker(value)`
**用法**:
```python
t = ValueTracker(0)
dot = always_redraw(lambda: Dot(axes.c2p(t.get_value(), t.get_value()**2)))
self.add(dot)
self.play(t.animate.set_value(3), run_time=4)
```
**坑**: 通过 `t.get_value()` 读、`t.animate.set_value(x)` 改；对 ValueTracker 的动画自动 propagate 到 always_redraw 注册的对象。
**关键词**: valuetracker, 数值追踪, 参数动画

### always_redraw
**签名**: `always_redraw(lambda: <构造 mobject>)`
**用法**:
```python
ang = ValueTracker(0)
arrow = always_redraw(lambda: Arrow(ORIGIN, [np.cos(ang.get_value()), np.sin(ang.get_value()), 0]))
self.add(arrow)
self.play(ang.animate.set_value(2 * PI), run_time=4)
```
**坑**: lambda 必须返回**新构造的 mobject**，不是修改旧的。每帧重建——计算量大时考虑 add_updater 替代。
**关键词**: always_redraw, 重绘, 动态

### TracedPath
**签名**: `TracedPath(point_func, stroke_color=WHITE, stroke_width=3)`
**用法**:
```python
dot = always_redraw(lambda: Dot(axes.c2p(t.get_value(), t.get_value()**2)))
trace = TracedPath(dot.get_center, stroke_color=YELLOW, stroke_width=4)
self.add(dot, trace)
```
**坑**: `point_func` 是 callable，每帧调用拿当前位置。**留下尾迹**画函数图象很有用。
**关键词**: tracedpath, 轨迹, 尾迹, 画曲线

### add_updater
**用法**:
```python
def follow(mob, dt):
    mob.move_to(other.get_center() + UP * 0.5)
label.add_updater(follow)
self.add(label)
```
**坑**: 比 always_redraw 高效（不重建对象）。要用 `mob.remove_updater(follow)` 解绑，否则一直跑。
**关键词**: add_updater, updater, 跟随更新

---

## Scene 控制

### self.play
**用法**:
```python
self.play(Write(t1), GrowFromCenter(c1), run_time=1.5)  # 多个动画并行
self.play(t1.animate.shift(UP), c1.animate.scale(2))    # animate 链同样并行
```
**坑**: 一次 play 里的动画都是**并行**的；要串行用多个 play 或 Succession。
**关键词**: self.play, play, 播放动画

### self.wait
**用法**: `self.wait(2)`
**坑**: **千万别忘**！每个关键画面后留 `wait(1.5-2)` 让学生看清。`wait(0)` 不算等待。
**关键词**: self.wait, wait, 暂停, 停顿

### self.add / self.remove
**用法**:
```python
self.add(static_mob)        # 直接放进 scene 不带动画
self.remove(old_mob)        # 直接移除不带动画
```
**坑**: 适合预设场景；动态场景应该用 FadeIn/FadeOut 这种动画版。
**关键词**: self.add, self.remove, 添加, 移除

---

## 我们项目的禁用对象（重要）

### Sector / AnnularSector / Annulus
**禁用！** 这三个对象在 Manim CE 某些版本里 API 不稳定，渲染容易崩。
**替代**:
- 扇形 → `ArcPolygon` 或 `Arc + Line` 拼
- 圆环 → `Circle(radius=R) - Circle(radius=r)`（用 `Difference` 集合操作）
**关键词**: sector, annular, annulus, 扇形, 圆环, 禁用

### ThreeDScene
**禁用！** 3D 渲染慢且不稳定，本项目设计是 2D 教学；需要"立体感"用透视模拟（投影 + 阴影）。
**关键词**: threedscene, 3d, 三维, 立体

### Surface
**禁用！** 同 ThreeDScene 风险。
**关键词**: surface, 曲面

---

## 常见错误诊断

### `'Mobject' object has no attribute 'X'`
**多半是**：用了不存在的方法（如 `set_fill_opacity`）。**正确**: `set_fill(color, opacity=...)` 或 `set_opacity(...)`。
**关键词**: AttributeError, has no attribute, 没有属性

### `LaTeX Error` / `MathTex` 渲染失败
**多半是**：MANIM_USE_LATEX=false 但代码用了 MathTex/Tex。**改用 `Text`**。
**关键词**: latex, mathtex, 编译失败

### `IndexError: list index out of range`（VGroup 里）
**多半是**：`group[N]` 越界。VGroup 用前先看 `len(group)` 或检查源数据。
**关键词**: indexerror, 越界

### `TypeError: __init__() got an unexpected keyword argument`
**多半是**：API 在新版 Manim 改了；查官方文档对应版本的签名。
**关键词**: typeerror, unexpected keyword

---

## Manim 渲染配置（可选）

### config.frame_size / frame_width / frame_height
**默认**: 14.222 × 8 单位（16:9）；像素 1920×1080。
**关键词**: config, frame_size, 画布大小

### scene 命令行
- `manim -pql file.py SolutionScene`：低质量预览（480p）
- `manim -pqh file.py SolutionScene`：高质量（1080p）
- `-s` 只渲最后一帧
**关键词**: pql, pqh, 渲染质量, manim 命令
