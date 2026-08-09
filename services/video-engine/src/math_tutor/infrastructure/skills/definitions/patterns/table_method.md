# 列表枚举模式 (Table Method Pattern)

## 描述
用网格列出所有可能性，逐行筛选符合条件的组合。适合枚举量不大的题目。

## 适用场景
- 鸡兔同笼的列表解法（小学三四年级常用）
- 简单的方程组（一种穷举验证）
- 排列组合的可视化
- 找规律题（先列前几项）

## 关键词
列表, 枚举, 一一列举, 表格, 找规律, 试一试

## 核心代码

```python
def make_enumeration_table(rows: list[list[str]], header: list[str]):
    """rows: 每行是字符串列表，与 header 长度一致"""
    n_cols = len(header)
    cell_w, cell_h = 1.6, 0.55
    table = VGroup()
    # 表头
    for j, h in enumerate(header):
        cell = Rectangle(width=cell_w, height=cell_h,
                         color=BLUE, fill_opacity=0.4)
        text = Text(h, font="Microsoft YaHei", font_size=18)
        cell.move_to(np.array([j * cell_w, 0, 0]))
        text.move_to(cell.get_center())
        table.add(VGroup(cell, text))
    # 数据行
    for i, row in enumerate(rows):
        for j, value in enumerate(row):
            cell = Rectangle(width=cell_w, height=cell_h,
                             color=GRAY, fill_opacity=0.2)
            text = Text(str(value), font="Microsoft YaHei", font_size=16)
            cell.move_to(np.array([j * cell_w, -(i + 1) * cell_h, 0]))
            text.move_to(cell.get_center())
            table.add(VGroup(cell, text))
    table.move_to(ORIGIN).scale(0.7)
    return table


def reveal_row_by_row(scene, table, header_count, row_count, target_row=None):
    """逐行展示，最后高亮命中的那行"""
    # 表头一次出
    head = VGroup(*table[:header_count])
    scene.play(FadeIn(head))
    scene.wait(0.6)

    # 数据行逐行
    cells_per_row = header_count
    for i in range(row_count):
        row_group = VGroup(*table[header_count + i * cells_per_row:
                                   header_count + (i + 1) * cells_per_row])
        scene.play(LaggedStart(*[FadeIn(c) for c in row_group], lag_ratio=0.05))
        scene.wait(0.4)

    # 高亮目标行
    if target_row is not None:
        row_group = VGroup(*table[header_count + target_row * cells_per_row:
                                   header_count + (target_row + 1) * cells_per_row])
        box = SurroundingRectangle(row_group, color=YELLOW, buff=0.05)
        scene.play(Create(box))
        scene.wait(2)
```

## 使用示例

### 鸡兔同笼（共 5 头，14 脚）的列表解法
```python
header = ["鸡", "兔", "脚数"]
rows = [
    ["5", "0", "10"],
    ["4", "1", "12"],
    ["3", "2", "14"],   # 命中
    ["2", "3", "16"],
    ["1", "4", "18"],
    ["0", "5", "20"],
]
table = make_enumeration_table(rows, header)
title = Text("列表枚举法", font="Microsoft YaHei", font_size=22).to_edge(UP, buff=0.3)
self.play(Write(title))
reveal_row_by_row(self, table, header_count=3, row_count=6, target_row=2)
```

## 关键原则
1. **每行单独出现**：让学生跟着逐个验证
2. **命中行最后高亮**：用 SurroundingRectangle 强化"答案"
3. **行数 ≤ 8**：超过 8 行就不该用枚举法
