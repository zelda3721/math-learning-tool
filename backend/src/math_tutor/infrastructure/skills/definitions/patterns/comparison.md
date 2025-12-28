# 比较对比模式 (Comparison Pattern)

## 描述
用上下或左右排列的图形，直观展示两个量的对比关系。

## 适用场景
- 大小比较
- 多/少多少
- 相差问题
- 倍数关系

## 核心代码

```python
# 创建对比图
def create_comparison(count1, count2, color1=BLUE, color2=GREEN):
    """创建上下对比的两组"""
    group1 = VGroup(*[Circle(radius=0.1, color=color1, fill_opacity=0.8) for _ in range(count1)])
    group2 = VGroup(*[Circle(radius=0.1, color=color2, fill_opacity=0.8) for _ in range(count2)])
    
    group1.arrange(RIGHT, buff=0.12)
    group2.arrange(RIGHT, buff=0.12)
    
    # 上下排列，左对齐
    group1.move_to(UP * 0.8)
    group2.move_to(DOWN * 0.8)
    group2.align_to(group1, LEFT)
    
    return group1, group2

# 高亮差异部分
def highlight_difference(scene, group1, group2):
    """高亮多出的部分"""
    min_count = min(len(group1), len(group2))
    
    if len(group1) > len(group2):
        extra = group1[min_count:]
        diff_count = len(group1) - len(group2)
    else:
        extra = group2[min_count:]
        diff_count = len(group2) - len(group1)
    
    # 高亮多出部分
    box = SurroundingRectangle(extra, color=RED, buff=0.08)
    label = Text(f"多 {diff_count}", font="Microsoft YaHei", font_size=18, color=RED)
    label.next_to(box, RIGHT, buff=0.2)
    
    scene.play(Create(box), Write(label))
    scene.wait(1.5)
    
    return diff_count

# 用线段比较（适合大数）
def create_bar_comparison(value1, value2, label1, label2, max_width=5):
    """用线段长度表示数量对比"""
    max_val = max(value1, value2)
    
    len1 = (value1 / max_val) * max_width
    len2 = (value2 / max_val) * max_width
    
    bar1 = Rectangle(width=len1, height=0.3, color=BLUE, fill_opacity=0.7)
    bar2 = Rectangle(width=len2, height=0.3, color=GREEN, fill_opacity=0.7)
    
    bar1.move_to(UP * 0.6)
    bar2.move_to(DOWN * 0.6)
    bar1.align_to(LEFT * 3, LEFT)
    bar2.align_to(LEFT * 3, LEFT)
    
    lbl1 = Text(f"{label1}: {value1}", font="Microsoft YaHei", font_size=18)
    lbl2 = Text(f"{label2}: {value2}", font="Microsoft YaHei", font_size=18)
    lbl1.next_to(bar1, LEFT, buff=0.3)
    lbl2.next_to(bar2, LEFT, buff=0.3)
    
    return VGroup(bar1, lbl1), VGroup(bar2, lbl2)
```

## 使用示例

### 比较: 8 比 5 多多少?
```python
# 创建对比
group1, group2 = create_comparison(8, 5, BLUE, GREEN)

# 逐个展示
self.play(LaggedStart(*[FadeIn(c) for c in group1], lag_ratio=0.08))
self.wait(0.5)
self.play(LaggedStart(*[FadeIn(c) for c in group2], lag_ratio=0.08))
self.wait(1)

# 高亮差异
diff = highlight_difference(self, group1, group2)

# 显示答案
answer = Text(f"多 {diff} 个", font="Microsoft YaHei", font_size=24, color=YELLOW)
answer.to_edge(DOWN)
self.play(Write(answer))
```

## 关键原则
1. **左对齐** - 便于比较长度差异
2. **上下排列** - 直观看出多少
3. **高亮差异** - 用框标出多出的部分
4. **颜色区分** - 两组用不同颜色
