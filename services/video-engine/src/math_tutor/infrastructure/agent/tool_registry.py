"""Holder for the LLM-callable tool set."""
from __future__ import annotations

from ...application.interfaces import ITool, ToolDefinition


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ITool] = {}
        #: 只供 API 路由按名直接调用的工具：不喂给控制器 LLM、不进对外契约。
        #: 与 writer/validator/renderer 被 compile_video 组合起来是同一个道理——
        #: 控制器该看到的是五个阶段，不是每一颗螺丝。
        self._internal: dict[str, ITool] = {}

    def register(self, tool: ITool) -> None:
        if tool.name in self._tools or tool.name in self._internal:
            raise ValueError(f"tool already registered: {tool.name}")
        self._tools[tool.name] = tool

    def register_internal(self, tool: ITool) -> None:
        """注册一个可按名取用、但不对外公开的工具。"""
        if tool.name in self._tools or tool.name in self._internal:
            raise ValueError(f"tool already registered: {tool.name}")
        self._internal[tool.name] = tool

    def get(self, name: str) -> ITool | None:
        return self._tools.get(name) or self._internal.get(name)

    def names(self) -> list[str]:
        return list(self._tools.keys())

    def list_definitions(self) -> list[ToolDefinition]:
        return [t.to_definition() for t in self._tools.values()]

    def __contains__(self, name: str) -> bool:
        return name in self._tools or name in self._internal

    def __len__(self) -> int:
        return len(self._tools)
