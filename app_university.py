"""
大学课程讲解视频生成系统 - Streamlit UI
面向留学生，支持上传PPT/PDF教材章节，生成讲解视频
"""
import streamlit as st
import asyncio
import json
import os
from pathlib import Path
from datetime import datetime
import logging

from core.university_engine import UniversityLectureEngine
import config

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 页面配置
st.set_page_config(
    page_title="大学课程讲解视频生成系统",
    page_icon="🎓",
    layout="wide",
    initial_sidebar_state="expanded"
)

# 自定义CSS
st.markdown("""
<style>
    .main-header {
        font-size: 2.5rem;
        font-weight: bold;
        color: #1f77b4;
        text-align: center;
        margin-bottom: 1rem;
    }
    .sub-header {
        font-size: 1.2rem;
        color: #666;
        text-align: center;
        margin-bottom: 2rem;
    }
    .metric-card {
        background-color: #f0f2f6;
        padding: 1rem;
        border-radius: 0.5rem;
        margin: 0.5rem 0;
    }
    .knowledge-point {
        background-color: #e8f4f8;
        padding: 1rem;
        border-left: 4px solid #1f77b4;
        margin: 0.5rem 0;
        border-radius: 0.3rem;
    }
    .stButton>button {
        width: 100%;
        background-color: #1f77b4;
        color: white;
        font-weight: bold;
    }
</style>
""", unsafe_allow_html=True)


def initialize_session_state():
    """初始化session state"""
    if 'engine' not in st.session_state:
        st.session_state.engine = None

    if 'processing_result' not in st.session_state:
        st.session_state.processing_result = None

    if 'uploaded_file_path' not in st.session_state:
        st.session_state.uploaded_file_path = None

    if 'knowledge_data' not in st.session_state:
        st.session_state.knowledge_data = None

    if 'script_data' not in st.session_state:
        st.session_state.script_data = None


def save_uploaded_file(uploaded_file):
    """保存上传的文件"""
    upload_dir = Path("data/uploads")
    upload_dir.mkdir(parents=True, exist_ok=True)

    file_path = upload_dir / uploaded_file.name
    with open(file_path, "wb") as f:
        f.write(uploaded_file.getbuffer())

    return str(file_path)


def render_sidebar():
    """渲染侧边栏配置"""
    st.sidebar.title("⚙️ 系统配置")

    # API配置
    st.sidebar.subheader("API设置")
    api_provider = st.sidebar.selectbox(
        "选择API提供商",
        ["deepseek", "openai", "anthropic", "xinference", "custom"],
        index=0,
        help="选择用于生成内容的AI模型提供商"
    )

    # 性能模式
    st.sidebar.subheader("性能模式")
    performance_mode = st.sidebar.radio(
        "选择模式",
        ["快速模式", "平衡模式", "高质量模式"],
        index=1,
        help="快速模式：跳过代码审核，1次调试\n平衡模式：启用审核，2次调试\n高质量模式：完整审核，3次调试"
    )

    # 根据模式设置参数
    if performance_mode == "快速模式":
        enable_review = False
        max_debug_attempts = 1
    elif performance_mode == "平衡模式":
        enable_review = True
        max_debug_attempts = 2
    else:  # 高质量模式
        enable_review = True
        max_debug_attempts = 3

    # 高级选项
    with st.sidebar.expander("高级选项"):
        st.checkbox("启用代码审核", value=enable_review, key="enable_review_override")
        st.number_input("最大调试次数", min_value=1, max_value=5, value=max_debug_attempts, key="max_debug_override")

    return {
        "api_provider": api_provider,
        "enable_review": st.session_state.get("enable_review_override", enable_review),
        "max_debug_attempts": st.session_state.get("max_debug_override", max_debug_attempts)
    }


def render_header():
    """渲染页面头部"""
    st.markdown('<div class="main-header">🎓 大学课程讲解视频生成系统</div>', unsafe_allow_html=True)
    st.markdown(
        '<div class="sub-header">上传教材章节，自动生成专业讲解视频 | 支持数学、经济学、计算机科学</div>',
        unsafe_allow_html=True
    )
    st.markdown("---")


