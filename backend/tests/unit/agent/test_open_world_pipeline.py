from __future__ import annotations

import ast
import asyncio
import re
from datetime import datetime, timezone
from typing import Any

from math_tutor.application.interfaces import ArtifactSpec, ITool, ToolContext, ToolResult
from math_tutor.infrastructure.agent.events import DoneEvent, ToolCallStart
from math_tutor.infrastructure.agent.learned_wiki import LearnedWiki, Lesson
from math_tutor.infrastructure.agent.loop import (
    AgentLoop,
    _allowed_tool_names,
    _compact_tool_data,
    _select_next_tool,
    _stage_budget_error,
)
from math_tutor.infrastructure.agent.prompt_composer import PromptComposer
from math_tutor.infrastructure.agent.quality_metrics import (
    aggregate_quality_summaries,
    build_session_quality_summary,
    compare_quality_windows,
)
from math_tutor.infrastructure.agent.tool_registry import ToolRegistry
from math_tutor.infrastructure.agent.tools.compile_video import (
    CompileVideoTool,
    build_verified_fallback_code,
)
from math_tutor.infrastructure.agent.tools.inspect_video import (
    InspectVideoTool,
    _derive_technical_issues,
    _parse_rate,
)
from math_tutor.infrastructure.agent.tools.run_manim import _compact_manim_error
from math_tutor.infrastructure.agent.tools.solve_problem import (
    _invalid_literal_equalities,
    _solution_contract_issues,
)
from math_tutor.infrastructure.agent.tools.validate_manim_code import (
    _check_animation_api_misuse,
    _check_hierarchical_label_band_conflicts,
    _check_problem_opening,
    _check_render_complexity,
    _check_scene_magnitude_contract,
    _check_stale_loop_indices,
    _check_structure,
    _check_teaching_contract,
    _check_visual_evidence_contract,
    _parse_semantic_audit,
    _teaching_similarity,
)
from math_tutor.infrastructure.agent.tools.verify_solution import (
    _add_safe_data_aliases,
    _classify_verification_failure,
    _parse_consistency_audit,
    _parse_data_object,
    _parse_logical_audit,
    _safe_exec_verify,
)
from math_tutor.infrastructure.agent.tools.visual_plan import (
    _normalize_plan,
    _parse_plan_audit,
    _validate_plan,
)
from math_tutor.infrastructure.agent.tools.watch_video import WatchVideoTool
from math_tutor.infrastructure.agent.wiki_ingester import (
    _copies_problem_content,
    _parse_lesson_decision,
)
from math_tutor.infrastructure.llm.openai_provider import _is_local_url
from math_tutor.infrastructure.media import build_narration_cues, render_webvtt
from math_tutor.infrastructure.storage.models import Artifact, Session, ToolCallRecord


def _open_world_plan(thesis: str = "让一个状态连续变化并在同一参照下显出目标关系") -> dict:
    return {
        "visual_thesis": thesis,
        "essence_rationale": "因为学生能看到状态变化与稳定参照的对应，所以结论由画面本身得到验证。",
        "symbol_ledger": ["blue object = changing state", "gold mark = stable reference"],
        "scenes": [
            {
                "role": "setup",
                "anchor_zone": "B2-E5",
                "key_objects": "state and reference",
                "action": "establish both visible states",
                "invariant": "initial relation is fixed",
                "attention_target": "the reference",
                "exit_condition": "both meanings are visible",
                "teaching_line": "First fix the meaning of the stable reference.",
                "duration_s": 4,
            },
            {
                "role": "transform",
                "anchor_zone": "B2-E5",
                "key_objects": "state and reference",
                "action": "change the state while retaining the reference",
                "invariant": "declared relation remains true",
                "attention_target": "the changing gap",
                "exit_condition": "target state is reached",
                "teaching_line": "Watch only what changes while the reference remains fixed.",
                "duration_s": 6,
            },
            {
                "role": "verify",
                "anchor_zone": "B2-E5",
                "key_objects": "final state and check mark",
                "action": "compare the final state against the original relation",
                "invariant": "all constraints remain satisfied",
                "attention_target": "the visual check",
                "exit_condition": "the conclusion is checked on screen",
                "teaching_line": "Now check the final state against every constraint.",
                "duration_s": 4,
            },
        ],
        "forbidden": ["text-only page changes", "decorative motion without semantics"],
    }


def test_visual_plan_accepts_unseen_free_form_thesis_and_temporal_zone_reuse() -> None:
    plan = _open_world_plan("an entirely new visual argument invented from the current semantics")
    assert _validate_plan(plan, "advanced") == []


def test_visual_plan_requires_reference_and_change_ledger_entries() -> None:
    plan = _open_world_plan()
    plan["symbol_ledger"] = ["stable reference = blue object"]
    assert any("至少 2 项" in issue for issue in _validate_plan(plan, "advanced"))


def test_visual_plan_audit_parser_requires_machine_checkable_verdict() -> None:
    assert _parse_plan_audit(
        '{"consistent":false,"issues":["BLOCKING: count; observed=10; expected=20"],'
        '"checked_claims":["dimension change"],"corrected_plan":{"visual_thesis":"fixed"}}'
    ) == (
        False,
        ["BLOCKING: count; observed=10; expected=20"],
        ["dimension change"],
        {"visual_thesis": "fixed"},
    )
    assert _parse_plan_audit('{"consistent":"yes","issues":[]}') is None


def test_visual_plan_fills_only_safe_structural_omissions() -> None:
    plan = _open_world_plan()
    plan["scenes"][1]["invariant"] = ""
    plan["scenes"][2]["exit_condition"] = ""
    normalized = _normalize_plan(plan)
    assert normalized["scenes"][1]["invariant"]
    assert normalized["scenes"][2]["exit_condition"]
    assert _validate_plan(normalized, "advanced") == []


def test_lan_model_endpoint_bypasses_system_proxy() -> None:
    assert _is_local_url("http://192.168.3.29:1234/v1") is True
    assert _is_local_url("http://10.1.2.3:8000/v1") is True
    assert _is_local_url("https://api.openai.com/v1") is False


def test_verifier_safely_accepts_fraction_literals_but_not_code_execution() -> None:
    parsed = _parse_data_object('{"optimal_x": 5/3, "bounds": [0, 5]}')
    assert parsed == {"optimal_x": 5 / 3, "bounds": [0, 5]}
    assert _parse_data_object('{"x": __import__("os").system("id")}') is None
    passed, _ = _safe_exec_verify(
        "def verify(data):\n    import math\n    return isinstance(data, dict) and math.isclose(math.sqrt(4), 2)",
        {},
    )
    assert passed is True
    rejected, message = _safe_exec_verify("def verify(data):\n    import os\n    return True", {})
    assert rejected is False and "禁止的导入" in message


def test_legacy_pattern_is_read_only_as_free_text_not_enum() -> None:
    legacy = _open_world_plan()
    legacy["primary_pattern"] = "never-before-seen-mechanism"
    legacy.pop("visual_thesis")
    normalized = _normalize_plan(legacy)
    assert normalized["visual_thesis"] == "never-before-seen-mechanism"
    assert "primary_pattern" not in normalized


def test_controller_excludes_type_routing_and_single_session_memory() -> None:
    prompt = PromptComposer().compose(
        grade="middle",
        use_latex=False,
        learned_context="single task instruction that must never leak",
    )
    assert "不调用 `match_skill`" in prompt
    assert "single task instruction" not in prompt
    assert "primary_pattern" not in prompt


