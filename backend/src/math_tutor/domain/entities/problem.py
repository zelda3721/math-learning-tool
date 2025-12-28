"""
Problem entity - represents a math problem
"""
from dataclasses import dataclass, field
from typing import Any

from ..value_objects.grade import EducationLevel


@dataclass
class Problem:
    """A math problem to be solved and visualized"""
    
    text: str
    grade_level: EducationLevel = EducationLevel.ELEMENTARY_UPPER
    
    # Analysis results (filled after understanding step)
    problem_type: str = ""
    concepts: list[str] = field(default_factory=list)
    known_conditions: list[str] = field(default_factory=list)
    question: str = ""
    key_values: dict[str, Any] = field(default_factory=dict)
    difficulty: str = ""
    strategy: str = ""
    
    @property
    def is_analyzed(self) -> bool:
        """Check if problem has been analyzed"""
        return bool(self.problem_type)
