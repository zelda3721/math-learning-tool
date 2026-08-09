"""
Skill entity - represents an Anthropic-style skill
"""
from dataclasses import dataclass, field

from ..value_objects.grade import EducationLevel


@dataclass
class Skill:
    """
    A skill definition (Anthropic Skills style).
    
    Skills are declaratively defined in Markdown files and loaded at runtime.
    They contain prompt templates and code templates for visualization.
    """
    
    name: str
    description: str
    keywords: list[str] = field(default_factory=list)
    parameters: dict[str, str] = field(default_factory=dict)
    prompt_template: str = ""
    code_template: str = ""
    grade_levels: list[EducationLevel] = field(default_factory=list)
    category: str = "visualization"  # visualization, agent, system
    
    # Source file path (for debugging)
    source_path: str = ""
    
    def get_prompt(self, include_code: bool = True) -> str:
        """Get the skill's prompt content"""
        if include_code and self.code_template:
            return f"{self.prompt_template}\n\n```python\n{self.code_template}\n```"
        return self.prompt_template
    
    def render(self, **params: str) -> str:
        """Render the code template with parameters"""
        result = self.code_template
        for key, value in params.items():
            placeholder = f"{{{key}}}"
            result = result.replace(placeholder, str(value))
        return result
    
    def matches_grade(self, grade: EducationLevel) -> bool:
        """Check if skill is available for the given grade level"""
        if not self.grade_levels:
            return True  # Available for all grades
        return grade in self.grade_levels
