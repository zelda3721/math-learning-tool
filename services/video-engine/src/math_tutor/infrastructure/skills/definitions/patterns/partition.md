# 分割模式 (Partition Pattern)

## 描述
把一个整体（线段、矩形、圆）切成若干份，展示份额、比例、分数关系。

## 适用场景
- 分数（1/2、3/4 等）
- 整体与部分（盒装糖果分配）
- 面积分解
- 比例问题

## 关键词
分, 切, 几分之, 平均, 比例, 面积, 一半

## 核心代码

```python
def partitioned_bar(total_units: int, fill_units: int, label: str = ""):
    """长条分成 total_units 段，前 fill_units 段填色"""
    width = 6.0
    height = 0.6
    seg_w = width / total_units
    bars = VGroup()
    for i in range(total_units):
        color = TEAL if i < fill_units else GRAY
        seg = Rectangle(width=seg_w * 0.95, height=height,
                        color=color, fill_opacity=0.7 if i < fill_units else 0.2)
        seg.move_to(np.array([(i - total_units / 2 + 0.5) * seg_w, 0, 0]))
        bars.add(seg)
    if label:
        text = Text(label, font="Microsoft YaHei", font_size=22)
        text.next_to(bars, DOWN, buff=0.3)
        return VGroup(bars, text)
    return bars


def fraction_pie(total: int, filled: int, radius: float = 1.4):
    """画一个被切成 total 份的饼，前 filled 份填色"""
    pie = VGroup()
    for i in range(total):
        start = i * 360 / total
        end = (i + 1) * 360 / total
        # 用 Arc + Lines 拼出扇区（避免 Sector 兼容问题）
        arc = Arc(radius=radius, start_angle=np.deg2rad(start),
                  angle=np.deg2rad(end - start), color=WHITE)
        line1 = Line(ORIGIN, arc.point_from_proportion(0))
        line2 = Line(ORIGIN, arc.point_from_proportion(1))
        sector = VGroup(arc, line1, line2)
        sector.set_fill(TEAL if i < filled else GRAY,
                        opacity=0.7 if i < filled else 0.15)
        sector.set_stroke(WHITE, width=2)
        pie.add(sector)
    return pie
```

## 使用示例

### 展示 3/4
```python
title = Text("3/4 表示什么？", font="Microsoft YaHei", font_size=24).to_edge(UP)
self.play(Write(title))

bar = partitioned_bar(total_units=4, fill_units=3, label="3 份 / 共 4 份")
bar.move_to(ORIGIN)
self.play(FadeIn(bar))
self.wait(2)

# 切换饼图视角
self.play(FadeOut(bar))
pie = fraction_pie(total=4, filled=3)
self.play(LaggedStart(*[FadeIn(p) for p in pie], lag_ratio=0.1))
self.wait(2)

answer = Text("3/4 = 0.75", font="Microsoft YaHei", font_size=26, color=GREEN).to_edge(DOWN)
self.play(Write(answer))
self.wait(2)
```

## 关键原则
1. **长条 vs 饼图二选一**：长条适合精确比例感，饼图适合"占多大"的直觉
2. **填色 vs 灰色**：明确区分"已分得"和"剩余"
3. **避免 Sector**：用 Arc + Line 拼扇区
