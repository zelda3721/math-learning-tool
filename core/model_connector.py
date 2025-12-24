"""
模型连接器，用于连接Xinference模型
"""
import logging
from typing import Dict, Any, List, Optional
from langchain_openai import ChatOpenAI
from langchain_core.callbacks import BaseCallbackManager
from langchain_core.callbacks.streaming_stdout import StreamingStdOutCallbackHandler
import config

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def create_llm(
    streaming: bool = False, 
    temperature: float = config.TEMPERATURE,
    max_tokens: int = config.MAX_TOKENS
) -> ChatOpenAI:
    """
    创建LLM模型实例
    
    Args:
        streaming: 是否启用流式输出
        temperature: 模型温度
        max_tokens: 生成的最大token数
        
    Returns:
        ChatOpenAI实例
    """
    callbacks = [StreamingStdOutCallbackHandler()] if streaming else None
    
    # 使用OpenAI兼容接口连接Xinference
    logger.info(f"Creating LLM with base_url: {config.XINFERENCE_API_BASE}, model: {config.MODEL_NAME}")
    
    llm = ChatOpenAI(
        model=config.MODEL_NAME,
        temperature=temperature,
        max_tokens=max_tokens,
        streaming=streaming,
        callbacks=callbacks,
        base_url=config.XINFERENCE_API_BASE,
        api_key=config.XINFERENCE_API_KEY or "dummy_key"  # xinference可能不需要API密钥
    )
    
    return llm