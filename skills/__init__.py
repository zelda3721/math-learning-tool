"""
可视化技能模块

提供预定义的、可复用的数学可视化技能
"""
from skills.visualization_skills import (
    skill_registry,
    AdditionSkill,
    SubtractionSkill,
    MultiplicationSkill,
    ComparisonSkill,
    detect_operation_type,
    extract_numbers
)

__all__ = [
    'skill_registry',
    'AdditionSkill',
    'SubtractionSkill',
    'MultiplicationSkill',
    'ComparisonSkill',
    'detect_operation_type',
    'extract_numbers'
]
