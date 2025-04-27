"""
基础Agent类，所有其他Agent都继承自这个类
"""
import logging
from typing import Dict, Any, List, Optional
from langchain.schema import HumanMessage, SystemMessage, AIMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class BaseAgent(BaseModel):
    """基础Agent类"""
    name: str
    description: str
    system_prompt: str
    model: ChatOpenAI
    messages: List = Field(default_factory=list)
    
    class Config:
        arbitrary_types_allowed = True
    
    def __init__(self, name: str, description: str, system_prompt: str, model: ChatOpenAI):
        """
        初始化Agent
        
        Args:
            name: Agent名称
            description: Agent描述
            system_prompt: 系统提示词
            model: LLM模型实例
        """
        super().__init__(
            name=name,
            description=description,
            system_prompt=system_prompt,
            model=model,
            messages=[SystemMessage(content=system_prompt)]
        )
        logger.info(f"Agent {name} initialized with prompt: {system_prompt[:50]}...")
    
    def reset(self):
        """重置Agent对话历史"""
        self.messages.clear()
        self.messages.append(SystemMessage(content=self.system_prompt))
    
    async def arun(self, user_input: str, memory: Optional[List] = None) -> str:
        """
        异步执行Agent任务
        
        Args:
            user_input: 用户输入
            memory: 可选的消息历史记录
            
        Returns:
            Agent的响应
        """
        messages = self.messages.copy()
        if memory:
            messages.extend(memory)
        
        messages.append(HumanMessage(content=user_input))
        
        logger.info(f"Agent {self.name} processing input: {user_input[:50]}...")
        response = await self.model.ainvoke(messages)
        
        # 将消息添加到历史记录
        self.messages.append(HumanMessage(content=user_input))
        self.messages.append(AIMessage(content=response.content))
        
        logger.info(f"Agent {self.name} responded: {response.content[:50]}...")
        return response.content
    
    def run(self, user_input: str, memory: Optional[List] = None) -> str:
        """
        同步执行Agent任务
        
        Args:
            user_input: 用户输入
            memory: 可选的消息历史记录
            
        Returns:
            Agent的响应
        """
        messages = self.messages.copy()
        if memory:
            messages.extend(memory)
        
        messages.append(HumanMessage(content=user_input))
        
        logger.info(f"Agent {self.name} processing input: {user_input[:50]}...")
        response = self.model.invoke(messages)
        
        # 将消息添加到历史记录
        self.messages.append(HumanMessage(content=user_input))
        self.messages.append(AIMessage(content=response.content))
        
        logger.info(f"Agent {self.name} responded: {response.content[:50]}...")
        return response.content