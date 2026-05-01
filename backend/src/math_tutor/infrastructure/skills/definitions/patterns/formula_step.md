# 公式逐步模式 (Formula Step Pattern)

## 描述
把一个解方程或代数变形的过程一步步展示出来，每一步用动画"导出"下一行。

## 适用场景
- 解方程（一元一次、一元二次、方程组）
- 代数式化简
- 因式分解
- 公式推导

## 关键词
方程, 解方程, 化简, 移项, 代入, 因式分解, =

## 核心代码

```python
def stack_equations(equations: list[str], font_size=24, line_buff=0.4):
    """把一组等式上下排列，居中"""
    lines = VGroup(*[Text(eq, font="Microsoft YaHei", font_size=font_size) for eq in equations])
    lines.arrange(DOWN, buff=line_buff, aligned_edge=LEFT)
    lines.move_to(ORIGIN)
    return lines


def reveal_steps(scene, lines: VGroup, hint_texts: list[str] = None):
    """逐行揭示等式；hint_texts 与 lines 一一对应，写在右边解释这一步做了什么"""
    for i, line in enumerate(lines):
        if i == 0:
            scene.play(Write(line))
        else:
            # 上一行抄一份，写新等式
            prev = lines[i - 1]
            scene.play(TransformFromCopy(prev, line))
        if hint_texts and i < len(hint_texts) and hint_texts[i]:
            hint = Text(hint_texts[i], font="Microsoft YaHei", font_size=18, color=YELLOW)
            hint.next_to(line, RIGHT, buff=0.5)
            scene.play(FadeIn(hint, shift=LEFT * 0.2))
            scene.wait(1.5)
            scene.play(FadeOut(hint))
        else:
            scene.wait(1)


def highlight_term(scene, line, term_text: str, color=RED):
    """高亮一行中某个子项（当行是 Text，需要切片定位）"""
    # 简单方案：用 SurroundingRectangle 框住整行强调一下
    box = SurroundingRectangle(line, color=color, buff=0.08)
    scene.play(Create(box))
    scene.wait(0.8)
    scene.play(FadeOut(box))
```

## 使用示例

### 解方程 2x + 3 = 11
```python
title = Text("解方程：2x + 3 = 11", font="Microsoft YaHei", font_size=24).to_edge(UP, buff=0.4)
self.play(Write(title))

steps = [
    "2x + 3 = 11",
    "2x = 11 - 3",
    "2x = 8",
    "x = 4",
]
hints = [
    "",
    "两边减 3（移项）",
    "化简右边",
    "两边除 2",
]
lines = stack_equations(steps)
reveal_steps(self, lines, hint_texts=hints)
self.wait(1)

answer = Text("x = 4", font="Microsoft YaHei", font_size=30, color=GREEN).to_edge(DOWN, buff=0.5)
self.play(Write(answer))
self.wait(3)
```

## 关键原则
1. **TransformFromCopy 比 FadeIn 强**：让学生看到"是从上一行变来的"
2. **每步配 hint_text**：写在右边解释"这一步做了什么"
3. **左对齐**：等号位置不一定对齐，但每行起始位置一致
4. **不要用 MathTex**（除非确认 LaTeX 已装）
