"""
Manim执行器，负责执行Manim代码并生成视频
"""
import os
import sys
import logging
import tempfile
import subprocess
import uuid
from typing import Tuple, Optional
import config

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ManimExecutor:
    """Manim执行器类"""

    def __init__(self, output_dir: Optional[str] = None, quality: Optional[str] = None):
        """
        初始化Manim执行器

        Args:
            output_dir: 输出目录，默认使用配置文件中的目录
            quality: 渲染质量，默认使用配置文件中的质量
        """
        self.output_dir = output_dir or config.MANIM_OUTPUT_DIR
        self.quality = quality or config.MANIM_QUALITY

        # 确保输出目录存在
        os.makedirs(self.output_dir, exist_ok=True)
        logger.info(f"Manim执行器初始化完成，输出目录: {self.output_dir}, 渲染质量: {self.quality}")
    
    def execute_code(self, code: str) -> Tuple[bool, str, str]:
        """
        执行Manim代码并生成视频
        
        Args:
            code: Manim代码
            
        Returns:
            Tuple(成功标志, 视频文件路径, 错误信息)
        """
        # 创建唯一的文件名
        file_id = str(uuid.uuid4())
        temp_dir = tempfile.gettempdir()
        script_path = os.path.join(temp_dir, f"manim_script_{file_id}.py")
        
        try:
            # 尝试检测代码是否为有效的Python代码
            try:
                compile(code, script_path, 'exec')
            except SyntaxError as se:
                # 如果有语法错误，尝试修复常见问题
                code = self._sanitize_code(code)
                # 再次尝试编译
                try:
                    compile(code, script_path, 'exec')
                except SyntaxError as se_again:
                    logger.error(f"代码存在语法错误，无法执行: {se_again}")
                    return False, "", f"代码存在语法错误: {str(se_again)}"
            
            # 写入代码到临时文件
            with open(script_path, 'w', encoding='utf-8') as f:
                f.write(code)
            
            logger.info(f"Manim代码已写入临时文件: {script_path}")
            
            # 确定Scene类名
            scene_name = self._extract_scene_name(code)
            if not scene_name:
                logger.error("无法确定Scene类名")
                return False, "", "无法确定Scene类名，请检查代码"
            
            # 构建命令
            quality_flag = "-ql" if self.quality == "low_quality" else "-qm" if self.quality == "medium_quality" else "-qh"
            output_flag = f"--media_dir={self.output_dir}"
            
            cmd = [
                sys.executable, "-m", "manim", 
                quality_flag, 
                output_flag,
                script_path, 
                scene_name
            ]
            
            logger.info(f"执行命令: {' '.join(cmd)}")
            
            # 执行命令
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            
            stdout, stderr = process.communicate()
            
            # 检查执行结果
            if process.returncode == 0:
                # 查找生成的视频文件
                expected_path = self._find_video_file(self.output_dir, scene_name)
                if expected_path:
                    logger.info(f"Manim代码执行成功，视频文件: {expected_path}")
                    return True, expected_path, ""
                else:
                    logger.error("无法找到生成的视频文件")
                    return False, "", "无法找到生成的视频文件"
            else:
                logger.error(f"Manim代码执行失败: {stderr}")
                return False, "", f"执行错误: {stderr}"
        
        except Exception as e:
            logger.error(f"执行Manim代码时出错: {e}")
            return False, "", f"执行错误: {str(e)}"
        
        finally:
            # 清理临时文件
            try:
                if os.path.exists(script_path):
                    os.remove(script_path)
            except Exception as e:
                logger.warning(f"清理临时文件时出错: {e}")
    
    def _sanitize_code(self, code: str) -> str:
        """
        清理和修复代码中的常见问题
        
        Args:
            code: 原始代码
            
        Returns:
            修复后的代码
        """
        # 分割代码行
        lines = code.split('\n')
        clean_lines = []
        
        # 标记是否在代码块内
        in_code_block = True
        
        for line in lines:
            # 检查行是否包含中文或其他非ASCII字符
            if any(ord(c) > 127 for c in line) and not line.strip().startswith('#'):
                # 如果包含中文且不是注释，转换为注释
                clean_lines.append(f"# {line}")
            else:
                # 保留原行
                clean_lines.append(line)
        
        # 如果没有找到有效的Scene类，添加一个默认的
        clean_code = '\n'.join(clean_lines)
        if "class" not in clean_code or "Scene" not in clean_code:
            clean_code += """

# 添加默认Scene类
class DefaultMathVisualization(Scene):
    def construct(self):
        title = Text("数学可视化")
        self.play(Write(title))
        self.wait(2)
        self.play(FadeOut(title))
"""
        
        return clean_code    
    def _extract_scene_name(self, code: str) -> Optional[str]:
        """
        从代码中提取Scene类名
        
        Args:
            code: Manim代码
            
        Returns:
            Scene类名，如果找不到则返回None
        """
        import re
        
        # 查找继承自Scene的类
        pattern = r"class\s+(\w+)\s*\(\s*Scene\s*\)"
        match = re.search(pattern, code)
        
        if match:
            return match.group(1)
        
        return None
    
    def _find_video_file(self, output_dir: str, scene_name: str) -> Optional[str]:
        """
        查找生成的视频文件
        
        Args:
            output_dir: 输出目录
            scene_name: Scene类名
            
        Returns:
            视频文件路径，如果找不到则返回None
        """
        # 视频通常存放在videos子目录中
        video_dir = os.path.join(output_dir, "videos")
        
        # 如果videos目录不存在，尝试直接在output_dir中查找
        if not os.path.exists(video_dir):
            video_dir = output_dir
        
        # 遍历目录查找最新的匹配视频
        latest_video = None
        latest_time = 0
        
        for root, dirs, files in os.walk(video_dir):
            for file in files:
                if scene_name in file and (file.endswith('.mp4') or file.endswith('.mov')):
                    file_path = os.path.join(root, file)
                    file_time = os.path.getmtime(file_path)
                    
                    if file_time > latest_time:
                        latest_time = file_time
                        latest_video = file_path
        
        return latest_video