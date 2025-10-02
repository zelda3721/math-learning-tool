"""
Prompt优化增强工具和最佳实践指南
"""

from typing import Dict, Any, List, Optional
import json
import re

# ============================
# 难度自适应系统
# ============================

class DifficultyAdapter:
    """根据题目难度自动调整prompt策略"""
    
    DIFFICULTY_KEYWORDS = {
        'easy': ['一位数', '两位数', '简单', '基础', '加法', '减法', '认识'],
        'medium': ['三位数', '四位数', '乘法', '除法', '分数', '小数', '面积', '周长'],
        'hard': ['方程', '比例', '百分数', '立体', '复合', '应用', '综合', '奥数']
    }
    
    @classmethod
    def analyze_difficulty(cls, problem_text: str) -> str:
        """分析题目难度
        
        Args:
            problem_text: 题目文本
            
        Returns:
            难度等级: 'easy'/'medium'/'hard'
        """
        text = problem_text.lower()
        scores = {'easy': 0, 'medium': 0, 'hard': 0}
        
        for difficulty, keywords in cls.DIFFICULTY_KEYWORDS.items():
            for keyword in keywords:
                if keyword in text:
                    scores[difficulty] += 1
        
        # 根据分数确定难度
        max_score = max(scores.values())
        if max_score == 0:
            return 'medium'  # 默认中等难度
        
        for difficulty, score in scores.items():
            if score == max_score:
                return difficulty
        
        return 'medium'
    
    @classmethod
    def adapt_prompt(cls, base_prompt: str, problem_text: str) -> str:
        """根据题目难度调整prompt
        
        Args:
            base_prompt: 基础prompt
            problem_text: 题目文本
            
        Returns:
            调整后的prompt
        """
        difficulty = cls.analyze_difficulty(problem_text)
        
        difficulty_instructions = {
            'easy': """
**难度调整（基础题目）**：
- 注重基本概念的理解和掌握
- 使用简单直观的方法，避免复杂推理
- 多用具体的实物或图形来辅助理解
- 步骤要特别详细，每一步都要充分解释
""",
            'medium': """
**难度调整（中等题目）**：
- 平衡概念理解和方法应用
- 可以使用多步骤的推理过程
- 注重不同知识点之间的联系
- 提供多种解题思路的对比
""",
            'hard': """
**难度调整（较难题目）**：
- 强调分析思维和逻辑推理
- 可以引入更高级的数学概念
- 注重解题策略的选择和优化
- 培养学生的数学思维能力
"""
        }
        
        return base_prompt + difficulty_instructions[difficulty]

# ============================
# 个性化学习风格适配
# ============================

class LearningStyleAdapter:
    """根据学习风格调整教学方法"""
    
    STYLE_PROMPTS = {
        'visual': {
            'emphasis': '重点使用图形、图表、颜色标记等视觉元素',
            'methods': ['绘制示意图', '使用颜色区分', '制作表格', '创建流程图']
        },
        'auditory': {
            'emphasis': '重点使用语言描述、步骤朗读、概念解释',
            'methods': ['详细的语言描述', '步骤逐一说明', '概念反复强调', '口诀记忆']
        },
        'kinesthetic': {
            'emphasis': '重点使用动手操作、实际演示、互动体验',
            'methods': ['动画演示', '步骤模拟', '实际操作', '互动练习']
        }
    }
    
    @classmethod
    def adapt_for_style(cls, base_prompt: str, learning_style: str) -> str:
        """根据学习风格调整prompt
        
        Args:
            base_prompt: 基础prompt
            learning_style: 学习风格类型
            
        Returns:
            调整后的prompt
        """
        if learning_style not in cls.STYLE_PROMPTS:
            return base_prompt
        
        style_config = cls.STYLE_PROMPTS[learning_style]
        
        style_instruction = f"""
**学习风格适配（{learning_style}）**：
- {style_config['emphasis']}
- 推荐方法：{', '.join(style_config['methods'])}
"""
        
        return base_prompt + style_instruction

# ============================
# 输出质量验证器
# ============================

