"""
File-based Skill Repository - Loads skills from Markdown files

This is the Adapter implementation for ISkillRepository,
implementing Anthropic Skills style declarative skill loading.
"""
import logging
import re
from pathlib import Path
from typing import Optional

from ...application.interfaces import ISkillRepository
from ...domain.entities import Skill
from ...domain.value_objects import EducationLevel

logger = logging.getLogger(__name__)


class FileSkillRepository(ISkillRepository):
    """
    Loads skills from Markdown files (Anthropic Skills style).
    
    Skill files are structured as:
    - Front matter with metadata (name, description, keywords, etc.)
    - Prompt content
    - Code template section
    """
    
    def __init__(self, skills_dir: Path | str):
        self.skills_dir = Path(skills_dir)
        self._skills_cache: dict[str, Skill] = {}
        self._agent_prompts: dict[str, str] = {}
        self._load_all()
    
    def _load_all(self) -> None:
        """Load all skills from the definitions directory"""
        if not self.skills_dir.exists():
            logger.warning(f"Skills directory not found: {self.skills_dir}")
            return
        
        # Load visualization skills
        viz_dir = self.skills_dir / "visualization"
        if viz_dir.exists():
            for md_file in viz_dir.glob("*.md"):
                skill = self._parse_skill_file(md_file, category="visualization")
                if skill:
                    self._skills_cache[skill.name] = skill
        
        # Load grade-specific skills
        grade_dir = self.skills_dir / "grade_specific"
        if grade_dir.exists():
            for grade_subdir in grade_dir.iterdir():
                if grade_subdir.is_dir():
                    for md_file in grade_subdir.glob("*.md"):
                        skill = self._parse_skill_file(md_file, category="visualization")
                        if skill:
                            # Add grade level info from directory name
                            grade_name = grade_subdir.name
                            if grade_name == "elementary":
                                skill.grade_levels = [
                                    EducationLevel.ELEMENTARY_LOWER,
                                    EducationLevel.ELEMENTARY_UPPER,
                                ]
                            elif grade_name == "middle_school":
                                skill.grade_levels = [EducationLevel.MIDDLE_SCHOOL]
                            elif grade_name == "high_school":
                                skill.grade_levels = [EducationLevel.HIGH_SCHOOL]
                            elif grade_name == "university":
                                skill.grade_levels = [EducationLevel.UNIVERSITY]
                            self._skills_cache[skill.name] = skill
        
        # Load agent prompts
        agent_dir = self.skills_dir / "agents"
        if agent_dir.exists():
            for md_file in agent_dir.glob("*.md"):
                agent_name = md_file.stem
                self._agent_prompts[agent_name] = md_file.read_text(encoding="utf-8")
        
        logger.info(
            f"Loaded {len(self._skills_cache)} skills and "
            f"{len(self._agent_prompts)} agent prompts"
        )
    
    def _parse_skill_file(self, filepath: Path, category: str = "visualization") -> Optional[Skill]:
        """Parse a skill from a Markdown file"""
        try:
            content = filepath.read_text(encoding="utf-8")
            
            # Extract metadata from comments or front matter
            name = filepath.stem
            description = ""
            keywords: list[str] = []
            parameters: dict[str, str] = {}
            prompt_template = ""
            code_template = ""
            
            # Look for description in first paragraph
            lines = content.split("\n")
            for i, line in enumerate(lines):
                if line.startswith("# "):
                    description = line[2:].strip()
                    break
            
            # Look for keywords section - try multiple formats
            # Format 1: 关键词：xxx, yyy
            keyword_match = re.search(r"关键词[：:]\s*(.+)", content)
            if keyword_match:
                keywords = [k.strip() for k in keyword_match.group(1).split(",")]
            
            # Format 2: 题目中包含"xxx"、"yyy"等关键词
            if not keywords:
                pattern_match = re.search(r'题目中包含["“]([^"”]+)["”]', content)
                if pattern_match:
                    # Extract all quoted keywords
                    # Use a non-greedy match for quoted strings
                    all_keywords = re.findall(r'["“]([^"”]+)["”]', content[:500])  # First 500 chars
                    keywords = [k.strip() for k in all_keywords if len(k) <= 5]  # Short words only
            
            # Extract ALL code blocks and use the largest one as the template
            code_blocks = re.findall(r"```python\n(.*?)```", content, re.DOTALL)
            if code_blocks:
                # Use the largest code block as the main template
                # (usually the complete implementation is the longest)
                code_template = max(code_blocks, key=len).strip()
            
            # Use the ENTIRE file content as prompt_template
            # This ensures all guidelines, principles, etc. are included
            prompt_template = content.strip()
            
            return Skill(
                name=name,
                description=description,
                keywords=keywords,
                parameters=parameters,
                prompt_template=prompt_template,
                code_template=code_template,
                grade_levels=[],
                category=category,
                source_path=str(filepath),
            )
        except Exception as e:
            logger.error(f"Failed to parse skill file {filepath}: {e}")
            return None
    
    def get_skill(self, name: str) -> Optional[Skill]:
        """Get a skill by name"""
        return self._skills_cache.get(name)
    
    def list_skills(self, grade: Optional[EducationLevel] = None) -> list[Skill]:
        """List available skills, optionally filtered by grade"""
        skills = list(self._skills_cache.values())
        if grade:
            skills = [s for s in skills if s.matches_grade(grade)]
        return skills
    
    def find_best_match(
        self,
        problem_text: str,
        grade: EducationLevel,
    ) -> Optional[Skill]:
        """Find the best matching skill for a problem"""
        problem_lower = problem_text.lower()
        best_skill = None
        best_score = 0.0
        
        for skill in self.list_skills(grade):
            score = 0.0
            for keyword in skill.keywords:
                if keyword.lower() in problem_lower:
                    score += 1.0
            
            if score > best_score:
                best_score = score
                best_skill = skill
        
        return best_skill if best_score > 0 else None
    
    def get_animation_guidelines(self) -> str:
        """Get the animation guidelines content"""
        guidelines_path = self.skills_dir / "visualization" / "animation_guidelines.md"
        if guidelines_path.exists():
            return guidelines_path.read_text(encoding="utf-8")
        return ""
    
    def get_agent_prompt(
        self,
        agent_name: str,
        grade: Optional[EducationLevel] = None,
    ) -> str:
        """Get the system prompt for an agent"""
        prompt = self._agent_prompts.get(agent_name, "")
        
        # TODO: Add grade-specific customization
        
        return prompt