async def progress_callback(message: str, progress: float):
    """进度回调"""
    st.session_state.current_progress = progress
    st.session_state.current_message = message


def render_tab_upload():
    """Tab 1: 文档上传"""
    st.header("📤 上传教材文档")

    col1, col2 = st.columns([2, 1])

    with col1:
        uploaded_file = st.file_uploader(
            "选择PDF或PPT文件",
            type=["pdf", "ppt", "pptx"],
            help="上传教材章节的PDF或课件PPT"
        )

        if uploaded_file:
            file_path = save_uploaded_file(uploaded_file)
            st.session_state.uploaded_file_path = file_path
            st.success(f"✅ 文件已上传: {uploaded_file.name}")

            # 显示文件信息
            file_size = os.path.getsize(file_path) / 1024  # KB
            st.info(f"📊 文件大小: {file_size:.2f} KB")

    with col2:
        st.info("""
        **支持的文件类型**
        - PDF教材章节
        - PPT/PPTX课件

        **支持的学科**
        - 数学
        - 经济学
        - 计算机科学
        """)

    # 可选参数
    st.subheader("可选设置")

    col1, col2 = st.columns(2)

    with col1:
        chapter_title = st.text_input(
            "章节标题（可选）",
            placeholder="例如：第3章 矩阵运算",
            help="指定章节标题可以只处理该章节"
        )

    with col2:
        use_page_range = st.checkbox("指定页面范围")

        if use_page_range:
            col_start, col_end = st.columns(2)
            with col_start:
                start_page = st.number_input("起始页", min_value=1, value=1)
            with col_end:
                end_page = st.number_input("结束页", min_value=1, value=10)
            page_range = (start_page - 1, end_page)  # 转换为0-based
        else:
            page_range = None

    # 处理按钮
    if st.button("🚀 开始处理", type="primary", disabled=not uploaded_file):
        if st.session_state.uploaded_file_path:
            with st.spinner("正在处理文档..."):
                # 初始化引擎
                config_params = render_sidebar()
                engine = UniversityLectureEngine(
                    api_provider=config_params["api_provider"],
                    enable_review=config_params["enable_review"],
                    max_debug_attempts=config_params["max_debug_attempts"]
                )

                # 处理文档
                try:
                    result = asyncio.run(engine.process_document(
                        st.session_state.uploaded_file_path,
                        chapter_title=chapter_title if chapter_title else None,
                        page_range=page_range,
                        progress_callback=progress_callback
                    ))

                    st.session_state.processing_result = result
                    st.session_state.knowledge_data = result.get("knowledge_data")
                    st.session_state.script_data = result.get("script_data")

                    if result.get("success"):
                        st.success("✅ 处理完成！请切换到其他标签页查看结果。")
                    else:
                        st.error(f"❌ 处理失败: {result.get('error', '未知错误')}")

                except Exception as e:
                    st.error(f"❌ 处理过程中发生错误: {str(e)}")
                    logger.exception("Processing error")


