"""
Problem Handlers - Type-specific visualization handlers

Extracted from the original visualization.py for better maintainability.
Each handler specializes in a specific problem type.
"""
import logging
from abc import ABC, abstractmethod
from typing import Any

from langchain_openai import ChatOpenAI

from .code_generator import ManimCodeGenerator

logger = logging.getLogger(__name__)


class BaseProblemHandler(ABC):
    """Base class for problem type handlers"""
    
    def __init__(self, model: ChatOpenAI):
        self.model = model
        self.code_gen = ManimCodeGenerator()
    
    @abstractmethod
    def can_handle(self, problem_type: str, analysis: dict[str, Any]) -> bool:
        """Check if this handler can handle the given problem type"""
        ...
    
    @abstractmethod
    async def generate(
        self,
        problem_text: str,
        analysis: dict[str, Any],
        solution: dict[str, Any],
    ) -> str:
        """Generate visualization code for this problem type"""
        ...


class ContinuousOperationHandler(BaseProblemHandler):
    """
    Handler for continuous operation problems (连续运算).
    
    These are problems with multiple sequential arithmetic operations,
    common in elementary math.
    """
    
    KEYWORDS = ["连续", "依次", "然后", "接着", "又", "再"]
    
    def can_handle(self, problem_type: str, analysis: dict[str, Any]) -> bool:
        problem_type_lower = problem_type.lower()
        return (
            "连续" in problem_type_lower or
            "运算" in problem_type_lower or
            problem_type_lower in ["加减混合", "连续加减"]
        )
    
    async def generate(
        self,
        problem_text: str,
        analysis: dict[str, Any],
        solution: dict[str, Any],
    ) -> str:
        """Generate visualization for continuous operations"""
        steps = solution.get("steps", [])
        
        code_parts = []
        code_parts.append(self.code_gen.generate_problem_display(problem_text))
        
        # Initial value
        initial_value = self._extract_initial_value(problem_text)
        
        code_parts.append(f'''
        # Initialize number line / value display
        current_value = {initial_value}
        value_text = Text(f"当前: {{current_value}}", font_size=36)
        value_text.move_to(ORIGIN)
        self.play(Write(value_text))
''')
        
        # Generate each step
        for i, step in enumerate(steps):
            operation = step.get("operation", "")
            description = step.get("description", "")
            result = step.get("result", "")
            
            # Extract operation type and value
            op_type, op_value = self._parse_operation(operation)
            
            code_parts.append(f'''
        # Step {i + 1}: {description[:30]}
        step_label = Text("步骤 {i + 1}: {description[:25]}", font_size=20)
        step_label.to_corner(UL)
        self.play(Write(step_label))
        
        # Show operation
        op_text = Text("{operation[:30]}", font_size=24, color=YELLOW)
        op_text.next_to(value_text, DOWN)
        self.play(Write(op_text))
        
        # Update value
        new_value = Text("{result}", font_size=36, color=GREEN)
        new_value.move_to(value_text.get_center())
        self.play(Transform(value_text, new_value))
        self.play(FadeOut(op_text), FadeOut(step_label))
''')
        
        # Final answer
        answer = solution.get("answer", "")
        code_parts.append(self.code_gen.generate_answer_display(answer))
        
        return self.code_gen.wrap_in_scene("".join(code_parts), "ContinuousOperation")
    
    def _extract_initial_value(self, problem_text: str) -> int:
        """Extract the initial value from problem text"""
        import re
        numbers = re.findall(r'\d+', problem_text)
        return int(numbers[0]) if numbers else 0
    
    def _parse_operation(self, operation: str) -> tuple[str, int]:
        """Parse operation string to get type and value"""
        import re
        if "+" in operation or "加" in operation:
            numbers = re.findall(r'\d+', operation)
            return "+", int(numbers[-1]) if numbers else 0
        elif "-" in operation or "减" in operation:
            numbers = re.findall(r'\d+', operation)
            return "-", int(numbers[-1]) if numbers else 0
        return "", 0


