"""
配置文件，包含系统设置和环境变量
"""
import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

# Xinference设置
# XINFERENCE_API_BASE = os.getenv("XINFERENCE_API_BASE", "http://localhost:9997/v1")  # Xinference API基础URL
# XINFERENCE_API_KEY = os.getenv("XINFERENCE_API_KEY", "sk-453593f571ee4d618693343431dba9f3")  # 如果需要的话
# MODEL_NAME = os.getenv("MODEL_NAME", "QwQ-32B")  # 使用的模型名称

XINFERENCE_API_BASE = os.getenv("XINFERENCE_API_BASE", "https://api.deepseek.com/v1")  # Xinference API基础URL
XINFERENCE_API_KEY = os.getenv("XINFERENCE_API_KEY", "sk-453593f571ee4d618693343431dba9f3")  # 如果需要的话
MODEL_NAME = os.getenv("MODEL_NAME", "deepseek-chat")  # 使用的模型名称

# Manim设置
MANIM_OUTPUT_DIR = os.getenv("MANIM_OUTPUT_DIR", "./media")  # Manim输出目录
MANIM_QUALITY = os.getenv("MANIM_QUALITY", "medium_quality")  # 视频质量（low_quality, medium_quality, high_quality）

# Agent设置
TEMPERATURE = float(os.getenv("TEMPERATURE", "0.6"))  # 模型温度
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "8192"))  # 生成的最大token数

# Streamlit设置
PAGE_TITLE = "小学数学辅导工具"
PAGE_ICON = "🧮"