def render_tab_knowledge():
    """Tab 2: 知识点分析"""
    st.header("🧠 知识点分析")

    if st.session_state.knowledge_data is None:
        st.info("请先在'文档上传'标签页上传并处理文档")
        return

    knowledge_data = st.session_state.knowledge_data

    # 章节信息
    st.subheader("📚 章节信息")
    col1, col2, col3 = st.columns(3)

    with col1:
        st.metric("章节标题", knowledge_data.get("chapter_title", "未知"))

    with col2:
        st.metric("学科领域", knowledge_data.get("subject", "未知"))

    with col3:
        difficulty = knowledge_data.get("difficulty_level", "intermediate")
        difficulty_map = {"basic": "基础", "intermediate": "中等", "advanced": "高级"}
        st.metric("难度等级", difficulty_map.get(difficulty, difficulty))

    # 章节摘要
    if "summary" in knowledge_data:
        st.info(f"**章节摘要**: {knowledge_data['summary']}")

    # 知识点列表
    st.subheader("📝 知识点列表")

    knowledge_points = knowledge_data.get("knowledge_points", [])

    if not knowledge_points:
        st.warning("未提取到知识点")
        return

    # 筛选器
    col1, col2 = st.columns(2)

    with col1:
        filter_type = st.multiselect(
            "按类型筛选",
            ["definition", "theorem", "formula", "derivation", "property", "example", "method", "note"],
            default=[]
        )

    with col2:
        filter_importance = st.selectbox(
            "按重要性筛选",
            ["全部", "高", "中", "低"]
        )

    # 应用筛选
    filtered_kps = knowledge_points

    if filter_type:
        filtered_kps = [kp for kp in filtered_kps if kp.get("type") in filter_type]

    if filter_importance != "全部":
        importance_map = {"高": "high", "中": "medium", "低": "low"}
        filtered_kps = [kp for kp in filtered_kps if kp.get("importance") == importance_map[filter_importance]]

    # 显示知识点
    for i, kp in enumerate(filtered_kps, 1):
        with st.expander(f"#{i} {kp.get('title', '知识点')} ({kp.get('type', 'unknown')})"):
            col1, col2 = st.columns([3, 1])

            with col1:
                st.markdown(f"**内容**: {kp.get('content', '无描述')}")

                if kp.get("formulas"):
                    st.markdown("**公式**:")
                    for formula in kp["formulas"]:
                        st.latex(formula)

                if kp.get("explanation_points"):
                    st.markdown("**讲解要点**:")
                    for point in kp["explanation_points"]:
                        st.markdown(f"- {point}")

            with col2:
                importance_colors = {"high": "🔴", "medium": "🟡", "low": "🟢"}
                st.markdown(f"**重要性**: {importance_colors.get(kp.get('importance', 'medium'), '⚪')} {kp.get('importance', 'medium')}")
                st.markdown(f"**难度**: {kp.get('difficulty', 'intermediate')}")

    # 知识结构
    st.subheader("🗂️ 知识结构")

    if "knowledge_structure" in knowledge_data:
        struct = knowledge_data["knowledge_structure"]

        col1, col2 = st.columns(2)

        with col1:
            st.markdown("**核心概念**")
            for concept in struct.get("core_concepts", []):
                st.markdown(f"- {concept}")

            st.markdown("**关键定理**")
            for theorem in struct.get("key_theorems", []):
                st.markdown(f"- {theorem}")

        with col2:
            st.markdown("**重要公式**")
            for formula in struct.get("important_formulas", []):
                st.markdown(f"- {formula}")

            st.markdown("**典型问题**")
            for problem in struct.get("typical_problems", []):
                st.markdown(f"- {problem}")