class GeometryHandler(BaseProblemHandler):
    """
    Handler for geometry problems.
    
    Handles visualization of shapes, transformations, and measurements.
    """
    
    def can_handle(self, problem_type: str, analysis: dict[str, Any]) -> bool:
        geometry_keywords = ["几何", "图形", "面积", "周长", "三角形", "矩形", "圆"]
        return any(kw in problem_type for kw in geometry_keywords)
    
    async def generate(
        self,
        problem_text: str,
        analysis: dict[str, Any],
        solution: dict[str, Any],
    ) -> str:
        """Generate visualization for geometry problems"""
        code_parts = []
        code_parts.append(self.code_gen.generate_problem_display(problem_text))
        
        # Determine shape type
        shape_type = self._detect_shape(problem_text, analysis)
        dimensions = self._extract_dimensions(problem_text)
        
        if shape_type == "rectangle":
            code_parts.append(self._generate_rectangle_viz(dimensions))
        elif shape_type == "triangle":
            code_parts.append(self._generate_triangle_viz(dimensions))
        elif shape_type == "circle":
            code_parts.append(self._generate_circle_viz(dimensions))
        else:
            # Generic polygon
            code_parts.append(self._generate_generic_shape_viz())
        
        # Solution steps
        steps = solution.get("steps", [])
        for i, step in enumerate(steps):
            code_parts.append(
                self.code_gen.generate_graphical_step(
                    i + 1,
                    step.get("description", ""),
                    step.get("operation", ""),
                    step.get("result", ""),
                )
            )
        
        # Answer
        answer = solution.get("answer", "")
        code_parts.append(self.code_gen.generate_answer_display(answer))
        
        return self.code_gen.wrap_in_scene("".join(code_parts), "GeometryVisualization")
    
    def _detect_shape(self, problem_text: str, analysis: dict[str, Any]) -> str:
        """Detect the shape type from problem text"""
        if "长方形" in problem_text or "矩形" in problem_text:
            return "rectangle"
        elif "三角形" in problem_text:
            return "triangle"
        elif "圆" in problem_text:
            return "circle"
        return "generic"
    
    def _extract_dimensions(self, problem_text: str) -> dict[str, float]:
        """Extract dimensions from problem text"""
        import re
        numbers = [float(n) for n in re.findall(r'\d+\.?\d*', problem_text)]
        
        if len(numbers) >= 2:
            return {"width": numbers[0], "height": numbers[1]}
        elif len(numbers) == 1:
            return {"side": numbers[0]}
        return {}
    
    def _generate_rectangle_viz(self, dims: dict[str, float]) -> str:
        width = dims.get("width", 4)
        height = dims.get("height", 3)
        scale = min(2 / max(width, height), 1)
        
        return f'''
        # Draw rectangle
        rect = Rectangle(width={width * scale}, height={height * scale}, color=BLUE)
        rect.move_to(ORIGIN)
        
        width_label = Text("{width}厘米", font_size=20)
        width_label.next_to(rect, DOWN)
        
        height_label = Text("{height}厘米", font_size=20)
        height_label.next_to(rect, RIGHT)
        
        self.play(Create(rect))
        self.play(Write(width_label), Write(height_label))
        self.wait(1)
'''
    
    def _generate_triangle_viz(self, dims: dict[str, float]) -> str:
        return '''
        # Draw triangle
        triangle = Polygon(
            LEFT * 2 + DOWN,
            RIGHT * 2 + DOWN,
            UP * 2,
            color=BLUE
        )
        triangle.move_to(ORIGIN)
        
        self.play(Create(triangle))
        self.wait(1)
'''
    
    def _generate_circle_viz(self, dims: dict[str, float]) -> str:
        radius = dims.get("side", 2)
        return f'''
        # Draw circle
        circle = Circle(radius={min(radius * 0.3, 2)}, color=BLUE)
        circle.move_to(ORIGIN)
        
        radius_line = Line(ORIGIN, RIGHT * {min(radius * 0.3, 2)}, color=YELLOW)
        radius_label = Text("r={radius}", font_size=20)
        radius_label.next_to(radius_line, UP)
        
        self.play(Create(circle))
        self.play(Create(radius_line), Write(radius_label))
        self.wait(1)
'''
    
    def _generate_generic_shape_viz(self) -> str:
        return '''
        # Generic shape placeholder
        shape = Square(side_length=3, color=BLUE)
        shape.move_to(ORIGIN)
        
        self.play(Create(shape))
        self.wait(1)
'''


class WordProblemHandler(BaseProblemHandler):
    """
    Handler for word problems (应用题).
    
    Uses LLM to generate appropriate visualizations for complex
    real-world scenarios.
    """
    
    def can_handle(self, problem_type: str, analysis: dict[str, Any]) -> bool:
        return "应用" in problem_type or "文字" in problem_type
    
    async def generate(
        self,
        problem_text: str,
        analysis: dict[str, Any],
        solution: dict[str, Any],
    ) -> str:
        """Generate visualization for word problems"""
        code_parts = []
        code_parts.append(self.code_gen.generate_problem_display(problem_text))
        
        # Generate step-by-step visualization
        steps = solution.get("steps", [])
        for i, step in enumerate(steps):
            code_parts.append(
                self.code_gen.generate_graphical_step(
                    i + 1,
                    step.get("description", ""),
                    step.get("operation", ""),
                    step.get("result", ""),
                )
            )
        
        # Answer
        answer = solution.get("answer", "")
        code_parts.append(self.code_gen.generate_answer_display(answer))
        
        return self.code_gen.wrap_in_scene("".join(code_parts), "WordProblem")
