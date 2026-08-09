"""
Solution entity - represents the solution to a math problem
"""
from dataclasses import dataclass, field


@dataclass
class SolutionStep:
    """A single step in the solution"""
    
    step_number: int
    description: str
    operation: str
    explanation: str = ""
    result: str = ""


@dataclass
class Solution:
    """Complete solution to a math problem"""
    
    strategy: str
    steps: list[SolutionStep] = field(default_factory=list)
    answer: str = ""
    key_points: list[str] = field(default_factory=list)
    
    @property
    def is_solved(self) -> bool:
        """Check if solution is complete"""
        return bool(self.answer)
