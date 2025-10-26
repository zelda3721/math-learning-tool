"""
智能Agent协调器 - 实现高效的多Agent协作

核心功能：
1. 共享记忆池 - Agent之间共享上下文，避免重复传递
2. 智能跳过 - 根据质量评估决定是否需要review/debug
3. 结果缓存 - 避免重复计算
4. 性能监控 - 追踪tokens消耗和耗时
"""
from typing import Dict, Any, List, Optional, Tuple
from dataclasses import dataclass, field
from datetime import datetime
import logging
import hashlib
import json

logger = logging.getLogger(__name__)


@dataclass
class AgentMemory:
    """Agent共享记忆"""
    problem_text: str
    analysis_result: Optional[Dict[str, Any]] = None
    solution_result: Optional[Dict[str, Any]] = None
    visualization_code: Optional[str] = None
    reviewed_code: Optional[str] = None
    final_code: Optional[str] = None
    scene_state: Optional[Dict[str, Any]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    # 性能追踪
    tokens_used: int = 0
    steps_completed: List[str] = field(default_factory=list)
    errors_encountered: List[str] = field(default_factory=list)
    start_time: datetime = field(default_factory=datetime.now)


@dataclass
class QualityMetrics:
    """代码质量评估指标"""
    has_chinese_font: bool = True
    has_layout_issues: bool = False
    scene_transition_count: int = 0  # FadeOut次数
    transform_count: int = 0
    syntax_valid: bool = True
    has_scene_class: bool = True
    estimated_overlap_risk: float = 0.0  # 0-1之间

    @property
    def quality_score(self) -> float:
        """计算质量分数（0-100）"""
        score = 100.0

        if not self.has_chinese_font:
            score -= 20
        if self.has_layout_issues:
            score -= 15
        if not self.syntax_valid:
            score -= 30
        if not self.has_scene_class:
            score -= 30

        # 过多的场景切换扣分
        if self.scene_transition_count > 5:
            score -= (self.scene_transition_count - 5) * 5

        # Transform使用加分
        if self.transform_count > 0:
            score += min(self.transform_count * 3, 15)

        # 重叠风险扣分
        score -= self.estimated_overlap_risk * 20

        return max(0, min(100, score))

    @property
    def needs_review(self) -> bool:
        """是否需要review"""
        return self.quality_score < 70

    @property
    def is_good_enough(self) -> bool:
        """是否足够好（可以跳过review）"""
        return self.quality_score >= 80


class CodeQualityAnalyzer:
    """代码质量分析器"""

    @staticmethod
    def analyze(code: str) -> QualityMetrics:
        """
        分析代码质量

        Args:
            code: Manim代码

        Returns:
            质量指标
        """
        metrics = QualityMetrics()

        # 检查中文字体
        metrics.has_chinese_font = 'font="Noto Sans CJK SC"' in code or "font='Noto Sans CJK SC'" in code

        # 检查语法
        try:
            compile(code, "<string>", "exec")
            metrics.syntax_valid = True
        except SyntaxError:
            metrics.syntax_valid = False

        # 检查Scene类
        metrics.has_scene_class = "class" in code and "Scene" in code

        # 统计场景切换
        metrics.scene_transition_count = code.count("FadeOut")
        metrics.transform_count = code.count("Transform")

        # 检查布局问题
        has_to_edge = ".to_edge(" in code
        has_move_to = ".move_to(" in code
        has_scale = ".scale(" in code

        if not (has_to_edge or has_move_to):
            metrics.has_layout_issues = True

        if "VGroup" in code and not has_scale:
            metrics.has_layout_issues = True

        # 估计重叠风险（基于启发式规则）
        text_count = code.count("Text(")
        vgroup_count = code.count("VGroup")

        if text_count > 5 and not has_to_edge:
            metrics.estimated_overlap_risk += 0.3

        if vgroup_count > 3 and not has_scale:
            metrics.estimated_overlap_risk += 0.2

        # 检查是否有位置定义
        position_statements = code.count(".to_edge(") + code.count(".move_to(") + code.count(".next_to(")
        if text_count + vgroup_count > position_statements:
            metrics.estimated_overlap_risk += 0.3

        metrics.estimated_overlap_risk = min(1.0, metrics.estimated_overlap_risk)

        logger.info(f"代码质量分析: 分数={metrics.quality_score:.1f}, 需要review={metrics.needs_review}")

        return metrics


class AgentCoordinator:
    """Agent协调器"""

    def __init__(self):
        """初始化协调器"""
        self.memory: Optional[AgentMemory] = None
        self.cache: Dict[str, Any] = {}  # 结果缓存
        logger.info("Agent协调器初始化完成")

    def start_new_task(self, problem_text: str) -> AgentMemory:
        """
        开始新任务

        Args:
            problem_text: 题目文本

        Returns:
            记忆对象
        """
        self.memory = AgentMemory(problem_text=problem_text)
        logger.info(f"开始新任务: {problem_text[:50]}...")
        return self.memory

    def update_memory(self, **kwargs):
        """
        更新记忆

        Args:
            **kwargs: 要更新的字段
        """
        if not self.memory:
            logger.warning("记忆未初始化")
            return

        for key, value in kwargs.items():
            if hasattr(self.memory, key):
                setattr(self.memory, key, value)
                logger.debug(f"更新记忆: {key}")

    def mark_step_completed(self, step_name: str, tokens_used: int = 0):
        """
        标记步骤完成

        Args:
            step_name: 步骤名称
            tokens_used: 消耗的tokens
        """
        if not self.memory:
            return

        self.memory.steps_completed.append(step_name)
        self.memory.tokens_used += tokens_used
        logger.info(f"步骤完成: {step_name}, 累计tokens: {self.memory.tokens_used}")

    def record_error(self, error_msg: str):
        """
        记录错误

        Args:
            error_msg: 错误信息
        """
        if not self.memory:
            return

        self.memory.errors_encountered.append(error_msg)
        logger.warning(f"记录错误: {error_msg[:100]}")

    def should_skip_understanding(self, fast_mode: bool = False) -> bool:
        """
        判断是否应跳过理解Agent

        Args:
            fast_mode: 是否快速模式

        Returns:
            是否跳过
        """
        # 快速模式下跳过
        if fast_mode:
            logger.info("快速模式: 跳过理解Agent")
            return True

        # 如果题目很简单（少于20字），可以跳过
        if self.memory and len(self.memory.problem_text) < 20:
            logger.info("简单题目: 跳过理解Agent")
            return True

        return False

    def should_skip_review(
        self,
        code: str,
        force_review: bool = False,
        quality_threshold: float = 80.0
    ) -> Tuple[bool, str]:
        """
        判断是否应跳过审查Agent

        Args:
            code: 生成的代码
            force_review: 是否强制审查
            quality_threshold: 质量阈值

        Returns:
            (是否跳过, 原因)
        """
        if force_review:
            return False, "强制审查模式"

        # 分析代码质量
        metrics = CodeQualityAnalyzer.analyze(code)

        # 如果质量足够好，跳过review
        if metrics.quality_score >= quality_threshold:
            logger.info(f"代码质量优秀({metrics.quality_score:.1f}): 跳过审查Agent，节省tokens")
            return True, f"质量优秀({metrics.quality_score:.1f}分)"

        # 如果有严重问题，必须review
        if not metrics.syntax_valid or not metrics.has_scene_class:
            return False, "存在严重问题，必须审查"

        # 中等质量，需要review
        return False, f"质量一般({metrics.quality_score:.1f}分)，需要优化"

    def estimate_tokens_saved(self) -> int:
        """
        估算节省的tokens

        Returns:
            节省的tokens数
        """
        if not self.memory:
            return 0

        saved = 0

        # 如果跳过了理解Agent
        if "understanding" not in self.memory.steps_completed:
            saved += 1500  # 估算

        # 如果跳过了审查Agent
        if "review" not in self.memory.steps_completed:
            saved += 2000  # 估算

        # 如果减少了调试次数
        debug_count = sum(1 for step in self.memory.steps_completed if "debug" in step)
        if debug_count < 2:
            saved += (2 - debug_count) * 2500

        return saved

    def get_cache_key(self, prefix: str, data: Any) -> str:
        """
        生成缓存键

        Args:
            prefix: 前缀
            data: 数据

        Returns:
            缓存键
        """
        data_str = json.dumps(data, ensure_ascii=False, sort_keys=True)
        hash_val = hashlib.md5(data_str.encode()).hexdigest()
        return f"{prefix}_{hash_val}"

    def cache_result(self, key: str, value: Any):
        """
        缓存结果

        Args:
            key: 缓存键
            value: 值
        """
        self.cache[key] = value
        logger.debug(f"缓存结果: {key}")

    def get_cached_result(self, key: str) -> Optional[Any]:
        """
        获取缓存结果

        Args:
            key: 缓存键

        Returns:
            缓存值，如果不存在则返回None
        """
        result = self.cache.get(key)
        if result:
            logger.info(f"使用缓存结果: {key}")
        return result

    def generate_performance_report(self) -> str:
        """
        生成性能报告

        Returns:
            性能报告
        """
        if not self.memory:
            return "无性能数据"

        elapsed = (datetime.now() - self.memory.start_time).total_seconds()

        report = [
            "=== 性能报告 ===",
            f"总耗时: {elapsed:.1f}秒",
            f"总tokens: {self.memory.tokens_used}",
            f"节省tokens: {self.estimate_tokens_saved()}",
            f"完成步骤: {len(self.memory.steps_completed)}",
            f"错误次数: {len(self.memory.errors_encountered)}",
            "",
            "步骤详情:",
        ]

        for step in self.memory.steps_completed:
            report.append(f"  ✓ {step}")

        if self.memory.errors_encountered:
            report.append("\n错误详情:")
            for error in self.memory.errors_encountered:
                report.append(f"  ✗ {error[:80]}")

        return "\n".join(report)

    def clear(self):
        """清除当前任务的记忆和缓存"""
        self.memory = None
        self.cache.clear()
        logger.info("清除记忆和缓存")
