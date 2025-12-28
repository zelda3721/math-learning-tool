"""
Problems API endpoints - main processing routes

Uses LangGraph workflow for intelligent problem processing.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ...domain.value_objects import EducationLevel
from ...config.dependencies import get_langgraph_engine
from ...infrastructure.agents.langgraph_engine import LangGraphEngine

router = APIRouter()


class ProcessProblemRequest(BaseModel):
    """Request model for processing a math problem"""
    problem: str
    grade: EducationLevel = EducationLevel.ELEMENTARY_UPPER
    
    class Config:
        json_schema_extra = {
            "example": {
                "problem": "小明有25个糖果，他给了小红8个，又给了小刚5个，然后小明的妈妈又给了他10个糖果。请问小明现在有多少个糖果？",
                "grade": "elementary_upper"
            }
        }


class ProcessProblemResponse(BaseModel):
    """Response model for processed problem"""
    status: str
    problem: str
    grade: str
    analysis: dict | None = None
    solution: dict | None = None
    visualization_code: str | None = None
    video_path: str | None = None
    error: str | None = None
    fallback_content: str | None = None


@router.post("/process", response_model=ProcessProblemResponse)
async def process_problem(
    request: ProcessProblemRequest,
    engine: LangGraphEngine = Depends(get_langgraph_engine),
) -> ProcessProblemResponse:
    """
    Process a math problem end-to-end using LangGraph workflow.
    
    Flow:
    1. Classify problem complexity
    2. Analyze (complex only)
    3. Solve and validate
    4. Generate visualization
    5. Execute Manim
    6. Debug or fallback on error
    """
    try:
        result = await engine.process_problem(
            problem_text=request.problem,
            grade=request.grade,
        )
        # Convert filesystem path to URL
        video_path = result.get("video_path")
        video_url = None
        if video_path:
            # video_path is like: media/videos/.../file.mp4
            # Convert to URL: /media/videos/.../file.mp4
            if video_path.startswith("media/"):
                video_url = "/" + video_path
            elif "/media/" in video_path:
                # Absolute path, extract from /media/ onwards
                video_url = "/media/" + video_path.split("/media/")[-1]
            else:
                video_url = "/media/" + video_path
        
        return ProcessProblemResponse(
            status=result.get("status", "failed"),
            problem=result.get("problem", request.problem),
            grade=result.get("grade", request.grade.value),
            analysis=result.get("analysis"),
            solution=result.get("solution"),
            visualization_code=result.get("visualization_code"),
            video_path=video_url,
            error=result.get("error"),
            fallback_content=result.get("fallback_content"),
        )
    except Exception as e:
        return ProcessProblemResponse(
            status="failed",
            problem=request.problem,
            grade=request.grade.value,
            error=str(e),
        )


@router.post("/analyze")
async def analyze_problem(
    request: ProcessProblemRequest,
    engine: LangGraphEngine = Depends(get_langgraph_engine),
) -> dict:
    """Analyze a math problem (classification + understanding)"""
    # Run partial workflow - just classify and understand
    result = await engine.process_problem(
        problem_text=request.problem,
        grade=request.grade,
    )
    return {
        "status": "success",
        "problem_type": result.get("analysis", {}).get("problem_type"),
        "analysis": result.get("analysis"),
    }


@router.post("/solve")
async def solve_problem(
    request: ProcessProblemRequest,
    engine: LangGraphEngine = Depends(get_langgraph_engine),
) -> dict:
    """Solve a math problem (full workflow)"""
    result = await engine.process_problem(
        problem_text=request.problem,
        grade=request.grade,
    )
    return {
        "status": result.get("status", "failed"),
        "solution": result.get("solution"),
        "answer": result.get("solution", {}).get("answer"),
    }
