"""
PDF解析Agent - 用于解析教材PDF章节
支持文本提取、公式识别、图表提取、结构分析
"""
import logging
import fitz  # PyMuPDF
import re
from typing import Dict, Any, List, Optional
from pathlib import Path
import base64
from io import BytesIO
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class PDFParserAgent:
    """PDF文档解析Agent"""

    def __init__(self):
        """初始化PDF解析器"""
        self.name = "PDF Parser"
        self.description = "解析PDF教材，提取文本、公式、图表和结构信息"
        logger.info(f"{self.name} initialized")

    def parse_pdf(self, pdf_path: str, page_range: Optional[tuple] = None) -> Dict[str, Any]:
        """
        解析PDF文件

        Args:
            pdf_path: PDF文件路径
            page_range: 页码范围 (start, end)，None表示全部页面

        Returns:
            包含解析结果的字典
        """
        try:
            doc = fitz.open(pdf_path)
            total_pages = len(doc)

            # 确定要解析的页面范围
            if page_range:
                start_page, end_page = page_range
                start_page = max(0, start_page)
                end_page = min(total_pages, end_page)
            else:
                start_page, end_page = 0, total_pages

            logger.info(f"Parsing PDF: {pdf_path}, pages {start_page}-{end_page} of {total_pages}")

            # 解析结果
            result = {
                "file_name": Path(pdf_path).name,
                "total_pages": total_pages,
                "parsed_pages": end_page - start_page,
                "pages": [],
                "metadata": self._extract_metadata(doc),
                "structure": {
                    "chapters": [],
                    "sections": [],
                    "main_topics": []
                }
            }

            # 逐页解析
            for page_num in range(start_page, end_page):
                page_data = self._parse_page(doc[page_num], page_num + 1)
                result["pages"].append(page_data)

                # 提取章节标题
                if page_data.get("title"):
                    result["structure"]["chapters"].append({
                        "page": page_num + 1,
                        "title": page_data["title"]
                    })

            # 分析文档结构
            result["structure"]["main_topics"] = self._extract_main_topics(result["pages"])

            doc.close()
            logger.info(f"PDF parsing completed: {len(result['pages'])} pages processed")
            return result

        except Exception as e:
            logger.error(f"Error parsing PDF: {str(e)}")
            raise

    def _parse_page(self, page: fitz.Page, page_num: int) -> Dict[str, Any]:
        """
        解析单个页面

        Args:
            page: PyMuPDF页面对象
            page_num: 页码

        Returns:
            页面解析结果
        """
        # 提取文本
        text = page.get_text("text")
        blocks = page.get_text("blocks")

        # 提取图片
        images = self._extract_images(page, page_num)

        # 识别标题
        title = self._detect_title(text, blocks)

        # 提取文本块
        text_blocks = self._extract_text_blocks(blocks)

        # 识别公式（基于文本特征）
        formulas = self._extract_formulas(text)

        # 提取关键概念
        keywords = self._extract_keywords(text)

        return {
            "page_num": page_num,
            "title": title,
            "text": text.strip(),
            "text_blocks": text_blocks,
            "formulas": formulas,
            "images": images,
            "keywords": keywords,
            "word_count": len(text.split())
        }

    def _extract_metadata(self, doc: fitz.Document) -> Dict[str, Any]:
        """提取PDF元数据"""
        metadata = doc.metadata
        return {
            "title": metadata.get("title", ""),
            "author": metadata.get("author", ""),
            "subject": metadata.get("subject", ""),
            "creator": metadata.get("creator", ""),
            "producer": metadata.get("producer", ""),
            "creation_date": metadata.get("creationDate", ""),
        }

    def _detect_title(self, text: str, blocks: List) -> str:
        """
        检测页面标题
        通过字体大小、位置等特征识别标题
        """
        lines = text.split('\n')

        # 查找可能的标题特征
        for line in lines[:5]:  # 只检查前5行
            line = line.strip()
            if not line:
                continue

            # 标题特征：
            # 1. 包含"章"、"节"、"Section"、"Chapter"等关键词
            # 2. 较短（通常<50字符）
            # 3. 在页面顶部
            title_patterns = [
                r'^第[一二三四五六七八九十\d]+章',
                r'^第[一二三四五六七八九十\d]+节',
                r'^Chapter\s+\d+',
                r'^Section\s+\d+',
                r'^\d+\.\d+\s+',
                r'^\d+\s+[A-Z]'
            ]

            for pattern in title_patterns:
                if re.search(pattern, line):
                    return line

            # 如果第一行不太长，也可能是标题
            if len(line) < 50 and len(line) > 5:
                return line

        return ""

    def _extract_text_blocks(self, blocks: List) -> List[Dict[str, Any]]:
        """提取结构化文本块"""
        text_blocks = []

        for block in blocks:
            if block[6] == 0:  # 文本块类型
                text_blocks.append({
                    "bbox": block[:4],  # 边界框坐标
                    "text": block[4].strip(),
                    "block_no": block[5]
                })

        return text_blocks

    def _extract_images(self, page: fitz.Page, page_num: int) -> List[Dict[str, Any]]:
        """提取页面中的图片"""
        images = []
        image_list = page.get_images()

        for img_index, img_info in enumerate(image_list):
            try:
                xref = img_info[0]
                base_image = page.parent.extract_image(xref)

                images.append({
                    "image_index": img_index,
                    "page": page_num,
                    "width": base_image["width"],
                    "height": base_image["height"],
                    "colorspace": base_image.get("colorspace", "unknown"),
                    "bpc": base_image.get("bpc", 0),  # bits per component
                    # 可以保存图片数据或路径
                    # "image_data": base_image["image"]
                })
            except Exception as e:
                logger.warning(f"Failed to extract image {img_index} on page {page_num}: {str(e)}")

        return images

    def _extract_formulas(self, text: str) -> List[str]:
        """
        识别文本中的数学公式
        基于文本特征（包含数学符号、运算符等）
        """
        formulas = []

        # 数学公式的常见模式
        formula_patterns = [
            r'[a-zA-Z]\s*[=+\-*/]\s*[a-zA-Z0-9()]+',  # 基本代数式
            r'\b[a-zA-Z]\s*\^\s*[0-9]+',  # 指数
            r'∫|∑|∏|∂|∇|√|π|θ|α|β|γ|λ|μ|σ|Δ',  # 数学符号
            r'\b(sin|cos|tan|log|ln|exp|lim|max|min|det|rank)\s*\(',  # 数学函数
            r'[a-zA-Z]+\s*=\s*\{[^}]+\}',  # 集合定义
            r'\([^)]*[+\-*/^][^)]*\)',  # 括号内的运算
        ]

        lines = text.split('\n')
        for line in lines:
            for pattern in formula_patterns:
                matches = re.findall(pattern, line)
                if matches:
                    # 提取包含公式的完整行
                    cleaned_line = line.strip()
                    if cleaned_line and len(cleaned_line) < 200:  # 避免整段文本
                        formulas.append(cleaned_line)
                    break

        # 去重
        formulas = list(set(formulas))
        return formulas[:20]  # 限制数量

    def _extract_keywords(self, text: str) -> List[str]:
        """
        提取关键词
        基于数学、经济学、计算机领域的专业术语
        """
        # 专业领域关键词库
        math_keywords = [
            '定理', '公式', '证明', '推导', '定义', '性质', '引理', '推论',
            '矩阵', '向量', '函数', '导数', '积分', '微分', '极限', '级数',
            '概率', '统计', '方程', '不等式', '集合', '映射', '变换',
            'theorem', 'proof', 'definition', 'lemma', 'corollary',
            'matrix', 'vector', 'derivative', 'integral', 'limit'
        ]

        econ_keywords = [
            '需求', '供给', '均衡', '弹性', '效用', '成本', '收益', '利润',
            '市场', '价格', '产量', '消费', '投资', '储蓄', 'GDP', '通货膨胀',
            'demand', 'supply', 'equilibrium', 'elasticity', 'utility',
            'cost', 'revenue', 'profit', 'market', 'price'
        ]

        cs_keywords = [
            '算法', '复杂度', '数据结构', '时间复杂度', '空间复杂度',
            '排序', '搜索', '树', '图', '哈希', '递归', '动态规划',
            'algorithm', 'complexity', 'data structure', 'sorting',
            'searching', 'tree', 'graph', 'hash', 'recursion'
        ]

        all_keywords = math_keywords + econ_keywords + cs_keywords

        # 查找文本中出现的关键词
        found_keywords = []
        text_lower = text.lower()

        for keyword in all_keywords:
            if keyword.lower() in text_lower:
                found_keywords.append(keyword)

        return list(set(found_keywords))[:15]  # 去重并限制数量

    def _extract_main_topics(self, pages: List[Dict]) -> List[str]:
        """从所有页面中提取主要主题"""
        all_keywords = []
        for page in pages:
            all_keywords.extend(page.get("keywords", []))

        # 统计关键词频率
        from collections import Counter
        keyword_freq = Counter(all_keywords)

        # 返回出现频率最高的主题
        main_topics = [kw for kw, _ in keyword_freq.most_common(10)]
        return main_topics

    def extract_chapter(self, pdf_path: str, chapter_title: str) -> Dict[str, Any]:
        """
        提取特定章节的内容

        Args:
            pdf_path: PDF文件路径
            chapter_title: 章节标题（用于匹配）

        Returns:
            章节内容
        """
        # 首先解析整个文档找到章节
        doc_data = self.parse_pdf(pdf_path)

        # 查找匹配的章节
        chapter_pages = []
        in_chapter = False

        for i, page in enumerate(doc_data["pages"]):
            # 检查是否是目标章节的开始
            if chapter_title.lower() in page.get("title", "").lower():
                in_chapter = True
                chapter_pages.append(page)
            # 如果遇到新章节，停止
            elif in_chapter and page.get("title") and any(
                keyword in page["title"] for keyword in ["章", "Chapter", "第"]
            ):
                break
            # 在章节内，继续收集
            elif in_chapter:
                chapter_pages.append(page)

        return {
            "chapter_title": chapter_title,
            "pages": chapter_pages,
            "total_pages": len(chapter_pages),
            "text": "\n\n".join(page["text"] for page in chapter_pages),
            "formulas": [f for page in chapter_pages for f in page.get("formulas", [])],
            "keywords": list(set([k for page in chapter_pages for k in page.get("keywords", [])]))
        }
