"""
Figure endpoint — 读图一次，处处可用。

POST /api/v1/figure/transcribe  { problem, figure_image }
  → { problem_with_conditions, conditions, structure, transcription, reconciled }

网关在拍照识题裁出配图之后调它：把"图上写的条件"按像素几何写准（"三角形AEF内标注「5」"），
替换抽取模型猜的那句，再回填到输入框——孩子看到的题干、送去解题的题干、题库存的题干，
用的是同一份读图结果。转写失败返回 200 + 空结果（调用方按"没读出"继续，绝不拦路）。
"""
from __future__ import annotations

import base64
import json
import logging
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...application.interfaces import ILLMProvider
from ...config.dependencies import get_escalation_provider_optional, get_vision_provider
from ...infrastructure.agent.figure_transcription import (
    cache_grounded_transcription,
    figure_structure_text,
    problem_with_figure_conditions,
    refine_transcription,
    transcribe_figure,
    transcription_conditions,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class FigureTranscribeRequest(BaseModel):
    problem: str = ""
    figure_image: str


_NUMERIC_LABEL_RE = re.compile(r"\d+(?:\.\d+)?")


def _unresolved_numeric_labels(t: dict[str, Any] | None) -> list[str]:
    """数字标注中没被像素几何归属到区域的那些（短 on 也算没归属）。"""
    out = []
    for label in (t or {}).get("labels") or []:
        text = str(label.get("text") or "").strip()
        if not _NUMERIC_LABEL_RE.fullmatch(text):
            continue
        if label.get("resolved") != "geometry" and len(label.get("on") or []) < 3:
            out.append(text)
    return out


def _dump_figure_debug(figure_image: str, problem: str, t: dict[str, Any] | None) -> None:
    """失败可复现：把收到的图形原样存档（前端裁剪不可观测，实机两次只能盲猜框）。"""
    try:
        head, _, payload = figure_image.partition(",")
        ext = "png" if "png" in head else "jpg"
        stamp = time.strftime("%Y%m%dT%H%M%S")
        root = Path("data/figure_debug")
        root.mkdir(parents=True, exist_ok=True)
        (root / f"{stamp}.{ext}").write_bytes(base64.b64decode(payload))
        (root / f"{stamp}.json").write_text(json.dumps(
            {"problem": problem[:400], "labels": (t or {}).get("labels"),
             "reconciled": (t or {}).get("reconciled")},
            ensure_ascii=False, indent=2))
    except Exception:  # noqa: BLE001
        logger.exception("figure debug dump failed")


@router.post("/transcribe")
async def transcribe(
    req: FigureTranscribeRequest,
    llm: ILLMProvider = Depends(get_vision_provider),
    escalation_llm: ILLMProvider | None = Depends(get_escalation_provider_optional),
) -> dict[str, Any]:
    if not req.figure_image.startswith("data:image/"):
        return {"transcription": None, "conditions": [], "structure": "", "problem_with_conditions": req.problem}
    try:
        t = await transcribe_figure(llm, req.figure_image)
    except Exception:  # noqa: BLE001
        logger.exception("figure transcribe endpoint failed")
        t = None
    if not t:
        return {"transcription": None, "conditions": [], "structure": "", "problem_with_conditions": req.problem}
    refine_transcription(t, req.figure_image, req.problem)
    # 抽取升级梯：像素几何没能把全部数字标注归属到区域、或有命名点没校准上时，
    # 用升级模型重转写一次。更强的视觉初判常常直接给出正确区域（AEF:5）和更准的
    # 点位，不依赖像素补救；只在失败时付时间税
    def _snap_incomplete(x: dict[str, Any]) -> bool:
        return int(x.get("snap_total") or 0) > int(x.get("snap_matched") or 0)

    unresolved = _unresolved_numeric_labels(t)
    if (unresolved or _snap_incomplete(t)) and escalation_llm is not None:
        logger.info(
            "figure transcribe escalation: 未归属数字标注 %s / 点校准 %s/%s，升级模型重转写",
            unresolved, t.get("snap_matched"), t.get("snap_total"),
        )
        try:
            t2 = await transcribe_figure(escalation_llm, req.figure_image)
            if t2:
                refine_transcription(t2, req.figure_image, req.problem)
                better = (
                    len(_unresolved_numeric_labels(t2)) < len(unresolved)
                    or (_snap_incomplete(t) and not _snap_incomplete(t2))
                )
                if better:
                    t2.setdefault("reconciled", []).append("升级模型重转写（首轮抽取不完整）")
                    t = t2
        except Exception:  # noqa: BLE001
            logger.exception("figure transcribe escalation failed")
    if _unresolved_numeric_labels(t) or _snap_incomplete(t):
        _dump_figure_debug(req.figure_image, req.problem, t)
    else:
        # 质量完好的转写才配进缓存：视频会话将复用这一份，不再重掷骰子
        cache_grounded_transcription(req.figure_image, t)
    return {
        "transcription": t,
        "conditions": transcription_conditions(t, req.problem),
        "structure": figure_structure_text(t),
        "problem_with_conditions": problem_with_figure_conditions(req.problem, t),
        # 给输入框/题库看的短版：只带"图中标注"，不带整段结构（结构由引擎解题时自己重算）
        "problem_short": problem_with_figure_conditions(req.problem, t, include_structure=False),
        "reconciled": t.get("reconciled") or [],
        "grounded": any(l.get("resolved") == "geometry" for l in t.get("labels") or []),
    }