class OutputValidator:
    """验证Agent输出质量"""
    
    @staticmethod
    def validate_understanding_output(output: str) -> Dict[str, Any]:
        """验证理解Agent输出"""
        try:
            # 尝试解析JSON
            if "```json" in output:
                json_text = output.split("```json", 1)[1].split("```", 1)[0].strip()
            else:
                json_text = output.strip()
            
            data = json.loads(json_text)
            
            # 检查必需字段
            required_fields = ['题目类型', '核心知识点', '关键信息', '难点分析', '推荐策略']
            missing_fields = [field for field in required_fields if field not in data]
            
            return {
                'valid': len(missing_fields) == 0,
                'missing_fields': missing_fields,
                'data': data if len(missing_fields) == 0 else None
            }
        except json.JSONDecodeError as e:
            return {
                'valid': False,
                'error': f'JSON解析错误: {str(e)}',
                'data': None
            }
    
    @staticmethod
    def validate_solving_output(output: str) -> Dict[str, Any]:
        """验证解题Agent输出"""
        try:
            if "```json" in output:
                json_text = output.split("```json", 1)[1].split("```", 1)[0].strip()
            else:
                json_text = output.strip()
            
            data = json.loads(json_text)
            
            # 检查必需字段
            required_fields = ['理解确认', '解题策略', '详细步骤', '最终答案', '关键技巧']
            missing_fields = [field for field in required_fields if field not in data]
            
            # 检查步骤格式
            steps_valid = True
            if '详细步骤' in data and isinstance(data['详细步骤'], list):
                for step in data['详细步骤']:
                    if not isinstance(step, dict) or '步骤编号' not in step or '步骤说明' not in step:
                        steps_valid = False
                        break
            else:
                steps_valid = False
            
            return {
                'valid': len(missing_fields) == 0 and steps_valid,
                'missing_fields': missing_fields,
                'steps_valid': steps_valid,
                'data': data if len(missing_fields) == 0 and steps_valid else None
            }
        except json.JSONDecodeError as e:
            return {
                'valid': False,
                'error': f'JSON解析错误: {str(e)}',
                'data': None
            }
    
    @staticmethod
    def validate_visualization_output(output: str) -> Dict[str, Any]:
        """验证可视化Agent输出"""
        # 检查基本Python代码结构
        has_import = 'from manim import' in output or 'import manim' in output
        has_class = 'class' in output and 'Scene' in output
        has_construct = 'def construct' in output
        
        # 检查中文支持
        has_chinese_font = 'Noto Sans CJK SC' in output
        
        # 尝试编译检查语法
        syntax_valid = True
        try:
            # 提取代码块
            if "```python" in output:
                code = output.split("```python", 1)[1].split("```", 1)[0].strip()
            else:
                code = output
            
            compile(code, "<string>", "exec")
        except SyntaxError:
            syntax_valid = False
        
        return {
            'valid': has_import and has_class and has_construct and syntax_valid,
            'has_import': has_import,
            'has_class': has_class,
            'has_construct': has_construct,
            'has_chinese_font': has_chinese_font,
            'syntax_valid': syntax_valid
        }

# ============================
# 错误模式分析器
# ============================

class ErrorPatternAnalyzer:
    """分析常见错误模式并提供解决方案"""
    
    COMMON_PATTERNS = {
        'json_parse_error': {
            'keywords': ['json', 'parse', 'decode', '解析'],
            'solutions': [
                '检查JSON格式是否正确',
                '确保所有字符串都用引号包围',
                '检查逗号和花括号的匹配',
                '移除多余的反斜杠或特殊字符'
            ]
        },
        'manim_import_error': {
            'keywords': ['manim', 'import', 'module'],
            'solutions': [
                '确保Manim已正确安装',
                '使用正确的导入语句：from manim import *',
                '检查Manim版本兼容性',
                '验证Python环境配置'
            ]
        },
        'font_error': {
            'keywords': ['font', 'Noto', 'Sans', 'CJK', '字体'],
            'solutions': [
                '安装Noto Sans CJK SC字体',
                '使用系统默认字体作为备选',
                '检查字体路径配置',
                '在Text对象中正确指定font参数'
            ]
        },
        'layout_error': {
            'keywords': ['overlap', 'position', 'layout', '重叠', '布局'],
            'solutions': [
                '使用VGroup组织相关元素',
                '采用相对定位方法（.next_to(), .to_edge()）',
                '调整元素大小（.scale()）',
                '增加元素间的缓冲距离（buff参数）'
            ]
        }
    }
    
    @classmethod
    def analyze_error(cls, error_message: str) -> Dict[str, Any]:
        """分析错误信息并提供解决方案
        
        Args:
            error_message: 错误信息
            
        Returns:
            分析结果和解决方案
        """
        error_lower = error_message.lower()
        matched_patterns = []
        
        for pattern_name, pattern_info in cls.COMMON_PATTERNS.items():
            for keyword in pattern_info['keywords']:
                if keyword in error_lower:
                    matched_patterns.append({
                        'pattern': pattern_name,
                        'solutions': pattern_info['solutions']
                    })
                    break
        
        return {
            'matched_patterns': matched_patterns,
            'has_solutions': len(matched_patterns) > 0
        }

