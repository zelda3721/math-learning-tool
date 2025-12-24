"""
解题Agent，负责解决数学问题并提供详细的解题步骤
"""
import json
import logging
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent
from skills.skill_loader import skill_loader

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class SolvingAgent(BaseAgent):
    """解题Agent类"""
    
    def __init__(self, model: ChatOpenAI):
        """
        初始化解题Agent
        
        Args:
            model: LLM模型实例
        """
        # 从skills系统获取提示词
        system_prompt = skill_loader.get_agent_prompt('solving')
        
        super().__init__(
            name="解题Agent",
            description="解决数学问题并提供详细的解题步骤",
            system_prompt=system_prompt,
            model=model
        )
        logger.info("解题Agent初始化完成")
    
    async def solve_problem(self, problem_text: str, analysis_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        解决数学问题
        
        Args:
            problem_text: 题目文本
            analysis_result: 理解Agent的分析结果
            
        Returns:
            解题结果，包含解题思路、解题步骤、答案等
        """
        # 构建提示词，包含题目和分析结果
        analysis_json = json.dumps(analysis_result, ensure_ascii=False, indent=2)
        prompt = f"""请解决以下数学题目：

题目：
{problem_text}

题目分析：
{analysis_json}

请基于以上信息，提供详细的解题过程和答案。"""
        
        response = await self.arun(prompt)
        logger.info(f"解题Agent解答完成: {response[:100]}...")
        
        try:
            # 尝试从响应中提取JSON
            if "```json" in response and "```" in response.split("```json", 1)[1]:
                json_text = response.split("```json", 1)[1].split("```", 1)[0].strip()
            elif "```" in response and "```" in response.split("```", 1)[1]:
                json_text = response.split("```", 1)[1].split("```", 1)[0].strip()
            else:
                json_text = response.strip()
                
            solution_result = json.loads(json_text)
            return solution_result
        except json.JSONDecodeError as e:
            logger.error(f"JSON解析错误: {e}")
            logger.error(f"原始响应: {response}")
            # 返回一个基本结构，避免程序崩溃
            return {
                "解题思路": "解析失败",
                "解题步骤": [{"步骤": "错误", "说明": "JSON解析失败", "计算": "无法解析"}],
                "答案": "未知",
                "解题要点": ["请重试"]
            }
        except Exception as e:
            logger.error(f"处理响应时出错: {e}")
            return {
                "解题思路": "处理失败",
                "解题步骤": [{"步骤": "错误", "说明": str(e), "计算": "处理出错"}],
                "答案": "未知",
                "解题要点": ["请重试"]
            }