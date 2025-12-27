"""
LLM Service Interface - Port for LLM interactions
"""
from abc import ABC, abstractmethod
from typing import Any

from ...domain.entities import Problem, Solution


class ILLMService(ABC):
    """
    LLM Service interface.
    
    This is a Port in the Ports & Adapters pattern.
    Implementations (e.g., LangChain, LangGraph) are in infrastructure.
    """
    
    @abstractmethod
    async def analyze_problem(self, problem: Problem) -> dict[str, Any]:
        """
        Analyze a math problem.
        
        Args:
            problem: The problem to analyze
            
        Returns:
            Analysis result dictionary
        """
        ...
    
    @abstractmethod
    async def solve_problem(
        self, 
        problem: Problem, 
        analysis: dict[str, Any]
    ) -> Solution:
        """
        Solve a math problem.
        
        Args:
            problem: The problem to solve
            analysis: Prior analysis result
            
        Returns:
            Solution with steps and answer
        """
        ...
    
    @abstractmethod
    async def generate_visualization_code(
        self,
        problem: Problem,
        solution: Solution,
    ) -> str:
        """
        Generate Manim visualization code.
        
        Args:
            problem: The original problem
            solution: The solution to visualize
            
        Returns:
            Manim Python code as string
        """
        ...
    
    @abstractmethod
    async def debug_code(
        self,
        code: str,
        error_message: str,
        attempt: int,
    ) -> str:
        """
        Debug and fix Manim code.
        
        Args:
            code: The failing code
            error_message: Error message from execution
            attempt: Current attempt number
            
        Returns:
            Fixed code
        """
        ...
