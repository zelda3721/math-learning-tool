"""
核心处理引擎，协调各个Agent的工作
"""
import json
import logging
import asyncio
from typing import Dict, Any, List, Optional, Tuple
from langchain_openai import ChatOpenAI

from agents.understanding import UnderstandingAgent
from agents.solving import SolvingAgent
from agents.visualization import VisualizationAgent
from agents.debugging import DebuggingAgent
from agents.review import ReviewAgent
from core.manim_executor import ManimExecutor
from core.model_connector import create_llm
import config

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class MathTutorEngine:
    """数学辅导工具核心引擎"""

    def __init__(self, performance_config: Optional[Dict[str, Any]] = None):
        """
        初始化核心引擎

        Args:
            performance_config: 性能配置字典，包含:
                - enable_understanding: 是否启用理解Agent
                - enable_review: 是否启用审查Agent
                - max_debug_attempts: 最大调试次数
                - manim_quality: Manim渲染质量
        """
        # 创建LLM模型
        self.llm = create_llm()

        # 创建各个Agent
        self.understanding_agent = UnderstandingAgent(model=self.llm)
        self.solving_agent = SolvingAgent(model=self.llm)
        self.visualization_agent = VisualizationAgent(model=self.llm)
        self.debugging_agent = DebuggingAgent(model=self.llm)
        self.review_agent = ReviewAgent(model=self.llm)

        # 性能优化设置：优先使用传入的配置，否则使用config文件中的默认值
        if performance_config:
            self.enable_understanding_agent = performance_config.get('enable_understanding', config.ENABLE_UNDERSTANDING_AGENT)
            self.enable_review_agent = performance_config.get('enable_review', config.ENABLE_REVIEW_AGENT)
            self.max_debug_attempts = performance_config.get('max_debug_attempts', config.MAX_DEBUG_ATTEMPTS)
            manim_quality = performance_config.get('manim_quality', config.MANIM_QUALITY)
        else:
            self.enable_understanding_agent = config.ENABLE_UNDERSTANDING_AGENT
            self.enable_review_agent = config.ENABLE_REVIEW_AGENT
            self.max_debug_attempts = config.MAX_DEBUG_ATTEMPTS
            manim_quality = config.MANIM_QUALITY

        # 创建Manim执行器，传入质量设置
        self.manim_executor = ManimExecutor(quality=manim_quality)

        logger.info(f"核心引擎初始化完成 (理解Agent: {'启用' if self.enable_understanding_agent else '禁用'}, 审查Agent: {'启用' if self.enable_review_agent else '禁用'}, 最大调试次数: {self.max_debug_attempts}, 渲染质量: {manim_quality})")
    
    async def process_problem(self, problem_text: str) -> Dict[str, Any]:
        """
        处理数学问题
        
        Args:
            problem_text: 题目文本
            
        Returns:
            处理结果，包含分析、解答、可视化代码和视频路径
        """
        logger.info(f"开始处理数学问题: {problem_text[:50]}...")
        
        try:
            # 1. 使用理解Agent分析题目（可选，禁用可加速）
            if self.enable_understanding_agent:
                logger.info("正在分析题目...")
                analysis_result = await self.understanding_agent.analyze_problem(problem_text)
                logger.info(f"题目分析完成: {analysis_result}")
            else:
                logger.info("理解Agent已禁用，使用简化分析（极速模式）")
                analysis_result = {
                    "题目类型": "待解析",
                    "核心知识点": [],
                    "关键信息": {"已知条件": [], "待求问题": problem_text}
                }

            # 2. 使用解题Agent解决问题
            logger.info("正在解题...")
            solution_result = await self.solving_agent.solve_problem(problem_text, analysis_result)
            logger.info(f"解题完成: {solution_result}")
            
            # 3. 使用可视化Agent生成Manim代码
            logger.info("正在生成可视化代码...")
            visualization_code = await self.visualization_agent.generate_visualization_code(
                problem_text, analysis_result, solution_result
            )
            logger.info(f"可视化代码生成完成: {visualization_code[:100]}...")

            # 4. 使用审查Agent检查和优化布局和场景切换（可选，用于提高质量）
            if self.enable_review_agent:
                logger.info("正在审查代码布局和场景切换...")
                reviewed_code = await self.review_agent.review_code(
                    visualization_code, problem_text
                )
                logger.info(f"代码审查完成: {reviewed_code[:100]}...")
            else:
                logger.info("审查Agent已禁用，跳过审查步骤（提速模式）")
                reviewed_code = visualization_code

            # 5. 执行Manim代码生成视频，如果失败则使用调试Agent修复
            logger.info("正在生成可视化视频...")
            success, video_path, error_msg = await self._execute_with_debugging(
                reviewed_code, problem_text, analysis_result, solution_result
            )
            
            if success:
                logger.info(f"视频生成成功: {video_path}")
                status = "success"
            else:
                logger.error(f"视频生成失败: {error_msg}")
                status = "error"
            
            # 5. 返回处理结果
            result = {
                "status": status,
                "problem": problem_text,
                "analysis": analysis_result,
                "solution": solution_result,
                "visualization_code": visualization_code,
                "reviewed_code": reviewed_code, 
                "video_path": video_path if success else "",
                "error": error_msg if not success else "",
                "debug_attempts": self.debug_attempts if hasattr(self, "debug_attempts") else 0,
                "final_code": self.final_code if hasattr(self, "final_code") else visualization_code
            }
            
            return result
            
        except Exception as e:
            logger.error(f"处理问题时出错: {e}")
            return {
                "status": "error",
                "problem": problem_text,
                "error": str(e)
            }
    
    async def _execute_with_debugging(
        self, 
        code: str, 
        problem_text: str, 
        analysis_result: Dict[str, Any],
        solution_result: Dict[str, Any]
    ) -> Tuple[bool, str, str]:
        """
        执行代码并在失败时进行调试
        
        Args:
            code: 原始Manim代码
            problem_text: 题目文本
            analysis_result: 分析结果
            solution_result: 解题结果
            
        Returns:
            Tuple(成功标志, 视频文件路径, 错误信息)
        """
        self.debug_attempts = 0
        current_code = code
        self.final_code = code
        
        # 首次尝试执行
        success, video_path, error_msg = self.manim_executor.execute_code(current_code)
        
        # 如果执行成功，直接返回
        if success:
            return success, video_path, error_msg
        
        # 如果执行失败，使用调试Agent进行修复
        while not success and self.debug_attempts < self.max_debug_attempts:
            self.debug_attempts += 1
            logger.info(f"开始第{self.debug_attempts}次代码调试...")
            
            # 使用调试Agent修复代码
            fixed_code = await self.debugging_agent.debug_code(
                current_code, error_msg, self.debug_attempts
            )

            # 如果调试Agent修复了代码，且启用了审查Agent，则检查布局和场景切换
            if fixed_code != current_code and self.enable_review_agent:
                logger.info("调试Agent修复了代码，正在进行布局和场景切换审查...")
                fixed_code = await self.review_agent.review_code(
                    fixed_code, problem_text, error_msg
                )
            elif fixed_code != current_code:
                logger.info("调试Agent修复了代码（审查Agent已禁用，提速模式）")
            
            # 如果调试Agent无法修复代码，尝试使用可视化Agent重新生成
            if fixed_code == current_code and self.debug_attempts == self.max_debug_attempts - 1:
                logger.info("调试Agent无法修复代码，尝试使用可视化Agent重新生成...")
                fixed_code = await self.visualization_agent.generate_visualization_code(
                    problem_text, analysis_result, solution_result, 
                    is_retry=True, error_message=error_msg
                )
            
            # 对重新生成的代码进行布局和场景切换审查
            logger.info("对重新生成的代码进行布局和场景切换审查...")
            fixed_code = await self.review_agent.review_code(
                fixed_code, problem_text, error_msg
            )

            # 尝试执行修复后的代码
            current_code = fixed_code
            self.final_code = fixed_code
            success, video_path, error_msg = self.manim_executor.execute_code(current_code)
            
            # 如果执行成功，返回结果
            if success:
                logger.info(f"在第{self.debug_attempts}次调试后代码执行成功")
                return success, video_path, error_msg
            
            logger.warning(f"第{self.debug_attempts}次调试后代码执行仍然失败: {error_msg}")
        
        # 如果达到最大尝试次数仍然失败，返回最后一次的结果
        logger.error(f"达到最大调试尝试次数({self.max_debug_attempts})，代码执行失败")
        return success, video_path, error_msg