"""
AgentLoop — the harness agent's main loop.

Drives turns of (compose system prompt → stream LLM → execute tool calls
→ append messages) until the model stops calling tools or max_turns is
reached. Yields typed AgentEvent objects so the SSE endpoint can forward
them. Also persists every step to ConversationStore for replay and
labeling.

The production tools form a dependency graph, so calls are executed in order.
Large tool payloads (especially generated code) stay in session state and are
compacted before being appended to LLM history.  This bounds context growth
without depriving downstream tools of artifacts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

from ...application.interfaces import (
    ChatMessage,
    ILLMProvider,
    ITool,
    ReasoningDelta,
    StreamDone,
    TextDelta,
    ToolCallEvent,
    ToolCallSpec,
    ToolContext,
    ToolResult,
)
from ..storage import ConversationStore
from .events import (
    AgentEvent,
    DoneEvent,
    ErrorEvent,
    ReasoningChunk,
    SessionCreated,
    TextChunk,
    ToolCallResult,
    ToolCallStart,
)
from .learned_memory import LearnedMemory
from .prompt_composer import PromptComposer
from .tool_registry import ToolRegistry

logger = logging.getLogger(__name__)


# Solve is a single committed mathematical artifact. Re-running it after a
# verifier defect used to create solve→verify loops and silently replace a
# correct derivation. Verification may retry its own format once; later stages
# own only evidence-directed local repair.
_STAGE_ATTEMPT_LIMITS: dict[str, int] = {
    "solve_problem": 1,
    "verify_solution": 2,
    "direct_video": 1,
    # These stages already own one evidence-directed internal repair.
    "compile_video": 1,
    "watch_video": 1,
}


def _stage_budget_error(tool_name: str, attempts: int) -> str | None:
    """Return a user-facing stop reason when a stage would retry again."""
    limit = _STAGE_ATTEMPT_LIMITS.get(tool_name, 1)
    if attempts < limit:
        return None
    if limit == 1:
        return (
            f"{tool_name} 的首轮及阶段内部定向修复仍未满足质量门禁；"
            "已停止继续试错，请检查该阶段证据或更换模型后重新生成。"
        )
    return (
        f"{tool_name} 已完成首轮和一次兜底，仍未满足质量门禁；"
        "已停止继续试错，请检查该阶段证据或更换模型后重新生成。"
    )


def _compact_tool_data(tool_name: str, data: Any) -> Any:
    """Return only controller-relevant fields for the next LLM turn."""
    if not isinstance(data, dict):
        text = str(data)
        return text[:1200] + ("…" if len(text) > 1200 else "")
    if tool_name == "generate_manim_code":
        code = data.get("code") or ""
        return {
            "code_stored_in_state": bool(code),
            "code_chars": len(code) if isinstance(code, str) else 0,
            "fix_scope": data.get("fix_scope"),
        }
    if tool_name == "compile_video":
        code = data.get("code") or ""
        return {
            "code_stored_in_state": bool(code),
            "code_chars": len(code) if isinstance(code, str) else 0,
            "video_url": data.get("video_url"),
            "internal_repair_count": data.get("internal_repair_count", 0),
        }
    allowed_by_tool = {
        "analyze_problem": ("difficulty", "question", "objects", "relations", "constraints"),
        "solve_problem": ("strategy", "answer"),
        "verify_solution": ("passed", "message", "mode", "expected_matched_actual"),
        "visual_plan": ("visual_thesis", "essence_rationale"),
        "validate_manim_code": (
            "valid",
            "syntax_error",
            "structure_issues",
            "overlap_risk_issues",
            "occupancy_overlap_issues",
            "zone_violations",
            "visual_evidence_issues",
        ),
        "run_manim": ("video_path", "video_url", "returncode", "error"),
        "inspect_video": (
            "overall_quality",
            "b_total",
            "blacklist_hits",
            "issues",
            "fix_suggestion",
        ),
        "direct_video": ("visual_thesis", "essence_rationale"),
        "watch_video": (
            "overall_quality",
            "b_total",
            "blacklist_hits",
            "issues",
            "internal_repair_count",
            "replanned",
            "video_url",
        ),
    }
    keys = allowed_by_tool.get(tool_name)
    if keys is None:
        return {key: data[key] for key in list(data)[:8]}
    return {key: data[key] for key in keys if key in data}


def _allowed_tool_names(state: dict[str, Any], *, review_available: bool) -> set[str]:
    """Expose only valid next actions for the current workflow state."""
    if not state.get("solution_steps"):
        return {"solve_problem"}
    if state.get("solution_verified") is not True:
        if state.get("last_verify_failure"):
            return {"solve_problem", "verify_solution"}
        if state.get("last_verify_format_failure"):
            return {"verify_solution"}
        return {"verify_solution"}
    if not isinstance(state.get("visual_plan"), dict):
        return {"direct_video"}
    if not state.get("latest_video_path"):
        return {"compile_video"}
    if review_available and (
        not state.get("last_visual_review") or state.get("last_visual_failed")
    ):
        return {"watch_video"}
    if state.get("last_visual_failed"):
        return {"watch_video"}
    return set()


def _select_next_tool(state: dict[str, Any], *, review_available: bool) -> str | None:
    """Deterministic recovery policy for the bounded workflow."""
    allowed = _allowed_tool_names(state, review_available=review_available)
    if len(allowed) == 1:
        return next(iter(allowed))
    if not allowed:
        return None
    if state.get("last_verify_failure"):
        return "solve_problem"
    if state.get("last_verify_format_failure"):
        return "verify_solution"
    return sorted(allowed)[0]


@dataclass
class _ToolOutcome:
    """The full per-call outcome returned by `_execute_one_tool`."""

    tc: ToolCallEvent
    result: ToolResult
    duration_ms: int
    artifact_records: list[dict[str, Any]] = field(default_factory=list)
    final_video_path: str | None = None
    final_video_url: str | None = None
    unknown_tool_error: str | None = None


class AgentLoop:
    def __init__(
        self,
        *,
        llm: ILLMProvider,
        registry: ToolRegistry,
        composer: PromptComposer,
        store: ConversationStore,
        use_latex: bool,
        learned_memory: LearnedMemory | None = None,
        max_turns: int = 12,
        tool_timeout_s: float = 120.0,
        per_turn_max_tokens: int = 2048,
        wiki_ingester: Any = None,
        deterministic_workflow: bool = True,
    ) -> None:
        self._llm = llm
        self._registry = registry
        self._composer = composer
        self._store = store
        self._use_latex = use_latex
        self._learned_memory = learned_memory
        self._max_turns = max_turns
        self._tool_timeout = tool_timeout_s
        # Cap on the agent's between-tools reasoning. Keeping this short is
        # the single biggest knob for end-to-end latency: every extra token
        # of "now I will call X" thinking costs wall-clock time on a local
        # 35B model. Tool internals have their own (much larger) budgets.
        self._per_turn_max_tokens = max(256, per_turn_max_tokens)
        # Optional wiki ingester (LEARNED_WIKI_ENABLED=true). When set, fires
        # a fire-and-forget background task on session done to extract any
        # non-trivial lesson from this session. Failure of ingester never
        # blocks the response — see WikiIngester.schedule.
        self._wiki_ingester = wiki_ingester
        self._deterministic_workflow = deterministic_workflow

    async def run(
        self,
        *,
        problem: str,
        grade: str,
        session_id: str | None = None,
        extra_directives: str | None = None,
    ) -> AsyncIterator[AgentEvent]:
        if session_id is None:
            session_id = await self._store.create_session(
                problem=problem,
                grade=grade,
                meta={
                    "engine": "five_stage_workflow_v3",
                    "quality_contract": "open_world_v4",
                    "narration_timeline": "webvtt_v1",
                },
            )
        yield SessionCreated(session_id=session_id)

        # The bounded workflow chooses stages in code, so it needs neither a
        # controller system prompt nor controller tool schemas. Individual
        # tools still receive their focused prompts and promoted lessons.
        history: list[ChatMessage] = [ChatMessage(role="user", content=problem)]
        if not self._deterministic_workflow:
            learned_context = self._learned_memory.read() if self._learned_memory else None
            system_prompt = self._composer.compose(
                grade=grade,
                use_latex=self._use_latex,
                learned_context=learned_context,
                extra_directives=extra_directives,
            )
            history.insert(0, ChatMessage(role="system", content=system_prompt))
        await self._store.append_message(session_id, 0, "user", problem)

        # Per-session mutable working memory passed to every tool.
        state: dict[str, Any] = {
            "use_latex": self._use_latex,
            "extra_directives": extra_directives or "",
        }

        all_tool_definitions = (
            [] if self._deterministic_workflow else self._registry.list_definitions()
        )
        final_video_path: str | None = None
        final_video_url: str | None = None

        stage_attempts: Counter[str] = Counter()
        for turn_index in range(1, self._max_turns + 1):
            text_acc: list[str] = []
            reasoning_acc: list[str] = []
            tool_calls_emitted: list[ToolCallEvent] = []
            stream_finished = False
            finish_reason = "stop"

            allowed_names = _allowed_tool_names(
                state, review_available="watch_video" in self._registry
            )
            if self._deterministic_workflow:
                selected = _select_next_tool(
                    state, review_available="watch_video" in self._registry
                )
                if selected is not None:
                    budget_error = _stage_budget_error(
                        selected, stage_attempts[selected]
                    )
                    if budget_error:
                        # Exhausted budgets must not discard a playable video:
                        # deliver the best candidate with a quality warning
                        # instead of ending the session empty-handed.
                        best = state.get("best_visual_candidate") or {}
                        salvage_path = state.get("latest_video_path") or best.get(
                            "video_path"
                        )
                        salvage_url = state.get("latest_video_url") or best.get(
                            "video_url"
                        )
                        if salvage_path:
                            logger.warning(
                                "session %s stage budget exhausted at %s; "
                                "delivering best playable candidate",
                                session_id,
                                selected,
                            )
                            state["quality_degraded"] = True
                            yield DoneEvent(
                                status="ok",
                                text=(
                                    f"答案：{state.get('solution_answer') or '已验证'}。"
                                    f"{budget_error} 已交付当前最佳可播放候选视频，"
                                    "质量提示请查看 Watch 阶段。"
                                ),
                                final_video_url=salvage_url,
                                final_video_path=salvage_path,
                            )
                            await self._store.update_session(
                                session_id,
                                status="done",
                                error=f"stage_budget_exhausted:{selected}",
                                final_video_path=salvage_path,
                            )
                            self._maybe_schedule_wiki_ingest(session_id, success=False)
                            return
                        logger.warning(
                            "session %s stopped by stage budget: %s attempts=%d",
                            session_id,
                            selected,
                            stage_attempts[selected],
                        )
                        yield DoneEvent(
                            status="failed",
                            text=budget_error,
                            final_video_url=None,
                            final_video_path=None,
                        )
                        await self._store.update_session(
                            session_id,
                            status="failed",
                            error=f"stage_budget_exhausted:{selected}",
                            final_video_path=None,
                        )
                        self._maybe_schedule_wiki_ingest(session_id, success=False)
                        return
                    stage_attempts[selected] += 1
                stream_finished = True
                if selected is not None:
                    finish_reason = "tool_calls"
                    tool_calls_emitted = [
                        ToolCallEvent(
                            id=f"auto-{turn_index}-{uuid.uuid4().hex[:10]}",
                            name=selected,
                            arguments={},
                        )
                    ]
                else:
                    finish_reason = "stop"
                    answer = state.get("solution_answer") or "已验证"
                    if state.get("quality_degraded"):
                        text_acc.append(
                            f"答案：{answer}。视频已生成；当前为可播放保底版本，"
                            "质量提示请查看 Watch 阶段。"
                        )
                    else:
                        text_acc.append(f"答案：{answer}。视频已生成并通过质量评审。")
            else:
                try:
                    tool_definitions = [
                        definition
                        for definition in all_tool_definitions
                        if definition.name in allowed_names
                    ]
                    async for evt in self._llm.chat_stream(
                        messages=history,
                        tools=tool_definitions,
                        max_tokens=self._per_turn_max_tokens,
                    ):
                        if isinstance(evt, TextDelta):
                            text_acc.append(evt.text)
                            yield TextChunk(text=evt.text)
                        elif isinstance(evt, ReasoningDelta):
                            reasoning_acc.append(evt.text)
                            yield ReasoningChunk(text=evt.text)
                        elif isinstance(evt, ToolCallEvent):
                            tool_calls_emitted.append(evt)
                        elif isinstance(evt, StreamDone):
                            stream_finished = True
                            finish_reason = evt.finish_reason or finish_reason
                            if len(evt.tool_calls) > len(tool_calls_emitted):
                                tool_calls_emitted = evt.tool_calls
                except Exception as exc:
                    logger.exception("LLM stream failed for session %s", session_id)
                    yield ErrorEvent(message=f"LLM 调用失败: {exc}", fatal=True)
                    await self._store.update_session(session_id, status="failed", error=str(exc))
                    self._maybe_schedule_wiki_ingest(session_id, success=False)
                    return

            full_text = "".join(text_acc)
            full_reasoning = "".join(reasoning_acc)
            tool_calls_json = (
                [
                    {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                    for tc in tool_calls_emitted
                ]
                if tool_calls_emitted
                else None
            )

            await self._store.append_message(
                session_id,
                turn_index,
                "assistant",
                full_text,
                reasoning=full_reasoning or None,
                tool_calls=tool_calls_json,
            )
            history.append(
                ChatMessage(
                    role="assistant",
                    content=full_text,
                    tool_calls=[
                        ToolCallSpec(id=tc.id, name=tc.name, arguments=tc.arguments)
                        for tc in tool_calls_emitted
                    ]
                    if tool_calls_emitted
                    else None,
                )
            )

            if not stream_finished:
                logger.warning("LLM stream ended without StreamDone for %s", session_id)

            if not tool_calls_emitted:
                # Model wants to stop OR ran out of tokens before emitting
                # tool_calls. Distinguish:
                #   - Truly stop (finish_reason='stop' AND we already produced
                #     useful work like a final video URL): treat as success
                #   - Out of tokens but only thinking, no answer: surface a
                #     clear error so the user knows to disable thinking or
                #     bump LLM_AGENT_LOOP_MAX_TOKENS. This is the canonical
                #     Gemma 4 + LMStudio failure mode (thinking eats all
                #     budget; tool_calls never get a chance).
                truncated_no_progress = (
                    finish_reason == "length"
                    and turn_index == 1
                    and not full_text.strip()
                    and not final_video_path
                )
                only_thinking = (
                    bool(full_reasoning.strip()) and not full_text.strip() and not final_video_path
                )
                if truncated_no_progress or only_thinking:
                    hint = (
                        "模型只输出了思考（没有 tool_calls 也没有最终回复）。"
                        "常见原因：思考占满 max_tokens 预算（Gemma 4 / Qwen3 + "
                        "LMStudio 的已知 issue）。建议：(1) 在 LMStudio 模型 "
                        "Prompt Template 顶部加 `{%- set enable_thinking = false %}` "
                        "硬覆盖；(2) .env 调大 LLM_AGENT_LOOP_MAX_TOKENS（4096-6144）。"
                    )
                    logger.warning(
                        "session %s: only thinking, no tool_calls (finish=%s, "
                        "reasoning_chars=%d). Treating as failed.",
                        session_id,
                        finish_reason,
                        len(full_reasoning),
                    )
                    yield ErrorEvent(message=hint, fatal=True)
                    await self._store.update_session(
                        session_id,
                        status="failed",
                        error="only_thinking_no_tool_calls",
                    )
                    self._maybe_schedule_wiki_ingest(session_id, success=False)
                    return

                review_required = "watch_video" in self._registry
                workflow_complete = bool(
                    state.get("latest_video_path")
                    and state.get("solution_verified") is True
                    and (
                        not review_required
                        or (
                            state.get("last_visual_review")
                            and not state.get("last_visual_failed", False)
                        )
                    )
                )
                if not workflow_complete and turn_index < self._max_turns:
                    missing: list[str] = []
                    if state.get("solution_verified") is not True:
                        missing.append("已校验解答")
                    if not state.get("latest_video_path"):
                        missing.append("成功渲染的视频")
                    if review_required and not state.get("last_visual_review"):
                        missing.append("成片视觉评审")
                    if state.get("last_visual_failed"):
                        missing.append("修复未通过的视觉评审")
                    reminder = (
                        "工作流尚未完成，缺少：" + "、".join(missing) + "。请直接调用下一项工具。"
                    )
                    history.append(ChatMessage(role="user", content=reminder))
                    continue
                if not workflow_complete:
                    yield DoneEvent(
                        status="exhausted",
                        text="达到最大推理轮数，工作流仍未完成",
                        final_video_url=None,
                        final_video_path=None,
                    )
                    await self._store.update_session(
                        session_id,
                        status="failed",
                        error="incomplete_workflow",
                        final_video_path=None,
                    )
                    self._maybe_schedule_wiki_ingest(session_id, success=False)
                    return

                # Normal stop path: only a verified, rendered, reviewed video
                # is reported as success when the review tool is available.
                yield DoneEvent(
                    status="ok",
                    text=full_text,
                    final_video_url=final_video_url,
                    final_video_path=final_video_path,
                )
                await self._store.update_session(
                    session_id,
                    status="done",
                    final_video_path=final_video_path,
                )
                self._maybe_schedule_wiki_ingest(session_id, success=True)
                return

            # 1) Emit ToolCallStart eagerly for every call + record pending row
            for tc in tool_calls_emitted:
                yield ToolCallStart(
                    id=tc.id,
                    name=tc.name,
                    arguments=tc.arguments,
                    turn_index=turn_index,
                )
                await self._store.record_tool_call(
                    session_id, turn_index, tc.id, tc.name, tc.arguments
                )

            # 2) Execute in emitted order. The remaining production tools all
            # depend on state from prior stages, so parallel writes can race.
            outcomes: list[_ToolOutcome] = []
            for tc in tool_calls_emitted:
                outcomes.append(
                    await self._execute_one_tool(
                        tc,
                        session_id=session_id,
                        turn_index=turn_index,
                        grade=grade,
                        problem=problem,
                        state=state,
                    )
                )

            # 3) Persist completion + compact history, then yield event.
            for outcome in outcomes:
                if outcome.tc.name == "solve_problem" and outcome.result.success:
                    # Verification attempts belong to a specific solution artifact.
                    # A corrected solution must receive a fresh bounded verification
                    # budget instead of inheriting attempts spent on the rejected draft.
                    stage_attempts["verify_solution"] = 0
                if outcome.unknown_tool_error is not None:
                    await self._store.complete_tool_call(
                        outcome.tc.id,
                        status="failed",
                        error=outcome.unknown_tool_error,
                        duration_ms=outcome.duration_ms,
                    )
                else:
                    await self._store.complete_tool_call(
                        outcome.tc.id,
                        status="success" if outcome.result.success else "failed",
                        result_summary=outcome.result.summary,
                        duration_ms=outcome.duration_ms,
                        error=outcome.result.error,
                    )

                if outcome.final_video_path:
                    final_video_path = outcome.final_video_path
                if outcome.final_video_url:
                    final_video_url = outcome.final_video_url
                # inspect_video may restore an earlier elite candidate after
                # later stochastic rewrites regress. Keep the completion
                # payload synchronized with the authoritative session state.
                if state.get("latest_video_path"):
                    final_video_path = str(state["latest_video_path"])
                if state.get("latest_video_url"):
                    final_video_url = str(state["latest_video_url"])

                # Build tool message
                if outcome.unknown_tool_error is not None:
                    tool_message_payload: dict[str, Any] = {
                        "success": False,
                        "error": outcome.unknown_tool_error,
                    }
                else:
                    tool_message_payload = {
                        "success": outcome.result.success,
                        "summary": outcome.result.summary,
                    }
                    if outcome.result.data is not None:
                        tool_message_payload["data"] = _compact_tool_data(
                            outcome.tc.name, outcome.result.data
                        )
                    if outcome.result.error:
                        tool_message_payload["error"] = outcome.result.error
                tool_message_content = json.dumps(tool_message_payload, ensure_ascii=False)
                history.append(
                    ChatMessage(
                        role="tool",
                        tool_call_id=outcome.tc.id,
                        name=outcome.tc.name,
                        content=tool_message_content,
                    )
                )
                await self._store.append_message(
                    session_id,
                    turn_index,
                    "tool",
                    tool_message_content,
                    tool_call_id=outcome.tc.id,
                    tool_name=outcome.tc.name,
                )

                yield ToolCallResult(
                    id=outcome.tc.id,
                    name=outcome.tc.name,
                    success=False if outcome.unknown_tool_error else outcome.result.success,
                    summary=outcome.unknown_tool_error or outcome.result.summary,
                    data=None if outcome.unknown_tool_error else outcome.result.data,
                    error=outcome.unknown_tool_error or outcome.result.error,
                    duration_ms=outcome.duration_ms,
                    artifacts=outcome.artifact_records,
                )

            # A bounded run has no controller that needs to observe one more
            # turn before stopping. Complete immediately after the final
            # successful review (or render when review is unavailable). This
            # preserves the full retry budget at the max-turn boundary.
            if self._deterministic_workflow:
                review_required = "watch_video" in self._registry
                workflow_complete = bool(
                    state.get("latest_video_path")
                    and state.get("solution_verified") is True
                    and (
                        not review_required
                        or (
                            state.get("last_visual_review")
                            and not state.get("last_visual_failed", False)
                        )
                    )
                )
                if workflow_complete:
                    if state.get("quality_degraded"):
                        final_text = (
                            f"答案：{state.get('solution_answer') or '已验证'}。"
                            "视频已生成；当前为可播放保底版本，质量提示请查看 Watch 阶段。"
                        )
                    else:
                        final_text = (
                            f"答案：{state.get('solution_answer') or '已验证'}。"
                            "视频已生成并通过质量评审。"
                        )
                    yield DoneEvent(
                        status="ok",
                        text=final_text,
                        final_video_url=final_video_url,
                        final_video_path=final_video_path,
                    )
                    await self._store.update_session(
                        session_id,
                        status="done",
                        final_video_path=final_video_path,
                    )
                    self._maybe_schedule_wiki_ingest(session_id, success=True)
                    return

        # Reached max turns without the model stopping (sentinel below)
        yield DoneEvent(
            status="exhausted",
            text="达到最大推理轮数",
            final_video_url=None,
            final_video_path=None,
        )
        await self._store.update_session(
            session_id,
            status="failed",
            error="max_turns_exhausted",
            final_video_path=None,
        )
        self._maybe_schedule_wiki_ingest(session_id, success=False)

    def _maybe_schedule_wiki_ingest(self, session_id: str, *, success: bool) -> None:
        """Fire-and-forget wiki ingest when configured. Never raises."""
        if self._wiki_ingester is None:
            return
        try:
            self._wiki_ingester.schedule(session_id, success=success)
        except Exception:
            logger.exception("wiki ingest scheduling failed (non-fatal)")

    async def _execute_one_tool(
        self,
        tc: ToolCallEvent,
        *,
        session_id: str,
        turn_index: int,
        grade: str,
        problem: str,
        state: dict[str, Any],
    ) -> _ToolOutcome:
        """Run a single tool call. Returns a structured outcome the main loop
        can persist + yield. Catches all exceptions so a parallel sibling
        can't crash the whole turn."""
        start = time.monotonic()
        tool: ITool | None = self._registry.get(tc.name)

        if tool is None:
            duration_ms = int((time.monotonic() - start) * 1000)
            return _ToolOutcome(
                tc=tc,
                result=ToolResult(success=False, summary=f"未知工具: {tc.name}"),
                duration_ms=duration_ms,
                unknown_tool_error=f"未知工具: {tc.name}",
            )

        ctx = ToolContext(
            session_id=session_id,
            turn_index=turn_index,
            grade=grade,
            problem=problem,
            state=state,
        )
        # Defense: arguments must be a dict for tool .get(...) calls. If a
        # provider parser slipped through with a non-dict (string/list/etc),
        # coerce to {} and let the tool surface its own "missing args" error
        # instead of crashing with AttributeError.
        safe_args: dict[str, Any]
        if isinstance(tc.arguments, dict):
            safe_args = tc.arguments
        else:
            logger.warning(
                "tool %s received non-dict arguments (%s): %r — coercing to {}",
                tc.name,
                type(tc.arguments).__name__,
                tc.arguments,
            )
            safe_args = {}
        try:
            result = await asyncio.wait_for(
                tool.execute(safe_args, ctx),
                timeout=self._tool_timeout,
            )
        except asyncio.TimeoutError:
            duration_ms = int((time.monotonic() - start) * 1000)
            return _ToolOutcome(
                tc=tc,
                result=ToolResult(
                    success=False,
                    summary=f"工具 {tc.name} 超时",
                    error="timeout",
                ),
                duration_ms=duration_ms,
            )
        except Exception as exc:  # noqa: BLE001
            import traceback

            logger.exception("tool %s crashed", tc.name)
            duration_ms = int((time.monotonic() - start) * 1000)
            # Attach the deepest 2 frames to the visible summary so the user
            # can see where the crash happened without digging through logs.
            tb = traceback.extract_tb(exc.__traceback__)
            origin = ""
            if tb:
                # Last frame is most informative; second-to-last gives caller
                tail = tb[-2:]
                origin_parts = [
                    f"{frame.filename.rsplit('/', 1)[-1]}:{frame.lineno}({frame.name})"
                    for frame in tail
                ]
                origin = " @ " + " ← ".join(reversed(origin_parts))
            return _ToolOutcome(
                tc=tc,
                result=ToolResult(
                    success=False,
                    summary=f"工具 {tc.name} 异常: {exc}{origin}",
                    error=f"{exc}{origin}",
                ),
                duration_ms=duration_ms,
            )

        duration_ms = int((time.monotonic() - start) * 1000)

        # Persist artifacts (if any) and pull out video URL
        artifact_records: list[dict[str, Any]] = []
        final_video_path: str | None = None
        final_video_url: str | None = None
        for art in result.artifacts:
            try:
                if art.content is not None and art.filename:
                    art_id, rel = await self._store.save_text_artifact(
                        session_id,
                        art.kind,
                        art.filename,
                        art.content,
                        meta=art.meta,
                    )
                    artifact_records.append(
                        {"id": art_id, "kind": art.kind, "path": rel, "meta": art.meta}
                    )
                elif art.external_path:
                    art_id = await self._store.add_artifact(
                        session_id,
                        art.kind,
                        art.external_path,
                        meta=art.meta,
                    )
                    artifact_records.append(
                        {
                            "id": art_id,
                            "kind": art.kind,
                            "path": art.external_path,
                            "meta": art.meta,
                        }
                    )
                    if art.kind == "video":
                        final_video_path = art.external_path
                        url_meta = art.meta.get("url")
                        if isinstance(url_meta, str):
                            final_video_url = url_meta
            except Exception:
                logger.exception(
                    "failed to persist artifact (session=%s, kind=%s)",
                    session_id,
                    art.kind,
                )

        return _ToolOutcome(
            tc=tc,
            result=result,
            duration_ms=duration_ms,
            artifact_records=artifact_records,
            final_video_path=final_video_path,
            final_video_url=final_video_url,
        )
