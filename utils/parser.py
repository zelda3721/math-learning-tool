"""
解析器工具，用于格式化Agent的输出结果
"""
import json
import logging
from typing import Dict, Any, List, Optional

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def format_analysis_result(analysis_result: Dict[str, Any]) -> str:
    """
    格式化题目分析结果
    
    Args:
        analysis_result: 题目分析结果
        
    Returns:
        格式化后的Markdown字符串
    """
    # 适配新的prompt输出格式
    problem_type = analysis_result.get("题目类型", "未提供")
    concepts = analysis_result.get("核心知识点", [])
    key_info = analysis_result.get("关键信息", {})
    difficulty = analysis_result.get("难点分析", "未提供")
    strategy = analysis_result.get("推荐策略", "未提供")
    
    # 从key_info中提取更详细的数据
    known_conditions = key_info.get("已知条件", ["未提供"])
    question_to_solve = key_info.get("待求问题", "未提供")
    important_values = key_info.get("重要数值", {})
    
    formatted_string = f"### 题目分析\n\n"
    formatted_string += f"**题目类型:** {problem_type}\n\n"
    formatted_string += f"**涉及的数学概念:**\n"
    if concepts:
        for concept in concepts:
            formatted_string += f"- {concept}\n"
    else:
        formatted_string += "- 未提供\n"
    formatted_string += "\n"
    
    formatted_string += f"**关键信息:**\n"
    formatted_string += f"- **问题:** {question_to_solve}\n"
    formatted_string += f"- **已知:**\n"
    for condition in known_conditions:
        formatted_string += f"  - {condition}\n"
    if important_values:
        formatted_string += f"- **数据:**\n"
        for name, value in important_values.items():
            formatted_string += f"  - {name}: {value}\n"
    formatted_string += "\n"
    
    formatted_string += f"**难点:** {difficulty}\n\n"
    formatted_string += f"**推荐解题策略:** {strategy}\n"
    
    return formatted_string

def format_solution_result(solution_result: Dict[str, Any]) -> str:
    """
    格式化解题过程结果
    
    Args:
        solution_result: 解题过程结果
        
    Returns:
        格式化后的Markdown字符串
    """
    # 适配新的prompt输出格式
    strategy = solution_result.get("解题策略", "未提供解题思路")
    steps = solution_result.get("详细步骤", [])
    answer = solution_result.get("最终答案", "未提供答案")
    key_points = solution_result.get("关键技巧", [])
    
    formatted_string = f"### 解题过程\n\n"
    formatted_string += f"**解题思路:** {strategy}\n\n"
    
    formatted_string += f"#### 详细步骤\n"
    if steps:
        for i, step in enumerate(steps, 1):
            # 兼容新旧两种步骤key
            step_num = step.get("步骤编号", f"第{i}步")
            step_desc = step.get("步骤说明", "无")
            step_calc = step.get("具体操作", "无")
            step_reason = step.get("解释", "")
            
            formatted_string += f"**{step_num}: {step_desc}**\n"
            formatted_string += f"- **操作:** {step_calc}\n"
            if step_reason:
                formatted_string += f"- **原理:** {step_reason}\n"
            formatted_string += "\n"
    else:
        formatted_string += "未提供详细步骤\n\n"
        
    formatted_string += f"#### 答案\n"
    formatted_string += f"{answer}\n\n"
    
    formatted_string += f"#### 解题要点\n"
    if key_points:
        for point in key_points:
            formatted_string += f"- {point}\n"
    else:
        formatted_string += "未提供解题要点\n"
        
    return formatted_string

def extract_main_visualization_class(code: str) -> str:
    """
    从Manim代码中提取主可视化类名
    
    Args:
        code: Manim代码
        
    Returns:
        主可视化类名，如果找不到则返回 'MathVisualization'
    """
    import re
    # 查找所有继承自Scene的类
    matches = re.findall(r"class\s+(\w+)\(Scene\):", code)
    if matches:
        # 通常最后一个是主场景，或者可以根据其他逻辑判断
        return matches[-1]
    return "MathVisualization" # 默认类名