# Perimeter Trick Problem Skill (巧求周长)

## 描述
可视化巧求周长问题，通过图形变换将不规则图形转化为规则图形来计算周长。

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
