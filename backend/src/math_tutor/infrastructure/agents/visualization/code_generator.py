"""
Manim Code Generator - Utilities for generating Manim visualization code

Extracted from the original visualization.py for better maintainability.
"""
import re
from typing import Any


class ManimCodeGenerator:
    """Utility class for generating Manim code snippets"""
    
    @staticmethod
    def generate_problem_display(problem_text: str) -> str:
        """
        Generate code to display the problem text.
        Handles long text with line wrapping.
        """
        # Escape special characters
        escaped_text = problem_text.replace('"', '\\"').replace("'", "\\'")
        
        # Split long text
        max_chars = 30
        if len(escaped_text) > max_chars:
            words = escaped_text.split()
            lines = []
            current_line = ""
            for word in words:
                if len(current_line) + len(word) + 1 <= max_chars:
                    current_line += (" " + word) if current_line else word
                else:
                    if current_line:
                        lines.append(current_line)
                    current_line = word
            if current_line:
                lines.append(current_line)
            text_content = "\\n".join(lines)
        else:
            text_content = escaped_text
        
        return f'''
        # Display problem
        problem_text = Text("{text_content}", font_size=28)
        problem_text.to_edge(UP)
        self.play(Write(problem_text))
        self.wait(2)
        self.play(FadeOut(problem_text))
'''
    
    @staticmethod
    def generate_answer_display(answer: str) -> str:
        """Generate code to display the final answer"""
        escaped_answer = answer.replace('"', '\\"').replace("'", "\\'")
        
        return f'''
        # Display answer
        answer_box = Rectangle(width=6, height=1.5, color=GREEN)
        answer_text = Text("答案: {escaped_answer}", font_size=32, color=GREEN)
        answer_group = VGroup(answer_box, answer_text)
        answer_group.to_edge(DOWN)
        
        self.play(Create(answer_box), Write(answer_text))
        self.wait(2)
'''
    
    @staticmethod
    def generate_step_header(step_number: int, description: str) -> str:
        """Generate code for step header with number and description"""
        escaped_desc = description.replace('"', '\\"')[:40]
        
        return f'''
        # Step {step_number}
        step_label = Text("步骤 {step_number}", font_size=24, color=BLUE)
        step_label.to_corner(UL)
        step_desc = Text("{escaped_desc}", font_size=20)
        step_desc.next_to(step_label, DOWN, aligned_edge=LEFT)
        
        self.play(Write(step_label), Write(step_desc))
'''
    
    @staticmethod
    def generate_graphical_step(
        step_number: int,
        description: str,
        operation: str,
        result: str,
    ) -> str:
        """Generate a generic graphical step visualization"""
        escaped_desc = description.replace('"', '\\"')[:30]
        escaped_op = operation.replace('"', '\\"')[:30]
        escaped_result = result.replace('"', '\\"')[:20]
        
        return f'''
        # Step {step_number} visualization
        step_box = RoundedRectangle(width=8, height=2, color=BLUE)
        step_title = Text("步骤 {step_number}: {escaped_desc}", font_size=24)
        step_title.move_to(step_box.get_top() + DOWN * 0.5)
        
        operation_text = Text("{escaped_op}", font_size=20, color=YELLOW)
        operation_text.move_to(step_box.get_center())
        
        result_text = Text("= {escaped_result}", font_size=24, color=GREEN)
        result_text.move_to(step_box.get_bottom() + UP * 0.4)
        
        step_group = VGroup(step_box, step_title, operation_text, result_text)
        step_group.move_to(ORIGIN)
        
        self.play(Create(step_box))
        self.play(Write(step_title))
        self.play(Write(operation_text))
        self.play(Write(result_text))
        self.wait(1)
        self.play(FadeOut(step_group))
'''
    
    @staticmethod
    def wrap_in_scene(code_body: str, scene_name: str = "MathVisualization") -> str:
        """Wrap code body in a complete Manim Scene class"""
        return f'''from manim import *

class {scene_name}(Scene):
    def construct(self):
{code_body}
        self.wait(1)
'''
    
    @staticmethod
    def extract_numbers(text: str) -> list[int]:
        """Extract numbers from text"""
        return [int(n) for n in re.findall(r'\d+', text)]
    
    @staticmethod
    def sanitize_code(code: str) -> str:
        """
        Sanitize generated Manim code.
        Fixes common LLM hallucinations and invalid API calls.
        """
        # Remove invalid rate_func parameters
        code = re.sub(
            r",?\s*rate_func\s*=\s*(ease_\w+|easeIn\w*|easeOut\w*)",
            "",
            code,
        )
        
        # Replace invalid color names
        invalid_colors = [
            "ORANGE_E", "BLUE_D", "BLUE_E", "RED_A",
            "GREEN_E", "GREEN_D", "YELLOW_E",
        ]
        for color in invalid_colors:
            code = re.sub(rf"\b{color}\b", "BLUE", code)
        
        # Remove non-existent method calls
        code = re.sub(r"\.get_text\(\)", "", code)
        
        return code
