# Unit Unification Visualization Skill (份数统一)

## 描述
可视化"份数统一"过程，用于解决涉及倍数变化的问题。当题目中出现"原来的N份=现在的M份"时，通过图形动画展示这两种单位的等价关系。

## 何时使用
- 题目涉及倍数变化（如"从3倍变成4倍"）
- 需要统一不同状态下的"份"的概念
- 涉及"差倍问题"或"和倍问题"的关键步骤

## 可视化原则
1. **并排对比** - 同时展示两种份数表示
2. **动态等价** - 用动画展示"2份(旧) = 3份(新)"的等价关系
3. **颜色区分** - 原来的份用蓝色，现在的份用绿色
4. **平滑过渡** - 使用Transform展示单位转换

## 核心代码模板

### 场景：展示"原来的2份 = 现在的3份"
```python
# ===== 份数统一可视化 =====
# 演示：原来的2份(差) = 现在的3份(差)

# 1. 标题
title = Text("份数统一", font="Microsoft YaHei", font_size=32, color=YELLOW)
title.to_edge(UP, buff=0.5)
self.play(Write(title))

# 2. 创建"原来的2份"（蓝色，较大单位）
old_unit = Rectangle(width=1.5, height=0.5, color=BLUE, fill_opacity=0.6)
old_2_parts = VGroup(
    old_unit.copy(),
    old_unit.copy()
).arrange(RIGHT, buff=0.05)

old_label = Text("原来的差: 2份", font="Microsoft YaHei", font_size=20)
old_brace = Brace(old_2_parts, DOWN)
old_brace_text = Text("人数差", font="Microsoft YaHei", font_size=18, color=BLUE)
old_brace_text.next_to(old_brace, DOWN, buff=0.1)

old_group = VGroup(old_label, old_2_parts, old_brace, old_brace_text)
old_group.arrange(DOWN, buff=0.3)
old_group.move_to(LEFT * 3 + UP * 0.5)

self.play(Create(old_2_parts), Write(old_label))
self.play(Create(old_brace), Write(old_brace_text))
self.wait(1)

# 3. 创建"现在的3份"（绿色，较小单位）
new_unit = Rectangle(width=1.0, height=0.5, color=GREEN, fill_opacity=0.6)
new_3_parts = VGroup(
    new_unit.copy(),
    new_unit.copy(),
    new_unit.copy()
).arrange(RIGHT, buff=0.05)

new_label = Text("现在的差: 3份", font="Microsoft YaHei", font_size=20)
new_brace = Brace(new_3_parts, DOWN)
new_brace_text = Text("人数差(相同)", font="Microsoft YaHei", font_size=18, color=GREEN)
new_brace_text.next_to(new_brace, DOWN, buff=0.1)

new_group = VGroup(new_label, new_3_parts, new_brace, new_brace_text)
new_group.arrange(DOWN, buff=0.3)
new_group.move_to(RIGHT * 3 + UP * 0.5)

self.play(Create(new_3_parts), Write(new_label))
self.play(Create(new_brace), Write(new_brace_text))
self.wait(1)

# 4. 关键：展示等价关系
# 用等号连接两边
equals = Text("=", font="Microsoft YaHei", font_size=48, color=YELLOW)
equals.move_to(ORIGIN + UP * 0.5)
self.play(Write(equals))
self.wait(0.5)

# 5. 缩放动画：让两边"对齐"成相同总长度
# 计算缩放比例使两边长度相等
target_width = 3.0
self.play(
    old_2_parts.animate.stretch_to_fit_width(target_width),
    new_3_parts.animate.stretch_to_fit_width(target_width),
    run_time=1.5
)
self.wait(1)

# 6. 划分线：在"原来的2份"上画3等分线，展示每份对应关系
dividers = VGroup()
for i in range(1, 3):
    line = Line(
        old_2_parts.get_left() + RIGHT * (target_width / 3) * i + UP * 0.3,
        old_2_parts.get_left() + RIGHT * (target_width / 3) * i + DOWN * 0.3,
        color=YELLOW, stroke_width=2
    )
    dividers.add(line)

self.play(Create(dividers))
self.wait(1)

# 7. 结论：标注每份的数值
conclusion = Text("所以：1份(新) = 2/3份(旧) = 100人", font="Microsoft YaHei", font_size=24, color=GREEN)
conclusion.to_edge(DOWN, buff=1.0)
self.play(Write(conclusion))
self.wait(3)
```

## 参数说明
- `{old_parts}`: 原来的份数 (int, 如2)
- `{new_parts}`: 现在的份数 (int, 如3)
- `{quantity_name}`: 代表的数量名称 (如"人数差")
- `{unit_value}`: 计算出的每份数值 (如100人)

## 关键动画技巧
| 动画 | 目的 |
|------|------|
| `stretch_to_fit_width` | 让两种份数的总长"对齐" |
| `Create(dividers)` | 画等分线展示份数对应 |
| 等号动画 | 强调等价关系 |

## 常见错误规避
- ❌ 不要直接说"0.5份"，要先展示为什么是0.5
- ❌ 不要跳过等价关系的图形展示
- ✅ 使用并排对比 + 缩放对齐 + 等分线

## 示例
输入：原来差2份(甲-乙)，现在差3份(甲'-乙')，差值不变
输出：
1. 左边2个蓝色矩形（原2份）
2. 右边3个绿色矩形（新3份）
3. 等号连接，缩放对齐
4. 在蓝色矩形上画2条分隔线，展示3等分
5. 标注"1份(新) = 100人"
