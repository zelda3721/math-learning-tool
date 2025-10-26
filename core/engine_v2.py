"""
核心处理引擎 V2 - 优化版

使用新的架构组件：
1. 场景状态管理器 - 避免元素重叠
2. 基于工具调用的代码生成 - 确保代码质量
3. 智能Agent协调器 - 减少tokens消耗
4. 可复用技能模块 - 提高生成质量

预期改进：
- Tokens消耗减少 80%+
- 视频生成质量提升 50%+
- 处理速度提升 30%+
"""
import json
import logging
import asyncio
from typing import Dict, Any, List, Optional, Tuple
from langchain_openai import ChatOpenAI

from agents.understanding import UnderstandingAgent
from agents.solving import SolvingAgent
from agents.visualization_v2 import VisualizationAgentV2
from agents.debugging import DebuggingAgent
from agents.review import ReviewAgent
from core.manim_executor import ManimExecutor
from core.model_connector import create_llm
from core.agent_coordinator import AgentCoordinator, CodeQualityAnalyzer
import config

logger = logging.getLogger(__name__)


class MathTutorEngineV2:
    """数学辅导工具核心引擎 V2"""

    def __init__(self, performance_config: Optional[Dict[str, Any]] = None):
        """
        初始化核心引擎 V2

        Args:
            performance_config: 性能配置字典
        """
        # 创建LLM模型
        self.llm = create_llm()

        # 创建Agent协调器
        self.coordinator = AgentCoordinator()

        # 创建各个Agent
        self.understanding_agent = UnderstandingAgent(model=self.llm)
        self.solving_agent = SolvingAgent(model=self.llm)
        self.visualization_agent = VisualizationAgentV2(model=self.llm)
        self.debugging_agent = DebuggingAgent(model=self.llm)
        self.review_agent = ReviewAgent(model=self.llm)

        # 性能优化设置
        if performance_config:
            self.enable_understanding_agent = performance_config.get('enable_understanding', config.ENABLE_UNDERSTANDING_AGENT)
            self.enable_review_agent = performance_config.get('enable_review', config.ENABLE_REVIEW_AGENT)
            self.max_debug_attempts = performance_config.get('max_debug_attempts', config.MAX_DEBUG_ATTEMPTS)
            manim_quality = performance_config.get('manim_quality', config.MANIM_QUALITY)
            self.auto_skip_optimization = performance_config.get('auto_skip_optimization', True)
        else:
            self.enable_understanding_agent = config.ENABLE_UNDERSTANDING_AGENT
            self.enable_review_agent = config.ENABLE_REVIEW_AGENT
            self.max_debug_attempts = config.MAX_DEBUG_ATTEMPTS
            manim_quality = config.MANIM_QUALITY
            self.auto_skip_optimization = True

        # 创建Manim执行器
        self.manim_executor = ManimExecutor(quality=manim_quality)

        logger.info(
            f"核心引擎V2初始化完成 "
            f"(理解Agent: {'启用' if self.enable_understanding_agent else '禁用'}, "
            f"审查Agent: {'智能' if self.auto_skip_optimization else '启用' if self.enable_review_agent else '禁用'}, "
            f"最大调试次数: {self.max_debug_attempts}, "
            f"渲染质量: {manim_quality})"
        )

    async def process_problem(self, problem_text: str) -> Dict[str, Any]:
        """
        处理数学问题

        Args:
            problem_text: 题目文本

        Returns:
            处理结果
        """
        logger.info(f"[V2引擎] 开始处理数学问题: {problem_text[:50]}...")

        # 初始化任务
        memory = self.coordinator.start_new_task(problem_text)

        try:
            # === 步骤1: 题目理解（可选，智能跳过）===
            if self.coordinator.should_skip_understanding(not self.enable_understanding_agent):
                logger.info("⚡ 跳过理解Agent（智能优化）")
                analysis_result = {
                    "题目类型": "待解析",
                    "核心知识点": [],
                    "关键信息": {"已知条件": [], "待求问题": problem_text}
                }
                tokens_used = 0
            else:
                logger.info("正在分析题目...")
                analysis_result = await self.understanding_agent.analyze_problem(problem_text)
                logger.info(f"题目分析完成: {analysis_result}")
                tokens_used = 1500  # 估算
                self.coordinator.mark_step_completed("understanding", tokens_used)

            self.coordinator.update_memory(analysis_result=analysis_result)

            # === 步骤2: 解题 ===
            logger.info("正在解题...")
            solution_result = await self.solving_agent.solve_problem(problem_text, analysis_result)
            logger.info(f"解题完成: {solution_result}")
            self.coordinator.mark_step_completed("solving", 2000)
            self.coordinator.update_memory(solution_result=solution_result)

            # === 步骤3: 生成可视化代码（使用V2 Agent）===
            logger.info("正在生成可视化代码（V2引擎 - 结构化生成）...")
            visualization_code = await self.visualization_agent.generate_visualization_code(
                problem_text, analysis_result, solution_result
            )
            logger.info(f"可视化代码生成完成: {visualization_code[:100]}...")
            self.coordinator.mark_step_completed("visualization_v2", 1000)  # V2消耗更少tokens
            self.coordinator.update_memory(visualization_code=visualization_code)

            # === 步骤4: 智能审查（自动决定是否需要）===
            reviewed_code = visualization_code

            if self.auto_skip_optimization:
                # 智能判断是否需要审查
                should_skip, reason = self.coordinator.should_skip_review(
                    visualization_code,
                    force_review=self.enable_review_agent and not self.auto_skip_optimization
                )

                if should_skip:
                    logger.info(f"⚡ 跳过审查Agent: {reason}（智能优化，节省~2000 tokens）")
                else:
                    logger.info(f"正在审查代码: {reason}")
                    reviewed_code = await self.review_agent.review_code(
                        visualization_code, problem_text
                    )
                    self.coordinator.mark_step_completed("review", 2000)
            elif self.enable_review_agent:
                logger.info("正在审查代码（强制模式）...")
                reviewed_code = await self.review_agent.review_code(
                    visualization_code, problem_text
                )
                self.coordinator.mark_step_completed("review", 2000)
            else:
                logger.info("⚡ 审查Agent已禁用")

            self.coordinator.update_memory(reviewed_code=reviewed_code)

            # === 步骤5: 执行并调试 ===
            logger.info("正在生成可视化视频...")
            success, video_path, error_msg = await self._execute_with_debugging(
                reviewed_code, problem_text, analysis_result, solution_result
            )

            if success:
                logger.info(f"✓ 视频生成成功: {video_path}")
                status = "success"
            else:
                logger.error(f"✗ 视频生成失败: {error_msg}")
                status = "error"
                self.coordinator.record_error(error_msg)

            # 生成性能报告
            performance_report = self.coordinator.generate_performance_report()
            logger.info(f"\n{performance_report}")

            # 返回结果
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
                "final_code": self.final_code if hasattr(self, "final_code") else reviewed_code,
                "performance": {
                    "tokens_used": memory.tokens_used,
                    "tokens_saved": self.coordinator.estimate_tokens_saved(),
                    "steps_completed": memory.steps_completed,
                    "errors_count": len(memory.errors_encountered)
                }
            }

            return result

        except Exception as e:
            logger.error(f"处理问题时出错: {e}", exc_info=True)
            self.coordinator.record_error(str(e))
            return {
                "status": "error",
                "problem": problem_text,
                "error": str(e),
                "performance": {
                    "tokens_used": memory.tokens_used if memory else 0,
                    "errors_count": len(memory.errors_encountered) if memory else 0
                }
            }
        finally:
            # 清理资源
            self.coordinator.clear()

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
            logger.info("✓ 首次执行成功，无需调试")
            return success, video_path, error_msg

        logger.warning(f"✗ 首次执行失败: {error_msg[:100]}")
        self.coordinator.record_error(error_msg)

        # 如果执行失败，使用调试Agent进行修复
        while not success and self.debug_attempts < self.max_debug_attempts:
            self.debug_attempts += 1
            logger.info(f"开始第{self.debug_attempts}次代码调试...")

            # 使用调试Agent修复代码
            fixed_code = await self.debugging_agent.debug_code(
                current_code, error_msg, self.debug_attempts
            )
            self.coordinator.mark_step_completed(f"debug_{self.debug_attempts}", 2500)

            # 如果调试Agent修复了代码，进行快速质量检查
            if fixed_code != current_code:
                logger.info("调试Agent修复了代码")
                # 如果启用了智能审查，检查修复后的代码是否需要review
                if self.auto_skip_optimization and self.enable_review_agent:
                    should_skip, reason = self.coordinator.should_skip_review(
                        fixed_code, quality_threshold=70.0
                    )
                    if not should_skip:
                        logger.info(f"修复后的代码质量不足，进行审查: {reason}")
                        fixed_code = await self.review_agent.review_code(
                            fixed_code, problem_text, error_msg
                        )
                        self.coordinator.mark_step_completed("review_after_debug", 2000)
            else:
                logger.warning("调试Agent无法修复代码")

            # 如果调试Agent无法修复且是最后一次尝试，重新生成
            if fixed_code == current_code and self.debug_attempts == self.max_debug_attempts:
                logger.info("调试Agent无法修复代码，尝试使用可视化Agent重新生成...")
                fixed_code = await self.visualization_agent.generate_visualization_code(
                    problem_text, analysis_result, solution_result,
                    is_retry=True, error_message=error_msg
                )
                self.coordinator.mark_step_completed("visualization_retry", 1000)

                # 对重新生成的代码进行审查
                if self.enable_review_agent:
                    logger.info("对重新生成的代码进行审查...")
                    fixed_code = await self.review_agent.review_code(
                        fixed_code, problem_text, error_msg
                    )
                    self.coordinator.mark_step_completed("review_after_retry", 2000)

            # 尝试执行修复后的代码
            current_code = fixed_code
            self.final_code = fixed_code
            success, video_path, error_msg = self.manim_executor.execute_code(current_code)

            # 如果执行成功，返回结果
            if success:
                logger.info(f"✓ 在第{self.debug_attempts}次调试后代码执行成功")
                return success, video_path, error_msg

            logger.warning(f"✗ 第{self.debug_attempts}次调试后代码执行仍然失败: {error_msg[:100]}")
            self.coordinator.record_error(error_msg)

        # 如果达到最大尝试次数仍然失败，返回最后一次的结果
        logger.error(f"✗ 达到最大调试尝试次数({self.max_debug_attempts})，代码执行失败")
        return success, video_path, error_msg
