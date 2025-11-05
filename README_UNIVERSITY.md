# 🎓 大学课程讲解视频生成系统

面向中国留学生的智能教学视频生成工具，支持上传PPT/PDF教材章节，自动生成专业讲解视频。

## ✨ 核心功能

### 📚 文档处理
- **PDF教材解析**：自动提取文本、公式、图表、结构信息
- **PPT课件解析**：支持PPT/PPTX，提取幻灯片内容和布局
- **章节识别**：智能识别章节标题和内容分段

### 🧠 知识提取
- **结构化知识点**：自动提取定义、定理、公式、推导、性质等
- **难度评估**：智能判断知识点的重要性和学习难度
- **依赖分析**：构建知识点之间的依赖关系图
- **学习路径**：自动生成推荐的学习顺序

### 📜 脚本生成
- **B站风格讲解**：参考优质讲解视频（3Blue1Brown、李永乐老师）
- **分段讲解**：Introduction、概念讲解、例题演示、总结
- **时长控制**：自动估算并优化视频时长
- **可视化指令**：为每个片段生成详细的可视化建议

### 🎥 视频生成
- **Manim动画**：使用Manim Community Edition生成专业数学动画
- **自动调试**：智能修复代码错误，最多3次重试
- **质量可控**：支持快速/平衡/高质量三种模式
- **中文支持**：完整的中文字体和排版支持

### 📊 高级功能
- **知识图谱可视化**：交互式知识点依赖关系图
- **批量处理**：一次处理多个章节
- **Anthropic Skills**：可选的Claude API增强（需要API key）
- **多API支持**：DeepSeek、OpenAI、Anthropic等

## 🏗️ 系统架构

```
大学课程讲解视频生成系统
├── 文档处理层 (Document Processing)
│   ├── PDF Parser Agent        # 解析教材PDF
│   ├── PPT Parser Agent         # 解析课件PPT
│   └── Content Extractor        # 提取文本、公式、图表
│
├── 知识理解层 (Knowledge Understanding)
│   ├── Knowledge Extractor      # 知识点提取
│   ├── Difficulty Assessor      # 难度评估
│   └── Dependency Mapper        # 依赖关系分析
│
├── 教学设计层 (Instructional Design)
│   ├── Script Writer Agent      # 讲解脚本生成
│   └── Visualization Planner    # 可视化方案设计
│
├── 视频生成层 (Video Generation)
│   ├── Visualization Agent      # Manim代码生成
│   ├── Review Agent             # 代码审核
│   ├── Debugging Agent          # 错误修复
│   └── Manim Executor           # 视频渲染
│
└── Skills集成层 (Optional)
    ├── Document Understanding   # 长文档分析
    ├── Mathematical Reasoning   # 数学推理
    ├── Code Generation          # 代码生成
    └── Quality Assurance        # 质量审核
```

## 🚀 快速开始

### 1. 安装依赖

```bash
# 安装Python依赖
pip install -r requirements.txt

# 安装Manim (如果未安装)
pip install manim

# 安装中文字体支持
# Ubuntu/Debian:
sudo apt-get install fonts-noto-cjk

# macOS:
# 字体已内置，无需额外安装

# Windows:
# 下载并安装 Noto Sans CJK SC 字体
```

### 2. 配置环境变量

创建 `.env` 文件：

```bash
# API配置
API_PROVIDER=deepseek                        # 选择API提供商
XINFERENCE_API_BASE=https://api.deepseek.com/v1
XINFERENCE_API_KEY=your_deepseek_api_key_here

# 可选：Anthropic Skills（高级功能）
ENABLE_ANTHROPIC_SKILLS=false
ANTHROPIC_API_KEY=your_anthropic_key_here

# 性能配置
ENABLE_REVIEW_AGENT=true                    # 启用代码审核
MAX_DEBUG_ATTEMPTS=2                        # 最大调试次数
MANIM_QUALITY=low_quality                   # 视频质量

# 模型配置
MODEL_NAME=deepseek-chat
TEMPERATURE=0.6
MAX_TOKENS=8192
```

### 3. 启动应用

```bash
# 启动大学版界面
streamlit run app_university.py

# 或启动小学版界面（原版）
streamlit run app.py
```

访问 http://localhost:8501

## 📖 使用教程

### 上传文档
1. 在"文档上传"标签页，选择PDF或PPT文件
2. 可选：指定章节标题或页面范围
3. 点击"开始处理"

### 查看知识点
1. 切换到"知识点分析"标签页
2. 查看提取的知识点列表
3. 使用筛选器按类型或重要性筛选
4. 查看知识结构和学习路径

### 预览脚本
1. 切换到"讲解脚本"标签页
2. 查看分段讲解内容
3. 可导出为Markdown格式编辑

### 生成视频
1. 切换到"生成视频"标签页
2. 预览或下载生成的视频
3. 查看Manim代码和性能统计

## ⚙️ 性能模式

