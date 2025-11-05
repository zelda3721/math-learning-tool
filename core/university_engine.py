"""
大学课程讲解引擎 - UniversityLectureEngine
完整流程: 文档解析 -> 知识点提取 -> 脚本生成 -> 视频生成
"""
import logging
import asyncio
import json
from typing import Dict, Any, List, Optional, Callable
from pathlib import Path
from datetime import datetime

from agents.pdf_parser import PDFParserAgent
from agents.ppt_parser import PPTParserAgent
from agents.knowledge_extractor import KnowledgeExtractorAgent
from agents.script_writer import ScriptWriterAgent
from agents.visualization import VisualizationAgent
from agents.review import ReviewAgent
from agents.debugging import DebuggingAgent
from core.model_connector import ModelConnector
from core.manim_executor import ManimExecutor
import config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class UniversityLectureEngine:
    """
    大学课程讲解视频生成引擎

    完整流程:
    1. 文档解析 (PDF/PPT)
    2. 知识点提取
    3. 讲解脚本生成
    4. Manim可视化代码生成
    5. 代码审核优化
    6. 视频生成（带调试循环）
    """

    def __init__(
        self,
        api_provider: str = "deepseek",
        enable_review: bool = True,
        max_debug_attempts: int = 2
    ):
        """
        初始化引擎

        Args:
            api_provider: API提供商
            enable_review: 是否启用代码审核
            max_debug_attempts: 最大调试尝试次数
        """
        self.api_provider = api_provider
        self.enable_review = enable_review
        self.max_debug_attempts = max_debug_attempts

        # 创建模型实例
        self.model = ModelConnector.create_llm(provider=api_provider)

        # 初始化Agents
        self.pdf_parser = PDFParserAgent()
        self.ppt_parser = PPTParserAgent()
        self.knowledge_extractor = KnowledgeExtractorAgent(self.model)
        self.script_writer = ScriptWriterAgent(self.model)
        self.visualization_agent = VisualizationAgent(self.model)
        self.review_agent = ReviewAgent(self.model) if enable_review else None
        self.debugging_agent = DebuggingAgent(self.model)

        # Manim执行器
        self.manim_executor = ManimExecutor()

        # 性能统计
        self.stats = {
            "total_processing_time": 0,
            "document_parsing_time": 0,
            "knowledge_extraction_time": 0,
            "script_generation_time": 0,
            "video_generation_time": 0,
            "debug_attempts": 0
        }

        logger.info(f"UniversityLectureEngine initialized with provider: {api_provider}")

    async def process_document(
        self,
        file_path: str,
        chapter_title: Optional[str] = None,
        page_range: Optional[tuple] = None,
        progress_callback: Optional[Callable] = None
    ) -> Dict[str, Any]:
        """
        处理文档并生成讲解视频

        Args:
            file_path: 文档路径（PDF或PPT）
            chapter_title: 章节标题（如果指定，只处理该章节）
            page_range: 页面范围 (start, end)
            progress_callback: 进度回调函数

        Returns:
            处理结果，包含视频路径、知识点、脚本等
        """
        start_time = datetime.now()

        try:
            # Step 1: 解析文档
            if progress_callback:
                await progress_callback("解析文档", 0.1)

            doc_data = await self._parse_document(file_path, chapter_title, page_range)

            # Step 2: 提取知识点
            if progress_callback:
                await progress_callback("提取知识点", 0.3)

            knowledge_data = await self._extract_knowledge(doc_data)

            # Step 3: 生成脚本
            if progress_callback:
                await progress_callback("生成讲解脚本", 0.5)

            script_data = await self._generate_script(knowledge_data)

            # Step 4: 生成视频
            if progress_callback:
                await progress_callback("生成可视化视频", 0.7)

            video_result = await self._generate_video(script_data, knowledge_data)

            # 计算总耗时
            total_time = (datetime.now() - start_time).total_seconds()
            self.stats["total_processing_time"] = total_time

            # 构建返回结果
            result = {
                "success": video_result.get("success", False),
                "file_path": file_path,
                "chapter_title": doc_data.get("chapter_title", ""),
                "document_data": doc_data,
                "knowledge_data": knowledge_data,
                "script_data": script_data,
                "video_path": video_result.get("video_path", ""),
                "manim_code": video_result.get("code", ""),
                "stats": self.stats,
                "timestamp": datetime.now().isoformat()
            }

            if progress_callback:
                await progress_callback("完成", 1.0)

            logger.info(f"Document processing completed in {total_time:.2f}s")
            return result

        except Exception as e:
            logger.error(f"Error processing document: {str(e)}")
            return {
                "success": False,
                "error": str(e),
                "file_path": file_path
            }

    async def _parse_document(
        self,
        file_path: str,
        chapter_title: Optional[str],
        page_range: Optional[tuple]
    ) -> Dict[str, Any]:
        """解析文档（PDF或PPT）"""
        parse_start = datetime.now()

        file_ext = Path(file_path).suffix.lower()

        if file_ext == ".pdf":
            logger.info(f"Parsing PDF: {file_path}")
            if chapter_title:
                doc_data = self.pdf_parser.extract_chapter(file_path, chapter_title)
            else:
                doc_data = self.pdf_parser.parse_pdf(file_path, page_range)

        elif file_ext in [".ppt", ".pptx"]:
            logger.info(f"Parsing PPT: {file_path}")
            if chapter_title:
                doc_data = self.ppt_parser.extract_section(file_path, chapter_title)
            else:
                doc_data = self.ppt_parser.parse_ppt(file_path, page_range)

        else:
            raise ValueError(f"Unsupported file type: {file_ext}")

        parse_time = (datetime.now() - parse_start).total_seconds()
        self.stats["document_parsing_time"] = parse_time

        logger.info(f"Document parsed in {parse_time:.2f}s")
        return doc_data

    async def _extract_knowledge(self, doc_data: Dict[str, Any]) -> Dict[str, Any]:
        """提取知识点"""
        extract_start = datetime.now()

        # 构建章节内容
        if "text" in doc_data:
            chapter_content = doc_data["text"]
        elif "pages" in doc_data:
            chapter_content = "\n\n".join(
                page.get("text", "") for page in doc_data["pages"]
            )
        elif "slides" in doc_data:
            chapter_content = "\n\n".join(
                slide.get("full_text", "") for slide in doc_data["slides"]
            )
        else:
            chapter_content = str(doc_data)

        # 构建元数据
        metadata = {
            "title": doc_data.get("chapter_title") or doc_data.get("file_name", ""),
            "keywords": doc_data.get("keywords", [])
        }

        # 调用知识点提取Agent
        knowledge_data = await self.knowledge_extractor.extract_knowledge(
            chapter_content,
            metadata
        )

        extract_time = (datetime.now() - extract_start).total_seconds()
        self.stats["knowledge_extraction_time"] = extract_time

        logger.info(f"Knowledge extracted in {extract_time:.2f}s")
        return knowledge_data

    async def _generate_script(self, knowledge_data: Dict[str, Any]) -> Dict[str, Any]:
        """生成讲解脚本"""
        script_start = datetime.now()

        script_data = await self.script_writer.generate_script(
            knowledge_data,
            style="bilibili"
        )

        script_time = (datetime.now() - script_start).total_seconds()
        self.stats["script_generation_time"] = script_time

        logger.info(f"Script generated in {script_time:.2f}s")
        return script_data

    async def _generate_video(
        self,
        script_data: Dict[str, Any],
        knowledge_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """生成可视化视频"""
        video_start = datetime.now()

        # 将脚本转换为Manim代码
        # 这里简化处理，直接调用visualization agent
        # 实际可以根据script_data的segments逐个生成

        # 构建输入
        chapter_title = knowledge_data.get("chapter_title", "")
        segments = script_data.get("segments", [])

        # 简化：将前3个segment合并作为讲解内容
        narration_parts = []
        for seg in segments[:3]:
            narration_parts.append(f"{seg.get('title', '')}: {seg.get('narration', '')}")

        problem_text = f"章节: {chapter_title}"
        solution_text = "\n\n".join(narration_parts)

        # 构建假的analysis和solution结构（适配原visualization agent）
        analysis_result = {
            "题目类型": "大学课程讲解",
            "核心知识点": knowledge_data.get("knowledge_structure", {}).get("core_concepts", []),
            "难点分析": f"难度: {knowledge_data.get('difficulty_level', 'intermediate')}"
        }

        solution_result = {
            "解题步骤": [
                {"步骤": i + 1, "说明": seg.get("title", ""), "操作": seg.get("narration", "")}
                for i, seg in enumerate(segments[:5])
            ],
            "最终答案": f"完成{chapter_title}的讲解"
        }

        # 生成Manim代码
        code = await self.visualization_agent.generate_visualization_code(
            problem_text,
            analysis_result,
            solution_result
        )

        # 调试循环
        debug_attempts = 0
        video_path = None

        while debug_attempts < self.max_debug_attempts:
            try:
                # 如果启用了review，先审核代码
                if self.review_agent and debug_attempts == 0:
                    logger.info("Reviewing code...")
                    code = await self.review_agent.review_code(code)

                # 执行Manim代码
                logger.info(f"Executing Manim code (attempt {debug_attempts + 1})...")
                video_path = self.manim_executor.execute_code(code)

                # 成功
                logger.info(f"Video generated: {video_path}")
                break

            except Exception as e:
                debug_attempts += 1
                logger.warning(f"Video generation failed (attempt {debug_attempts}): {str(e)}")

                if debug_attempts < self.max_debug_attempts:
                    # 调用debugging agent修复代码
                    logger.info("Debugging code...")
                    code = await self.debugging_agent.debug_code(
                        code,
                        str(e),
                        {"problem": problem_text, "solution": solution_result}
                    )
                else:
                    logger.error("Max debug attempts reached")

        self.stats["debug_attempts"] = debug_attempts

        video_time = (datetime.now() - video_start).total_seconds()
        self.stats["video_generation_time"] = video_time

        return {
            "success": video_path is not None,
            "video_path": video_path or "",
            "code": code,
            "debug_attempts": debug_attempts
        }

    def batch_process(
        self,
        file_paths: List[str],
        progress_callback: Optional[Callable] = None
    ) -> List[Dict[str, Any]]:
        """
        批量处理多个文档

        Args:
            file_paths: 文档路径列表
            progress_callback: 进度回调

        Returns:
            处理结果列表
        """
        results = []

        for i, file_path in enumerate(file_paths):
            logger.info(f"Processing {i + 1}/{len(file_paths)}: {file_path}")

            if progress_callback:
                asyncio.run(progress_callback(f"处理文件 {i + 1}/{len(file_paths)}", i / len(file_paths)))

            result = asyncio.run(self.process_document(file_path))
            results.append(result)

        return results

    def get_stats(self) -> Dict[str, Any]:
        """获取性能统计"""
        return self.stats.copy()
