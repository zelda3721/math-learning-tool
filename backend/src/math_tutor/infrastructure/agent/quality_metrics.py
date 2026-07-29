"""Content-agnostic production metrics for completed video sessions."""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Iterable

from ..storage.models import Artifact, Feedback, Session, ToolCallRecord

_CRITICAL_STAGES = (
    "solve_problem",
    "verify_solution",
    "visual_plan",
    "generate_manim_code",
    "validate_manim_code",
    "run_manim",
    "inspect_video",
)


def build_session_quality_summary(
    session: Session,
    tool_calls: Iterable[ToolCallRecord],
    artifacts: Iterable[Artifact],
    feedback: Iterable[Feedback] = (),
) -> dict[str, Any]:
    """Aggregate latency, retries, deterministic gates, and user feedback.

    Metrics are based on workflow evidence and never on a problem-type label.
    """
    calls = list(tool_calls)
    artifact_list = list(artifacts)
    feedback_list = list(feedback)
    counts = Counter(call.name for call in calls)
    failures = Counter(call.name for call in calls if call.status != "success")
    latency_by_stage: dict[str, int] = defaultdict(int)
    for call in calls:
        latency_by_stage[call.name] += int(call.duration_ms or 0)

    quality_artifacts = [
        artifact for artifact in artifact_list if artifact.kind == "quality_report"
    ]
    latest_quality = quality_artifacts[-1].meta if quality_artifacts else {}
    subtitle_artifacts = [
        artifact for artifact in artifact_list if artifact.kind == "subtitle"
    ]
    latest_subtitle = subtitle_artifacts[-1].meta if subtitle_artifacts else {}
    overall = str(latest_quality.get("overall_quality") or "unknown").lower()
    technical_pass = latest_quality.get("technical_pass") is True
    math_consistency = latest_quality.get("math_consistency")
    essence_delivery = latest_quality.get("essence_delivery")
    has_audio = latest_quality.get("has_audio") is True
    has_subtitles = bool(latest_subtitle.get("cue_count"))
    accessibility_pass = bool(has_audio or has_subtitles)
    quality_contract = str((session.meta or {}).get("quality_contract") or "legacy")
    accessibility_required = quality_contract == "open_world_v3"
    quality_gate_passed = bool(
        overall in {"good", "acceptable"}
        and technical_pass
        and math_consistency != 0
        and essence_delivery != 0
        and (accessibility_pass or not accessibility_required)
    )

    retry_counts = {
        stage: max(0, counts.get(stage, 0) - 1)
        for stage in _CRITICAL_STAGES
        if counts.get(stage, 0)
    }
    completed_once = all(counts.get(stage, 0) == 1 for stage in _CRITICAL_STAGES)
    latest_feedback = feedback_list[-1].label if feedback_list else None
    return {
        "session_status": session.status,
        "quality_contract": quality_contract,
        "quality_gate_passed": quality_gate_passed,
        "first_pass_success": bool(
            session.status == "done" and quality_gate_passed and completed_once
        ),
        "overall_quality": overall,
        "b_total": latest_quality.get("b_total"),
        "math_consistency": math_consistency,
        "essence_delivery": essence_delivery,
        "technical_pass": technical_pass,
        "accessibility_pass": accessibility_pass,
        "has_audio": has_audio,
        "has_subtitles": has_subtitles,
        "video": {
            key: latest_quality.get(key)
            for key in ("width", "height", "fps", "duration_s", "has_audio")
            if latest_quality.get(key) is not None
        },
        "total_tool_latency_ms": sum(int(call.duration_ms or 0) for call in calls),
        "latency_by_stage_ms": dict(latency_by_stage),
        "attempts_by_stage": dict(counts),
        "failed_attempts_by_stage": dict(failures),
        "retry_counts": retry_counts,
        "user_feedback": latest_feedback,
    }