def test_candidate_requires_three_independent_sessions_before_retrieval(tmp_path) -> None:
    wiki = LearnedWiki(tmp_path)
    for index in range(1, 4):
        candidate, _ = wiki.write_candidate(
            Lesson(
                title="Preserve semantic continuity across a transform",
                category="production",
                slug="preserve-semantic-continuity",
                body="Keep unchanged references on screen while the mathematical state changes.",
                keywords=["continuity", "transform", "reference"],
                session_origins=[f"session-{index}"],
            )
        )
        promoted = wiki.promote_candidate(candidate.slug, candidate.category)
        if index < 3:
            assert promoted is None
            assert wiki.list_lessons() == []
        else:
            assert promoted is not None
            assert len(wiki.list_lessons()) == 1


def test_ingest_rejects_non_universal_rule() -> None:
    decision = """
## Lesson Decision

**verdict**: write
**scope**: task-specific
**category**: production
**slug**: task-only-rule
**title**: Task only rule
**keywords**: task, only, rule

### body
This is long enough to parse but must remain excluded because its scope is narrow.
"""
    assert _parse_lesson_decision(decision) is None


def test_candidate_rejects_verbatim_problem_content() -> None:
    lesson = Lesson(
        title="Copied content",
        category="production",
        slug="copied-content",
        body="The exact statement opaque-current-relation-abcdef should be animated.",
    )
    assert (
        _copies_problem_content(
            lesson, "opaque-current-relation-abcdef with an additional condition"
        )
        is True
    )


def test_validator_allows_legitimate_3d_scene() -> None:
    code = """from manim import *

class SolutionScene(ThreeDScene):
    def construct(self):
        self.wait(1)
"""
    assert _check_structure(code, use_latex=False) == []


def test_generated_code_stays_out_of_controller_history() -> None:
    compact = _compact_tool_data(
        "generate_manim_code", {"code": "x" * 50_000, "fix_scope": "global"}
    )
    assert compact == {
        "code_stored_in_state": True,
        "code_chars": 50_000,
        "fix_scope": "global",
    }


def test_logical_verification_requires_all_evidence_sections() -> None:
    incomplete = """
**结论**: pass
### 前提与条件覆盖
- all premises covered
### 步骤审计
- every implication checked
"""
    passed, message, _ = _parse_logical_audit(incomplete)
    assert passed is False
    assert "缺少证据区" in message


def test_controller_exposes_only_next_valid_stage() -> None:
    state: dict = {}
    assert _allowed_tool_names(state, review_available=True) == {"solve_problem"}
    state["solution_steps"] = [{"description": "derive"}]
    assert _allowed_tool_names(state, review_available=True) == {"verify_solution"}
    state["solution_verified"] = True
    assert _allowed_tool_names(state, review_available=True) == {"direct_video"}
    state["visual_plan"] = _open_world_plan()
    assert _allowed_tool_names(state, review_available=True) == {"compile_video"}
    state["latest_video_path"] = "video.mp4"
    assert _allowed_tool_names(state, review_available=True) == {"watch_video"}
    state["last_visual_review"] = {"overall_quality": "good"}
    state["last_visual_failed"] = False
    assert _allowed_tool_names(state, review_available=True) == set()


def test_bounded_recovery_policy_reuses_runnable_code_for_one_visual_fix() -> None:
    state = {
        "analysis": {"question": "goal"},
        "solution_steps": [{}],
        "solution_verified": True,
        "visual_plan": _open_world_plan(),
        "latest_manim_code": "code",
        "last_validation_passed": True,
        "latest_video_path": "video.mp4",
        "last_visual_review": {"overall_quality": "bad"},
        "last_visual_failed": True,
        "visual_fail_count": 1,
    }
    assert _select_next_tool(state, review_available=True) == "watch_video"
    state["force_visual_replan"] = True
    assert _select_next_tool(state, review_available=True) == "watch_video"


def test_stage_budget_allows_one_fallback_then_stops_blind_retries() -> None:
    assert _stage_budget_error("solve_problem", 0) is None
    assert _stage_budget_error("solve_problem", 1) is None
    message = _stage_budget_error("solve_problem", 2)
    assert message is not None
    assert "首轮和一次兜底" in message
    assert "停止继续试错" in message
    assert _stage_budget_error("compile_video", 0) is None
    assert _stage_budget_error("compile_video", 1) is not None


def test_solution_contract_rejects_visible_scratchpad_self_correction() -> None:
    payload = {
        "answer": "4秒",
        "steps": [
            {
                "description": "求时间",
                "operation": "12 / 3 = 4",
                "explanation": "由已知关系得到",
                "result": "等等，让我重新核算，答案是4秒",
            }
        ],
    }
    issues = _solution_contract_issues(payload)
    assert any("等等" in issue for issue in issues)
    assert _solution_contract_issues(
        {
            "answer": "4秒",
            "steps": [{"result": "代回全部条件后均成立"}],
        }
    ) == []


def test_solution_contract_rejects_duplicate_steps_and_stale_final_number() -> None:
    step = {
        "description": "计算最终量",
        "operation": "14 × 14 × 3",
        "explanation": "由已知关系",
        "result": "588 立方厘米",
    }
    issues = _solution_contract_issues(
        {"answer": "1254 立方厘米", "steps": [step, dict(step)]}
    )
    assert any("重复" in issue for issue in issues)
    assert any("answer=1254" in issue and "last_result=588" in issue for issue in issues)


def test_solution_contract_rejects_false_arithmetic_and_unproved_answer_values() -> None:
    assert _invalid_literal_equalities(r"$24 \div 2 = 14$（只）") == [
        "24 / 2 = 14"
    ]
    assert _invalid_literal_equalities(r"$24 \div 2 = 12$（只）") == []
    issues = _solution_contract_issues(
        {
            "answer": "甲21个，乙14个",
            "steps": [
                {"operation": "24 ÷ 2 = 12", "result": "乙有12个"},
                {"operation": "35 - 12 = 23", "result": "甲有23个"},
                {"operation": "23 + 12 = 35", "result": "全部条件成立"},
            ],
        }
    )
    assert any("14,21" in issue for issue in issues)


def test_verifier_schema_alias_repairs_only_unambiguous_role_prefix() -> None:
    code = 'def verify(data):\n    return data["answer_volume"] == data["volume"]'
    repaired = _add_safe_data_aliases(code, {"volume": 588})
    assert repaired["answer_volume"] == 588
    assert _add_safe_data_aliases(
        'def verify(data):\n    return data["mystery"]', {"volume": 588}
    ) == {"volume": 588}


def test_render_complexity_rejects_unreadable_literal_object_cloud() -> None:
    tree = ast.parse(
        """
for row in range(14):
    for column in range(14):
        tile = Cube(side_length=0.1)
"""
    )
    issues = _check_render_complexity(tree)
    assert any("196" in issue and "预算 96" in issue for issue in issues)


def test_scene_magnitude_contract_rejects_math_value_as_manim_size() -> None:
    tree = ast.parse(
        """
original_length = 20
paper = Square(side_length=original_length)
"""
    )
    issues = _check_scene_magnitude_contract(tree)
    assert any("side_length=20" in issue and "归一化" in issue for issue in issues)


def test_static_gate_rejects_reusing_caption_child_after_group_fadeout() -> None:
    code = """from manim import *
class SolutionScene(Scene):
    def construct(self):
        caption_text = Text('first')
        caption_box = Rectangle()
        caption = VGroup(caption_box, caption_text)
        self.play(FadeIn(caption))
        self.play(FadeOut(caption))
        next_text = Text('second')
        self.play(Transform(caption_text, next_text))
"""
    issues = _check_structure(code, use_latex=False)
    assert any("字幕生命周期错误" in issue for issue in issues)


