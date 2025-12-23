"""
Streamlit应用入口
"""
import os
import sys
import logging
import asyncio
import streamlit as st
from typing import Dict, Any
import time

# 添加当前目录到Python路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from core.engine import MathTutorEngineV2 as MathTutorEngine
from utils.parser import format_analysis_result, format_solution_result, extract_main_visualization_class
import config

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 页面配置
st.set_page_config(
    page_title=config.PAGE_TITLE,
    page_icon=config.PAGE_ICON,
    layout="wide",
    initial_sidebar_state="expanded"
)

# 获取当前工作目录
CWD = os.path.dirname(os.path.abspath(__file__))

# 创建session state变量
if 'engine' not in st.session_state:
    st.session_state['engine'] = None
if 'processing' not in st.session_state:
    st.session_state['processing'] = False
if 'result' not in st.session_state:
    st.session_state['result'] = None

# 标题和介绍
st.title("🧮 小学数学辅导工具")
st.markdown("""
这是一个基于大模型多Agent技术的小学数学辅导工具，只需输入数学题目，系统将自动分析、解答并生成直观的数形结合可视化视频。
""")

# 侧边栏
with st.sidebar:
    st.header("⚙️ 性能设置")

    # 性能模式预设
    performance_mode = st.selectbox(
        "性能模式",
        options=["平衡模式 (推荐)", "极速模式", "高质量模式", "自定义"],
        help="选择预设模式或自定义配置"
    )

    # 根据模式设置默认值
    if performance_mode == "极速模式":
        default_understanding = False
        default_review = False
        default_debug = 1
        default_quality = "low_quality"
    elif performance_mode == "高质量模式":
        default_understanding = True
        default_review = True
        default_debug = 3
        default_quality = "medium_quality"
    else:  # 平衡模式
        default_understanding = True
        default_review = False
        default_debug = 2
        default_quality = "low_quality"

    # 自定义模式下显示详细配置
    if performance_mode == "自定义":
        st.markdown("---")
        enable_understanding = st.checkbox(
            "启用题目理解分析",
            value=True,
            help="详细分析题目特征（禁用可加速约15-30秒）"
        )

        enable_review = st.checkbox(
            "启用代码审查优化",
            value=False,
            help="审查和优化布局代码（启用提升质量但增加约15-30秒）"
        )

        max_debug_attempts = st.slider(
            "最大调试次数",
            min_value=1,
            max_value=3,
            value=2,
            help="代码执行失败时的最大重试次数"
        )

        manim_quality = st.selectbox(
            "视频渲染质量",
            options=["low_quality", "medium_quality", "high_quality"],
            index=0,
            format_func=lambda x: {"low_quality": "低质量 (480p, 快)",
                                   "medium_quality": "中等质量 (720p, 平衡)",
                                   "high_quality": "高质量 (1080p, 慢)"}[x],
            help="视频分辨率和帧率"
        )
    else:
        enable_understanding = default_understanding
        enable_review = default_review
        max_debug_attempts = default_debug
        manim_quality = default_quality

        # 显示当前模式的配置信息
        quality_map = {'low_quality': '低', 'medium_quality': '中', 'high_quality': '高'}
        st.info(f"""
        **当前配置**：
        - 题目分析: {'启用' if enable_understanding else '禁用'}
        - 代码审查: {'启用' if enable_review else '禁用'}
        - 调试次数: {max_debug_attempts}
        - 视频质量: {quality_map[manim_quality]}
        """)

    # 估算处理时间
    estimated_time = 25  # 基础时间
    if enable_understanding:
        estimated_time += 20
    if enable_review:
        estimated_time += 25
    estimated_time += 30  # 可视化代码生成
    estimated_time += {"low_quality": 20, "medium_quality": 40, "high_quality": 60}[manim_quality]

    st.success(f"⏱️ 预计耗时: {estimated_time//60}分{estimated_time%60}秒")

    # 保存配置到session state
    st.session_state['performance_config'] = {
        'enable_understanding': enable_understanding,
        'enable_review': enable_review,
        'max_debug_attempts': max_debug_attempts,
        'manim_quality': manim_quality
    }

    st.markdown("---")

    st.header("关于")
    st.markdown("""
    本工具利用多Agent技术，提供小学数学题目的详细解析和直观演示。

    主要特点：
    - 🧠 深度理解数学题目
    - 📝 详细的步骤解答
    - 🎬 数形结合的可视化视频
    """)

    st.header("示例题目")
    example_problems = [
        "小明有25个糖果，他给了小红8个，又给了小刚5个，然后小明的妈妈又给了他10个糖果。请问小明现在有多少个糖果？",
        # "一个长方形的长是12厘米，宽是8厘米。如果把长方形分成面积相等的4个小长方形，每个小长方形的周长是多少厘米？",
        # "光明小学有学生760人，其中男生人数比女生人数的3倍少40人，男、女生各有多少人？",
    ]

    for i, example in enumerate(example_problems, 1):
        if st.button(f"示例 {i}", key=f"example_{i}"):
            st.session_state.problem_text = example

# 主界面
problem_text = st.text_area(
    "请输入数学题目",
    height=150,
    value=st.session_state.get("problem_text", ""),
    placeholder="在这里输入数学题目。"
)