def aggregate_quality_summaries(summaries: Iterable[dict[str, Any]]) -> dict[str, Any]:
    items = list(summaries)
    evaluated = [item for item in items if item.get("overall_quality") != "unknown"]
    count = len(evaluated)
    total_latency = sum(int(item.get("total_tool_latency_ms") or 0) for item in items)
    stage_totals: dict[str, int] = defaultdict(int)
    stage_counts: Counter[str] = Counter()
    for item in items:
        for stage, latency in (item.get("latency_by_stage_ms") or {}).items():
            stage_totals[stage] += int(latency or 0)
            stage_counts[stage] += 1
    return {
        "sessions": len(items),
        "evaluated_sessions": count,
        "quality_gate_pass_rate": (
            sum(bool(item.get("quality_gate_passed")) for item in evaluated) / count
            if count else None
        ),
        "first_pass_success_rate": (
            sum(bool(item.get("first_pass_success")) for item in evaluated) / count
            if count else None
        ),
        "accessibility_pass_rate": (
            sum(bool(item.get("accessibility_pass")) for item in evaluated) / count
            if count else None
        ),
        "average_tool_latency_ms": total_latency / len(items) if items else None,
        "average_latency_by_stage_ms": {
            stage: stage_totals[stage] / stage_counts[stage]
            for stage in stage_totals
        },
        "quality_distribution": dict(
            Counter(str(item.get("overall_quality")) for item in evaluated)
        ),
    }


def compare_quality_windows(
    summaries: Iterable[dict[str, Any]], *, window_size: int = 10
) -> dict[str, Any]:
    """Compare recent sessions with the preceding window without type buckets."""
    items = list(summaries)
    target_contract = (
        str(items[0].get("quality_contract") or "legacy") if items else "legacy"
    )
    # Do not interpret a quality-contract rollout as a model regression.
    items = [
        item
        for item in items
        if str(item.get("quality_contract") or "legacy") == target_contract
    ]
    size = max(2, min(50, int(window_size)))
    recent = items[:size]
    previous = items[size : size * 2]
    if len(recent) < 2 or len(previous) < 2:
        return {
            "status": "insufficient_data",
            "window_size": size,
            "recent_sessions": len(recent),
            "previous_sessions": len(previous),
            "quality_contract": target_contract,
        }

    def rate(values: list[dict[str, Any]], key: str) -> float:
        return sum(bool(item.get(key)) for item in values) / len(values)

    def average(values: list[dict[str, Any]], key: str) -> float:
        return sum(float(item.get(key) or 0) for item in values) / len(values)

    recent_pass = rate(recent, "quality_gate_passed")
    previous_pass = rate(previous, "quality_gate_passed")
    recent_first = rate(recent, "first_pass_success")
    previous_first = rate(previous, "first_pass_success")
    recent_latency = average(recent, "total_tool_latency_ms")
    previous_latency = average(previous, "total_tool_latency_ms")
    pass_delta = recent_pass - previous_pass
    first_delta = recent_first - previous_first
    latency_delta_ratio = (
        (recent_latency - previous_latency) / previous_latency
        if previous_latency > 0
        else None
    )
    regressions: list[str] = []
    if pass_delta < -0.1:
        regressions.append("quality_gate_pass_rate")
    if first_delta < -0.1:
        regressions.append("first_pass_success_rate")
    if latency_delta_ratio is not None and latency_delta_ratio > 0.25:
        regressions.append("average_tool_latency_ms")
    return {
        "status": "regression" if regressions else "stable_or_improving",
        "window_size": size,
        "quality_contract": target_contract,
        "recent_sessions": len(recent),
        "previous_sessions": len(previous),
        "recent": {
            "quality_gate_pass_rate": recent_pass,
            "first_pass_success_rate": recent_first,
            "average_tool_latency_ms": recent_latency,
        },
        "previous": {
            "quality_gate_pass_rate": previous_pass,
            "first_pass_success_rate": previous_first,
            "average_tool_latency_ms": previous_latency,
        },
        "delta": {
            "quality_gate_pass_rate": pass_delta,
            "first_pass_success_rate": first_delta,
            "average_tool_latency_ratio": latency_delta_ratio,
        },
        "regressions": regressions,
    }
