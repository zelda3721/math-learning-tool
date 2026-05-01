# 路径模式 (Journey Pattern)

## 描述
画一条数轴/路径，让点在上面移动，用相对位置展示运动、相遇、追及。

## 适用场景
- 相遇问题（两人相向而行）
- 追及问题
- 行程类应用题
- 数轴上点的移动

## 关键词
相遇, 追及, 行驶, 同时出发, 速度, 路程, 数轴

## 核心代码

```python
def make_road(length=10, label_left="A", label_right="B", color=GRAY):
    """画一条横向路径"""
    line = Line(LEFT * length / 2, RIGHT * length / 2, color=color, stroke_width=3)
    left_dot = Dot(LEFT * length / 2, color=YELLOW)
    right_dot = Dot(RIGHT * length / 2, color=YELLOW)
    left_label = Text(label_left, font="Microsoft YaHei", font_size=18).next_to(left_dot, DOWN, buff=0.2)
    right_label = Text(label_right, font="Microsoft YaHei", font_size=18).next_to(right_dot, DOWN, buff=0.2)
    return VGroup(line, left_dot, right_dot, left_label, right_label)


def make_traveler(road, color=BLUE, side="left", emoji_text="🚶"):
    """road 是 make_road 返回的 VGroup；side='left' 或 'right'"""
    line = road[0]
    start = line.get_start() if side == "left" else line.get_end()
    icon = Text(emoji_text, font="Apple Color Emoji", font_size=28)
    icon.move_to(start + UP * 0.4)
    return icon


def play_meeting(scene, road, traveler_a, traveler_b, meet_point_ratio=0.5, run_time=4):
    """两个旅行者相向而行，在 meet_point_ratio 处相遇"""
    line = road[0]
    meet_point = line.point_from_proportion(meet_point_ratio) + UP * 0.4
    scene.play(
        traveler_a.animate.move_to(meet_point + LEFT * 0.15),
        traveler_b.animate.move_to(meet_point + RIGHT * 0.15),
        run_time=run_time,
    )
    spark = Text("💥", font="Apple Color Emoji", font_size=36)
    spark.move_to(meet_point + UP * 0.3)
    scene.play(FadeIn(spark, scale=2))
    scene.wait(1)


def play_chasing(scene, road, leader, chaser, catch_ratio=0.7, lead_speed=1.0, chase_speed=1.5):
    """追及：chaser 比 leader 快，最终在 catch_ratio 处追上"""
    line = road[0]
    catch_point = line.point_from_proportion(catch_ratio) + UP * 0.4
    leader_distance = line.point_from_proportion(catch_ratio) - leader.get_center() + UP * 0.4
    scene.play(
        leader.animate.move_to(catch_point + LEFT * 0.05),
        chaser.animate.move_to(catch_point + RIGHT * 0.05),
        run_time=4,
    )
```

## 使用示例

### 相遇问题
```python
title = Text("两车从 A、B 两地同时相向出发", font="Microsoft YaHei", font_size=22).to_edge(UP, buff=0.4)
self.play(Write(title))

road = make_road(length=8, label_left="A", label_right="B")
road.move_to(ORIGIN)
self.play(Create(road))

car_a = make_traveler(road, side="left", emoji_text="🚗")
car_b = make_traveler(road, side="right", emoji_text="🚙")
self.play(FadeIn(car_a), FadeIn(car_b))
self.wait(1)

play_meeting(self, road, car_a, car_b, meet_point_ratio=0.4, run_time=3)
self.wait(2)

answer = Text("相遇时 A 走了路程 0.4，B 走了 0.6", font="Microsoft YaHei", font_size=20, color=GREEN)
answer.to_edge(DOWN)
self.play(Write(answer))
self.wait(3)
```

## 关键原则
1. **路径要清晰**：一条 Line + 两端的 Dot/Label
2. **旅行者用 emoji**：🚶/🚗/🚙/🐢/🐰 比抽象 Dot 直观
3. **相遇用 💥 标记点**：明确"在哪相遇"
4. **配合时间字幕**：next 步骤用 Text 写"经过 t 秒"
