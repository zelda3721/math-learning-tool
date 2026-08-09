# Perimeter Trick Problem Skill (巧求周长)

## 描述
可视化巧求周长问题，通过图形变换将不规则图形转化为规则图形来计算周长。


## 视觉契约（Visual Contract — 违反即重写）
本 skill 必须遵守以下硬约束。inspect_video 评审时会按此打分；违反任一即触发 generate_manim_code 重新生成。

### 必须出现的 mobject 类型
- 至少 1 个非 Text 图形（Circle / Rectangle / Line / Arrow / NumberLine / Polygon 之一），数学概念必须用图形对应
- 图形数量 ≥ Text 数量（不能让屏幕只剩文字）

### 必须出现的动画类型
- 至少 1 次 **变换/位移类** 动画（Transform / TransformFromCopy / animate.shift / animate.move_to / Rotate / GrowFromCenter）——不仅仅 Write 和 FadeIn/FadeOut
- 至少 1 个动画的"前后状态"承载数学含义（颜色/位置/大小变化必须对应数量/关系/守恒的变化）

### 禁用反模式（命中即 bad）
- 连续 ≥3 个 `Write(Text(...))` + `FadeOut` 的翻页式步骤（PPT 翻页）
- 屏幕同时存在 ≥3 行 Text/MathTex（公式墙）
- 全片只有 Text，没有 Circle/Rectangle/Line 等图形（文字搬运）
- 关键运算只用 Text 写出来而无图形动画对应（应该让"变化"看得见）

### 三阶段教学锚点（每段必须出现且语义对应）
- **setup**：把题目里的对象用图形表达（圆点/线段/方块），让学生先"看见"
- **core/transform**：用动画展示数学关系——变换、增减、对比、守恒、对应
- **verify/reveal**：用图形或动画回到题目，确认答案的合理性

## 何时使用
- 题目中包含"周长"、"不规则"、"凹凸"、"台阶形"等关键词
- 需要通过平移边来简化周长计算
- 涉及复杂图形的周长

## 可视化原则
1. **原图展示** - 先展示原始不规则图形
2. **平移变换** - 动态展示边的平移过程
3. **等价转化** - 证明周长不变
4. **简化计算** - 转化为规则图形后计算

## 标准流程

### 步骤1：展示原始图形
```python
title = Text("巧求周长", font="Noto Sans CJK SC", font_size=36, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

# 创建台阶形图形（示例）
points = [
    [-2, -1, 0], [-2, 0, 0], [-1, 0, 0], [-1, 1, 0],
    [1, 1, 0], [1, 0, 0], [2, 0, 0], [2, -1, 0]
]
shape = Polygon(*[np.array(p) for p in points], color=BLUE, fill_opacity=0.3)
shape.scale(0.8).move_to(ORIGIN)

self.play(Create(shape))
self.wait(1)

# 标注边长
# ... (根据具体题目标注)
```

### 步骤2：分析平移机会
```python
hint = Text("观察：可以把凹进去的边平移出来", font="Noto Sans CJK SC", font_size=22, color=YELLOW)
hint.next_to(shape, DOWN, buff=0.5)
self.play(Write(hint))
self.wait(2)

# 高亮可平移的边
# 用不同颜色标注水平边和竖直边
```

### 步骤3：动画展示平移
```python
# 将内凹的边平移到外面
# 最终变成一个规则矩形

# 创建目标矩形
target_rect = Rectangle(width={width}, height={height}, color=GREEN, fill_opacity=0.3)
target_rect.next_to(shape, RIGHT, buff=1.5)

transform_text = Text("平移后等价于矩形", font="Noto Sans CJK SC", font_size=20)
transform_text.next_to(target_rect, DOWN, buff=0.3)

# 变换动画
self.play(Transform(shape.copy(), target_rect))
self.play(Write(transform_text))
self.wait(2)
```

### 步骤4：计算周长
```python
# 显示计算
calc = VGroup(
    Text("周长 = (长 + 宽) × 2", font="Noto Sans CJK SC", font_size=22),
    Text(f"     = ({width} + {height}) × 2", font="Noto Sans CJK SC", font_size=22),
    Text(f"     = {perimeter}厘米", font="Noto Sans CJK SC", font_size=22, color=GREEN),
)
calc.arrange(DOWN, buff=0.2, aligned_edge=LEFT)
calc.to_edge(DOWN, buff=0.5)

for line in calc:
    self.play(Write(line), run_time=0.6)

self.wait(3)
```

## 参数说明
- `{width}`: 等价矩形的宽
- `{height}`: 等价矩形的高
- `{perimeter}`: 周长 = (width + height) × 2

## 常见变换
1. **台阶形** → 矩形（横向边合并，纵向边合并）
2. **内凹形** → 向外推平
3. **L形** → 补全成矩形再减去

## 核心技巧
- 水平边向左/右平移不改变周长
- 竖直边向上/下平移不改变周长
- 最终所有水平边 = 矩形的2倍宽
- 最终所有竖直边 = 矩形的2倍高

## 注意事项
- ⚠️ 用箭头动画展示边的平移
- ⚠️ 变换前后对比展示
- ⚠️ 强调"周长不变"

## 示例
输入：台阶形图形，外围尺寸8厘米×6厘米
输出：平移内凹边 → 变成8×6矩形 → 周长=(8+6)×2=28厘米
