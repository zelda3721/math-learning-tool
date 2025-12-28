"""
Visualization Agent Base - Core visualization agent class

Refactored from the original agents/visualization.py (1149 lines)
into a modular, maintainable structure.
"""
import json
import logging
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..base import BaseAgent
from .code_generator import ManimCodeGenerator
from .problem_handlers import (
    BaseProblemHandler,
    ContinuousOperationHandler,
    GeometryHandler,
    WordProblemHandler,
)
from ...skills import FileSkillRepository

logger = logging.getLogger(__name__)


class VisualizationAgent(BaseAgent):
    """
    Visualization Agent - Generates Manim code for math problems.
    
    Uses Anthropic Skills style system with problem-specific handlers.
    
    Architecture:
    - Skill-based approach: Uses skill definitions from Markdown files
    - Problem handlers: Specialized handlers for different problem types
    - Code generator: Utility class for Manim code generation
    """
    
    def __init__(
        self,
        model: ChatOpenAI,
        skill_repository: FileSkillRepository | None = None,
    ):
        system_prompt = ""
        if skill_repository:
            system_prompt = skill_repository.get_agent_prompt("visualization")
        
        if not system_prompt:
            system_prompt = self._default_system_prompt()
        
        super().__init__(
            name="visualization",
            description="Generates Manim visualization code for math problems",
            system_prompt=system_prompt,
            model=model,
        )
        
        self.skill_repository = skill_repository
        self.code_gen = ManimCodeGenerator()
        
        # Initialize problem handlers
        self.handlers: list[BaseProblemHandler] = [
            ContinuousOperationHandler(model),
            GeometryHandler(model),
            WordProblemHandler(model),
        ]
    
    async def generate_visualization_code(
        self,
        problem_text: str,
        analysis_result: dict[str, Any],
        solution_result: dict[str, Any],
        is_retry: bool = False,
        error_message: str = "",
    ) -> str:
        """
        Generate Manim visualization code for a math problem.
        
        Flow:
        1. Detect problem type
        2. Find appropriate handler or skill
        3. Generate visualization code
        4. Sanitize and validate
        
        Args:
            problem_text: The original problem text
            analysis_result: Output from understanding agent
            solution_result: Output from solving agent
            is_retry: Whether this is a retry after failure
            error_message: Error message from previous attempt
            
        Returns:
            Complete Manim code as string
        """
        problem_type = analysis_result.get("problem_type", "")
        
        # Try to use a specialized handler
        for handler in self.handlers:
            if handler.can_handle(problem_type, analysis_result):
                logger.info(f"Using handler: {handler.__class__.__name__}")
                try:
                    code = await handler.generate(
                        problem_text,
                        analysis_result,
                        solution_result,
                    )
                    return self.code_gen.sanitize_code(code)
                except Exception as e:
                    logger.warning(f"Handler failed: {e}")
        
        # Try skill-based approach
        if self.skill_repository:
            skill = self.skill_repository.find_best_match(problem_text, None)
            if skill:
                logger.info(f"Using skill: {skill.name}")
                code = await self._generate_with_skill(
                    skill,
                    problem_text,
                    analysis_result,
                    solution_result,
                )
                if code:
                    return self.code_gen.sanitize_code(code)
        
        # Fallback to LLM generation
        logger.info("Using LLM fallback for visualization")
        code = await self._generate_with_llm(
            problem_text,
            analysis_result,
            solution_result,
            is_retry,
            error_message,
        )
        
        return self.code_gen.sanitize_code(code)
    
    async def _generate_with_skill(
        self,
        skill: Any,
        problem_text: str,
        analysis: dict[str, Any],
        solution: dict[str, Any],
    ) -> str | None:
        """Generate visualization using a skill template"""
        try:
            # Get skill prompt
            skill_prompt = skill.get_prompt()
            
            # Build context
            steps = solution.get("steps", [])
            steps_text = "\n".join(
                f"{s.get('step_number', i+1)}. {s.get('description', '')}"
                for i, s in enumerate(steps)
            )
            
            prompt = f"""
使用技能 [{skill.name}] 为以下题目生成Manim可视化代码:

题目: {problem_text}

题型: {analysis.get('problem_type', '')}

解题步骤:
{steps_text}

答案: {solution.get('answer', '')}

{skill_prompt}

请生成完整的Manim代码。
"""
            
            response = await self.model.ainvoke([
                SystemMessage(content=self.system_prompt),
                HumanMessage(content=prompt),
            ])
            
            return self._extract_code(response.content)
        except Exception as e:
            logger.error(f"Skill-based generation failed: {e}")
            return None
    
    async def _generate_with_llm(
        self,
        problem_text: str,
        analysis: dict[str, Any],
        solution: dict[str, Any],
        is_retry: bool,
        error_message: str,
    ) -> str:
        """Generate visualization using pure LLM"""
        steps = solution.get("steps", [])
        steps_text = "\n".join(
            f"{s.get('step_number', i+1)}. {s.get('description', '')}: {s.get('operation', '')}"
            for i, s in enumerate(steps)
        )
        
        retry_context = ""
        if is_retry and error_message:
            retry_context = f"\n\n上次生成的代码出错:\n{error_message}\n请修正这些问题。"
        
        prompt = f"""
为以下数学题目生成Manim可视化代码:

题目: {problem_text}

题型: {analysis.get('problem_type', '')}
难度: {analysis.get('difficulty', '')}
策略: {solution.get('strategy', '')}

解题步骤:
{steps_text}

答案: {solution.get('answer', '')}
{retry_context}

要求:
1. 生成完整的Manim Scene类代码
2. 使用图形化方式展示，不要只有文字
3. 每个步骤都要有动画过渡
4. 最后展示答案

请直接输出完整的Python代码。
"""
        
        response = await self.model.ainvoke([
            SystemMessage(content=self.system_prompt),
            HumanMessage(content=prompt),
        ])
        
        return self._extract_code(response.content)
    
    def _extract_code(self, content: str) -> str:
        """Extract Python code from LLM response"""
        import re
        
        # Look for python code blocks
        code_match = re.search(r"```python\n(.*?)```", content, re.DOTALL)
        if code_match:
            return code_match.group(1).strip()
        
        # Any code block
        code_match = re.search(r"```\n(.*?)```", content, re.DOTALL)
        if code_match:
            return code_match.group(1).strip()
        
        return content.strip()
    
    def _default_system_prompt(self) -> str:
        return """你是一个Manim可视化专家，专门为数学题目生成清晰、美观的可视化动画。

生成代码时请遵循以下原则：
1. 使用图形和动画展示数学概念，不要只显示文字
2. 每个步骤都要有清晰的动画过渡
3. 使用合适的颜色来区分不同元素
4. 确保代码可以直接运行，不要使用不存在的API

输出格式：直接输出完整的Python代码，包含import语句和Scene类定义。"""
