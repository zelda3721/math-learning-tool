"""
Visual Styles Configuration - Grade-specific visualization styles

Defines visual parameters for different education levels,
inspired by videotutor.io (practical, step-by-step) and
3blue1brown (abstract beauty, formal reasoning).
"""
from dataclasses import dataclass, field
from typing import Any

from .grade import EducationLevel


@dataclass
class VisualStyle:
    """Visual style configuration for Manim animations"""
    
    # Colors
    primary_color: str = "BLUE"
    secondary_color: str = "GREEN"
    accent_color: str = "YELLOW"
    background_color: str = "BLACK"
    text_color: str = "WHITE"
    
    # Typography
    title_font_size: int = 48
    body_font_size: int = 32
    caption_font_size: int = 24
    
    # Animation
    animation_speed: float = 1.0
    default_wait: float = 1.5
    transition_duration: float = 0.5
    
    # Style modifiers
    use_icons: bool = False
    use_3d: bool = False
    use_gradients: bool = False
    cartoon_style: bool = False
    
    # Layout
    margin: float = 0.5
    element_spacing: float = 0.3


# Pre-defined styles for each education level
VISUAL_STYLES: dict[EducationLevel, VisualStyle] = {
    # Elementary Lower (Grades 1-3): Colorful, playful, icon-based
    EducationLevel.ELEMENTARY_LOWER: VisualStyle(
        primary_color="RED",
        secondary_color="BLUE",
        accent_color="YELLOW",
        title_font_size=56,
        body_font_size=40,
        animation_speed=0.7,  # Slower for younger kids
        default_wait=2.5,
        use_icons=True,
        cartoon_style=True,
    ),
    
    # Elementary Upper (Grades 4-6): Clear, structured, colorful
    EducationLevel.ELEMENTARY_UPPER: VisualStyle(
        primary_color="BLUE",
        secondary_color="GREEN",
        accent_color="ORANGE",
        title_font_size=48,
        body_font_size=36,
        animation_speed=0.9,
        default_wait=2.0,
        use_icons=True,
    ),
    
    # Middle School (Grades 7-9): More formal, geometric focus
    EducationLevel.MIDDLE_SCHOOL: VisualStyle(
        primary_color="BLUE_C",
        secondary_color="TEAL",
        accent_color="GOLD",
        title_font_size=44,
        body_font_size=32,
        animation_speed=1.0,
        default_wait=1.5,
        use_gradients=True,
    ),
    
    # High School (Grades 10-12): Elegant, mathematical
    EducationLevel.HIGH_SCHOOL: VisualStyle(
        primary_color="BLUE_D",
        secondary_color="PURPLE",
        accent_color="MAROON",
        title_font_size=40,
        body_font_size=28,
        animation_speed=1.2,
        default_wait=1.2,
        use_gradients=True,
    ),
    
    # University: 3Blue1Brown inspired, abstract beauty
    EducationLevel.UNIVERSITY: VisualStyle(
        primary_color="BLUE_E",
        secondary_color="TEAL_E",
        accent_color="YELLOW_D",
        background_color="DARKER_GREY",
        title_font_size=36,
        body_font_size=24,
        animation_speed=1.5,
        default_wait=1.0,
        use_3d=True,
        use_gradients=True,
    ),
}


def get_style_for_grade(grade: EducationLevel) -> VisualStyle:
    """Get visual style for a specific grade level"""
    return VISUAL_STYLES.get(grade, VISUAL_STYLES[EducationLevel.ELEMENTARY_UPPER])


def generate_style_preamble(style: VisualStyle) -> str:
    """Generate Manim code preamble with style configuration"""
    return f'''
# Visual style configuration
PRIMARY_COLOR = {style.primary_color}
SECONDARY_COLOR = {style.secondary_color}
ACCENT_COLOR = {style.accent_color}
TITLE_SIZE = {style.title_font_size}
BODY_SIZE = {style.body_font_size}
ANIM_SPEED = {style.animation_speed}
DEFAULT_WAIT = {style.default_wait}
'''