# ============================
# 性能监控器
# ============================

class PerformanceMonitor:
    """监控Agent性能和提示词效果"""
    
    def __init__(self):
        self.metrics = {
            'understanding_success_rate': [],
            'solving_success_rate': [],
            'visualization_success_rate': [],
            'debugging_attempts': [],
            'total_processing_time': []
        }
    
    def record_understanding_result(self, success: bool, processing_time: float):
        """记录理解Agent结果"""
        self.metrics['understanding_success_rate'].append(1 if success else 0)
    
    def record_solving_result(self, success: bool, processing_time: float):
        """记录解题Agent结果"""
        self.metrics['solving_success_rate'].append(1 if success else 0)
    
    def record_visualization_result(self, success: bool, processing_time: float):
        """记录可视化Agent结果"""
        self.metrics['visualization_success_rate'].append(1 if success else 0)
    
    def record_debugging_attempts(self, attempts: int):
        """记录调试尝试次数"""
        self.metrics['debugging_attempts'].append(attempts)
    
    def get_performance_report(self) -> Dict[str, Any]:
        """获取性能报告"""
        report = {}
        
        for metric, values in self.metrics.items():
            if values:
                if 'rate' in metric:
                    report[metric] = sum(values) / len(values)
                else:
                    report[metric + '_avg'] = sum(values) / len(values)
                    report[metric + '_max'] = max(values)
        
        return report

# ============================
# 使用示例和最佳实践
# ============================

BEST_PRACTICES = """
## Prompt优化最佳实践指南

### 1. 结构化设计原则
- 使用清晰的层次结构组织prompt内容
- 分离角色定义、任务描述、技术要求和输出格式
- 使用一致的命名约定和格式标准

### 2. 内容优化策略
- 优先级明确：将最重要的要求放在前面
- 避免冗余：删除重复或不必要的说明
- 具体化指导：提供具体的示例和反例

### 3. 适应性设计
- 根据题目难度动态调整prompt复杂度
- 考虑不同学习风格的学生需求
- 提供多种解题路径的选择

### 4. 质量保证机制
- 实施输出格式验证
- 建立错误模式识别
- 设置性能监控指标

### 5. 持续优化
- 定期分析Agent表现数据
- 收集用户反馈并调整
- 测试新的prompt变体

### 6. 错误处理策略
- 设计robust的错误恢复机制
- 提供清晰的错误信息
- 实现graceful degradation
"""

# 使用示例
if __name__ == "__main__":
    # 示例：难度自适应
    problem = "小明有25个糖果，他给了小红8个，又给了小刚5个，然后小明的妈妈又给了他10个糖果。请问小明现在有多少个糖果？"
    difficulty = DifficultyAdapter.analyze_difficulty(problem)
    print(f"题目难度: {difficulty}")
    
    # 示例：输出验证
    sample_output = '{"题目类型": "应用题", "核心知识点": ["加减法"], "关键信息": {"已知条件": ["小明有25个糖果"]}, "难点分析": "多步计算", "推荐策略": "按顺序计算"}'
    validation = OutputValidator.validate_understanding_output(sample_output)
    print(f"输出验证: {validation}") 