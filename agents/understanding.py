"""
题目理解Agent，负责分析题目并提取关键信息
"""
import json
import logging
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI

from agents.base import BaseAgent
from utils.prompts import UNDERSTANDING_AGENT_PROMPT

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class UnderstandingAgent(BaseAgent):
    """题目理解Agent类"""
    
    def __init__(self, model: ChatOpenAI):
        """
        初始化题目理解Agent
        
        Args:
            model: LLM模型实例
        """
        super().__init__(
            name="理解Agent",
            description="分析数学题目并提取关键信息",
            system_prompt=UNDERSTANDING_AGENT_PROMPT,
            model=model
        )
        logger.info("理解Agent初始化完成")
    
    async def analyze_problem(self, problem_text: str) -> Dict[str, Any]:
        """
        分析数学题目
        
        Args:
            problem_text: 题目文本
            
        Returns:
            分析结果，包含题目类型、数学概念、关键数据等
        """
        prompt = f"请分析以下数学题目：\n\n{problem_text}"
        
        response = await self.arun(prompt)
        logger.info(f"理解Agent分析完成: {response[:100]}...")
        
        try:
            # 尝试从响应中提取JSON
            # 首先检查是否有```json和```包裹的内容
            if "```json" in response and "```" in response.split("```json", 1)[1]:
                json_text = response.split("```json", 1)[1].split("```", 1)[0].strip()
            elif "```" in response and "```" in response.split("```", 1)[1]:
                json_text = response.split("```", 1)[1].split("```", 1)[0].strip()
            else:
                json_text = response.strip()
                
            analysis_result = json.loads(json_text)
            return analysis_result
        except json.JSONDecodeError as e:
            logger.error(f"JSON解析错误: {e}")
            logger.error(f"原始响应: {response}")
            # 返回一个基本结构，避免程序崩溃
            return {
                "题目类型": "解析失败",
                "数学概念": ["未能识别"],
                "关键数据": {"error": "JSON解析失败"},
                "难点": "无法确定",
                "策略": "请重试"
            }
        except Exception as e:
            logger.error(f"处理响应时出错: {e}")
            return {
                "题目类型": "处理失败",
                "数学概念": ["未能识别"],
                "关键数据": {"error": str(e)},
                "难点": "无法确定",
                "策略": "请重试"
            }