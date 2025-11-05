"""
模型连接器，支持多种LLM API
支持: DeepSeek, OpenAI, Anthropic (通过OpenAI兼容接口), 本地Xinference等
"""
import logging
from typing import Dict, Any, List, Optional, Union
from langchain_openai import ChatOpenAI
from langchain.callbacks.manager import CallbackManager
from langchain.callbacks.streaming_stdout import StreamingStdOutCallbackHandler
import config
import os

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class ModelConnector:
    """
    统一的模型连接器
    支持多种API provider的切换
    """

    SUPPORTED_PROVIDERS = {
        "deepseek": {
            "base_url": "https://api.deepseek.com/v1",
            "default_model": "deepseek-chat",
            "env_key": "DEEPSEEK_API_KEY"
        },
        "openai": {
            "base_url": "https://api.openai.com/v1",
            "default_model": "gpt-4",
            "env_key": "OPENAI_API_KEY"
        },
        "anthropic": {
            # Anthropic通过OpenAI兼容接口（如果有代理）
            "base_url": None,  # 使用原生Anthropic SDK
            "default_model": "claude-3-5-sonnet-20241022",
            "env_key": "ANTHROPIC_API_KEY"
        },
        "xinference": {
            "base_url": None,  # 从config读取
            "default_model": None,  # 从config读取
            "env_key": None
        },
        "custom": {
            "base_url": None,  # 从环境变量读取
            "default_model": None,
            "env_key": "CUSTOM_API_KEY"
        }
    }

    @staticmethod
    def create_llm(
        provider: Optional[str] = None,
        streaming: bool = False,
        temperature: float = None,
        max_tokens: int = None,
        model_name: Optional[str] = None
    ) -> ChatOpenAI:
        """
        创建LLM模型实例

        Args:
            provider: API提供商 (deepseek/openai/anthropic/xinference/custom)
                     None时从config读取
            streaming: 是否启用流式输出
            temperature: 模型温度
            max_tokens: 生成的最大token数
            model_name: 模型名称，None时使用默认

        Returns:
            ChatOpenAI实例
        """
        # 使用config中的默认值
        if provider is None:
            provider = getattr(config, 'API_PROVIDER', 'xinference')

        if temperature is None:
            temperature = config.TEMPERATURE

        if max_tokens is None:
            max_tokens = config.MAX_TOKENS

        # 获取provider配置
        if provider not in ModelConnector.SUPPORTED_PROVIDERS:
            logger.warning(f"Unknown provider '{provider}', falling back to 'xinference'")
            provider = "xinference"

        provider_config = ModelConnector.SUPPORTED_PROVIDERS[provider]

        # 确定base_url和model
        if provider == "xinference":
            base_url = config.XINFERENCE_API_BASE
            model = model_name or config.MODEL_NAME
            api_key = getattr(config, 'XINFERENCE_API_KEY', None) or "dummy_key"
        elif provider == "custom":
            base_url = os.getenv("CUSTOM_API_BASE", config.XINFERENCE_API_BASE)
            model = model_name or os.getenv("CUSTOM_MODEL_NAME", config.MODEL_NAME)
            api_key = os.getenv(provider_config["env_key"], "dummy_key")
        else:
            base_url = provider_config["base_url"]
            model = model_name or provider_config["default_model"]
            api_key = os.getenv(provider_config["env_key"])

            if not api_key:
                logger.warning(f"API key for {provider} not found in environment variables")
                api_key = "dummy_key"

        # 回调管理器
        callback_manager = CallbackManager([StreamingStdOutCallbackHandler()]) if streaming else None

        logger.info(f"Creating LLM: provider={provider}, base_url={base_url}, model={model}")

        # 创建LLM实例
        llm = ChatOpenAI(
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            streaming=streaming,
            callback_manager=callback_manager,
            base_url=base_url,
            api_key=api_key
        )

        return llm


# 向后兼容的函数
def create_llm(
    streaming: bool = False,
    temperature: float = config.TEMPERATURE,
    max_tokens: int = config.MAX_TOKENS
) -> ChatOpenAI:
    """
    创建LLM模型实例（向后兼容接口）

    Args:
        streaming: 是否启用流式输出
        temperature: 模型温度
        max_tokens: 生成的最大token数

    Returns:
        ChatOpenAI实例
    """
    return ModelConnector.create_llm(
        streaming=streaming,
        temperature=temperature,
        max_tokens=max_tokens
    )