"""
大学课程讲解系统测试脚本
用于测试各个模块的功能
"""
import asyncio
import logging
from pathlib import Path

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


async def test_pdf_parser():
    """测试PDF解析器"""
    logger.info("=" * 50)
    logger.info("测试 PDF Parser")
    logger.info("=" * 50)

    from agents.pdf_parser import PDFParserAgent

    parser = PDFParserAgent()

    # 创建一个示例测试（需要实际PDF文件）
    logger.info("PDF Parser 初始化成功")
    logger.info("提示：请将PDF文件放在 data/uploads/ 目录下进行测试")


async def test_ppt_parser():
    """测试PPT解析器"""
    logger.info("=" * 50)
    logger.info("测试 PPT Parser")
    logger.info("=" * 50)

    from agents.ppt_parser import PPTParserAgent

    parser = PPTParserAgent()
    logger.info("PPT Parser 初始化成功")
    logger.info("提示：请将PPT文件放在 data/uploads/ 目录下进行测试")


async def test_knowledge_extractor():
    """测试知识点提取"""
    logger.info("=" * 50)
    logger.info("测试 Knowledge Extractor")
    logger.info("=" * 50)

    from agents.knowledge_extractor import KnowledgeExtractorAgent
    from core.model_connector import ModelConnector

    # 创建模型
    model = ModelConnector.create_llm(provider="deepseek")

    # 创建Agent
    extractor = KnowledgeExtractorAgent(model)

    # 示例文本
    sample_text = """
    第3章 矩阵运算

    3.1 矩阵乘法
    设A是m×n矩阵，B是n×p矩阵，则矩阵乘法C=AB定义为：
    C的第i行第j列的元素 c_ij = Σ(k=1 to n) a_ik * b_kj

    重要性质：
    1. 矩阵乘法不满足交换律：一般AB ≠ BA
    2. 矩阵乘法满足结合律：(AB)C = A(BC)
    3. 分配律：A(B+C) = AB + AC

    例题：计算以下矩阵乘积...
    """

    metadata = {
        "title": "第3章 矩阵运算",
        "subject": "线性代数"
    }

    logger.info("正在提取知识点...")
    try:
        knowledge_data = await extractor.extract_knowledge(sample_text, metadata)

        logger.info(f"提取成功！")
        logger.info(f"章节: {knowledge_data.get('chapter_title', 'N/A')}")
        logger.info(f"学科: {knowledge_data.get('subject', 'N/A')}")
        logger.info(f"知识点数量: {len(knowledge_data.get('knowledge_points', []))}")

        # 显示第一个知识点
        kps = knowledge_data.get('knowledge_points', [])
        if kps:
            logger.info(f"\n第一个知识点示例:")
            logger.info(f"  ID: {kps[0].get('id', 'N/A')}")
            logger.info(f"  标题: {kps[0].get('title', 'N/A')}")
            logger.info(f"  类型: {kps[0].get('type', 'N/A')}")
            logger.info(f"  重要性: {kps[0].get('importance', 'N/A')}")

    except Exception as e:
        logger.error(f"测试失败: {str(e)}")


async def test_script_writer():
    """测试脚本生成"""
    logger.info("=" * 50)
    logger.info("测试 Script Writer")
    logger.info("=" * 50)

    from agents.script_writer import ScriptWriterAgent
    from core.model_connector import ModelConnector

    model = ModelConnector.create_llm(provider="deepseek")
    writer = ScriptWriterAgent(model)

    # 简单的知识点数据
    knowledge_data = {
        "chapter_title": "矩阵乘法",
        "subject": "线性代数",
        "knowledge_points": [
            {
                "id": "kp_001",
                "type": "definition",
                "title": "矩阵乘法定义",
                "content": "C=AB，其中c_ij = Σ a_ik * b_kj",
                "importance": "high"
            },
            {
                "id": "kp_002",
                "type": "property",
                "title": "不满足交换律",
                "content": "一般AB ≠ BA",
                "importance": "high"
            }
        ]
    }

    logger.info("正在生成脚本...")
    try:
        script_data = await writer.generate_script(knowledge_data, style="bilibili")

        logger.info(f"脚本生成成功！")
        logger.info(f"标题: {script_data.get('title', 'N/A')}")
        logger.info(f"总时长: {script_data.get('total_duration', 0)}秒")
        logger.info(f"片段数量: {len(script_data.get('segments', []))}")

    except Exception as e:
        logger.error(f"测试失败: {str(e)}")