### 快速模式 (15-30秒)
- 跳过代码审核
- 1次调试尝试
- 低质量视频 (480p)
- 适合快速预览

### 平衡模式 (40-60秒) ⭐推荐
- 启用代码审核
- 2次调试尝试
- 低质量视频
- 质量和速度平衡

### 高质量模式 (60-120秒)
- 完整代码审核
- 3次调试尝试
- 中等质量视频 (720p)
- 最佳输出质量

## 🔌 API切换

### 使用DeepSeek（默认）
```bash
API_PROVIDER=deepseek
XINFERENCE_API_BASE=https://api.deepseek.com/v1
XINFERENCE_API_KEY=your_deepseek_key
```

### 使用OpenAI
```bash
API_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
```

### 使用Anthropic
```bash
API_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_key
```

### 使用自定义API
```bash
API_PROVIDER=custom
CUSTOM_API_BASE=http://your-api-server/v1
CUSTOM_API_KEY=your_key
CUSTOM_MODEL_NAME=your_model
```

## 🎨 支持的学科

### 数学
- 微积分
- 线性代数
- 概率论与数理统计
- 离散数学
- 实分析、抽象代数等

### 经济学
- 微观经济学
- 宏观经济学
- 计量经济学
- 博弈论

### 计算机科学
- 数据结构与算法
- 操作系统
- 计算机网络
- 数据库系统

## 🛠️ 高级功能

### Anthropic Skills集成
启用后可使用Claude的高级功能：
- 长文档理解（200K tokens）
- 数学推理增强
- 高质量代码生成
- 内容质量审核

```python
# 在代码中使用
from utils.anthropic_skills import get_skills_manager

skills = get_skills_manager()
if skills.is_enabled():
    result = await skills.document_understanding_skill(content)
```

### 知识图谱可视化
```python
from utils.knowledge_graph import KnowledgeGraphVisualizer

visualizer = KnowledgeGraphVisualizer()
visualizer.build_graph(knowledge_points)

# 生成交互式图
fig = visualizer.visualize_plotly()

# 获取学习路径
path = visualizer.get_learning_path()
```

### 批量处理
```python
from core.university_engine import UniversityLectureEngine

engine = UniversityLectureEngine()
results = engine.batch_process([
    "chapter1.pdf",
    "chapter2.pdf",
    "chapter3.pdf"
])
```

## 📁 项目结构

```
math-learning-tool/
├── agents/                     # 智能Agents
│   ├── base.py                 # 基础Agent类
│   ├── pdf_parser.py           # PDF解析
│   ├── ppt_parser.py           # PPT解析
│   ├── knowledge_extractor.py  # 知识提取
│   ├── script_writer.py        # 脚本生成
│   ├── visualization.py        # Manim代码生成
│   ├── review.py               # 代码审核
│   └── debugging.py            # 错误修复
│
├── core/                       # 核心引擎
│   ├── university_engine.py    # 大学课程引擎
│   ├── engine.py               # 小学版引擎
│   ├── model_connector.py      # 多API连接器
│   └── manim_executor.py       # Manim执行器
│
├── utils/                      # 工具模块
│   ├── prompts.py              # Prompt模板
│   ├── anthropic_skills.py     # Skills集成
│   ├── knowledge_graph.py      # 知识图谱
│   └── parser.py               # 解析工具
│
├── data/                       # 数据目录
│   ├── uploads/                # 上传文件
│   ├── processed/              # 处理结果
│   └── temp/                   # 临时文件
│
├── app_university.py           # 大学版UI
├── app.py                      # 小学版UI
├── config.py                   # 配置文件
├── requirements.txt            # 依赖列表
└── README_UNIVERSITY.md        # 本文档
```

## 🐛 故障排除

### 视频生成失败
1. 检查Manim是否正确安装：`manim --version`
2. 检查中文字体是否安装
3. 查看错误日志，手动运行Manim代码测试

### API连接错误
1. 确认API key配置正确
2. 检查网络连接
3. 验证API余额

### 内存不足
1. 减少页面范围
2. 使用快速模式
3. 调整MAX_TOKENS参数

## 📊 性能优化建议

1. **文档大小**：单次处理不超过50页
2. **页面范围**：指定具体章节而非全书
3. **性能模式**：日常使用选择平衡模式
4. **API选择**：DeepSeek性价比最高

## 🤝 贡献指南

欢迎提交Issue和Pull Request！

## 📄 许可证

MIT License

## 🙏 致谢

- [Manim Community](https://www.manim.community/) - 数学动画引擎
- [3Blue1Brown](https://www.3blue1brown.com/) - 视觉化灵感
- [LangChain](https://www.langchain.com/) - AI应用框架
- [Streamlit](https://streamlit.io/) - Web界面框架

## 📧 联系方式

如有问题或建议，请提交GitHub Issue。

---

**Powered by DeepSeek & Manim** 🚀