def render_tab_script():
    """Tab 3: 讲解脚本"""
    st.header("📜 讲解脚本")

    if st.session_state.script_data is None:
        st.info("请先在'文档上传'标签页上传并处理文档")
        return

    script_data = st.session_state.script_data

    # 脚本信息
    col1, col2, col3 = st.columns(3)

    with col1:
        st.metric("视频标题", script_data.get("title", "未知"))

    with col2:
        duration = script_data.get("total_duration", 0)
        st.metric("预计时长", f"{duration // 60}分{duration % 60}秒")

    with col3:
        st.metric("片段数量", len(script_data.get("segments", [])))

    # 学习目标
    if "learning_objectives" in script_data:
        st.subheader("🎯 学习目标")
        for obj in script_data["learning_objectives"]:
            st.markdown(f"- {obj}")

    st.markdown("---")

    # 脚本片段
    st.subheader("🎬 脚本片段")

    segments = script_data.get("segments", [])

    for i, segment in enumerate(segments, 1):
        with st.expander(f"片段 {i}: {segment.get('title', '未命名')} ({segment.get('duration', 0)}秒)"):
            st.markdown(f"**类型**: {segment.get('type', 'unknown')}")

            # 讲解内容
            st.markdown("**讲解内容**:")
            st.text_area("", segment.get("narration", ""), height=150, key=f"narration_{i}", disabled=True)

            # 关键要点
            if segment.get("key_points"):
                st.markdown("**关键要点**:")
                for point in segment["key_points"]:
                    st.markdown(f"- {point}")

            # 公式展示
            if segment.get("formulas_to_display"):
                st.markdown("**公式展示**:")
                for formula in segment["formulas_to_display"]:
                    st.latex(formula)

            # 可视化指令
            if segment.get("visual_instructions"):
                with st.expander("查看可视化指令"):
                    for j, visual in enumerate(segment["visual_instructions"], 1):
                        st.markdown(f"**{j}.** (T={visual.get('timing', 0)}s) {visual.get('action', '')} - {visual.get('content', '')}")

    # 导出脚本
    if st.button("📥 导出脚本为Markdown"):
        from agents.script_writer import ScriptWriterAgent
        from core.model_connector import create_llm

        # 创建临时agent用于导出
        model = create_llm()
        script_writer = ScriptWriterAgent(model)
        md_content = script_writer.export_to_markdown(script_data)

        st.download_button(
            label="下载Markdown文件",
            data=md_content,
            file_name=f"script_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md",
            mime="text/markdown"
        )


def render_tab_video():
    """Tab 4: 视频生成"""
    st.header("🎥 生成的视频")

    if st.session_state.processing_result is None:
        st.info("请先在'文档上传'标签页上传并处理文档")
        return

    result = st.session_state.processing_result

    if not result.get("success"):
        st.error(f"视频生成失败: {result.get('error', '未知错误')}")
        return

    # 视频播放
    video_path = result.get("video_path", "")

    if video_path and os.path.exists(video_path):
        st.subheader("📹 视频预览")
        with open(video_path, "rb") as video_file:
            st.video(video_file.read())

        # 下载按钮
        with open(video_path, "rb") as video_file:
            st.download_button(
                label="📥 下载视频",
                data=video_file.read(),
                file_name=os.path.basename(video_path),
                mime="video/mp4"
            )
    else:
        st.warning("视频文件未找到")

    # Manim代码
    st.subheader("💻 Manim代码")

    code = result.get("manim_code", "")

    if code:
        st.code(code, language="python", line_numbers=True)

        st.download_button(
            label="📥 下载代码",
            data=code,
            file_name=f"manim_code_{datetime.now().strftime('%Y%m%d_%H%M%S')}.py",
            mime="text/x-python"
        )
    else:
        st.warning("代码未生成")

    # 性能统计
    st.subheader("📊 性能统计")

    if "stats" in result:
        stats = result["stats"]

        col1, col2, col3, col4 = st.columns(4)

        with col1:
            st.metric("总耗时", f"{stats.get('total_processing_time', 0):.2f}秒")

        with col2:
            st.metric("文档解析", f"{stats.get('document_parsing_time', 0):.2f}秒")

        with col3:
            st.metric("知识提取", f"{stats.get('knowledge_extraction_time', 0):.2f}秒")

        with col4:
            st.metric("调试次数", stats.get('debug_attempts', 0))


def main():
    """主函数"""
    initialize_session_state()
    render_header()

    # 侧边栏
    config_params = render_sidebar()

    # 主内容区 - 标签页
    tab1, tab2, tab3, tab4 = st.tabs(["📤 文档上传", "🧠 知识点分析", "📜 讲解脚本", "🎥 生成视频"])

    with tab1:
        render_tab_upload()

    with tab2:
        render_tab_knowledge()

    with tab3:
        render_tab_script()

    with tab4:
        render_tab_video()

    # 页脚
    st.markdown("---")
    st.markdown(
        '<div style="text-align: center; color: #666; font-size: 0.9rem;">'
        '大学课程讲解视频生成系统 | Powered by DeepSeek & Manim'
        '</div>',
        unsafe_allow_html=True
    )


if __name__ == "__main__":
    main()
