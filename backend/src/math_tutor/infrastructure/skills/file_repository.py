"""
File-based Skill Repository - Loads skills from Markdown files

This is the Adapter implementation for ISkillRepository,
implementing Anthropic Skills style declarative skill loading.
"""
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from ...application.interfaces import ISkillRepository
from ...domain.entities import Skill
from ...domain.value_objects import EducationLevel

logger = logging.getLogger(__name__)


@dataclass
class Pattern:
    """A reusable visualization pattern (counting / comparison / coordinate ...).

    Patterns are intentionally generic: they live in skills/definitions/patterns/
    and provide reusable helper code that maps to a visual mode rather than a
    specific math problem.
    """

    name: str
    description: str
    keywords: list[str] = field(default_factory=list)
    full_text: str = ""
    core_code: str = ""
    source_path: str = ""


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
        self._patterns_cache: dict[str, "Pattern"] = {}
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

        # Load visualization patterns (generic, reusable across problem types)
        patterns_dir = self.skills_dir / "patterns"
        if patterns_dir.exists():
            for md_file in patterns_dir.glob("*.md"):
                pattern = self._parse_pattern_file(md_file)
                if pattern:
                    self._patterns_cache[pattern.name] = pattern

        logger.info(
            f"Loaded {len(self._skills_cache)} skills, "
            f"{len(self._patterns_cache)} patterns, and "
            f"{len(self._agent_prompts)} agent prompts"
        )

    def _parse_pattern_file(self, filepath: Path) -> Optional["Pattern"]:
        """Parse a visualization pattern markdown file."""
        try:
            content = filepath.read_text(encoding="utf-8")
            name = filepath.stem
            description = ""
            keywords: list[str] = []

            for line in content.split("\n"):
                if line.startswith("# "):
                    description = line[2:].strip()
                    break

            # 关键词 line: "关键词\n<keywords on next line>" or inline
            keyword_match = re.search(r"##\s*关键词\s*\n([^\n]+)", content)
            if keyword_match:
                raw = keyword_match.group(1)
                keywords = [k.strip() for k in re.split(r"[,，、\s]+", raw) if k.strip()]

            # Extract the LARGEST python code block as the canonical "core code"
            code_blocks = re.findall(r"```python\n(.*?)```", content, re.DOTALL)
            core_code = max(code_blocks, key=len).strip() if code_blocks else ""

            return Pattern(
                name=name,
                description=description,
                keywords=keywords,
                full_text=content.strip(),
                core_code=core_code,
                source_path=str(filepath),
            )
        except Exception as e:
            logger.error(f"Failed to parse pattern file {filepath}: {e}")
            return None

    def list_patterns(self) -> list["Pattern"]:
        return list(self._patterns_cache.values())

    def get_pattern(self, name: str) -> Optional["Pattern"]:
        return self._patterns_cache.get(name)

    def find_matching_patterns(
        self,
        problem_text: str,
        top_k: int = 2,
    ) -> list["Pattern"]:
        """Score every pattern by keyword overlap; return top-K (≥1 hit)."""
        problem_lower = problem_text.lower()
        scored: list[tuple[int, Pattern]] = []
        for pat in self._patterns_cache.values():
            score = sum(1 for kw in pat.keywords if kw.lower() in problem_lower)
            if score > 0:
                scored.append((score, pat))
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [p for _, p in scored[:top_k]]
    
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
    
    def get_visualization_patterns(self, problem_text: str, problem_type: str = "") -> str:
        """
        Get relevant visualization patterns based on problem keywords.
        Returns concatenated pattern content for LLM prompt injection.
        """
        patterns_dir = self.skills_dir / "patterns"
        if not patterns_dir.exists():
            return ""
        
        problem_lower = problem_text.lower()
        selected_patterns = []
        
        # Pattern selection logic
        pattern_keywords = {
            "counting": ["多少", "几个", "共", "加", "减", "数", "+", "-"],
            "comparison": ["比", "多", "少", "相差", "大", "小"],
            "transformation": ["变", "换", "替换", "鸡", "兔", "脚", "腿"],
            "process": ["第一", "然后", "最后", "先", "后", "步"],
        }
        
        # Always include counting for word problems
        if problem_type == "word":
            selected_patterns.append("counting")
        
        # Match patterns based on keywords
        for pattern_name, keywords in pattern_keywords.items():
            if any(kw in problem_lower for kw in keywords):
                if pattern_name not in selected_patterns:
                    selected_patterns.append(pattern_name)
        
        # Default to counting + process if no specific match
        if not selected_patterns:
            selected_patterns = ["counting", "process"]
        
        # Load and concatenate pattern content
        result = []
        for pattern_name in selected_patterns[:3]:  # Max 3 patterns to avoid token overflow
            pattern_path = patterns_dir / f"{pattern_name}.md"
            if pattern_path.exists():
                content = pattern_path.read_text(encoding="utf-8")
                # Extract just the core code section to save tokens
                code_match = re.search(r"## 核心代码\n\n```python\n(.*?)```", content, re.DOTALL)
                if code_match:
                    result.append(f"### {pattern_name} 模式\n```python\n{code_match.group(1).strip()}\n```")
        
        return "\n\n".join(result)
