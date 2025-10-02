"""
可视化Agent，负责使用Manim生成数学可视化代码
"""
import json
import logging
import re
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent
from utils.prompts import VISUALIZATION_AGENT_PROMPT

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class VisualizationAgent(BaseAgent):
    """可视化Agent类"""
    
    def __init__(self, model: ChatOpenAI):
        """
        初始化可视化Agent
        
        Args:
            model: LLM模型实例
        """
        super().__init__(
            name="可视化Agent",
            description="生成Manim数学可视化代码",
            system_prompt=VISUALIZATION_AGENT_PROMPT,
            model=model
        )
        logger.info("可视化Agent初始化完成")
    
    async def generate_visualization_code(
        self, 
        problem_text: str, 
        analysis_result: Dict[str, Any], 
        solution_result: Dict[str, Any],
        is_retry: bool = False,
        error_message: str = ""
    ) -> str:
        """
        生成Manim可视化代码

        Args:
            problem_text: 题目文本
            analysis_result: 理解Agent的分析结果
            solution_result: 解题Agent的解题结果
            is_retry: 是否是重试
            error_message: 错误信息

        Returns:
            Manim可视化代码
        """
        # 构建提示词，包含题目、分析结果和解题结果
        analysis_json = json.dumps(analysis_result, ensure_ascii=False, indent=2)
        solution_json = json.dumps(solution_result, ensure_ascii=False, indent=2)

        # 根据是否重试调整提示词
        if is_retry:
            prompt = f"""⚠️ 之前生成的代码执行失败，请重新生成并严格遵循规范。

**错误信息**：
{error_message}

**题目**：
{problem_text}

**题目分析**：
{analysis_json}

**解题过程**：
{solution_json}

**🔑 最关键要求（必须遵守）**：
1. **判断步骤间的逻辑连续性**：如果步骤2用到步骤1的结果，必须在步骤1的VGroup上继续操作
2. **禁止清空重建**：不要FadeOut后再创建相同的元素
3. **在同一VGroup上操作**：用颜色变化、位置移动、添加/删除元素表达变化
4. **步骤标题用Transform**：不要FadeOut+Write
5. 参考系统提示词中的"20-3+2"完整示例和常见操作模板
6. 所有图形scale(0.65-0.7)，中文用font="Noto Sans CJK SC"

**只输出完整的Python代码，不要任何解释**。"""
        else:
            prompt = f"""请为以下数学题目生成Manim可视化代码。

**题目**：
{problem_text}

**题目分析**：
{analysis_json}

**解题过程**：
{solution_json}

**🔑 最关键原则（通用规则）**：
1. **判断步骤连续性**：如果步骤B用到步骤A的结果，必须在步骤A的图形上继续操作
2. **元素复用而非重建**：同一类型的可视化元素（圆圈/方块/线条）应贯穿多个相关步骤
3. **用变换表达过程**：通过animate.set_color/shift/scale表达变化，而非FadeOut重建
4. **Transform更新标题**：步骤说明文字用Transform(old, new)平滑更新
5. **最小化场景切换**：整个解题过程应该是一个连续场景，最多3-4次清空
6. **参考系统提示词中的通用模板**（加法/减法/乘法/除法/比较等操作模式）
7. 技术要求：scale(0.65-0.7)，中文font="Noto Sans CJK SC"

**只输出完整的Python代码，不要任何解释**。"""
        
        response = await self.arun(prompt)
        logger.info(f"可视化Agent代码生成完成: {response[:100]}...")
        
        try:
            # 尝试从响应中提取Python代码
            code = ""
            if "```python" in response:
                code_match = re.search(r"```python\n(.*?)```", response, re.DOTALL)
                if code_match:
                    code = code_match.group(1).strip()
            elif "```" in response:
                 # Fallback: try to extract from generic code blocks if ```python is not found
                 code_match = re.search(r"```.*\n(.*?)```", response, re.DOTALL)
                 if code_match:
                     code = code_match.group(1).strip()

            # If no code block found, try to find Manim import as a starting point
            if not code:
                match = re.search(r'(from\s+manim\s+import.*|import\s+manim.*)', response, re.DOTALL)
                if match:
                    code = match.string[match.start():].strip()
                else:
                    # If still no code found, log warning and use default
                    logger.warning("无法从响应中提取有效的Manim代码或找到Manim导入语句")
                    code = self._create_default_visualization_code(problem_text, solution_result)

            # 检查代码是否包含基本的Manim元素
            if "from manim import" not in code and "import manim" not in code:
                logger.warning("生成的代码不是有效的Manim代码，将使用默认代码")
                code = self._create_default_visualization_code(problem_text, solution_result)
            
            # 移除代码块前后可能存在的非代码文本 (更宽松的清理)
            lines = code.split('\n')
            cleaned_lines = []
            in_code_block = False
            for line in lines:
                 # Start capturing lines from the first Manim import
                 if "from manim import" in line or "import manim" in line:
                     in_code_block = True
                 if in_code_block:
                     # Keep lines that look like code or comments, or are empty
                     # This is a simplified check, might need further refinement
                     if line.strip().startswith('#') or line.strip() == '' or any(c in line for c in ' =().:,[]{}'):
                         cleaned_lines.append(line)
                     # Optionally log lines that are potentially non-code and discarded
                     # else:
                     #    logger.debug(f"Discarding potentially non-code line: {line}")

            if cleaned_lines:
                 code = '\n'.join(cleaned_lines)
            else:
                 # If cleaning resulted in empty code, fall back to default
                 logger.warning("代码清理后为空，将使用默认代码")
                 code = self._create_default_visualization_code(problem_text, solution_result)


            # 检查是否包含Scene类
            if "class" not in code or "Scene" not in code:
                logger.warning("生成的代码不包含Scene类，将添加默认Scene类")
                code = self._add_default_scene_class(code)
            
            # 尝试编译代码检查语法
            try:
                compile(code, "<string>", "exec")
                logger.info("生成的代码通过了语法检查")
            except SyntaxError as e:
                logger.warning(f"生成的代码存在语法错误: {e}")
                # 考虑是否需要更复杂的修复逻辑或直接返回错误
                # For now, just return the code with potential syntax errors

            # 验证代码是否遵循布局规范
            validation_issues = self._validate_layout_rules(code)
            if validation_issues:
                logger.warning(f"代码布局验证发现问题: {', '.join(validation_issues)}")
                # 记录问题但不阻止执行，由review agent来修复

            return code
        except Exception as e:
            logger.error(f"处理响应时出错: {e}")
            # 创建默认的可视化代码
            return self._create_default_visualization_code(problem_text, solution_result)
    
    def _create_default_visualization_code(self, problem_text: str, solution_result: Dict[str, Any]) -> str:
        """
        创建默认的Manim可视化代码 (优化布局和过渡以避免重叠)

        Args:
            problem_text: 题目文本
            solution_result: 解题结果

        Returns:
            默认的Manim代码
        """
        # 提取题目和答案
        steps = solution_result.get("解题步骤", [])
        answer = solution_result.get("答案", "未知")
        
        # 创建简单的可视化代码
        code = f"""from manim import *

class MathVisualization(Scene):
    def construct(self):
        # 显示题目
        title = Text("小学数学题目可视化", font="Noto Sans CJK SC")
        self.play(Write(title))
        self.wait(1)
        self.play(FadeOut(title))
        
        problem = Text('{problem_text[:50]}...', font="Noto Sans CJK SC", font_size=24)
        self.play(Write(problem))
        self.wait(2)
        self.play(FadeOut(problem))
        
        # 解题步骤
"""
        
        # 添加解题步骤
        # 移除 [:3] 限制，遍历所有步骤
        previous_step_group = None # 用于跟踪上一组元素
        for i, step in enumerate(steps, 1): #  <- 修改这里
            step_text = step.get("步骤", f"步骤{i}")
            explanation = step.get("说明", "")
            calculation = step.get("计算", "")

            # 限制解释文本长度，防止过长
            explanation_short = explanation[:80] + '...' if len(explanation) > 80 else explanation

            # --- 修改开始 ---
            # 创建当前步骤的元素
            # 使用支持中文的字体，并设置合适的字号
            step_title = Text(f"{step_text}", font="Noto Sans CJK SC", font_size=32)
            explanation_text = Text(explanation_short, font="Noto Sans CJK SC", font_size=24, t2c={"[:20]": "#FFFF00"}) # 考虑换行或宽度限制
            # MathTex 用于显示数学公式，确保 LaTeX 环境配置正确或使用 Text 替代
            try:
                # 尝试使用 MathTex，如果失败则回退到 Text
                calculation_mobject = MathTex(r"{}".format(calculation) if calculation else "", font_size=28)
            except:
                 logger.warning(f"MathTex渲染失败，步骤 {i} 的计算将使用 Text 显示: {calculation}")
                 calculation_mobject = Text(calculation if calculation else "", font="Noto Sans CJK SC", font_size=24)


            # 将当前步骤的元素组合并自动排列
            # 使用 VGroup 和 arrange 来确保元素垂直排列且有足够间距
            current_step_group = VGroup(step_title, explanation_text, calculation_mobject)
            current_step_group.arrange(DOWN, buff=0.7, aligned_edge=LEFT) # 垂直排列，增加间距，左对齐
            current_step_group.to_edge(UP, buff=1.0) # 定位到屏幕上方，留出边距

            # 过渡动画：先移除上一步的元素（如果存在）
            if previous_step_group:
                self.play(FadeOut(previous_step_group))
                self.wait(0.5) # 等待淡出完成

            # 显示当前步骤的元素
            # 分步显示，增加清晰度
            self.play(Write(step_title))
            self.wait(0.5)
            self.play(Write(explanation_text))
            self.wait(1)
            if calculation: # 仅在有计算内容时显示
                self.play(Write(calculation_mobject))
                self.wait(2)
            else:
                self.wait(1) # 如果没有计算，也等待一下

            # 更新 previous_step_group 以便下次循环移除
            previous_step_group = current_step_group
            # --- 修改结束 ---

        # 添加答案
        code += f"""
        # 清除最后一个步骤的元素
        if previous_step_group:
            self.play(FadeOut(previous_step_group))
            self.wait(0.5)

        # 显示答案
        answer_title = Text("答案", font="Noto Sans CJK SC", font_size=36).to_edge(UP, buff=1.0)
        answer_text = Text("{answer}", font="Noto Sans CJK SC", font_size=48).next_to(answer_title, DOWN, buff=0.8)

        answer_group = VGroup(answer_title, answer_text)

        self.play(Write(answer_title))
        self.wait(0.5)
        self.play(Write(answer_text))
        self.wait(3)

        self.play(FadeOut(answer_group))
        self.wait(1)

        # 结束
        end_text = Text("谢谢观看", font="Noto Sans CJK SC", font_size=40)
        self.play(Write(end_text))
        self.wait(2)
        self.play(FadeOut(end_text)) # <-- 添加此行以淡出结束文本
        self.wait(1) # <-- 添加短暂等待确保淡出完成
"""

        return code

    def _validate_layout_rules(self, code: str) -> List[str]:
        """
        验证代码是否遵循布局规范

        Args:
            code: Manim代码

        Returns:
            问题列表
        """
        issues = []

        # 检查是否使用中文字体
        if 'Text(' in code and 'font="Noto Sans CJK SC"' not in code:
            issues.append("缺少中文字体设置")

        # 检查是否有缩放操作
        if 'VGroup' in code and '.scale(' not in code:
            issues.append("VGroup未缩放可能超出边界")

        # 新增：检查场景切换频率
        fadeout_count = code.count('FadeOut')
        write_count = code.count('Write')
        create_count = code.count('Create')
        transform_count = code.count('Transform')

        # 如果FadeOut次数过多（超过5次），可能场景切换过度
        if fadeout_count > 5:
            issues.append(f"场景切换过度({fadeout_count}次FadeOut)，建议使用Transform保持连贯性")

        # 如果有多个Write但没有Transform，说明可能在重建而非变换
        if write_count > 3 and transform_count == 0:
            issues.append("缺少Transform，步骤间应使用Transform而非重建元素")

        # 检查是否使用to_edge布局
        if 'Text(' in code and '.to_edge(' not in code and '.move_to(' not in code:
            issues.append("文字未使用to_edge或move_to定位")

        return issues

    def _add_default_scene_class(self, code: str) -> str:
        """
        如果代码不包含Scene类，则添加一个默认的Scene类包装器
        """
        default_scene = """

class MathVisualization(Scene):
    def construct(self):
        title = Text("数学可视化", font="Noto Sans CJK SC")
        self.play(Write(title))
        self.wait(2)
        self.play(FadeOut(title))

        problem = Text("数学问题", font="Noto Sans CJK SC")
        self.play(Write(problem))
        self.wait(2)
        self.play(FadeOut(problem))

        answer = Text("解答", font="Noto Sans CJK SC")
        self.play(Write(answer))
        self.wait(2)
"""

        # 检查代码是否已经有导入语句
        if "from manim import" in code or "import manim" in code:
            # 在导入语句后添加Scene类
            return code + default_scene
        else:
            # 添加导入语句和Scene类
            return "from manim import *\n" + code + default_scene