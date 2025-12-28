"""
Base Agent - Foundation for all LLM agents in the system

Refactored from the original agents/base.py with Clean Architecture principles.
"""
import logging
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class BaseAgent(BaseModel):
    """
    Base agent class for LLM-based agents.
    
    All specialized agents (Understanding, Solving, Visualization, etc.)
    inherit from this class.
    """
    
    name: str
    description: str
    system_prompt: str
    model: ChatOpenAI
    messages: list[Any] = Field(default_factory=list)
    
    model_config = {"arbitrary_types_allowed": True}
    
    def __init__(
        self,
        name: str,
        description: str,
        system_prompt: str,
        model: ChatOpenAI,
    ):
        super().__init__(
            name=name,
            description=description,
            system_prompt=system_prompt,
            model=model,
            messages=[SystemMessage(content=system_prompt)],
        )
        logger.info(f"Agent '{name}' initialized")
    
    def reset(self) -> None:
        """Reset conversation history to initial state"""
        self.messages.clear()
        self.messages.append(SystemMessage(content=self.system_prompt))
    
    async def arun(self, user_input: str, memory: list[Any] | None = None) -> str:
        """
        Async execution of agent task.
        
        Args:
            user_input: The input to process
            memory: Optional additional message history
            
        Returns:
            Agent's response content
        """
        messages = self.messages.copy()
        if memory:
            messages.extend(memory)
        
        messages.append(HumanMessage(content=user_input))
        
        logger.debug(f"Agent '{self.name}' processing: {user_input[:80]}...")
        response = await self.model.ainvoke(messages)
        
        # Update history
        self.messages.append(HumanMessage(content=user_input))
        self.messages.append(AIMessage(content=response.content))
        
        logger.debug(f"Agent '{self.name}' responded: {response.content[:80]}...")
        return response.content
    
    def run(self, user_input: str, memory: list[Any] | None = None) -> str:
        """
        Sync execution of agent task.
        
        Args:
            user_input: The input to process
            memory: Optional additional message history
            
        Returns:
            Agent's response content
        """
        messages = self.messages.copy()
        if memory:
            messages.extend(memory)
        
        messages.append(HumanMessage(content=user_input))
        
        logger.debug(f"Agent '{self.name}' processing: {user_input[:80]}...")
        response = self.model.invoke(messages)
        
        # Update history
        self.messages.append(HumanMessage(content=user_input))
        self.messages.append(AIMessage(content=response.content))
        
        logger.debug(f"Agent '{self.name}' responded: {response.content[:80]}...")
        return response.content