# 保存输入到session state
st.session_state['problem_text'] = problem_text

# 启动处理按钮
if st.button("开始分析", type="primary", disabled=st.session_state['processing']):
    if not problem_text.strip():
        st.error("请输入数学题目后再开始分析")
    else:
        st.session_state['processing'] = True
        st.session_state['result'] = None
        
        with st.spinner("正在分析题目..."):
            try:
                # 获取性能配置
                perf_config = st.session_state.get('performance_config', {})

                # 初始化引擎（如果尚未初始化或配置已变化）
                if st.session_state['engine'] is None or st.session_state.get('last_config') != perf_config:
                    st.session_state['engine'] = MathTutorEngine(performance_config=perf_config)
                    st.session_state['last_config'] = perf_config
                
                # 创建进度条
                progress_bar = st.progress(0)
                
                # 更新进度提示
                progress_text = st.empty()
                progress_text.text("正在理解题目...")
                
                # 使用asyncio运行异步任务
                async def process_async(engine):
                    return await engine.process_problem(problem_text)
                
                # 在新线程中运行异步任务
                import threading
                import asyncio
                
                result_container = [None]
                engine = st.session_state['engine']
                
                def run_async():
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    result_container[0] = loop.run_until_complete(process_async(engine))
                    loop.close()
                
                thread = threading.Thread(target=run_async)
                thread.start()
                
                # 显示处理进度
                steps = ["理解题目", "解题分析", "生成解题步骤", "创建可视化代码", "生成视频"]
                step_weights = [0.1, 0.2, 0.3, 0.2, 0.2]  # 各步骤权重
                
                for i, (step, weight) in enumerate(zip(steps, step_weights)):
                    progress_text.text(f"正在{step}...")
                    # 模拟该步骤的处理时间
                    for j in range(10):
                        if not thread.is_alive() and i >= 3:  # 如果线程已结束并且已经到了后面的步骤
                            break
                        time.sleep(0.2)
                        current_progress = sum(step_weights[:i]) + (weight * j / 10)
                        progress_bar.progress(min(current_progress, 0.95))
                
                # 等待线程完成
                thread.join()
                
                # 获取处理结果
                result = result_container[0]
                st.session_state['result'] = result
                
                # 更新进度
                progress_bar.progress(1.0)
                progress_text.text("处理完成！")
                
            except Exception as e:
                st.error(f"处理过程中出错: {str(e)}")
                logger.error(f"处理过程中出错: {e}", exc_info=True)
            finally:
                st.session_state['processing'] = False

# 显示处理结果
if st.session_state['result']:
    result = st.session_state['result']
    
    st.markdown("---")
    
    if result.get("status") == "success":
        # 创建四个选项卡 (之前是三个，现在加了代码显示)
        tab1, tab2, tab3, tab4 = st.tabs(["📊 题目分析", "📝 解题过程", "🎬 可视化视频", "💻 可视化代码"])
        
        with tab1:
            analysis_result = result.get("analysis", {})
            formatted_analysis = format_analysis_result(analysis_result)
            st.markdown(formatted_analysis)
        
        with tab2:
            solution_result = result.get("solution", {})
            formatted_solution = format_solution_result(solution_result)
            st.markdown(formatted_solution)
        
        with tab3:
            video_path = result.get("video_path")
            if video_path and os.path.exists(video_path):
                try:
                    # 使用 st.video 播放视频
                    st.video(video_path)
                    st.success("视频加载成功！")
                except Exception as e:
                    st.error(f"加载视频时出错: {e}")
                    logger.error(f"加载视频时出错: {e}", exc_info=True)
            elif video_path:
                st.warning(f"找不到视频文件: {video_path}")
                st.markdown(f"请检查路径是否正确，或尝试重新生成。")
            else:
                st.warning("未能生成可视化视频。")
                error_msg = result.get("error")
                if error_msg:
                    st.error(f"错误信息: {error_msg}")

        with tab4:
            # 获取最终代码（可能是修复后的代码）
            final_code = result.get("final_code", result.get("visualization_code", ""))
            debug_attempts = result.get("debug_attempts", 0)
            
            if final_code:
                st.markdown("### Manim可视化代码")
                
                # 如果经过调试，显示调试信息
                if debug_attempts > 0:
                    st.success(f"✅ 代码经过 {debug_attempts} 次调试后成功修复")
                
                st.code(final_code, language="python")
                
                # 提供下载链接
                st.download_button(
                    label="下载代码",
                    data=final_code,
                    file_name="math_visualization.py",
                    mime="text/plain"
                )
                
                # 显示执行命令
                main_class = extract_main_visualization_class(final_code)
                if main_class:
                    st.markdown("### 执行命令")
                    st.code(f"manim -qm -p math_visualization.py {main_class}", language="bash")
            else:
                st.error("可视化代码生成失败。")
    
    else:
        st.error("处理失败！")
        st.code(result.get("error", "未知错误"))

# 页脚
st.markdown("---")
# st.markdown("© 2025 小学数学辅导工具 | 基于Langchain + Manim + Xinference")
st.markdown("© 2025 小学数学辅导工具")
