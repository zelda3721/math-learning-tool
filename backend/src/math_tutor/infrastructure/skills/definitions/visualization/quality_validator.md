# Quality Validator Skill

## 描述
代码质量验证技能，用于在执行Manim代码前检测潜在问题，确保生成的视频质量。

## 何时使用
- 在ManimExecutor执行代码前自动调用
- 调试Agent修复代码后进行验证
- 代码生成后的质量检查

## 验证项目

### 1. 元素重叠检测
检查是否存在以下重叠风险：
- 多个元素使用相同坐标
- 未使用VGroup和arrange管理布局
- 文字与图形之间缺少足够间距

### 2. 场景切换合理性
检查场景切换是否合理：
- FadeOut次数是否过多（>5次警告）
- 是否缺少Transform（有多个Write但无Transform）
- 步骤间元素是否正确保留

### 3. 中文字体设置
检查所有Text是否设置中文字体：
- 必须包含 `font="Noto Sans CJK SC"`
- MathTex中的中文需要特殊处理

### 4. 尺寸和边界
检查元素是否会超出屏幕：
- VGroup是否有scale操作
- 元素是否在安全区域内（[-5,5] x [-3,3]）

### 5. 代码语法
基本语法检查：
- Python语法正确性
- Manim API使用正确性

## 验证代码模板

```python
def validate_manim_code(code: str) -> dict:
    """
    验证Manim代码质量
    
    Returns:
        {
            "valid": bool,
            "score": float (0-100),
            "issues": [
                {"type": "error|warning", "message": str, "line": int}
            ],
            "suggestions": [str]
        }
    """
    issues = []
    suggestions = []
    score = 100
    
    # 1. 元素重叠检测
    overlap_patterns = [
        (r'\.move_to\(ORIGIN\).*\.move_to\(ORIGIN\)', '多个元素都在ORIGIN，可能重叠'),
        (r'\.to_edge\(UP\).*\.to_edge\(UP\)', '多个元素都在顶部，检查是否有足够间距'),
    ]
    for pattern, msg in overlap_patterns:
        if re.search(pattern, code, re.DOTALL):
            issues.append({"type": "warning", "message": msg})
            score -= 5
    
    # 2. 场景切换检测
    fadeout_count = code.count('FadeOut')
    transform_count = code.count('Transform')
    write_count = code.count('Write')
    
    if fadeout_count > 5:
        issues.append({
            "type": "warning", 
            "message": f"FadeOut使用过多({fadeout_count}次)，建议使用Transform保持连贯"
        })
        score -= 10
        suggestions.append("将FadeOut+Write替换为Transform")
    
    if write_count > 3 and transform_count == 0:
        issues.append({
            "type": "warning",
            "message": "缺少Transform，步骤间建议使用Transform而非重建元素"
        })
        score -= 5
    
    # 3. 中文字体检测
    text_without_font = re.findall(r'Text\([^)]*\)', code)
    for text_call in text_without_font:
        if 'font=' not in text_call and 'font_size' in text_call:
            # 有font_size但没font，可能遗漏
            pass
        if 'Text(' in text_call and 'Noto Sans CJK' not in text_call:
            issues.append({
                "type": "error",
                "message": f"Text缺少中文字体设置: {text_call[:50]}..."
            })
            score -= 15
    
    # 4. 尺寸检测
    if 'VGroup' in code and '.scale(' not in code:
        issues.append({
            "type": "warning",
            "message": "VGroup未进行scale操作，可能超出屏幕边界"
        })
        score -= 5
        suggestions.append("对VGroup添加.scale(0.7)确保不超出边界")
    
    # 5. 语法检测
    try:
        compile(code, '<string>', 'exec')
    except SyntaxError as e:
        issues.append({
            "type": "error",
            "message": f"语法错误: {str(e)}",
            "line": e.lineno
        })
        score -= 30
    
    # 6. 必要元素检测
    if 'class' not in code or 'Scene' not in code:
        issues.append({
            "type": "error",
            "message": "代码缺少Scene类定义"
        })
        score -= 20
    
    if 'def construct' not in code:
        issues.append({
            "type": "error",
            "message": "代码缺少construct方法"
        })
        score -= 20
    
    return {
        "valid": score >= 60 and not any(i["type"] == "error" for i in issues),
        "score": max(0, score),
        "issues": issues,
        "suggestions": suggestions
    }
```

## 使用方式

### 在engine中集成
```python
from skills.skill_loader import skill_loader

# 获取验证技能的prompt
validator_prompt = skill_loader.get_skill('quality_validator').get_prompt()

# 在代码生成后执行验证
def validate_before_execution(code: str) -> tuple[bool, list]:
    """
    Returns: (is_valid, issues_list)
    """
    result = validate_manim_code(code)
    
    if not result["valid"]:
        # 如果有严重问题，尝试自动修复
        for issue in result["issues"]:
            if issue["type"] == "error":
                if "中文字体" in issue["message"]:
                    # 自动添加字体设置
                    code = re.sub(
                        r'Text\(([^,]+),',
                        r'Text(\1, font="Noto Sans CJK SC",',
                        code
                    )
    
    return result["valid"], result["issues"]
```

## 参数说明
本技能不需要外部参数，直接对代码进行分析。

## 输出格式
```json
{
    "valid": true/false,
    "score": 0-100,
    "issues": [
        {"type": "error", "message": "...", "line": 42},
        {"type": "warning", "message": "..."}
    ],
    "suggestions": ["建议1", "建议2"]
}
```

## 注意事项
- ⚠️ score < 60 或存在error时，应触发修复流程
- ⚠️ warning可以忽略，但会影响视频质量
- ⚠️ 某些问题可以自动修复（如添加字体）
- ⚠️ 语法错误必须修复才能执行
