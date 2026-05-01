"""
LearnedMemory — a single markdown file the agent reads on every run.

Lives at `{data_dir}/learned_rules.md`. The user is free to edit it by hand;
P5+ may add an automatic distiller that appends rules from feedback. The
file is loaded fresh on each `read()` so edits take effect without restart.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


_DEFAULT_TEMPLATE = """# Learned Rules

> 这个文件是 agent 系统提示的一部分，包含跨会话的沉淀规则。
> 你可以随时手编。每次新对话都会重新读取，无需重启服务。

## 视觉风格偏好
- （示例）小学题目优先使用暖色 BLUE/PINK/YELLOW 配色，避免冷灰
- （示例）数量类题目（鸡兔同笼、植树问题等）一律用 Circle 表示个数

## 反模式（来自 bad 反馈）
- （示例）禁止把所有解题步骤直接 FadeIn 后立即 wait——必须配 LaggedStart 节奏
- （示例）禁止将文字与图形放在同一 Y 坐标，文字必须 to_edge(UP) / to_edge(DOWN)

## 检查清单
- 题目展示后是否 wait(2)
- 是否每个步骤都用动画体现而非直接显示结果
- 是否清理了上一阶段的元素再展示下一阶段
"""


class LearnedMemory:
    def __init__(self, data_dir: Path | str) -> None:
        self._path = Path(data_dir).expanduser().resolve() / "learned_rules.md"
        self._ensure_initialized()

    @property
    def path(self) -> Path:
        return self._path

    def _ensure_initialized(self) -> None:
        if not self._path.exists():
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                self._path.write_text(_DEFAULT_TEMPLATE, encoding="utf-8")
                logger.info("Seeded learned_rules.md template at %s", self._path)
            except OSError:
                logger.warning("Failed to seed learned_rules.md at %s", self._path)

    def read(self) -> str:
        try:
            return self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""
        except OSError as exc:
            logger.warning("read learned_rules.md failed: %s", exc)
            return ""

    def write(self, content: str) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._path.write_text(content, encoding="utf-8")