async def test_knowledge_graph():
    """测试知识图谱"""
    logger.info("=" * 50)
    logger.info("测试 Knowledge Graph")
    logger.info("=" * 50)

    from utils.knowledge_graph import KnowledgeGraphVisualizer

    visualizer = KnowledgeGraphVisualizer()

    # 示例知识点
    knowledge_points = [
        {
            "id": "kp_001",
            "title": "矩阵基础",
            "type": "definition",
            "importance": "high",
            "prerequisites": []
        },
        {
            "id": "kp_002",
            "title": "矩阵加法",
            "type": "definition",
            "importance": "medium",
            "prerequisites": ["kp_001"]
        },
        {
            "id": "kp_003",
            "title": "矩阵乘法",
            "type": "definition",
            "importance": "high",
            "prerequisites": ["kp_001"]
        },
        {
            "id": "kp_004",
            "title": "矩阵转置",
            "type": "property",
            "importance": "medium",
            "prerequisites": ["kp_001"]
        },
        {
            "id": "kp_005",
            "title": "逆矩阵",
            "type": "definition",
            "importance": "high",
            "prerequisites": ["kp_003"]
        }
    ]

    logger.info("构建知识图谱...")
    graph = visualizer.build_graph(knowledge_points)

    logger.info(f"节点数: {graph.number_of_nodes()}")
    logger.info(f"边数: {graph.number_of_edges()}")

    # 分析图
    analysis = visualizer.analyze_graph()
    logger.info(f"分析结果:")
    logger.info(f"  是否为DAG: {analysis.get('is_dag', False)}")
    logger.info(f"  基础节点: {analysis.get('foundation_nodes', [])}")
    logger.info(f"  高级节点: {analysis.get('advanced_nodes', [])}")

    # 学习路径
    path = visualizer.get_learning_path()
    logger.info(f"推荐学习路径: {' -> '.join(path)}")


async def test_model_connector():
    """测试模型连接器"""
    logger.info("=" * 50)
    logger.info("测试 Model Connector")
    logger.info("=" * 50)

    from core.model_connector import ModelConnector

    # 测试不同provider
    providers = ["deepseek"]  # 只测试默认的

    for provider in providers:
        try:
            logger.info(f"测试 {provider}...")
            model = ModelConnector.create_llm(provider=provider)
            logger.info(f"  ✓ {provider} 初始化成功")
        except Exception as e:
            logger.warning(f"  ✗ {provider} 初始化失败: {str(e)}")


async def run_all_tests():
    """运行所有测试"""
    logger.info("\n" + "=" * 60)
    logger.info("开始测试大学课程讲解系统")
    logger.info("=" * 60 + "\n")

    # 基础组件测试
    await test_pdf_parser()
    await test_ppt_parser()
    await test_model_connector()
    await test_knowledge_graph()

    # LLM相关测试（需要API key）
    logger.info("\n" + "=" * 60)
    logger.info("LLM相关测试（需要有效的API key）")
    logger.info("=" * 60 + "\n")

    try:
        await test_knowledge_extractor()
        await test_script_writer()
    except Exception as e:
        logger.warning(f"LLM测试跳过: {str(e)}")
        logger.info("提示：请在 .env 文件中配置有效的API key")

    logger.info("\n" + "=" * 60)
    logger.info("测试完成！")
    logger.info("=" * 60 + "\n")

    logger.info("下一步：")
    logger.info("1. 将PDF/PPT文件放入 data/uploads/ 目录")
    logger.info("2. 运行: streamlit run app_university.py")
    logger.info("3. 在浏览器中访问: http://localhost:8501")


if __name__ == "__main__":
    # 确保数据目录存在
    Path("data/uploads").mkdir(parents=True, exist_ok=True)
    Path("data/processed").mkdir(parents=True, exist_ok=True)
    Path("data/temp").mkdir(parents=True, exist_ok=True)

    # 运行测试
    asyncio.run(run_all_tests())
