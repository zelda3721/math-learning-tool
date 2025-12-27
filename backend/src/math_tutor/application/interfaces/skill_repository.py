"""
Skill Repository Interface - Port for skill storage and retrieval
"""
from abc import ABC, abstractmethod
from typing import Optional

from ...domain.entities import Skill
from ...domain.value_objects import EducationLevel


class ISkillRepository(ABC):
    """
    Repository interface for skills (Anthropic Skills style).
    
    This is a Port in the Ports & Adapters pattern.
    Implementations (Adapters) are in the infrastructure layer.
    """
    
    @abstractmethod
    def get_skill(self, name: str) -> Optional[Skill]:
        """
        Get a skill by name.
        
        Args:
            name: Skill name (e.g., "addition", "geometry")
            
        Returns:
            Skill if found, None otherwise
        """
        ...
    
    @abstractmethod
    def list_skills(self, grade: Optional[EducationLevel] = None) -> list[Skill]:
        """
        List available skills, optionally filtered by grade level.
        
        Args:
            grade: Filter by education level, or None for all
            
        Returns:
            List of matching skills
        """
        ...
    
    @abstractmethod
    def find_best_match(
        self, 
        problem_text: str, 
        grade: EducationLevel
    ) -> Optional[Skill]:
        """
        Find the best matching skill for a given problem.
        
        Args:
            problem_text: The math problem text
            grade: Current education level
            
        Returns:
            Best matching skill, or None if no match found
        """
        ...
    
    @abstractmethod
    def get_agent_prompt(self, agent_name: str, grade: Optional[EducationLevel] = None) -> str:
        """
        Get the system prompt for an agent.
        
        Args:
            agent_name: Name of the agent (understanding, solving, etc.)
            grade: Optional grade level for customization
            
        Returns:
            System prompt string
        """
        ...
