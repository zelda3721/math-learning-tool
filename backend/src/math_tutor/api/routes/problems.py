"""
Problems API endpoints - main processing routes
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ...domain.value_objects import EducationLevel

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
    video_url: str | None = None
    error: str | None = None


@router.post("/process", response_model=ProcessProblemResponse)
async def process_problem(request: ProcessProblemRequest) -> ProcessProblemResponse:
    """
    Process a math problem end-to-end.
    
    This endpoint:
    1. Analyzes the problem
    2. Generates a solution
    3. Creates visualization code
    4. Renders the video
    """
    # TODO: Inject use case via dependency
    # For now, return a placeholder response
    return ProcessProblemResponse(
        status="pending",
        problem=request.problem,
        grade=request.grade.value,
        analysis=None,
        solution=None,
        visualization_code=None,
        video_url=None,
        error="Processing not yet implemented - infrastructure layer needed",
    )


@router.post("/analyze")
async def analyze_problem(request: ProcessProblemRequest) -> dict:
    """Analyze a math problem (understanding step only)"""
    # TODO: Implement with ILLMService
    return {
        "status": "pending",
        "message": "Analysis not yet implemented",
    }


@router.post("/solve")
async def solve_problem(request: ProcessProblemRequest) -> dict:
    """Solve a math problem (requires prior analysis)"""
    # TODO: Implement with ILLMService
    return {
        "status": "pending",
        "message": "Solving not yet implemented",
    }
