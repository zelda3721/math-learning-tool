"""
Figure endpoint — 读图一次，处处可用。

POST /api/v1/figure/transcribe  { problem, figure_image }
  → { problem_with_conditions, conditions, structure, transcription, reconciled }

网关在拍照识题裁出配图之后调它：把"图上写的条件"按像素几何写准（"三角形AEF内标注「5」"），
替换抽取模型猜的那句，再回填到输入框——孩子看到的题干、送去解题的题干、题库存的题干，
用的是同一份读图结果。转写失败返回 200 + 空结果（调用方按"没读出"继续，绝不拦路）。
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...application.interfaces import ILLMProvider
from ...config.dependencies import get_vision_provider
from ...infrastructure.agent.figure_transcription import (
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


@router.post("/transcribe")
async def transcribe(
    req: FigureTranscribeRequest,
    llm: ILLMProvider = Depends(get_vision_provider),
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
