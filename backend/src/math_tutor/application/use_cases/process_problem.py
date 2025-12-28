"""
Process Problem Use Case

Orchestrates the full problem processing pipeline:
1. Understanding (analysis)
2. Solving
3. Visualization code generation
4. Video rendering
"""
import logging
from dataclasses import dataclass
from typing import Any

from ..interfaces import ILLMService, IVideoGenerator, ISkillRepository
from ...domain import Problem, Solution, EducationLevel

logger = logging.getLogger(__name__)


@dataclass
class ProcessProblemResult:
    """Result of processing a problem"""
    success: bool
    problem: Problem
    analysis: dict[str, Any] | None = None
    solution: Solution | None = None
    visualization_code: str | None = None
    video_path: str | None = None
    error: str | None = None


class ProcessProblemUseCase:
    """
    Use case for processing a math problem end-to-end.
    
    This is the main orchestrator that coordinates:
    - Understanding Agent (analysis)
    - Solving Agent
    - Visualization Agent
    - Manim Executor
    """
    
    def __init__(
        self,
        llm_service: ILLMService,
        video_generator: IVideoGenerator,
        skill_repository: ISkillRepository | None = None,
        max_debug_attempts: int = 2,
    ):
        self.llm_service = llm_service
        self.video_generator = video_generator
        self.skill_repository = skill_repository
        self.max_debug_attempts = max_debug_attempts
    
    async def execute(
        self,
        problem_text: str,
        grade: EducationLevel = EducationLevel.ELEMENTARY_UPPER,
    ) -> ProcessProblemResult:
        """
        Execute the full problem processing pipeline.
        
        Args:
            problem_text: The math problem text
            grade: Education level
            
        Returns:
            ProcessProblemResult with all outputs
        """
        problem = Problem(text=problem_text, grade_level=grade)
        
        try:
            # Step 1: Analyze the problem
            logger.info(f"Analyzing problem: {problem_text[:50]}...")
            analysis = await self.llm_service.analyze_problem(problem)
            
            # Update problem with analysis
            problem.problem_type = analysis.get("problem_type", "")
            problem.concepts = analysis.get("concepts", [])
            problem.known_conditions = analysis.get("known_conditions", [])
            problem.question = analysis.get("question", "")
            problem.key_values = analysis.get("key_values", {})
            problem.difficulty = analysis.get("difficulty", "")
            problem.strategy = analysis.get("strategy", "")
            
            # Step 2: Solve the problem
            logger.info("Solving problem...")
            solution = await self.llm_service.solve_problem(problem, analysis)
            
            # Step 3: Generate visualization code
            logger.info("Generating visualization code...")
            code = await self.llm_service.generate_visualization_code(problem, solution)
            
            # Step 4: Execute code and generate video
            logger.info("Rendering video...")
            video_path = await self._render_with_debugging(code)
            
            return ProcessProblemResult(
                success=True,
                problem=problem,
                analysis=analysis,
                solution=solution,
                visualization_code=code,
                video_path=video_path,
            )
        
        except Exception as e:
            logger.exception(f"Error processing problem: {e}")
            return ProcessProblemResult(
                success=False,
                problem=problem,
                error=str(e),
            )
    
    async def _render_with_debugging(self, code: str) -> str | None:
        """
        Render video with automatic debugging on failure.
        
        Args:
            code: Initial Manim code
            
        Returns:
            Video path if successful, None otherwise
        """
        current_code = code
        
        for attempt in range(self.max_debug_attempts + 1):
            result = self.video_generator.execute_code(current_code)
            
            if result.success:
                return result.video_path
            
            if attempt < self.max_debug_attempts:
                logger.info(f"Debugging attempt {attempt + 1}...")
                current_code = await self.llm_service.debug_code(
                    current_code,
                    result.error_message,
                    attempt + 1,
                )
            else:
                logger.error(f"Failed after {self.max_debug_attempts} debug attempts")
        
        return None
