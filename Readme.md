# 小学数学辅导工具

一个基于大模型多Agent技术和Manim库的小学数学辅导工具，能够理解小学数学题目，并生成直观的数形结合可视化视频。

## 主要特点

- 🧠 **智能分析**：深度理解各类小学数学题目
- 📝 **详细解答**：提供清晰的分步解题过程
- 🎬 **可视化演示**：生成数形结合的动画视频，让抽象概念具体化
- 💻 **Web界面**：简洁易用的Streamlit交互界面

## 系统架构

系统由以下主要组件构成：

1. **用户界面**：Streamlit web应用
2. **多Agent协作系统**：
   - 理解Agent：分析题目，提取关键信息
   - 解题Agent：生成详细解题步骤
   - 可视化Agent：将解题步骤转换为Manim代码
   - 审查Agent：优化Manim代码的布局和场景切换
   - 调试Agent：修复Manim代码中的错误
3. **视频生成引擎**：执行Manim代码，生成可视化视频
4. **模型连接器**：通过OpenAI兼容接口连接大语言模型

## 技术栈

- **大模型**：DeepSeek Chat（通过API连接）
- **多Agent框架**：LangChain
- **可视化库**：Manim CE（社区版）
- **Web框架**：Streamlit
- **语言**：Python 3.10+

## 安装与设置

### 前提条件

- Python 3.10或更高版本
- 已配置的DeepSeek API密钥
- FFmpeg（Manim依赖）

### 安装步骤

1. 克隆仓库：

```bash
git clone https://github.com/yourusername/math-learning-tool.git
cd math-learning-tool
```

2. 创建并激活虚拟环境：

```bash
python -m venv venv
source venv/bin/activate  # 在Windows上使用: venv\Scripts\activate
```

3. 安装依赖：

```bash
pip install -r requirements.txt
```

4. 配置环境变量：

```bash
cp .env.example .env
```

编辑`.env`文件，设置DeepSeek API地址和其他配置。

### 启动应用

```bash
streamlit run app.py
```

访问 http://localhost:8501 打开应用界面。

## 使用方法

1. 在文本框中输入小学数学题目
2. 点击"开始分析"按钮
3. 等待系统处理（这可能需要一些时间）
4. 查看分析结果、解题过程和可视化视频

## 目录结构

```
math_learning_tool/
├── app.py                # Streamlit应用入口
├── requirements.txt      # 项目依赖
├── config.py             # 配置文件
├── agents/
│   ├── __init__.py
│   ├── base.py           # 基础Agent类
│   ├── understanding.py  # 题目理解Agent
│   ├── solving.py        # 解题Agent
│   ├── visualization.py  # 可视化Agent
│   ├── review.py         # 审查Agent
│   ├── debugging.py      # 调试Agent
├── core/
│   ├── __init__.py
│   ├── engine.py         # 核心处理引擎
│   ├── model_connector.py # 模型连接器
│   ├── manim_executor.py # Manim执行器
├── utils/
│   ├── __init__.py
│   ├── prompts.py        # 提示词模板
│   ├── parser.py         # 结果解析工具
├── media/                # 生成的视频和图像
│   ├── images/
│   ├── videos/
│   └── texts/
```

## 工作流程

1. **题目理解**：理解Agent分析题目，提取关键信息和数学概念
2. **解题过程**：解题Agent生成详细的分步解题过程
3. **可视化生成**：可视化Agent创建Manim代码
4. **代码审查**：审查Agent优化布局和场景切换
5. **视频生成**：执行Manim代码生成视频，如有错误则由调试Agent修复
6. **结果展示**：在Web界面上展示分析结果、解题过程和可视化视频

## 扩展与定制

- 修改`utils/prompts.py`中的提示词可以调整各Agent的行为
- 在`config.py`中调整模型参数和Manim设置
- 添加新的Agent可以扩展系统功能

## 本系统暂时只是一个简单的原型，可能存在一些问题，尤其是视频生成质量，欢迎反馈和贡献。

## 许可证

本项目采用MIT许可证。详情请参阅[LICENSE](LICENSE)文件。

## 致谢

- 本项目使用了[LangChain](https://github.com/langchain-ai/langchain)
- 可视化基于[Manim社区版](https://github.com/ManimCommunity/manim)
- 大模型通过[DeepSeek API](https://api.deepseek.com)
- 本地大模型通过[Xinference](https://github.com/xorbitsai/inference)

        
