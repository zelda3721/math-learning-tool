"""
配置文件，包含系统设置和环境变量
"""
import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

XINFERENCE_API_BASE = os.getenv("XINFERENCE_API_BASE", "https://api.deepseek.com/v1")  # Xinference API基础URL
XINFERENCE_API_KEY = os.getenv("XINFERENCE_API_KEY", "your_actual_api_key")  # 如果需要的话
MODEL_NAME = os.getenv("MODEL_NAME", "deepseek-chat")  # 使用的模型名称

# Manim设置
MANIM_OUTPUT_DIR = os.getenv("MANIM_OUTPUT_DIR", "./media")  # Manim输出目录
MANIM_QUALITY = os.getenv("MANIM_QUALITY", "low_quality")  # 视频质量（low_quality, medium_quality, high_quality）
# low_quality: 480p15, 速度快，适合预览
# medium_quality: 720p30, 平衡质量和速度
# high_quality: 1080p60, 高质量但慢

# Agent设置
TEMPERATURE = float(os.getenv("TEMPERATURE", "0.6"))  # 模型温度
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "8192"))  # 生成的最大token数

# 性能优化设置
ENABLE_REVIEW_AGENT = os.getenv("ENABLE_REVIEW_AGENT", "false").lower() == "true"  # 是否启用审查Agent（耗时但质量更好）
ENABLE_UNDERSTANDING_AGENT = os.getenv("ENABLE_UNDERSTANDING_AGENT", "true").lower() == "true"  # 是否启用理解Agent（可跳过加速）
MAX_DEBUG_ATTEMPTS = int(os.getenv("MAX_DEBUG_ATTEMPTS", "2"))  # 最大调试次数（减少可提速）

# Streamlit设置
PAGE_TITLE = "小学数学辅导工具"
PAGE_ICON = "🧮"

# API Provider设置（新增 - 用于大学版）
API_PROVIDER = os.getenv("API_PROVIDER", "deepseek")  # deepseek/openai/anthropic/xinference/custom

# Anthropic Skills设置（可选）
ENABLE_ANTHROPIC_SKILLS = os.getenv("ENABLE_ANTHROPIC_SKILLS", "false").lower() == "true"

# 大学版特有设置
UNIVERSITY_MODE = os.getenv("UNIVERSITY_MODE", "false").lower() == "true"
SUPPORTED_SUBJECTS = ["数学", "经济学", "计算机科学"]
DEFAULT_VIDEO_DURATION = int(os.getenv("DEFAULT_VIDEO_DURATION", "900"))  # 15分钟

# 知识图谱设置
ENABLE_KNOWLEDGE_GRAPH = os.getenv("ENABLE_KNOWLEDGE_GRAPH", "true").lower() == "true"
