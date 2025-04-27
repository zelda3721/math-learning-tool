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
    
    def __init__(self):
        """初始化核心引擎"""
        # 创建LLM模型
        self.llm = create_llm()
        
        # 创建各个Agent
        self.understanding_agent = UnderstandingAgent(model=self.llm)
        self.solving_agent = SolvingAgent(model=self.llm)
        self.visualization_agent = VisualizationAgent(model=self.llm)
        self.debugging_agent = DebuggingAgent(model=self.llm)
        self.review_agent = ReviewAgent(model=self.llm) 
        
        # 创建Manim执行器
        self.manim_executor = ManimExecutor()
        
        # 设置最大调试尝试次数
        self.max_debug_attempts = 3
        
        logger.info("核心引擎初始化完成")
    
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
            # 1. 使用理解Agent分析题目
            logger.info("正在分析题目...")
            analysis_result = await self.understanding_agent.analyze_problem(problem_text)
            logger.info(f"题目分析完成: {analysis_result}")
            
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
            
            # 4. 使用审查Agent检查和优化布局和场景切换
            logger.info("正在审查代码布局和场景切换...")
            reviewed_code = await self.review_agent.review_code(
                visualization_code, problem_text
            )
            logger.info(f"代码审查完成: {reviewed_code[:100]}...")

            # 5. 执行Manim代码生成视频，如果失败则使用调试Agent修复
            logger.info("正在生成可视化视频...")
            success, video_path, error_msg = await self._execute_with_debugging(
                visualization_code, problem_text, analysis_result, solution_result
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

            # 如果调试Agent修复了代码，使用审查Agent检查布局和场景切换
            if fixed_code != current_code:
                logger.info("调试Agent修复了代码，正在进行布局和场景切换审查...")
                fixed_code = await self.review_agent.review_code(
                    fixed_code, problem_text, error_msg
                )
            
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