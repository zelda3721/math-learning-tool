"""
结果解析工具，用于处理和展示结果
"""
import json
import logging
from typing import Dict, Any, List, Optional

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def format_analysis_result(analysis_result: Dict[str, Any]) -> str:
    """
    格式化分析结果为易读的文本
    
    Args:
        analysis_result: 理解Agent的分析结果
        
    Returns:
        格式化后的文本
    """
    try:
        # 提取各个部分
        problem_type = analysis_result.get("题目类型", "未知类型")
        concepts = analysis_result.get("数学概念", [])
        key_data = analysis_result.get("关键数据", {})
        difficulty = analysis_result.get("难点", "未提供")
        strategy = analysis_result.get("策略", "未提供")
        
        # 格式化关键数据
        data_text = "\n".join([f"- {k}: {v}" for k, v in key_data.items()])
        
        # 格式化数学概念
        concepts_text = ", ".join(concepts)
        
        # 组合成完整文本
        formatted_text = f"""## 题目分析

**题目类型:** {problem_type}

**涉及的数学概念:** {concepts_text}

**关键数据:**
{data_text}

**难点:** {difficulty}

**推荐解题策略:** {strategy}
"""
        
        return formatted_text
    
    except Exception as e:
        logger.error(f"格式化分析结果时出错: {e}")
        return "分析结果格式化失败"

def format_solution_result(solution_result: Dict[str, Any]) -> str:
    """
    格式化解题结果为易读的文本
    
    Args:
        solution_result: 解题Agent的解题结果
        
    Returns:
        格式化后的文本
    """
    try:
        # 提取各个部分
        thinking = solution_result.get("解题思路", "未提供解题思路")
        steps = solution_result.get("解题步骤", [])
        answer = solution_result.get("答案", "未提供答案")
        key_points = solution_result.get("解题要点", [])
        
        # 格式化解题步骤
        steps_text = ""
        for i, step in enumerate(steps, 1):
            step_name = step.get("步骤", f"步骤{i}")
            explanation = step.get("说明", "未提供说明")
            calculation = step.get("计算", "未提供计算过程")
            
            steps_text += f"### 步骤{i}: {step_name}\n\n"
            steps_text += f"{explanation}\n\n"
            steps_text += f"**计算过程:**\n```\n{calculation}\n```\n\n"
        
        # 格式化解题要点
        key_points_text = "\n".join([f"- {point}" for point in key_points])
        
        # 组合成完整文本
        formatted_text = f"""## 解题过程

**解题思路:**
{thinking}

## 详细步骤

{steps_text}

## 答案
{answer}

## 解题要点
{key_points_text}
"""
        
        return formatted_text
    
    except Exception as e:
        logger.error(f"格式化解题结果时出错: {e}")
        return "解题结果格式化失败"

def extract_main_visualization_class(code: str) -> Optional[str]:
    """
    从Manim代码中提取主要的可视化类名
    
    Args:
        code: Manim代码
        
    Returns:
        主要的Scene类名，如果找不到则返回None
    """
    import re
    
    # 查找继承自Scene的类
    pattern = r"class\s+(\w+)\s*\(\s*Scene\s*\)"
    matches = re.findall(pattern, code)
    
    if matches:
        # 如果有多个Scene类，优先选择包含与数学、可视化相关的类名
        preferred_names = [
            name for name in matches if any(keyword in name.lower() for keyword in 
                                          ["math", "visual", "animation", "problem", "solution", "calc"])
        ]
        
        # 如果有优选名称，返回第一个
        if preferred_names:
            return preferred_names[0]
        
        # 否则返回第一个匹配的类名
        return matches[0]
    
    # 如果没有找到Scene类，尝试查找其他可能的类
    alternative_pattern = r"class\s+(\w+)\s*\(\s*\w+\s*\)"
    alt_matches = re.findall(alternative_pattern, code)
    
    if alt_matches:
        # 检查是否有任何类名暗示这是一个可视化类
        for name in alt_matches:
            if any(keyword in name.lower() for keyword in 
                  ["scene", "visual", "anim", "math", "display"]):
                return name
        
        # 否则返回第一个类名
        return alt_matches[0]
    
    return None