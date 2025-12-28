"""
LangChain Service - Implements ILLMService using LangChain

This is the adapter for LLM interactions using LangChain/LangGraph.
"""
import json
import logging
import re
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ...application.interfaces import ILLMService, ISkillRepository
from ...config import get_settings
from ...domain import Problem, Solution, SolutionStep

logger = logging.getLogger(__name__)


def create_llm() -> ChatOpenAI:
    """Factory function to create ChatOpenAI instance"""
    settings = get_settings()
    return ChatOpenAI(
        model=settings.llm_model,
        openai_api_base=settings.llm_api_base,
        openai_api_key=settings.llm_api_key,
        temperature=settings.llm_temperature,
        max_tokens=settings.llm_max_tokens,
    )


class LangChainService(ILLMService):
    """
    LLM Service implementation using LangChain.
    
    Implements the ILLMService port from the application layer.
    """
    
    def __init__(
        self,
        skill_repository: ISkillRepository | None = None,
        model: ChatOpenAI | None = None,
    ):
        self.model = model or create_llm()
        self.skill_repository = skill_repository
        logger.info("LangChainService initialized")
    
    async def analyze_problem(self, problem: Problem) -> dict[str, Any]:
        """Analyze a math problem using the Understanding Agent"""
        system_prompt = ""
        if self.skill_repository:
            system_prompt = self.skill_repository.get_agent_prompt(
                "understanding",
                problem.grade_level,
            )
        
        if not system_prompt:
            system_prompt = self._default_understanding_prompt()
        
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=f"请分析以下数学题目:\n\n{problem.text}"),
        ]
        
        response = await self.model.ainvoke(messages)
        
        # Parse JSON from response
        return self._parse_json_response(response.content, {
            "problem_type": "",
            "concepts": [],
            "known_conditions": [],
            "question": "",
            "key_values": {},
            "difficulty": "",
            "strategy": "",
        })
    
    async def solve_problem(
        self,
        problem: Problem,
        analysis: dict[str, Any],
    ) -> Solution:
        """Solve a math problem using the Solving Agent"""
        system_prompt = ""
        if self.skill_repository:
            system_prompt = self.skill_repository.get_agent_prompt(
                "solving",
                problem.grade_level,
            )
        
        if not system_prompt:
            system_prompt = self._default_solving_prompt()
        
        prompt = f"""
题目: {problem.text}

分析结果:
{json.dumps(analysis, ensure_ascii=False, indent=2)}

请根据分析结果，给出详细的解题步骤和最终答案。
"""
        
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=prompt),
        ]
        
        response = await self.model.ainvoke(messages)
        
        result = self._parse_json_response(response.content, {
            "strategy": "",
            "steps": [],
            "answer": "",
            "key_points": [],
        })
        
        # Convert to Solution entity
        steps = [
            SolutionStep(
                step_number=i + 1,
                description=step.get("description", ""),
                operation=step.get("operation", ""),
                explanation=step.get("explanation", ""),
                result=step.get("result", ""),
            )
            for i, step in enumerate(result.get("steps", []))
        ]
        
        return Solution(
            strategy=result.get("strategy", ""),
            steps=steps,
            answer=result.get("answer", ""),
            key_points=result.get("key_points", []),
        )
    
    async def generate_visualization_code(
        self,
        problem: Problem,
        solution: Solution,
    ) -> str:
        """Generate Manim visualization code"""
        system_prompt = ""
        if self.skill_repository:
            system_prompt = self.skill_repository.get_agent_prompt(
                "visualization",
                problem.grade_level,
            )
            
            # Find best matching skill
            skill = self.skill_repository.find_best_match(
                problem.text,
                problem.grade_level,
            )
            if skill:
                system_prompt += f"\n\n### 推荐技能: {skill.name}\n{skill.get_prompt()}"
        
        if not system_prompt:
            system_prompt = self._default_visualization_prompt()
        
        # Format solution steps
        steps_text = "\n".join(
            f"{s.step_number}. {s.description}: {s.operation}"
            for s in solution.steps
        )
        
        prompt = f"""
请为以下数学题目生成Manim可视化代码:

题目: {problem.text}

解题策略: {solution.strategy}

解题步骤:
{steps_text}

最终答案: {solution.answer}

请生成完整的Manim代码，包含Scene类定义和construct方法。
"""
        
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=prompt),
        ]
        
        response = await self.model.ainvoke(messages)
        
        # Extract code from response
        return self._extract_code(response.content)
    
    async def debug_code(
        self,
        code: str,
        error_message: str,
        attempt: int,
    ) -> str:
        """Debug and fix Manim code"""
        system_prompt = ""
        if self.skill_repository:
            system_prompt = self.skill_repository.get_agent_prompt("debugging")
        
        if not system_prompt:
            system_prompt = self._default_debugging_prompt()
        
        prompt = f"""
以下Manim代码执行时出错，请修复:

错误信息:
{error_message}

当前代码:
```python
{code}
```

这是第 {attempt} 次调试尝试。请修复代码并返回完整的可执行代码。
"""
        
        messages = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=prompt),
        ]
        
        response = await self.model.ainvoke(messages)
        return self._extract_code(response.content)
    
    def _parse_json_response(
        self,
        content: str,
        default: dict[str, Any],
    ) -> dict[str, Any]:
        """Parse JSON from LLM response"""
        try:
            # Try to find JSON in the response
            json_match = re.search(r"\{[\s\S]*\}", content)
            if json_match:
                return json.loads(json_match.group())
        except json.JSONDecodeError:
            logger.warning("Failed to parse JSON from response")
        return default
    
    def _extract_code(self, content: str) -> str:
        """Extract Python code from LLM response"""
        # Look for code blocks
        code_match = re.search(r"```python\n(.*?)```", content, re.DOTALL)
        if code_match:
            return code_match.group(1).strip()
        
        # Look for any code block
        code_match = re.search(r"```\n(.*?)```", content, re.DOTALL)
        if code_match:
            return code_match.group(1).strip()
        
        # Return as-is if no code blocks found
        return content.strip()
    
    def _default_understanding_prompt(self) -> str:
        return "你是一个数学题目分析专家。请分析题目并以JSON格式输出分析结果。"
    
    def _default_solving_prompt(self) -> str:
        return "你是一个数学解题专家。请根据分析结果，给出详细的解题步骤。以JSON格式输出。"
    
    def _default_visualization_prompt(self) -> str:
        return "你是一个Manim可视化专家。请生成完整的Manim代码来可视化数学解题过程。"
    
    def _default_debugging_prompt(self) -> str:
        return "你是一个代码调试专家。请修复Manim代码中的错误，返回完整的可执行代码。"