def test_executable_verification_survives_malformed_secondary_critic() -> None:
    from types import SimpleNamespace

    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.verify_solution import VerifySolutionTool

    class TwoStageLLM:
        calls = 0

        async def chat_complete(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            if self.calls == 1:
                return SimpleNamespace(
                    text="""## 验证
**验证模式**: executable
**题目数值**: {"expected_value": 4}
**答案数值**: {"answer_value": 4}
**预期**: 通过

```python
def verify(data):
    assert data["answer_value"] == data["expected_value"]
    return True
```""",
                    reasoning="",
                )
            return SimpleNamespace(text="critic emitted prose instead of JSON", reasoning="")

    state = {
        "solution_steps": [{"description": "derive", "result": "4"}],
        "solution_answer": "4",
    }
    ctx = ToolContext("session", 1, "middle", "求目标值", state)
    result = asyncio.run(
        VerifySolutionTool(TwoStageLLM(), PromptLibrary()).execute({}, ctx)  # type: ignore[arg-type]
    )

    assert result.success
    assert state["solution_verified"] is True
    assert result.data is not None
    assert "格式无效" in str(result.data["consistency_audit_warning"])


def test_compile_stage_owns_semantic_audit_without_exposing_validator() -> None:
    state = {
        "analysis": {"question": "goal"},
        "solution_steps": [{}],
        "solution_verified": True,
        "visual_plan": _open_world_plan(),
        "latest_manim_code": "code",
        "last_validation_passed": False,
        "last_validation_issues": ["独立语义审计返回格式无效"],
        "retry_semantic_audit": True,
    }
    assert _allowed_tool_names(state, review_available=True) == {"compile_video"}
    assert _select_next_tool(state, review_available=True) == "compile_video"


def test_video_probe_rejects_draft_or_static_output_without_problem_types() -> None:
    critical, warnings = _derive_technical_issues(
        {
            "width": 854,
            "height": 480,
            "fps": 15,
            "duration_s": 18,
            "has_audio": False,
            "visible_fraction_by_frame": [0.1] * 5,
            "blank_frame_count": 0,
            "adjacent_frame_difference": [0.001] * 4,
        }
    )
    assert any("分辨率" in issue for issue in critical)
    assert any("帧率" in issue for issue in critical)
    assert any("静态" in issue for issue in critical)
    assert any("无音轨" in warning for warning in warnings)
    assert _parse_rate("30000/1001") == 30000 / 1001


def test_video_review_uses_dense_temporal_sampling_by_default() -> None:
    tool = InspectVideoTool(object(), object())  # dependencies are not called here
    assert tool._frame_count == 12


def test_video_probe_rejects_overfilled_caption_safe_zone() -> None:
    critical, _ = _derive_technical_issues(
        {
            "width": 1280,
            "height": 720,
            "fps": 30,
            "duration_s": 20,
            "visible_fraction_by_frame": [0.1] * 4,
            "blank_frame_count": 0,
            "caption_zone_occupancy": [0.04, 0.08, 0.31, 0.07],
            "adjacent_frame_difference": [0.02] * 3,
        }
    )
    assert any("字幕安全带过密" in issue for issue in critical)


def test_static_evidence_gate_follows_free_form_countability_contract() -> None:
    plan = _open_world_plan()
    plan["scenes"][2]["action"] = "最终网格中的单位小方块必须可逐项数一数"
    code = """tiles = VGroup()
for row in range(10):
    tile = Rectangle(width=0.4, height=0.4, stroke_width=0)
    tiles.add(tile)
"""
    issues = _check_visual_evidence_contract(code, plan)
    assert any("单位可逐项计数" in issue for issue in issues)
    assert _check_visual_evidence_contract(
        code.replace("stroke_width=0", "stroke_width=1"), plan
    ) == []


def test_static_evidence_gate_rejects_identical_live_label_anchors() -> None:
    code = """old_label = Text("old")
old_label.next_to(grid, UP, buff=0.2)
self.play(FadeIn(old_label))
new_label = Text("new")
new_label.next_to(grid, UP, buff=0.2)
self.play(FadeIn(new_label))
"""
    issues = _check_visual_evidence_contract(code, {})
    assert any("确定性标签重叠" in issue for issue in issues)
    fixed = code.replace(
        'new_label = Text("new")',
        "self.play(FadeOut(old_label))\nnew_label = Text(\"new\")",
    )
    assert _check_visual_evidence_contract(fixed, {}) == []
    nearby = code.replace("buff=0.2", "buff=0.5", 1).replace(
        "new_label.next_to(grid, UP, buff=0.2)",
        "new_label.next_to(grid, UP)",
    )
    assert any(
        "相邻标签带" in issue for issue in _check_visual_evidence_contract(nearby, {})
    )


def test_static_gate_requires_faithful_visible_problem_opening() -> None:
    problem = "一个未知的新问题：条件甲为7，求目标乙。"
    good = """from manim import *
PROBLEM_TEXT = "一个未知的新问题：条件甲为7，求目标乙。"
class SolutionScene(Scene):
    def construct(self):
        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)
        self.play(Write(problem_card))
"""
    assert _check_problem_opening(good, problem) == []
    wrapped = good.replace(
        "self.play(Write(problem_card))",
        "problem_panel = VGroup(Rectangle(), problem_card)\n"
        "        self.play(Write(problem_panel))",
    )
    assert _check_problem_opening(wrapped, problem) == []
    class_constant = good.replace(
        'PROBLEM_TEXT = "一个未知的新问题：条件甲为7，求目标乙。"\nclass SolutionScene(Scene):',
        'class SolutionScene(Scene):\n    PROBLEM_TEXT = "一个未知的新问题：条件甲为7，求目标乙。"',
    ).replace("Text(PROBLEM_TEXT)", "Text(self.PROBLEM_TEXT)")
    assert _check_problem_opening(class_constant, problem) == []
    assert any(
        "忠实复制" in issue
        for issue in _check_problem_opening(good.replace("条件甲为7", "条件甲为8"), problem)
    )
    assert any(
        "未传给" in issue
        for issue in _check_problem_opening(
            good.replace("Text(PROBLEM_TEXT)", 'Text("开始解答")'), problem
        )
    )
    assert any(
        "未在" in issue
        for issue in _check_problem_opening(
            good.replace("self.play(Write(problem_card))", "self.wait(3)"), problem
        )
    )
    bad_first = good.replace(
        "problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
        'caption = Text("先讲答案")\n        self.play(Write(caption))\n'
        "        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
    )
    assert any("第一个可见 beat" in issue for issue in _check_problem_opening(bad_first, problem))
    added_first = good.replace(
        "problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
        'caption = Text("先讲策略")\n        self.add(caption)\n'
        "        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
    )
    assert any("第一个可见 beat" in issue for issue in _check_problem_opening(added_first, problem))
    nested_helper = good.replace(
        "problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
        'def update_caption():\n            self.play(Write(Text("稍后字幕")))\n'
        "        problem_card = Text(PROBLEM_TEXT).scale(0.8).to_edge(UP)",
    )
    assert _check_problem_opening(nested_helper, problem) == []
    camera_first = good.replace(
        "problem_card = Text(PROBLEM_TEXT)",
        "self.camera.frame.scale(0.8)\n        problem_card = Text(PROBLEM_TEXT)",
    )
    assert any("camera.frame" in issue for issue in _check_problem_opening(camera_first, problem))


def test_video_probe_rejects_blank_opening_and_border_clipping() -> None:
    critical, _ = _derive_technical_issues(
        {
            "width": 1280,
            "height": 720,
            "fps": 30,
            "duration_s": 20,
            "visible_fraction_by_frame": [0.004, 0.2, 0.3],
            "blank_frame_count": 0,
            "adjacent_frame_difference": [0.1, 0.1],
            "top_border_occupancy": [0.5, 0.1, 0.1],
            "side_border_occupancy": [0.1, 0.6, 0.1],
            "caption_zone_occupancy": [0.1, 0.2, 0.7],
        }
    )
    assert any("开场" in issue for issue in critical)
    assert any("顶部" in issue for issue in critical)
    assert any("左右" in issue for issue in critical)
    assert any("字幕安全带" in issue for issue in critical)


def test_teaching_lines_become_a_content_agnostic_caption_timeline() -> None:
    plan = _open_world_plan()
    cues = build_narration_cues(plan, actual_duration_s=28)
    assert len(cues) == 3
    assert cues[0].start_s < cues[0].end_s <= cues[1].start_s
    assert cues[-1].end_s <= 28
    vtt = render_webvtt(cues)
    assert vtt.startswith("WEBVTT")
    assert "00:00:" in vtt
    assert plan["scenes"][1]["teaching_line"] in vtt


def test_static_gate_requires_most_planned_teaching_lines_in_code() -> None:
    plan = _open_world_plan()
    lines = [scene["teaching_line"] for scene in plan["scenes"]]
    good_code = "\n".join(f'caption_{i} = Text("{line}")' for i, line in enumerate(lines))
    issues, matched, planned = _check_teaching_contract(good_code, plan)
    assert issues == []
    assert matched == planned == 3
    bad_issues, bad_matched, _ = _check_teaching_contract(
        'caption = Text("generic explanation")', plan
    )
    assert bad_matched == 0
    assert any("字幕契约" in issue for issue in bad_issues)


def test_teaching_contract_allows_distinct_semantic_paraphrases() -> None:
    planned = "观察高度增加时，底面边长如何同时缩短，体积由两种变化共同决定。"
    paraphrase = "盒子变高的同时底面缩小，体积取决于二者的平衡。"
    unrelated = "现在把最终答案写在屏幕中央。"
    assert _teaching_similarity(planned, paraphrase) >= 0.35
    assert _teaching_similarity(planned, unrelated) < 0.35


def test_teaching_contract_accepts_structurally_displayed_split_captions() -> None:
    plan = {
        "scenes": [
            {"teaching_line": "先建立基准并观察总量。"},
            {"teaching_line": "再把差额与单个对象的变化对应。"},
            {"teaching_line": "最后核对两个条件。"},
        ]
    }
    code = """TEACHING_LINES = ["基准画面", "差额画面", "对应画面", "核验画面"]
a = Text(TEACHING_LINES[0])
b = Text(TEACHING_LINES[1])
c = Text(TEACHING_LINES[2])
d = Text(TEACHING_LINES[3])
"""
    issues, matched, planned_count = _check_teaching_contract(code, plan)
    assert issues == []
    assert matched >= 3
    assert planned_count == 3

    frozen_code = """class SolutionScene:
    TEACHING_LINES = ["先建立基准并观察总量。", "再把差额与单个对象的变化对应。", "最后核对两个条件。"]
    def construct(self):
        caption = Text(self.TEACHING_LINES[0])
        self.add(caption)
"""
    frozen_issues, frozen_matched, _ = _check_teaching_contract(frozen_code, plan)
    assert frozen_matched == 1
    assert any("字幕契约" in issue for issue in frozen_issues)


def test_semantic_audit_parser_is_strict_and_reports_contradictions() -> None:
    parsed = _parse_semantic_audit(
        '```json\n{"consistent":false,"issues":["对象分组与标签冲突"],'
        '"checked_claims":["分组成员"]}\n```'
    )
    assert parsed == (False, ["对象分组与标签冲突"], ["分组成员"])
    assert _parse_semantic_audit(
        "审计结果如下：{'consistent': True, 'issues': [], 'checked_claims': ['公式']}\n额外说明"
    ) == (True, [], ["公式"])
    assert _parse_semantic_audit('{"consistent":"yes","issues":[],"checked_claims":[]}') is None


def test_malformed_semantic_audit_degrades_without_a_failed_workflow_turn() -> None:
    from types import SimpleNamespace

    from math_tutor.infrastructure.agent.prompt_library import PromptLibrary
    from math_tutor.infrastructure.agent.tools.validate_manim_code import ValidateManimCodeTool

    class MalformedAuditLLM:
        async def chat_complete(self, *args: Any, **kwargs: Any) -> Any:
            return SimpleNamespace(text="not-json", reasoning="")

    problem = "未知问题"
    code = """from manim import *
PROBLEM_TEXT = "未知问题"
TEACHING_LINES = ["展示当前关系"]
class SolutionScene(Scene):
    def construct(self):
        card = Text(PROBLEM_TEXT)
        self.play(Write(card))
        caption = Text(TEACHING_LINES[0])
        self.play(Transform(card, caption))
        self.wait(1)
"""
    state = {
        "latest_manim_code": code,
        "solution_answer": "答案",
        "solution_steps": ["推导"],
        "visual_plan": {"scenes": [{"teaching_line": "展示当前关系"}]},
    }
    ctx = ToolContext("session", 1, "middle", problem, state)
    tool = ValidateManimCodeTool(MalformedAuditLLM(), PromptLibrary())  # type: ignore[arg-type]

    result = asyncio.run(tool.execute({}, ctx))
    assert result.success
    assert "降级到静态与成片审查" in result.summary
    assert "retry_semantic_audit" not in state


def test_code_extraction_accepts_unclosed_or_balanced_markdown_fences() -> None:
    from math_tutor.infrastructure.agent.tools.generate_manim_code import (
        _ensure_problem_text,
        _extract_code,
        _sanitize_code,
    )

    source = "from manim import *\nclass SolutionScene(Scene):\n    pass"
    assert _extract_code(f"```python\n{source}\n```") == source
    assert _extract_code(f"```python\r\n{source}") == source
    assert _extract_code(f"Here is the source:\n{source}") == source
    assert "ShowCreation" not in _sanitize_code("self.play(ShowCreation(shape))")
    assert "Create(shape)" in _sanitize_code("self.play(ShowCreation(shape))")
    star = _sanitize_code("mark = Star(scale_factor=0.3, color=YELLOW)")
    assert "Star(color=YELLOW).scale(0.3)" in star
    layout_code = """TEACHING_LINES = ["first"]
caption = Text("Loading...", font_size=28)
caption.scale_to_fit_width(11.5)
volume_bar.set_height(target_h)"""
    sanitized_layout = _sanitize_code(layout_code)
    assert "Text(TEACHING_LINES[0]," in sanitized_layout
    assert "if caption.width > 11.5:" in sanitized_layout
    assert "volume_bar.stretch_to_fit_height(target_h)" in sanitized_layout
    assert "v_bar.copy().stretch_to_fit_height(h)" in _sanitize_code(
        "small_bar = v_bar.copy().set_height(h)"
    )
    nested = "class S:\n    def construct(self):\n        def phase():\n            pass\n        self.phase()"
    assert "self.phase()" not in _sanitize_code(nested)
    assert "phase()" in _sanitize_code(nested)
    filled = _sanitize_code("ball = Circle(radius=0.4, fill=True, fill_opacity=0.8, color=RED)")
    assert "fill=True" not in filled
    assert "fill_opacity=0.8" in filled
    assert "stroke_opacity=0" in _sanitize_code(
        "panel = Rectangle(stroke_color=NONE, fill_opacity=0.8)"
    )
    self_group = _sanitize_code("bg.become(VGroup(bg, txt).arrange(DOWN, buff=0.1))")
    assert self_group == "bg = VGroup(bg, txt).arrange(DOWN, buff=0.1)"
    animate_chain = _sanitize_code(
        "self.play(group.animate.set_fill(RED).animate.scale(0).fade(1))"
    )
    assert animate_chain == "self.play(group.animate.set_fill(RED).scale(0).fade(1))"
    parallel_animations = _sanitize_code(
        "self.play(left.animate.scale(1.05), right.animate.scale(1.05))"
    )
    assert parallel_animations == (
        "self.play(left.animate.scale(1.05), right.animate.scale(1.05))"
    )
    legacy_play = _sanitize_code(
        "self.play(removed.set_color, GREY, FadeOut(label))"
    )
    assert legacy_play == "self.play(removed.animate.set_color(GREY), FadeOut(label))"
    anchored_caption = _sanitize_code(
        "self.play(Transform(caption, Text(TEACHING_LINES[2], font_size=24)))"
    )
    assert "Text(TEACHING_LINES[2], font_size=24).move_to(caption.get_center())" in anchored_caption
    number_line = _sanitize_code(
        "axis = NumberLine(x_range=[-5, 10, 1], include_numbers=True)\n"
        "dot.move_to([value * SCALE, 0, 0])\n"
        "label.move_to([(left + right) / 2 * SCALE, 0.3, 0])"
    )
    assert "include_numbers=True, label_constructor=Text" in number_line
    assert "dot.move_to(axis.n2p(value) + UP * (0))" in number_line
    assert "label.move_to(axis.n2p((left + right) / 2) + UP * (0.3))" in number_line
    captions = _sanitize_code(
        "        self.play(Write(get_caption(TEACHING_LINES[0])))\n"
        "        self.play(Write(get_caption(TEACHING_LINES[1])))"
    )
    assert "caption = get_caption(TEACHING_LINES[0])" in captions
    assert "Transform(caption, next_caption_2)" in captions
    moving = _sanitize_code(
        "class SolutionScene(Scene):\n"
        "    def construct(self):\n"
        "        self.camera.frame.save_state()\n"
    )
    assert "class SolutionScene(MovingCameraScene):" in moving
    arranged = _sanitize_code("balls.arrange_in_circle(buff=0.8, center=ORIGIN, arc_angle=PI)")
    assert "arrange_in_circle" not in arranged
    assert "balls.arrange(RIGHT, buff=0.8).move_to(ORIGIN)" in arranged
    colors = _sanitize_code(
        "class SolutionScene(Scene):\n"
        "    def construct(self):\n"
        "        GREEN = GREEN\n"
        "        RED = BLUE\n"
        "        dot = Dot(color=GREEN)\n"
    )
    assert "GREEN = GREEN" not in colors
    assert "RED = BLUE" not in colors
    assert "Dot(color=GREEN)" in colors
    assert "LIGHT_BLUE" not in _sanitize_code("Dot(color=LIGHT_BLUE)")
    dashed = _sanitize_code("line = Line(LEFT, RIGHT, stroke_dash_array=[4, 4], color=GRAY)")
    assert "stroke_dash_array" not in dashed
    assert "color=GRAY" in dashed
    tuple_group = _sanitize_code(
        "connections = []\nconnections.append((i, j, line))\ngroup = VGroup(*connections, title)\n"
    )
    assert "VGroup(*[item[-1] for item in connections], title)" in tuple_group
    caption_bg = _sanitize_code("caption.set_fill(BLACK, opacity=0.7)")
    assert "caption.add_background_rectangle(color=BLACK, opacity=0.7)" in caption_bg
    caption_state = _sanitize_code(
        'TEACHING_LINES = ["first"]\n'
        'caption = Text("", font_size=32).to_edge(DOWN)\n'
        'self.play(ReplacementTransform(caption, Text("next")))\n'
    )
    assert "caption = Text(TEACHING_LINES[0]," in caption_state
    assert "Transform(caption, Text" in caption_state
    move_target = _sanitize_code("self.play(MoveToTarget(items, target_position=box))")
    assert "items.animate.move_to(box)" in move_target
    list_layout = _sanitize_code(
        "balls = [make_ball(x) for x in data]\nballs.arrange(RIGHT, buff=0.6).shift(UP)\n"
    )
    assert "VGroup(*balls).arrange(RIGHT, buff=0.6)" in list_layout
    shifted_fade = _sanitize_code(
        'self.play(FadeIn(Text("prompt", font_size=32), DOWN))\nself.play(FadeOut(title, UP))\n'
    )
    assert 'FadeIn(Text("prompt", font_size=32), shift=DOWN)' in shifted_fade
    assert "FadeOut(title, shift=UP)" in shifted_fade
    assert "np.append(coord, 0)" in _sanitize_code("ball.move_to(coord)")
    assert "unit.move_to([x0 + c * dx, y0 - r * dy, 0])" in _sanitize_code(
        "unit.move_to(x0 + c * dx, y0 - r * dy)"
    )
    line_3d = _sanitize_code("leg = Line(start=(offset, -radius), end=(offset, -radius - height))")
    assert "start=(offset, -radius, 0)" in line_3d
    assert "end=(offset, -radius - height, 0)" in line_3d
    positional_line = _sanitize_code("mark = Line([x, y, 0], [x, y - height], color=YELLOW)")
    assert "Line([x, y, 0], [x, y - height, 0], color=YELLOW)" in positional_line
    safe_append = _sanitize_code("body.move_to(np.append(position, 0))")
    assert "if len(position) == 2 else position" in safe_append
    assert "list(balls).index(ball)" in _sanitize_code("balls.get_index(ball)")
    assert "get_part_by_class" not in _sanitize_code(
        "feet = animal.get_part_by_class(Line)"
    )
    used_family = _sanitize_code(
        "feet = animal.get_part_by_class(Line)\nself.play(FadeOut(feet))"
    )
    assert "animal.get_family()" in used_family
    assert "isinstance(part, Line)" in used_family
    broken_caption = (
        "self.play(Transform(caption, Text('next').move_to("
        "caption_box.get_center().move_to(caption.get_center()))))"
    )
    repaired_caption = _sanitize_code(broken_caption)
    assert ".get_center().move_to(" not in repaired_caption
    assert repaired_caption == _sanitize_code(repaired_caption)
    ambiguous_colors = _sanitize_code(
        'label = Text("24 and 2", t2c={"24": RED, "2": ORANGE})'
    )
    assert '"24": RED' in ambiguous_colors
    assert '"2": ORANGE' not in ambiguous_colors
    assert "buff=max(0.3, 0.2)" in _sanitize_code(
        "items.arrange_in_grid(rows=5, cols=7, buff=(0.3, 0.2))"
    )
    assert "background_rect" not in _sanitize_code('caption = Text("hello", background_rect=True)')
    visible_transform = _sanitize_code(
        "for unit in animals:\n"
        "    unit.become(make_target())\n"
        "self.play(*[Transform(unit, make_target()) for unit in animals])\n"
    )
    assert "unit.become" not in visible_transform
    assert "Transform(unit, make_target())" in visible_transform
    chained_text = _sanitize_code(
        'caption = Text("short", font_size=24).to_edge(DOWN).scale_to_fit_width(11.5)'
    )
    assert 'caption = Text("short", font_size=24).to_edge(DOWN)' in chained_text
    assert "if caption.width > 11.5:" in chained_text
    wrapped = _ensure_problem_text(
        'from manim import *\nPROBLEM_TEXT = """old"""',
        "这是一个很长的全新问题，其中包含若干条件和一个需要回答的目标，"
        "视频开场必须完整显示原文且不能缩成难以阅读的一行。",
    )
    assert "old" not in wrapped
    assert "\\n" in wrapped
    problem_literal = ast.literal_eval(
        re.search(r"PROBLEM_TEXT\s*=\s*(.+)", wrapped).group(1)  # type: ignore[union-attr]
    )
    assert max(len(line) for line in problem_literal.splitlines()) <= 22
    ordered = _ensure_problem_text(
        """from manim import *
PROBLEM_TEXT = "old"
class SolutionScene(Scene):
    def construct(self):
        caption = Text("strategy")
        self.play(Write(caption))
        card = Text(PROBLEM_TEXT)
        self.play(Write(card))
        self.wait(2)
        self.play(FadeOut(card))
""",
        "new problem",
    )
    assert ordered.index("self.play(Write(card))") < ordered.index("self.play(Write(caption))")
    assert ordered.index("self.play(FadeOut(card))") < ordered.index("self.play(Write(caption))")
    multiline_ordered = _ensure_problem_text(
        """from manim import *
PROBLEM_TEXT = "old"
class SolutionScene(Scene):
    def construct(self):
        caption_bg = Rectangle()
        caption = Text("strategy")
        self.play(
            FadeIn(caption_bg),
            FadeIn(caption),
        )
        problem_card = Text(PROBLEM_TEXT)
        self.play(Write(problem_card))
        self.wait(2)
        self.play(FadeOut(problem_card))
""",
        "new problem",
    )
    assert multiline_ordered.index("self.play(Write(problem_card))") < multiline_ordered.index(
        "FadeIn(caption_bg)"
    )
    assert multiline_ordered.index("self.play(FadeOut(problem_card))") < multiline_ordered.index(
        "FadeIn(caption_bg)"
    )
    class_attr_ordered = _ensure_problem_text(
        _sanitize_code("""from manim import *
class SolutionScene(Scene):
    PROBLEM_TEXT = "old"
    def construct(self):
        caption = Text("strategy")
        self.add(caption)
        card = Text(self.PROBLEM_TEXT, font_size=20)
        self.play(Write(card))
        self.wait(2)
        self.play(FadeOut(card))
"""),
        "new problem",
    )
    assert "Text(self.PROBLEM_TEXT, font_size=40)" in class_attr_ordered
    assert class_attr_ordered.index("self.play(FadeOut(card))") < class_attr_ordered.index(
        "self.add(caption)"
    )
    atomic_opening = _ensure_problem_text(
        _sanitize_code("""from manim import *
PROBLEM_TEXT = "old"
class SolutionScene(Scene):
    def construct(self):
        card = Text(PROBLEM_TEXT)
        self.play(Write(card))
        self.play(FadeIn(answer_hint))
        self.wait(3)
        self.play(FadeOut(card))
"""),
        "new problem",
    )
    assert atomic_opening.index("self.play(FadeOut(card))") < atomic_opening.index(
        "self.play(FadeIn(answer_hint))"
    )
    inline_problem = _ensure_problem_text(
        """from manim import *
class SolutionScene(Scene):
    def construct(self):
        self.play(Write(Text(PROBLEM_TEXT, font_size=30).to_edge(UP)))
        self.wait(3)
        self.play(FadeOut(Text(PROBLEM_TEXT, font_size=30).to_edge(UP)))
""",
        "当前未知问题",
    )
    assert "problem_card = Text(PROBLEM_TEXT" in inline_problem
    assert "self.play(Write(problem_card))" in inline_problem
    assert "self.play(FadeOut(problem_card))" in inline_problem
    missing_problem_card = _ensure_problem_text(
        """from manim import *
class SolutionScene(Scene):
    def construct(self):
        PROBLEM_TEXT = "old"
        title = Text("开始")
        self.play(Write(title))
""",
        "当前未知问题",
    )
    assert "problem_card = Text(PROBLEM_TEXT" in missing_problem_card
    assert missing_problem_card.index("self.play(Write(problem_card))") < missing_problem_card.index(
        "self.play(Write(title))"
    )


def test_static_gate_rejects_display_text_as_category_state() -> None:
    code = """
from manim import *
class SolutionScene(Scene):
    def construct(self):
        is_different = left.get_text() != right.get_text()
"""
    issues = _check_structure(code, use_latex=False)
    assert any("完整显示文本" in issue for issue in issues)


def test_static_gate_rejects_class_helper_reading_construct_local() -> None:
    code = """
from manim import *
class SolutionScene(Scene):
    def construct(self):
        subtitle_y = -3
        self.set_caption("hello")
    def set_caption(self, text):
        caption = Text(text).set_y(subtitle_y)
"""
    issues = _check_structure(code, use_latex=False)
    assert any("set_caption" in issue and "subtitle_y" in issue for issue in issues)


def test_static_gate_rejects_stale_index_from_previous_layout_loop() -> None:
    tree = ast.parse(
        """for row in range(10):
    for col in range(10):
        make_tile(row, col)
for row in range(10):
    make_added_tile(row, col)
"""
    )
    issues = _check_stale_loop_indices(tree)
    assert any("col" in issue and "旧循环索引" in issue for issue in issues)
    fixed = ast.parse(
        """for row in range(10):
    for col in range(10):
        make_tile(row, col)
for row in range(10):
    for col in range(10, 12):
        make_added_tile(row, col)
"""
    )
    assert _check_stale_loop_indices(fixed) == []


def test_scope_refine_extracts_rich_traceback_location() -> None:
    from math_tutor.infrastructure.agent.scope_refine import extract_error_line

    traceback = (
        "/site-packages/manim/scene.py:237 in render\n"
        "/tmp/generated_scene.py:132 in construct\nNameError: missing"
    )
    assert extract_error_line(traceback) == 132


def test_verifier_program_fault_does_not_impugn_the_solution() -> None:
    assert (
        _classify_verification_failure("执行错误: TypeError: bad checker", expected_pass=True)
        == "verifier_fault"
    )
    assert (
        _classify_verification_failure("断言失败: claimed counterexample", expected_pass=True)
        == "unconfirmed_assertion"
    )
    assert (
        _classify_verification_failure("断言失败: actual counterexample", expected_pass=False)
        == "solution_failure"
    )
    assert (
        _classify_verification_failure("verify 返回 False（应返回 True）", expected_pass=False)
        == "solution_failure"
    )


def test_independent_consistency_audit_parses_specific_contradictions() -> None:
    parsed = _parse_consistency_audit(
        '{"consistent": false, "issues": ["同一计数先写3，后写4"], "checked_claims": ["总数为10"]}'
    )
    assert parsed == (False, ["同一计数先写3，后写4"], ["总数为10"])
    assert _parse_consistency_audit('{"issues": []}') is None


def test_static_gate_rejects_unbounded_or_huge_generated_loops() -> None:
    base = "from manim import *\nclass SolutionScene(Scene):\n    def construct(self):\n"
    assert any(
        "while" in issue
        for issue in _check_structure(
            base + "        while True:\n            self.wait(1)", use_latex=False
        )
    )
    assert any(
        "range" in issue
        for issue in _check_structure(
            base + "        for i in range(10000):\n            self.wait(0.1)", use_latex=False
        )
    )


def test_static_gate_rejects_loop_shadowing_of_later_fadeout_target() -> None:
    code = """from manim import *
class SolutionScene(Scene):
    def construct(self):
        volume_bar = Rectangle()
        for item in [1, 2, 3]:
            volume_bar = Rectangle(height=item)
        self.play(FadeOut(volume_bar))
"""
    issues = _check_structure(code, use_latex=False)
    assert any("覆盖" in issue and "volume_bar" in issue for issue in issues)


def test_static_gate_rejects_noop_or_unplayed_animation_patterns() -> None:
    tree = ast.parse("""class SolutionScene:
    def construct(self):
        self.play(Transform(group, group))
        caption.animate.become(other)
        self.play(self.get_caption(1))
        self.play(MoveToTarget(item))
""")
    issues = _check_animation_api_misuse(tree)
    assert any("同对象" in issue for issue in issues)
    assert any("未传给" in issue for issue in issues)
    assert any("不能确认" in issue for issue in issues)
    assert any("generate_target" in issue for issue in issues)
    fade_tree = ast.parse("self.play(FadeOut(Text('new object'))) ")
    assert any("未在场" in issue for issue in _check_animation_api_misuse(fade_tree))
    duplicate_tree = ast.parse(
        "self.play(Transform(item, target), item.animate.set_fill(RED))"
    )
    assert any("重复驱动对象 item" in issue for issue in _check_animation_api_misuse(duplicate_tree))
    mutated_target_tree = ast.parse("self.play(Transform(item, item.add(label)))")
    assert any("动画前直接修改了源对象 item" in issue for issue in _check_animation_api_misuse(mutated_target_tree))
    legacy_tree = ast.parse("self.play(item.set_color, RED)")
    assert any("旧式方法参数" in issue for issue in _check_animation_api_misuse(legacy_tree))
    drifting_caption = ast.parse(
        "self.play(Transform(caption, Text(TEACHING_LINES[2], font_size=24)))"
    )
    assert any("默认原点" in issue for issue in _check_animation_api_misuse(drifting_caption))


def test_static_gate_rejects_parent_and_child_labels_in_the_same_band() -> None:
    tree = ast.parse(
        """segments = VGroup()
remaining = segments[3:]
summary = Text("aggregate")
summary.next_to(remaining, DOWN, buff=0.3)
self.play(FadeIn(summary))
labels = VGroup()
for i in range(5):
    label = Text("unit")
    center = remaining[i].get_center()
    label.move_to(center + DOWN * 0.5)
    labels.add(label)
self.play(FadeIn(labels))
"""
    )
    issues = _check_hierarchical_label_band_conflicts(tree)
    assert any("summary" in issue and "labels" in issue and "DOWN" in issue for issue in issues)

    non_overlapping = ast.parse(
        """segments = VGroup()
remaining = segments[3:]
summary = Text("aggregate")
summary.next_to(remaining, UP, buff=0.3)
self.play(FadeIn(summary))
labels = VGroup()
for i in range(5):
    label = Text("unit")
    center = remaining[i].get_center()
    label.move_to(center + DOWN * 0.5)
    labels.add(label)
self.play(FadeIn(labels))
"""
    )
    assert _check_hierarchical_label_band_conflicts(non_overlapping) == []


def test_manim_error_compaction_preserves_exception_tail() -> None:
    compact = _compact_manim_error("header" * 1000 + "\nTypeError: actual cause")
    assert "traceback head omitted" in compact
    assert compact.endswith("TypeError: actual cause")


def test_session_quality_summary_measures_first_pass_without_type_labels() -> None:
    now = datetime.now(timezone.utc)
    session = Session(
        id="session",
        problem="opaque current problem",
        grade="middle",
        status="done",
        created_at=now,
        updated_at=now,
        final_video_path="video.mp4",
    )
    calls = [
        ToolCallRecord(
            id=f"call-{index}",
            session_id="session",
            turn_index=index,
            name=name,
            arguments={},
            status="success",
            created_at=now,
            duration_ms=100,
        )
        for index, name in enumerate(
            (
                "solve_problem",
                "verify_solution",
                "direct_video",
                "compile_video",
                "watch_video",
            ),
            start=1,
        )
    ]
    report = Artifact(
        id=1,
        session_id="session",
        kind="quality_report",
        path="quality.json",
        created_at=now,
        meta={
            "overall_quality": "good",
            "b_total": 10,
            "math_consistency": 2,
            "essence_delivery": 2,
            "technical_pass": True,
            "width": 1280,
            "height": 720,
            "fps": 30,
            "has_audio": False,
        },
    )
    subtitle = Artifact(
        id=2,
        session_id="session",
        kind="subtitle",
        path="captions.vtt",
        created_at=now,
        meta={"format": "webvtt", "language": "zh", "cue_count": 3},
    )
    summary = build_session_quality_summary(session, calls, [report, subtitle])
    assert summary["quality_gate_passed"] is True
    assert summary["first_pass_success"] is True
    assert summary["total_tool_latency_ms"] == 500
    assert "problem_type" not in summary
    aggregate = aggregate_quality_summaries([summary])
    assert aggregate["quality_gate_pass_rate"] == 1.0
    assert aggregate["first_pass_success_rate"] == 1.0
    assert aggregate["accessibility_pass_rate"] == 1.0


def test_quality_trend_detects_cross_session_regression_without_type_buckets() -> None:
    recent = [
        {
            "quality_gate_passed": False,
            "first_pass_success": False,
            "total_tool_latency_ms": 2000,
        }
        for _ in range(3)
    ]
    previous = [
        {
            "quality_gate_passed": True,
            "first_pass_success": True,
            "total_tool_latency_ms": 1000,
        }
        for _ in range(3)
    ]
    trend = compare_quality_windows(recent + previous, window_size=3)
    assert trend["status"] == "regression"
    assert "quality_gate_pass_rate" in trend["regressions"]
    assert "problem_type" not in str(trend)


def test_bounded_workflow_skips_controller_llm_calls() -> None:
    class NeverCalledLLM:
        calls = 0

        def chat_stream(self, *args: Any, **kwargs: Any) -> Any:
            self.calls += 1
            raise AssertionError("controller LLM must not run in bounded mode")

    class MemoryStore:
        def __init__(self) -> None:
            self.updated: dict[str, Any] = {}
            self.artifact_id = 0

        async def create_session(self, **kwargs: Any) -> str:
            return "session"

        async def append_message(self, *args: Any, **kwargs: Any) -> int:
            return 1

        async def record_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def complete_tool_call(self, *args: Any, **kwargs: Any) -> None:
            return None

        async def update_session(self, session_id: str, **kwargs: Any) -> None:
            self.updated = kwargs

        async def save_text_artifact(self, *args: Any, **kwargs: Any) -> tuple[int, str]:
            self.artifact_id += 1
            return self.artifact_id, "quality.json"

        async def add_artifact(self, *args: Any, **kwargs: Any) -> int:
            self.artifact_id += 1
            return self.artifact_id

    class StageTool(ITool):
        def __init__(self, name: str) -> None:
            self._name = name

        @property
        def name(self) -> str:
            return self._name

        @property
        def description(self) -> str:
            return self._name

        @property
        def parameters(self) -> dict[str, Any]:
            return {"type": "object", "properties": {}, "required": []}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            state = ctx.state
            if self.name == "solve_problem":
                state["analysis"] = {"question": "goal"}
                state["solution_steps"] = [{"description": "derive"}]
                state["solution_answer"] = "answer"
                state["solution_verified"] = False
            elif self.name == "verify_solution":
                state["solution_verified"] = True
            elif self.name == "direct_video":
                state["visual_plan"] = _open_world_plan()
            elif self.name == "compile_video":
                state["latest_manim_code"] = "code"
                state["last_validation_passed"] = True
                state["latest_video_path"] = "video.mp4"
                return ToolResult(
                    success=True,
                    summary="rendered",
                    artifacts=[
                        ArtifactSpec(
                            kind="video",
                            external_path="video.mp4",
                            meta={"url": "/video.mp4"},
                        )
                    ],
                )
            elif self.name == "watch_video":
                state["last_visual_review"] = {"overall_quality": "good"}
                state["last_visual_failed"] = False
            return ToolResult(success=True, summary="ok")

    registry = ToolRegistry()
    stage_names = (
        "solve_problem",
        "verify_solution",
        "direct_video",
        "compile_video",
        "watch_video",
    )
    for name in stage_names:
        registry.register(StageTool(name))
    llm = NeverCalledLLM()
    store = MemoryStore()
    loop = AgentLoop(
        llm=llm,  # type: ignore[arg-type]
        registry=registry,
        composer=PromptComposer(),
        store=store,  # type: ignore[arg-type]
        use_latex=False,
        # Exactly the five production stages: success must not require a
        # sixth empty controller turn.
        max_turns=5,
        deterministic_workflow=True,
    )

    async def collect() -> list[Any]:
        return [event async for event in loop.run(problem="opaque", grade="middle")]

    events = asyncio.run(collect())
    names = [event.name for event in events if isinstance(event, ToolCallStart)]
    done = [event for event in events if isinstance(event, DoneEvent)][-1]
    assert names == list(stage_names)
    assert llm.calls == 0
    assert done.status == "ok"
    assert done.final_video_path == "video.mp4"


def test_compile_video_hides_one_evidence_directed_repair_inside_stage() -> None:
    class Writer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_manim_code"] = f"code-{self.calls}"
            return ToolResult(success=True, summary="written")

    class Validator:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            if self.calls == 1:
                ctx.state["last_validation_issues"] = ["observed=x expected=y"]
                ctx.state["last_error_source"] = "validate"
                return ToolResult(success=False, summary="invalid", error="validation_failed")
            ctx.state["last_validation_passed"] = True
            return ToolResult(success=True, summary="valid")

    class Renderer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_video_path"] = "video.mp4"
            ctx.state["latest_video_url"] = "/video.mp4"
            return ToolResult(success=True, summary="rendered")

    writer, validator, renderer = Writer(), Validator(), Renderer()
    tool = CompileVideoTool(writer, validator, renderer)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="middle",
        problem="opaque",
        state={"solution_verified": True, "visual_plan": _open_world_plan()},
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert result.data is not None
    assert result.data["internal_repair_count"] == 1
    assert writer.calls == 2
    assert validator.calls == 2
    assert renderer.calls == 1


def test_compile_video_guarantees_a_rendered_verified_fallback() -> None:
    class Writer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            ctx.state["latest_manim_code"] = "model code"
            return ToolResult(success=True, summary="written")

    class Validator:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(success=True, summary="valid")

    class Renderer:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            if not ctx.state.get("delivery_fallback"):
                return ToolResult(success=False, summary="runtime failed", error="bad api")
            ctx.state["latest_video_path"] = "fallback.mp4"
            ctx.state["latest_video_url"] = "/fallback.mp4"
            return ToolResult(success=True, summary="fallback rendered")

    writer, validator, renderer = Writer(), Validator(), Renderer()
    tool = CompileVideoTool(writer, validator, renderer)  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=4,
        grade="middle",
        problem="一个此前未见的问题",
        state={
            "solution_verified": True,
            "solution_steps": [
                {"description": "建立关系", "operation": "7 + 5 = 12", "result": "12"}
            ],
            "solution_answer": "12",
            "visual_plan": _open_world_plan(),
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert result.data is not None and result.data["delivery_fallback"] is True
    assert result.data["video_path"] == "fallback.mp4"
    assert renderer.calls == 3
    fallback_code = build_verified_fallback_code(ctx)
    compile(fallback_code, "<fallback>", "exec")
    assert "一个此前未见的问题" in fallback_code
    assert "答案：12" in fallback_code
    assert "STEP_MODELS" in fallback_code
    assert "quantity_bar" in fallback_code
    assert "RoundedRectangle" in fallback_code
    assert "Arrow(" in fallback_code
    assert "STEP_TEXTS" not in fallback_code


def test_review_repair_uses_visual_fallback_instead_of_restoring_text_only_video() -> None:
    class Writer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=False, summary="repair source failed", error="bad patch")

    class Validator:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            raise AssertionError("validator is not reached when repair writing fails")

    class Renderer:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            assert ctx.state.get("delivery_fallback") is True
            assert "quantity_bar" in str(args.get("code") or "")
            ctx.state["latest_video_path"] = "visual-fallback.mp4"
            ctx.state["latest_video_url"] = "/visual-fallback.mp4"
            return ToolResult(success=True, summary="visual fallback rendered")

    tool = CompileVideoTool(Writer(), Validator(), Renderer())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="任意新问题",
        state={
            "solution_verified": True,
            "solution_steps": [
                {"description": "建立数量关系", "operation": "9 - 4 = 5", "result": "5"}
            ],
            "solution_answer": "5",
            "visual_plan": _open_world_plan(),
            "latest_video_path": "text-only.mp4",
        },
    )
    result = asyncio.run(tool.execute({"review_repair": True}, ctx))
    assert result.success is True
    assert result.data is not None and result.data["delivery_fallback"] is True
    assert result.data["video_path"] == "visual-fallback.mp4"


