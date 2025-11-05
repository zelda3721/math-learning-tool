"""
讲解脚本生成Agent - 基于知识点生成视频讲解脚本
参考B站风格，生成结构化的讲解内容
"""
import logging
import json
import re
from typing import Dict, Any, List, Optional
from agents.base import BaseAgent
from langchain_openai import ChatOpenAI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class ScriptWriterAgent(BaseAgent):
    """讲解脚本生成Agent"""

    def __init__(self, model: ChatOpenAI):
        """
        初始化脚本生成Agent

        Args:
            model: LLM模型实例
        """
        system_prompt = self._get_system_prompt()

        super().__init__(
            name="Script Writer",
            description="生成结构化的视频讲解脚本",
            system_prompt=system_prompt,
            model=model
        )

    def _get_system_prompt(self) -> str:
        """获取系统提示词"""
        return """你是一位经验丰富的在线教育内容创作者，擅长编写清晰、生动、易懂的讲解脚本。
你的风格参考B站优质讲解视频（如3Blue1Brown、李永乐老师），注重逻辑清晰、视觉化呈现、深入浅出。

**核心任务**：基于提取的知识点，生成完整的视频讲解脚本，包括讲解内容、可视化指令、时间控制等。

**讲解风格**：
1. **开场**：简洁有力，点明主题和价值
2. **逻辑**：层层递进，先易后难，符合认知规律
3. **语言**：口语化、亲切自然，避免生硬的书面语
4. **举例**：用具体例子帮助理解抽象概念
5. **可视化**：充分利用动画展示公式推导、几何变换等
6. **互动**：适当提问，引导思考
7. **总结**：简明扼要，强化记忆

**脚本结构**：
- **Introduction（开场）**：30-60秒，介绍主题和学习目标
- **Concept Segments（概念讲解）**：每个知识点2-5分钟
- **Example Segments（例题演示）**：1-3分钟
- **Summary（总结）**：30-60秒，回顾核心要点

**输出格式**（严格JSON）：
```json
{
  "title": "视频标题",
  "total_duration": 预计总时长(秒),
  "target_audience": "目标观众（本科生/研究生等）",
  "learning_objectives": ["学习目标1", "学习目标2"],
  "segments": [
    {
      "segment_id": "seg_001",
      "type": "introduction/concept/example/derivation/summary",
      "duration": 时长(秒),
      "title": "片段标题",
      "narration": "讲解文本（口语化）",
      "visual_instructions": [
        {
          "timing": "开始时间(秒)",
          "action": "显示标题/公式推导/图形变换/高亮文字等",
          "content": "具体内容",
          "animation_type": "FadeIn/Write/Transform/Create等Manim动画"
        }
      ],
      "key_points": ["要点1", "要点2"],
      "formulas_to_display": ["公式1", "公式2"],
      "transition_to_next": "过渡语句"
    }
  ],
  "visual_theme": {
    "color_scheme": "配色方案（专业蓝/学术黑/温暖橙等）",
    "font_style": "字体风格",
    "layout_preference": "布局偏好"
  },
  "references": ["参考资料1", "参考资料2"]
}
```

**示例脚本**（矩阵乘法）：
```json
{
  "title": "线性代数 | 矩阵乘法的几何意义",
  "total_duration": 900,
  "target_audience": "本科生",
  "learning_objectives": [
    "理解矩阵乘法的定义",
    "掌握矩阵乘法的几何意义",
    "了解矩阵乘法的性质"
  ],
  "segments": [
    {
      "segment_id": "seg_001",
      "type": "introduction",
      "duration": 45,
      "title": "开场 - 为什么学习矩阵乘法",
      "narration": "大家好！今天我们来聊一个线性代数中超级重要的运算——矩阵乘法。你可能会问，为什么矩阵的乘法这么复杂？为什么不能像普通数字那样直接对应位置相乘呢？别着急，看完这个视频，你不仅会算矩阵乘法，更能理解它背后的几何直觉。",
      "visual_instructions": [
        {
          "timing": "0",
          "action": "显示标题",
          "content": "矩阵乘法的几何意义",
          "animation_type": "Write"
        },
        {
          "timing": "15",
          "action": "显示问题",
          "content": "为什么矩阵乘法如此特殊？",
          "animation_type": "FadeIn"
        },
        {
          "timing": "30",
          "action": "显示学习目标",
          "content": "1. 定义 2. 几何意义 3. 性质",
          "animation_type": "Create"
        }
      ],
      "key_points": ["矩阵乘法的重要性", "学习目标"],
      "formulas_to_display": [],
      "transition_to_next": "首先，我们来看看矩阵乘法的精确定义。"
    },
    {
      "segment_id": "seg_002",
      "type": "concept",
      "duration": 180,
      "title": "矩阵乘法的定义",
      "narration": "假设我们有一个2×3的矩阵A和一个3×2的矩阵B。注意这里的维度，A的列数必须等于B的行数，这样才能相乘。结果C=AB是一个2×2的矩阵。那么C的每个元素是怎么来的呢？让我们看第一行第一列的元素c11，它等于A的第1行与B的第1列对应元素相乘再求和。我们用颜色来标记一下...",
      "visual_instructions": [
        {
          "timing": "0",
          "action": "显示矩阵A和B",
          "content": "A(2×3), B(3×2)",
          "animation_type": "Create"
        },
        {
          "timing": "20",
          "action": "高亮维度匹配",
          "content": "A列数=B行数",
          "animation_type": "Indicate"
        },
        {
          "timing": "40",
          "action": "逐步计算c11",
          "content": "c11 = a11*b11 + a12*b21 + a13*b31",
          "animation_type": "Transform"
        },
        {
          "timing": "90",
          "action": "用颜色高亮对应元素",
          "content": "第1行×第1列",
          "animation_type": "Indicate"
        },
        {
          "timing": "120",
          "action": "推广到通用公式",
          "content": "(AB)_ij = Σ a_ik * b_kj",
          "animation_type": "Write"
        }
      ],
      "key_points": [
        "维度匹配条件",
        "行列对应关系",
        "通用公式"
      ],
      "formulas_to_display": [
        "C = AB",
        "(AB)_{ij} = \\sum_{k=1}^{n} a_{ik} b_{kj}"
      ],
      "transition_to_next": "定义有了，但这样算有什么几何意义呢？"
    },
    {
      "segment_id": "seg_003",
      "type": "concept",
      "duration": 240,
      "title": "几何意义 - 线性变换的复合",
      "narration": "这里是矩阵乘法最美妙的地方！矩阵可以看作是对空间的一种变换。比如矩阵B把一个向量从原来的位置变换到新位置，矩阵A再把这个新位置继续变换。那么AB就代表先做B变换，再做A变换。让我们用一个具体的例子来看...",
      "visual_instructions": [
        {
          "timing": "0",
          "action": "显示坐标系和单位向量",
          "content": "2D坐标系",
          "animation_type": "Create"
        },
        {
          "timing": "30",
          "action": "应用B变换",
          "content": "旋转90度",
          "animation_type": "Transform"
        },
        {
          "timing": "90",
          "action": "应用A变换",
          "content": "缩放2倍",
          "animation_type": "Transform"
        },
        {
          "timing": "150",
          "action": "展示复合变换=AB",
          "content": "直接应用AB得到相同结果",
          "animation_type": "Transform"
        }
      ],
      "key_points": [
        "矩阵=线性变换",
        "矩阵乘法=变换复合",
        "顺序很重要"
      ],
      "formulas_to_display": ["(AB)v = A(Bv)"],
      "transition_to_next": "理解了几何意义，我们就能明白矩阵乘法的一些性质了。"
    },
    {
      "segment_id": "seg_004",
      "type": "summary",
      "duration": 60,
      "title": "总结",
      "narration": "好，我们来快速回顾一下。矩阵乘法的定义是行乘列求和，但本质是线性变换的复合。记住三个要点：第一，维度要匹配；第二，一般不满足交换律；第三，从几何角度理解更直观。掌握了这些，矩阵乘法就不再神秘了！",
      "visual_instructions": [
        {
          "timing": "0",
          "action": "显示知识点总结",
          "content": "1. 定义 2. 几何意义 3. 性质",
          "animation_type": "FadeIn"
        },
        {
          "timing": "30",
          "action": "显示关键公式",
          "content": "(AB)_ij = Σ a_ik * b_kj",
          "animation_type": "Write"
        }
      ],
      "key_points": ["定义", "几何意义", "性质"],
      "formulas_to_display": ["(AB)_ij = \\sum a_{ik} b_{kj}"],
      "transition_to_next": "感谢观看，我们下期再见！"
    }
  ],
  "visual_theme": {
    "color_scheme": "专业蓝（#1f77b4主色，#ff7f0e强调色）",
    "font_style": "现代简洁",
    "layout_preference": "上方标题，中央主内容，底部公式"
  },
  "references": ["线性代数及其应用", "3Blue1Brown - Essence of Linear Algebra"]
}
```

**质量要求**：
1. 讲解文本必须口语化，就像真人在对话
2. 每个片段时长合理（introduction≤60s, concept 2-5min, summary≤60s）
3. 可视化指令具体明确，能直接指导Manim代码生成
4. 逻辑流畅，过渡自然
5. 只输出JSON，不要其他文字
"""

    async def generate_script(
        self,
        knowledge_data: Dict[str, Any],
        style: str = "bilibili",
        target_duration: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        生成讲解脚本

        Args:
            knowledge_data: 知识点数据（来自KnowledgeExtractorAgent）
            style: 讲解风格（bilibili/academic/casual）
            target_duration: 目标时长（秒），None表示自动估算

        Returns:
            结构化的讲解脚本
        """
        # 提取关键信息
        chapter_title = knowledge_data.get("chapter_title", "未知章节")
        knowledge_points = knowledge_data.get("knowledge_points", [])
        learning_path = knowledge_data.get("learning_path", [])

        # 构建用户输入
        user_input = f"""请为以下知识点生成视频讲解脚本：

【章节标题】{chapter_title}

【知识点列表】
{json.dumps(knowledge_points[:10], ensure_ascii=False, indent=2)}

【学习路径】
{json.dumps(learning_path[:10], ensure_ascii=False, indent=2) if learning_path else "按知识点顺序"}

【风格要求】{style}风格（参考B站优质讲解视频）
"""
        if target_duration:
            user_input += f"【时长要求】控制在{target_duration}秒左右\n"

        user_input += "\n请严格按照JSON格式输出完整脚本。"

        # 调用LLM
        response = await self.arun(user_input)

        # 解析JSON响应
        try:
            script_data = self._parse_json_response(response)
            logger.info(f"Generated script with {len(script_data.get('segments', []))} segments")
            return script_data
        except Exception as e:
            logger.error(f"Failed to parse script generation response: {str(e)}")
            return {
                "title": chapter_title,
                "segments": [],
                "error": str(e),
                "raw_response": response
            }

    def _parse_json_response(self, response: str) -> Dict[str, Any]:
        """解析JSON响应"""
        # 尝试提取JSON部分
        json_match = re.search(r'```json\s*(.*?)\s*```', response, re.DOTALL)
        if json_match:
            json_str = json_match.group(1)
        else:
            json_str = response.strip()

        # 清理markdown标记
        json_str = json_str.replace('```json', '').replace('```', '').strip()

        return json.loads(json_str)

    def optimize_timing(self, script_data: Dict[str, Any], target_duration: int) -> Dict[str, Any]:
        """
        优化脚本时长

        Args:
            script_data: 原始脚本
            target_duration: 目标时长（秒）

        Returns:
            优化后的脚本
        """
        current_duration = script_data.get("total_duration", 0)

        if current_duration == 0:
            # 计算当前总时长
            segments = script_data.get("segments", [])
            current_duration = sum(seg.get("duration", 60) for seg in segments)

        # 计算缩放因子
        if current_duration > 0:
            scale_factor = target_duration / current_duration
        else:
            scale_factor = 1.0

        # 调整每个片段的时长
        for segment in script_data.get("segments", []):
            original_duration = segment.get("duration", 60)
            segment["duration"] = int(original_duration * scale_factor)

            # 调整可视化指令的时间
            for visual in segment.get("visual_instructions", []):
                if "timing" in visual and visual["timing"]:
                    try:
                        original_timing = float(visual["timing"])
                        visual["timing"] = str(int(original_timing * scale_factor))
                    except (ValueError, TypeError):
                        pass

        script_data["total_duration"] = target_duration
        logger.info(f"Optimized script duration: {current_duration}s -> {target_duration}s")

        return script_data

    def split_into_sub_videos(self, script_data: Dict[str, Any], max_duration: int = 600) -> List[Dict[str, Any]]:
        """
        将长脚本拆分为多个子视频

        Args:
            script_data: 完整脚本
            max_duration: 每个子视频的最大时长（秒）

        Returns:
            子视频脚本列表
        """
        segments = script_data.get("segments", [])
        sub_scripts = []
        current_script = {
            "title": f"{script_data.get('title', '')} - Part 1",
            "segments": [],
            "total_duration": 0
        }
        part_num = 1

        for segment in segments:
            segment_duration = segment.get("duration", 60)

            # 如果加入当前片段会超时
            if current_script["total_duration"] + segment_duration > max_duration:
                # 保存当前脚本
                if current_script["segments"]:
                    sub_scripts.append(current_script)

                # 开始新脚本
                part_num += 1
                current_script = {
                    "title": f"{script_data.get('title', '')} - Part {part_num}",
                    "segments": [],
                    "total_duration": 0
                }

            # 添加片段
            current_script["segments"].append(segment)
            current_script["total_duration"] += segment_duration

        # 添加最后一个脚本
        if current_script["segments"]:
            sub_scripts.append(current_script)

        logger.info(f"Split script into {len(sub_scripts)} parts")
        return sub_scripts

    def export_to_markdown(self, script_data: Dict[str, Any]) -> str:
        """
        将脚本导出为Markdown格式（便于用户预览和编辑）

        Args:
            script_data: 脚本数据

        Returns:
            Markdown格式文本
        """
        md_lines = []

        # 标题
        md_lines.append(f"# {script_data.get('title', '讲解脚本')}")
        md_lines.append("")

        # 元信息
        md_lines.append(f"**总时长**: {script_data.get('total_duration', 0)}秒")
        md_lines.append(f"**目标观众**: {script_data.get('target_audience', '大学生')}")
        md_lines.append("")

        # 学习目标
        objectives = script_data.get('learning_objectives', [])
        if objectives:
            md_lines.append("## 学习目标")
            for obj in objectives:
                md_lines.append(f"- {obj}")
            md_lines.append("")

        # 各个片段
        segments = script_data.get('segments', [])
        for i, segment in enumerate(segments, 1):
            md_lines.append(f"## {i}. {segment.get('title', '片段' + str(i))}")
            md_lines.append(f"**类型**: {segment.get('type', 'unknown')}")
            md_lines.append(f"**时长**: {segment.get('duration', 0)}秒")
            md_lines.append("")

            # 讲解文本
            md_lines.append("### 讲解内容")
            md_lines.append(segment.get('narration', ''))
            md_lines.append("")

            # 公式
            formulas = segment.get('formulas_to_display', [])
            if formulas:
                md_lines.append("### 公式展示")
                for formula in formulas:
                    md_lines.append(f"- {formula}")
                md_lines.append("")

            # 要点
            key_points = segment.get('key_points', [])
            if key_points:
                md_lines.append("### 关键要点")
                for point in key_points:
                    md_lines.append(f"- {point}")
                md_lines.append("")

            md_lines.append("---")
            md_lines.append("")

        return "\n".join(md_lines)