def test_watch_video_allows_exactly_one_frame_evidence_repair() -> None:
    class Inspector:
        calls = 0
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            quality = "bad" if self.calls == 1 else "good"
            ctx.state["last_visual_review"] = {"overall_quality": quality}
            ctx.state["last_visual_failed"] = quality == "bad"
            if quality == "bad":
                ctx.state["last_visual_issues"] = "24s observed=overlap expected=separate"
                ctx.state["last_error_source"] = "inspect"
            return ToolResult(
                success=True,
                summary=quality,
                data={"overall_quality": quality, "blacklist_hits": []},
            )

    class Compiler:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            assert args == {"review_repair": True}
            ctx.state["latest_video_path"] = "repaired.mp4"
            ctx.state["latest_video_url"] = "/repaired.mp4"
            return ToolResult(success=True, summary="recompiled")

    class Director:
        calls = 0

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            self.calls += 1
            return ToolResult(success=True, summary="redirected")

    inspector, compiler, director = Inspector(), Compiler(), Director()
    tool = WatchVideoTool(  # type: ignore[arg-type]
        inspector,
        compiler,
        director,
    )
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={"latest_video_path": "first.mp4"},
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert result.data is not None
    assert result.data["internal_repair_count"] == 1
    assert inspector.calls == 2
    assert compiler.calls == 1
    assert director.calls == 0


def test_watch_video_delivers_playable_candidate_when_quality_repair_fails() -> None:
    class Inspector:
        parameters: dict[str, Any] = {"type": "object", "properties": {}}

        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            ctx.state["last_visual_review"] = {"overall_quality": "bad"}
            ctx.state["last_visual_failed"] = True
            ctx.state["last_visual_issues"] = "字幕遮挡"
            return ToolResult(
                success=True,
                summary="bad",
                data={
                    "overall_quality": "bad",
                    "blacklist_hits": [],
                    "b_scores": {"b5": 2, "b6": 2},
                },
            )

    class Compiler:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=False, summary="repair failed", error="bad api")

    class Director:
        async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
            return ToolResult(success=True, summary="unused")

    tool = WatchVideoTool(Inspector(), Compiler(), Director())  # type: ignore[arg-type]
    ctx = ToolContext(
        session_id="s",
        turn_index=5,
        grade="middle",
        problem="opaque",
        state={
            "latest_manim_code": "playable code",
            "latest_video_path": "playable.mp4",
            "latest_video_url": "/playable.mp4",
        },
    )
    result = asyncio.run(tool.execute({}, ctx))
    assert result.success is True
    assert result.data is not None and result.data["quality_degraded"] is True
    assert result.data["video_path"] == "playable.mp4"
    assert ctx.state["last_visual_failed"] is False
