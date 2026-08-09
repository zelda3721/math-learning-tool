"""
generate_manim_code — produce / fix Manim code with full visualization rules.

Static rules live in `prompt_templates/generate_manim.md`. Per-call we
inject only the current verified solution, its open-world visual plan, and
error-local documentation in fix mode.  Similar-problem templates are kept
out of the production prompt so an unseen problem cannot be forced into a
closed taxonomy.
"""

from __future__ import annotations

import ast
import json
import logging
import re
import textwrap
from typing import Any

from ....application.interfaces import (
    ArtifactSpec,
    ChatMessage,
    ILLMProvider,
    ITool,
    ToolContext,
    ToolResult,
)
from .. import scope_refine as sref
from ..manim_api_kb import get_kb as get_manim_kb
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)


_LATEX_OFF = "系统未安装 LaTeX，**严禁使用 MathTex / Tex / Matrix**，所有公式用 Text 表示。"
_LATEX_ON = "已安装 LaTeX。可使用 MathTex 显示英文公式；中文仍推荐 Text。"


_GRADE_HINT: dict[str, str] = {
    "elementary_lower": (
        "小学低年级：从可直接观察和操作的对象开始；一次只引入一个关系，"
        "语言短、节奏慢，符号必须在视觉含义建立后才出现。"
        "画面禁止出现未知数字母与方程记号；数量变化用单位图形逐个演示。"
    ),
    "elementary_upper": (
        "小学高年级：先呈现数量之间的可见关系，再逐步压缩为符号表达；"
        "关键操作应可暂停、可复述，避免长串抽象推导。"
        "画面禁止出现未知数字母与方程记号；用算术图形（分组、替换、凑整）承载推理。"
    ),
    "middle": (
        "初中：符号变化要和一个稳定视觉表征同步；明确变量、约束和变化方向，不要让屏幕只剩公式行。"
        "方程按天平表达：两侧同时可见、操作同步作用于两侧、平衡状态全程可见。"
    ),
    "high": (
        "高中：允许多表征同步，但每个时刻只有一个注意焦点；用连续变化、"
        "局部强调和最终回代建立因果链。函数问题以图像为主体，代数式作注释。"
    ),
    "advanced": (
        "大学及以上：可使用二维、三维或动态参数表示；抽象符号必须有稳定的"
        "空间或行为语义，并明确假设、边界与验证。"
        "矩阵、变换等有几何意义的对象先演示几何效果（网格/基向量被变换），再给代数计算。"
    ),
}


def _format_steps(steps: list[dict[str, Any]] | Any) -> str:
    if not steps:
        return "（未提供）"
    # Defensive: solve_problem normally writes list[dict], but bad parsing or
    # a malformed JSON fallback could leave us with list[str] / str / dict.
    # Coerce gracefully so we never crash here.
    if isinstance(steps, str):
        return steps[:1000]  # take it as a single pre-formatted block
    if isinstance(steps, dict):
        steps = [steps]
    if not isinstance(steps, list):
        return "（步骤格式异常，无法解析）"
    lines = []
    for i, s in enumerate(steps):
        if isinstance(s, str):
            lines.append(f"{i + 1}. {s}")
            continue
        if not isinstance(s, dict):
            lines.append(f"{i + 1}. {s!r}")
            continue
        n = s.get("step_number", i + 1)
        desc = s.get("description") or ""
        op = s.get("operation") or ""
        res = s.get("result") or ""
        line = f"{n}. {desc} | 运算: {op} | 结果: {res}".rstrip(" |")
        lines.append(line)
    return "\n".join(lines)


def _extract_code(content: str) -> str:
    """Extract Python even when a local model forgets the closing fence.

    Token-limited models quite commonly emit `````python`` and then hit the
    output limit before writing the final fence.  Requiring a balanced pair
    made the fence itself become line 1 of the saved source, which then sent
    the workflow into an expensive regenerate loop.
    """
    value = (content or "").replace("\r\n", "\n").strip()
    opener = re.search(r"```(?:python|py)?[ \t]*\n", value, re.IGNORECASE)
    if opener:
        body = value[opener.end() :]
        closer = re.search(r"\n```(?:[ \t]*$|[ \t]*\n)", body)
        if closer:
            body = body[: closer.start()]
        return body.strip()

    # Some OpenAI-compatible backends prepend one sentence despite a
    # pure-source instruction.  The import is a reliable language boundary.
    start = value.find("from manim import")
    if start > 0:
        value = value[start:]
    return re.sub(r"\n```[ \t]*$", "", value).strip()


def _remove_point_move_to_calls(code: str) -> str:
    """Remove impossible ``point.move_to(...)`` chains with balanced parsing.

    ``get_center()`` returns a NumPy point, not a Mobject. A permissive caption
    rewrite in an earlier draft could accidentally attach ``move_to`` to that
    point. Keeping the point itself is the intended argument to the outer
    Mobject's ``move_to``.
    """
    marker = ".get_center().move_to("
    while marker in code:
        start = code.index(marker)
        open_index = start + len(".get_center().move_to")
        depth = 0
        close_index: int | None = None
        for index in range(open_index, len(code)):
            if code[index] == "(":
                depth += 1
            elif code[index] == ")":
                depth -= 1
                if depth == 0:
                    close_index = index
                    break
        if close_index is None:
            break
        keep_until = start + len(".get_center()")
        code = code[:keep_until] + code[close_index + 1 :]
    return code


def _remove_overlapping_t2c_keys(code: str) -> str:
    """Keep literal Text color spans unambiguous for Pango/Manim."""
    mapping = re.compile(r"t2c\s*=\s*\{(?P<body>[^{}\n]*)\}")
    entry = re.compile(
        r"(?P<raw>(?P<quote>['\"])(?P<key>.*?)(?P=quote)\s*:\s*[^,}]+)"
    )

    def replace(match: re.Match[str]) -> str:
        entries = list(entry.finditer(match.group("body")))
        keys = [item.group("key") for item in entries]
        kept = [
            item.group("raw").strip()
            for item in entries
            if not any(
                item.group("key") != other and item.group("key") in other
                for other in keys
            )
        ]
        if len(kept) == len(entries) or not kept:
            return match.group(0)
        return "t2c={" + ", ".join(kept) + "}"

    return mapping.sub(replace, code)


def _sanitize_code(code: str) -> str:
    code = _remove_point_move_to_calls(code)
    code = _remove_overlapping_t2c_keys(code)
    # Axes.get_axis_labels() defaults to MathTex("x"), MathTex("y") even
    # when generated source contains no explicit Tex call. Use Pango labels
    # so no-LaTeX installations remain renderable.
    code = re.sub(
        r"(?m)^(?P<indent>[ \t]*)(?P<var>[A-Za-z_]\w*)\s*=\s*"
        r"(?P<axes>[A-Za-z_]\w*)\.get_axis_labels\(\s*\)\s*$",
        lambda match: (
            f"{match.group('indent')}{match.group('var')} = VGroup("
            f"Text('x', font_size=24).next_to("
            f"{match.group('axes')}.x_axis.get_end(), RIGHT), "
            f"Text('y', font_size=24).next_to("
            f"{match.group('axes')}.y_axis.get_end(), UP))"
        ),
        code,
    )
    code = re.sub(
        r"(?P<prefix>\b(?:x_axis_config|y_axis_config|axis_config)\s*=\s*\{)"
        r"(?P<body>[^{}\n]*(?:[\"']?include_numbers[\"']?\s*:\s*True|"
        r"[\"']?numbers_to_include[\"']?\s*:)[^{}\n]*)\}",
        lambda match: (
            match.group(0)
            if "label_constructor" in match.group("body")
            else f"{match.group('prefix')}{match.group('body').rstrip()}, "
            "\"label_constructor\": Text}"
        ),
        code,
    )
    code = re.sub(
        r"(?m)^(?P<indent>[ \t]*)(?P<var>label\w*|[A-Za-z_]\w*label\w*)"
        r"\.next_to\((?P<args>[^\n]+)\)\s*$"
        r"(?!\n(?P=indent)(?P=var)\.shift_onto_screen)",
        lambda match: (
            f"{match.group(0)}\n{match.group('indent')}"
            f"{match.group('var')}.shift_onto_screen(buff=0.3)"
        ),
        code,
    )
    # Mechanical compatibility migrations are safer and much faster than
    # asking the model to rewrite an otherwise valid scene.  These aliases
    # preserve animation semantics across ManimCE versions.
    code = re.sub(r"\bShowCreation\b", "Create", code)
    code = re.sub(r"\b([A-Za-z_]\w*)\.get_graph\(", r"\1.plot(", code)
    graph_axes = {
        graph: axes
        for graph, axes in re.findall(
            r"(?m)^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.plot\(", code
        )
    }
    for graph, axes in graph_axes.items():
        code = re.sub(
            rf"\b{re.escape(graph)}\.get_point_at_x\(([^()\n]+)\)",
            rf"{axes}.i2gp(\1, {graph})",
            code,
        )
    # ManimCE shapes do not accept the matplotlib-style ``fill=True``
    # keyword.  Generated scenes often already provide fill_opacity; dropping
    # the boolean preserves that intended fill and avoids a render-only
    # TypeError.  When no opacity is present, an outline is safer than
    # guessing a visual value.
    code = re.sub(
        r"(?P<prefix>[,(]\s*)fill\s*=\s*True\s*,?\s*",
        r"\g<prefix>",
        code,
    )
    # Line/VMobject in ManimCE 0.19 does not accept this matplotlib-style
    # dash keyword.  A solid line preserves topology; use DashedLine when
    # dashing itself carries meaning.
    code = re.sub(
        r"(?P<prefix>[,(]\s*)stroke_dash_array\s*=\s*\[[^\]]*\]\s*,?\s*",
        r"\g<prefix>",
        code,
    )
    code = re.sub(
        r"(?P<prefix>[,(]\s*)stroke_dashes\s*=\s*[^,)]+\s*,?\s*",
        r"\g<prefix>",
        code,
    )
    code = re.sub(
        r"(?P<prefix>[,(]\s*)stroke_dashed\s*=\s*[^,)]+\s*,?\s*",
        r"\g<prefix>",
        code,
    )
    # `NONE` is not a Manim color constant. Models commonly use the SVG/CSS
    # idiom `stroke_color=NONE` when they mean a transparent outline.
    code = re.sub(r"\bstroke_color\s*=\s*NONE\b", "stroke_opacity=0", code)
    # Only the first `.animate` creates Manim's animation builder. A second
    # `.animate` in the same chain resolves as a method wrapper and crashes.
    code = re.sub(
        r"(?m)(\.animate\.[^,\n]*?)\.animate\.",
        r"\1.",
        code,
    )
    # A loop variable such as ``corner`` is already a 3D point. Wrapping it
    # with ORIGIN inside another list creates a ragged array at render time.
    code = re.sub(
        r"\.move_to\(\[\s*([A-Za-z_]\w*)\s*,\s*ORIGIN\s*,\s*0\s*\]\)",
        r".move_to(\1)",
        code,
    )
    # Never make a mobject become a group that contains itself: Manim's copy
    # graph then recurses forever. Rebinding the local variable preserves the
    # intended grouped panel and subsequent positioning/return statements.
    code = re.sub(
        r"(?m)^(?P<indent>[ \t]*)(?P<var>[A-Za-z_]\w*)\.become\(VGroup\("
        r"(?P=var),\s*(?P<rest>[^\n]+)$",
        lambda match: (
            f"{match.group('indent')}{match.group('var')} = VGroup("
            f"{match.group('var')}, {match.group('rest')[:-1]}"
        ),
        code,
    )
    # NumberLine's default numeric labels are TeX-backed. Use Pango Text in
    # no-LaTeX deployments even when the generated source contains no Tex.
    def _number_line_without_latex(match: re.Match[str]) -> str:
        body = match.group("body")
        if "label_constructor" not in body:
            body = re.sub(
                r"include_numbers\s*=\s*True",
                "include_numbers=True, label_constructor=Text",
                body,
            )
        return f"NumberLine({body})"

    code = re.sub(
        r"NumberLine\((?P<body>[^)]*include_numbers\s*=\s*True[^)]*)\)",
        _number_line_without_latex,
        code,
    )
    # Once a NumberLine is the visible coordinate reference, positions must
    # use its own mapping. A separate `value * SCALE` disagrees whenever the
    # line has a non-zero range start or was moved/resized.
    axis_match = re.search(
        r"(?m)^[ \t]*(?P<axis>axis|number_line|[A-Za-z_]\w*(?:_axis|_number_line))"
        r"\s*=\s*(?:NumberLine|[A-Za-z_]\w*)\(",
        code,
        re.IGNORECASE,
    )
    if axis_match and "NumberLine(" in code:
        axis_name = axis_match.group("axis")
        code = re.sub(
            r"\[\s*(?P<x>[^,\[\]]+?)\s*\*\s*SCALE\s*,\s*"
            r"(?P<y>-?\d+(?:\.\d+)?)\s*,\s*0\s*\]",
            lambda match: (
                f"{axis_name}.n2p({match.group('x').strip()})"
                f" + UP * ({match.group('y')})"
            ),
            code,
        )
    # ``camera.frame`` exists on MovingCameraScene, not the base Scene.
    # Promote the generated scene instead of deleting camera behavior.
    if re.search(r"\bself\.camera\.frame\b", code):
        code = re.sub(
            r"class\s+SolutionScene\s*\(\s*Scene\s*\)",
            "class SolutionScene(MovingCameraScene)",
            code,
        )

    # Repeated temporary caption factory calls leave every caption on screen.
    # Normalize the common shape to one persistent object updated in place.
    if not re.search(r"(?m)^\s*caption\s*=", code):
        caption_call = re.compile(
            r"^(?P<indent>[ \t]*)self\.play\(\s*(?:Write|FadeIn)\(\s*"
            r"(?P<factory>[A-Za-z_]\w*caption\w*)\((?P<arg>TEACHING_LINES\[\s*\d+\s*\])\)"
            r"\s*\)\s*\)\s*$",
            re.MULTILINE | re.IGNORECASE,
        )
        matches = list(caption_call.finditer(code))
        if len(matches) >= 2:
            replacement_index = 0

            def _replace_caption_call(match: re.Match[str]) -> str:
                nonlocal replacement_index
                replacement_index += 1
                indent = match.group("indent")
                factory = match.group("factory")
                arg = match.group("arg")
                if replacement_index == 1:
                    return (
                        f"{indent}caption = {factory}({arg})\n"
                        f"{indent}self.play(Write(caption))"
                    )
                next_name = f"next_caption_{replacement_index}"
                return (
                    f"{indent}{next_name} = {factory}({arg})\n"
                    f"{indent}self.play(Transform(caption, {next_name}))"
                )

            code = caption_call.sub(_replace_caption_call, code)

    # VGroup has arrange()/arrange_in_grid(), but no arrange_in_circle() in
    # ManimCE 0.19.  Preserve the requested spacing in a stable row layout;
    # visual planning may choose explicit polar coordinates when a true arc
    # carries mathematical meaning.
    def _replace_arrange_in_circle(match: re.Match[str]) -> str:
        args = match.group("args")
        buff_match = re.search(r"\bbuff\s*=\s*([^,)]+)", args)
        buff = buff_match.group(1).strip() if buff_match else "0.5"
        return f".arrange(RIGHT, buff={buff}).move_to(ORIGIN)"

    code = re.sub(
        r"\.arrange_in_circle\((?P<args>[^)]*)\)",
        _replace_arrange_in_circle,
        code,
    )
    # Assigning to imported Manim color constants inside construct() makes
    # every right-hand reference local and can raise UnboundLocalError (for
    # example ``GREEN = GREEN``).  Keep the canonical constants instead.
    code = re.sub(
        r"(?m)^[ \t]+(?:RED|BLUE|GREEN|ORANGE|YELLOW|WHITE|BLACK|GRAY|GREY)\s*=\s*[^\n]+\n",
        "",
        code,
    )
    # Generated code often stores metadata tuples such as (i, j, line), then
    # later expands the tuple list directly into VGroup.  VGroup only accepts
    # Mobjects; in this established shape the final tuple item is the visual
    # object.  Normalize the starred expansion before render time.
    tuple_lists = set(re.findall(r"\b([A-Za-z_]\w*)\.append\s*\(\s*\([^()\n]+\)\s*\)", code))
    for list_name in tuple_lists:
        code = re.sub(
            rf"\*{re.escape(list_name)}\b",
            f"*[item[-1] for item in {list_name}]",
            code,
        )
    # ``Text.set_fill(BLACK)`` colors the glyphs; it does not add a readable
    # background.  Caption/subtitle variables commonly use it by mistake.
    code = re.sub(
        r"\b((?:[A-Za-z_]\w*caption\w*|caption|[A-Za-z_]\w*subtitle\w*|subtitle))\.set_fill\(\s*BLACK\s*,\s*opacity\s*=\s*([^)]+)\)",
        r"\1.add_background_rectangle(color=BLACK, opacity=\2)",
        code,
        flags=re.IGNORECASE,
    )
    code = re.sub(
        r"Star\(\s*scale_factor\s*=\s*([^,)]+)\s*,\s*([^)]*)\)",
        r"Star(\2).scale(\1)",
        code,
    )
    code = re.sub(
        r"Star\(\s*scale_factor\s*=\s*([^,)]+)\s*\)",
        r"Star().scale(\1)",
        code,
    )
    if "TEACHING_LINES" in code:
        code = re.sub(
            r"Text\(\s*(['\"])Loading(?:\.\.\.)?\1\s*,",
            r"Text(TEACHING_LINES[0],",
            code,
            flags=re.IGNORECASE,
        )
        # Every generated teaching line gets the same deterministic maximum
        # width guard. This only shrinks long text; it never enlarges short
        # captions, and therefore remains safe across arbitrary content.
        guarded_caption_lines: list[str] = []
        caption_assignment = re.compile(
            r"^(?P<indent>[ \t]*)(?P<var>[A-Za-z_]\w*)\s*=\s*"
            r"Text\(\s*(?:self\.)?TEACHING_LINES\[\s*\d+\s*\]"
        )
        source_lines = code.splitlines()
        for index, line in enumerate(source_lines):
            guarded_caption_lines.append(line)
            match = caption_assignment.match(line)
            if match is None:
                continue
            var = match.group("var")
            lookahead = "\n".join(source_lines[index + 1 : index + 4])
            if re.search(rf"\bif\s+{re.escape(var)}\.width\s*>", lookahead):
                continue
            indent = match.group("indent")
            guarded_caption_lines.extend(
                [
                    f"{indent}if {var}.width > 10.8:",
                    f"{indent}    {var}.scale_to_fit_width(10.8)",
                ]
            )
        code = "\n".join(guarded_caption_lines)
        # Empty Text has no points; positioning it with set_x/set_y can fail
        # before the first caption update.
        code = re.sub(
            r"\b((?:[A-Za-z_]\w*caption\w*|caption|[A-Za-z_]\w*subtitle\w*|subtitle))\s*=\s*Text\(\s*(['\"])\2\s*,",
            r"\1 = Text(TEACHING_LINES[0],",
            code,
            flags=re.IGNORECASE,
        )
    # Keep one stable caption reference; ReplacementTransform removes the
    # original object and leaves the Python variable stale.
    code = re.sub(
        r"ReplacementTransform\(\s*((?:[A-Za-z_]\w*caption\w*|caption|[A-Za-z_]\w*subtitle\w*|subtitle))\s*,",
        r"Transform(\1,",
        code,
        flags=re.IGNORECASE,
    )
    # MoveToTarget requires obj.generate_target() and obj.target mutation.
    # Normalize the common invalid shorthand to a direct movement animation.
    code = re.sub(
        r"MoveToTarget\(\s*([A-Za-z_]\w*)\s*,\s*target_position\s*=\s*([A-Za-z_]\w*)\s*\)",
        r"\1.animate.move_to(\2)",
        code,
    )
    # A Python list has no Manim layout methods.  Wrapping the existing
    # mobject references in a temporary VGroup moves the original objects and
    # keeps later list indexing valid.
    list_vars = set(
        re.findall(
            r"(?m)^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:\[[^\n]*\]|\[[^\n]+\bfor\b[^\n]+\])\s*$",
            code,
        )
    )
    for list_name in list_vars:
        code = re.sub(
            rf"\b{re.escape(list_name)}\.(arrange(?:_in_grid)?)\(",
            rf"VGroup(*{list_name}).\1(",
            code,
        )
    # FadeIn/FadeOut accept displacement as the keyword ``shift``.  A second
    # positional vector is interpreted as another mobject and fails inside
    # Group construction.
    code = re.sub(
        r"\b(FadeIn|FadeOut)\((Text\([^\n]+\)),\s*(UP|DOWN|LEFT|RIGHT)\s*\)",
        r"\1(\2, shift=\3)",
        code,
    )
    code = re.sub(
        r"\b(FadeIn|FadeOut)\(([A-Za-z_]\w*),\s*(UP|DOWN|LEFT|RIGHT)\s*\)",
        r"\1(\2, shift=\3)",
        code,
    )

    # Manim points are 3D. Local models often provide (x, y) tuples through
    # variables named coord/pos/point, producing a broadcast error at runtime.
    def _expand_2d_position(match: re.Match[str]) -> str:
        name = match.group(1)
        if not re.search(r"(?:coord|pos|point)", name, flags=re.IGNORECASE):
            return match.group(0)
        return f".move_to(np.append({name}, 0) if len({name}) == 2 else {name})"

    code = re.sub(
        r"\.move_to\(\s*([A-Za-z_]\w*)\s*\)",
        _expand_2d_position,
        code,
    )
    # `move_to(x, y)` treats y as Manim's aligned_edge argument and crashes
    # because a scalar is not a direction vector.  Two positional scalar
    # expressions unambiguously mean a 2D coordinate; install the required z.
    code = re.sub(
        r"\.move_to\(\s*([^,()\n]+?)\s*,\s*([^,()\n]+?)\s*\)",
        lambda match: f".move_to([{match.group(1).strip()}, {match.group(2).strip()}, 0])",
        code,
    )
    # The same 3D-point contract applies to geometry constructor keywords.
    # Convert literal two-component expressions while leaving named vectors
    # and already-three-component coordinates untouched.
    code = re.sub(
        r"\b(start|end|point)\s*=\s*\(\s*([^,()\n]+?)\s*,\s*([^,()\n]+?)\s*\)",
        lambda match: f"{match.group(1)}=({match.group(2).strip()}, {match.group(3).strip()}, 0)",
        code,
    )
    # Do not append a fourth component when a repair uses a position that is
    # already `[x, y, z]`; retain the safe conditional form for both cases.
    code = re.sub(
        r"np\.append\(\s*([A-Za-z_]\w*)\s*,\s*0(?:\.0)?\s*\)"
        r"(?:\s+if\s+len\(\s*\1\s*\)\s*==\s*2\s+else\s+\1)?",
        lambda match: (
            f"np.append({match.group(1)}, 0) if len({match.group(1)}) == 2 else {match.group(1)}"
        ),
        code,
    )

    # Normalize two-component list literals used as positional Line endpoints.
    # Only inspect positional arguments before the first keyword, avoiding
    # unrelated lists in style options.
    def _expand_line_endpoint_lists(match: re.Match[str]) -> str:
        args = match.group(1)
        keyword = re.search(r"\b[A-Za-z_]\w*\s*=", args)
        split = keyword.start() if keyword else len(args)
        positional, options = args[:split], args[split:]
        positional = re.sub(
            r"\[\s*([^,\[\]\n]+?)\s*,\s*([^,\[\]\n]+?)\s*\]",
            lambda point: f"[{point.group(1).strip()}, {point.group(2).strip()}, 0]",
            positional,
        )
        return f"Line({positional}{options})"

    code = re.sub(r"\bLine\(([^\n]*)\)", _expand_line_endpoint_lists, code)
    # VGroup has no Python-style get_index(item) API; Manim's dynamic
    # attribute fallback turns this into a confusing runtime TypeError.
    # Iterating a VGroup yields its submobjects, so list(...).index(...) is
    # the direct, semantics-preserving equivalent.
    code = re.sub(
        r"\b([A-Za-z_]\w*)\.get_index\(\s*([A-Za-z_]\w*)\s*\)",
        r"list(\1).index(\2)",
        code,
    )
    # Some model outputs invent get_part(s)_by_class. Current Manim exposes
    # neither spelling. Drop the assignment when its result is unused; when
    # it is used, lower it to the supported get_family()+isinstance form.
    family_lookup = re.compile(
        r"^(?P<indent>[ \t]*)(?P<target>[A-Za-z_]\w*)\s*=\s*"
        r"(?P<object>[A-Za-z_]\w*)\.get_parts?_by_class\("
        r"(?P<class>[A-Za-z_]\w*)\)(?P<comment>\s*#.*)?$"
    )
    family_lines = code.splitlines()
    normalized_family_lines: list[str] = []
    for index, line in enumerate(family_lines):
        match = family_lookup.match(line)
        if match is None:
            normalized_family_lines.append(line)
            continue
        later = "\n".join(family_lines[index + 1 :])
        if not re.search(rf"\b{re.escape(match.group('target'))}\b", later):
            continue
        normalized_family_lines.append(
            f"{match.group('indent')}{match.group('target')} = VGroup(*[part for part in "
            f"{match.group('object')}.get_family() if isinstance(part, {match.group('class')})])"
        )
    code = "\n".join(normalized_family_lines)
    # In Manim 0.20 arrange_in_grid forwards buff into vector arithmetic;
    # a plain 2-tuple can produce a 2D-vs-3D broadcast failure. Collapse the
    # common horizontal/vertical tuple to one safe scalar spacing.
    code = re.sub(
        r"(arrange_in_grid\([^\n]*?\bbuff\s*=\s*)\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)",
        r"\1max(\2, \3)",
        code,
    )
    # Text does not accept a background_rect constructor keyword in current
    # Manim. A background can be added explicitly after construction; remove
    # the unsupported flag so preflight does not fail before the scene starts.
    code = re.sub(r",?\s*background_rect\s*=\s*(?:True|False)", "", code)
    # A temporary Text chain cannot be guarded in place: scale_to_fit_width
    # enlarges short labels as well as shrinking long ones. Split the common
    # assignment shape into a stable variable plus a maximum-width guard.
    # This migration is deterministic and avoids spending another LLM turn
    # on a mechanical Manim API correction.
    chained_text_lines: list[str] = []
    chained_text = re.compile(
        r"^([ \t]*)([A-Za-z_]\w*)\s*=\s*(Text\(.*)\.scale_to_fit_width\(([^()\n]+)\)\s*$"
    )
    for line in code.splitlines():
        match = chained_text.match(line)
        if not match:
            chained_text_lines.append(line)
            continue
        indent, variable, expression, width = match.groups()
        chained_text_lines.extend(
            [
                f"{indent}{variable} = {expression}",
                f"{indent}if {variable}.width > {width}:",
                f"{indent}    {variable}.scale_to_fit_width({width})",
            ]
        )
    code = "\n".join(chained_text_lines)
    # The same anti-pattern also appears inline as a Transform target. There
    # is no stable variable to guard, so remove only the eager fit operation;
    # the requested font size is preserved and later layout checks still catch
    # genuinely oversized text. This is a local API repair, not scene rewrite.
    code = re.sub(
        r"(Text\([^\n]*?\))\.scale_to_fit_width\([^()\n]+\)",
        r"\1",
        code,
    )
    # self.play expects animations as separate positional arguments, not one
    # Python list produced by a comprehension.
    code = re.sub(
        r"self\.play\(\s*\[(?P<body>[^\n]+\bfor\b[^\n]+)\]\s*,",
        r"self.play(*[\g<body>],",
        code,
    )
    # Migrate Manim's removed ``self.play(mobject.method, value, ...)`` API
    # when the legacy method has one simple positional argument. This is a
    # mechanical compatibility repair, not a semantic rewrite.
    legacy_play_method = re.compile(
        r"self\.play\(\s*(?P<object>[A-Za-z_]\w*)\."
        r"(?P<method>set_color|set_opacity|shift|move_to|scale)\s*,\s*"
        r"(?P<value>[^,\n]+?)\s*,"
    )
    code = legacy_play_method.sub(
        lambda match: (
            f"self.play({match.group('object')}.animate.{match.group('method')}"
            f"({match.group('value').strip()}),"
        ),
        code,
    )
    # A direct caption Transform to a fresh Text defaults the target to the
    # origin, pulling a correctly docked subtitle through the main diagram.
    # Preserve the source caption's current anchor for this common shape.
    code = re.sub(
        r"Transform\(\s*(?P<source>(?:caption|subtitle)(?:[A-Za-z_]\w*)?|"
        r"[A-Za-z_]\w*(?:caption|subtitle))\s*,\s*"
        r"(?P<target>Text\([^()\n]*\))(?!\.move_to)\s*\)",
        lambda match: (
            f"Transform({match.group('source')}, {match.group('target')}.move_to("
            f"{match.group('source')}.get_center()))"
        ),
        code,
        flags=re.IGNORECASE,
    )
    code = _remove_point_move_to_calls(code)
    # A same-object Transform is a no-op and often survives repeated local
    # fixes. Remove only the complete play statement with this exact shape.
    code = re.sub(
        r"(?m)^[ \t]*self\.play\(\s*Transform\(\s*([A-Za-z_]\w*)\s*,\s*\1\s*\)\s*\)[ \t]*\n?",
        "",
        code,
    )
    # A direct become() mutates an on-screen object immediately. If the same
    # variable is then passed to Transform a few lines later, the animation
    # starts from its destination and becomes visually empty. Remove only
    # this close-proximity setup mutation so Transform can show the change.
    become_lines: list[str] = []
    source_lines = code.splitlines()
    direct_become = re.compile(r"^[ \t]*([A-Za-z_]\w*)\.become\(")
    for index, line in enumerate(source_lines):
        match = direct_become.match(line)
        if match:
            nearby = "\n".join(source_lines[index + 1 : index + 16])
            if re.search(rf"\bTransform\(\s*{re.escape(match.group(1))}\s*,", nearby):
                continue
        become_lines.append(line)
    code = "\n".join(become_lines)
    # Manim's scale_to_fit_width also enlarges small objects. Generated code
    # nearly always intends a maximum-width guard for captions.
    guarded_lines: list[str] = []
    scale_line = re.compile(r"^([ \t]*)([A-Za-z_]\w*)\.scale_to_fit_width\(([^)\n]+)\)[ \t]*$")
    for line in code.splitlines():
        match = scale_line.match(line)
        previous = next((item.strip() for item in reversed(guarded_lines) if item.strip()), "")
        if match and previous != f"if {match.group(2)}.width > {match.group(3)}:":
            indent, variable, width = match.groups()
            guarded_lines.extend(
                [
                    f"{indent}if {variable}.width > {width}:",
                    f"{indent}    {variable}.scale_to_fit_width({width})",
                ]
            )
        else:
            guarded_lines.append(line)
    code = "\n".join(guarded_lines)
    # set_height preserves aspect ratio and can turn a narrow bar into a
    # screen-wide slab. Bar-like indicators need independent Y stretching.
    code = re.sub(
        r"\b([A-Za-z_]\w*bar\w*)\.set_height\(",
        r"\1.stretch_to_fit_height(",
        code,
        flags=re.IGNORECASE,
    )
    code = re.sub(
        r"\b([A-Za-z_]\w*bar\w*\.copy\(\))\.set_height\(",
        r"\1.stretch_to_fit_height(",
        code,
        flags=re.IGNORECASE,
    )
    # A common model slip is to define a helper inside construct(), then call
    # it as a Scene method. Correct only names proven to be nested functions.
    nested_helpers = set(re.findall(r"(?m)^(?: {8}|\t{2})def\s+([A-Za-z_]\w*)\s*\(", code))
    for helper in nested_helpers:
        code = re.sub(rf"\bself\.{re.escape(helper)}\s*\(", f"{helper}(", code)
    code = re.sub(r",?\s*rate_func\s*=\s*(ease_\w+|easeIn\w*|easeOut\w*)", "", code)
    for color in (
        "ORANGE_E",
        "BLUE_D",
        "BLUE_E",
        "RED_A",
        "GREEN_E",
        "GREEN_D",
        "YELLOW_E",
        "LIGHT_BLUE",
    ):
        code = re.sub(rf"\b{color}\b", "BLUE", code)
    # Normalize the cold-start card to a readable baseline. Width/height
    # guards still shrink unusually long prompts, so this does not overflow.
    code = re.sub(
        r"Text\(\s*((?:self\.)?PROBLEM_TEXT)\s*,\s*font_size\s*=\s*\d+(?:\.\d+)?",
        r"Text(\1, font_size=40",
        code,
    )
    return code


def _wrap_problem_for_card(problem: str) -> str:
    value = " ".join((problem or "").strip().split())
    if not value:
        return value
    # Text scales a whole line to the frame width.  Keeping CJK lines near
    # 22 glyphs avoids shrinking an otherwise ordinary question into a tiny
    # title; Latin text can safely carry roughly twice as many characters.
    width = 22 if re.search(r"[\u3400-\u9fff]", value) else 48
    return "\n".join(
        textwrap.wrap(
            value,
            width=width,
            break_long_words=True,
            break_on_hyphens=False,
        )
    )


def _ensure_problem_text(code: str, problem: str) -> str:
    """Install the exact current problem and deterministic readable wrapping."""
    wrapped = _wrap_problem_for_card(problem)
    literal = json.dumps(wrapped, ensure_ascii=False)
    triple = re.compile(
        r"(?P<prefix>\bPROBLEM_TEXT\s*=\s*)(?P<quote>\"\"\"|''')"
        r"(?P<body>.*?)(?P=quote)",
        re.DOTALL,
    )
    if triple.search(code):
        code = triple.sub(lambda match: match.group("prefix") + literal, code)
    else:
        simple = re.compile(
            r"(?P<prefix>\bPROBLEM_TEXT\s*=\s*)(?:\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')"
        )
        if simple.search(code):
            code = simple.sub(lambda match: match.group("prefix") + literal, code)
        else:
            import_match = re.search(r"(?m)^from manim import \*\s*$", code)
            if import_match:
                code = (
                    code[: import_match.end()]
                    + f"\n\nPROBLEM_TEXT = {literal}"
                    + code[import_match.end() :]
                )
            else:
                code = f"PROBLEM_TEXT = {literal}\n" + code

    # Normalize inline temporary question cards to one stable object. Creating
    # a second Text(PROBLEM_TEXT) inside FadeOut leaves the displayed instance
    # behind and prevents lifecycle validation.
    inline_card = re.compile(
        r"^(?P<indent>[ \t]*)self\.play\(\s*(?:Write|FadeIn|AddTextLetterByLetter)\(\s*"
        r"(?P<expr>(?:Text|Paragraph)\(\s*PROBLEM_TEXT\b.*)\)\s*\)\s*$"
    )
    normalized_lines: list[str] = []
    inline_indent: str | None = None
    for line in code.splitlines():
        match = inline_card.match(line)
        if match and inline_indent is None:
            inline_indent = match.group("indent")
            normalized_lines.extend(
                [
                    f"{inline_indent}problem_card = {match.group('expr')}",
                    f"{inline_indent}self.play(Write(problem_card))",
                ]
            )
            continue
        if (
            inline_indent is not None
            and line.startswith(inline_indent + "self.play(")
            and "FadeOut" in line
            and re.search(r"(?:Text|Paragraph)\(\s*PROBLEM_TEXT\b", line)
        ):
            normalized_lines.append(f"{inline_indent}self.play(FadeOut(problem_card))")
            continue
        normalized_lines.append(line)
    code = "\n".join(normalized_lines)

    # Existing problem cards get the same max-width/max-height protection as
    # injected cards. Local models often remember to show the question but
    # forget that a 16:9 frame is much shorter than it is wide.
    guarded_problem_lines: list[str] = []
    problem_assignment = re.compile(
        r"^(?P<indent>[ \t]*)(?P<var>[A-Za-z_]\w*)\s*=\s*"
        r"(?:Text|Paragraph)\(\s*(?:self\.)?PROBLEM_TEXT\b"
    )
    source_lines = code.splitlines()
    for index, line in enumerate(source_lines):
        guarded_problem_lines.append(line)
        match = problem_assignment.match(line)
        if match is None:
            continue
        var = match.group("var")
        lookahead = "\n".join(source_lines[index + 1 : index + 8])
        indent = match.group("indent")
        if not re.search(rf"\bif\s+{re.escape(var)}\.width\s*>", lookahead):
            guarded_problem_lines.extend(
                [
                    f"{indent}if {var}.width > 11.0:",
                    f"{indent}    {var}.scale_to_fit_width(11.0)",
                ]
            )
        if not re.search(rf"\bif\s+{re.escape(var)}\.height\s*>", lookahead):
            guarded_problem_lines.extend(
                [
                    f"{indent}if {var}.height > 5.2:",
                    f"{indent}    {var}.scale_to_fit_height(5.2)",
                ]
            )
    code = "\n".join(guarded_problem_lines)

    # If the model defined PROBLEM_TEXT but never created a visible card,
    # inject a standard safe opening deterministically. This is presentation
    # infrastructure, not problem-specific teaching logic.
    if not re.search(r"(?:Text|Paragraph)\(\s*(?:self\.)?PROBLEM_TEXT\b", code):
        lines = code.splitlines()
        insertion_index = -1
        insertion_indent = ""
        local_assignment = re.compile(r"^([ \t]+)PROBLEM_TEXT\s*=")
        for index, line in enumerate(lines):
            match = local_assignment.match(line)
            if match:
                insertion_index = index + 1
                insertion_indent = match.group(1)
                break
        if insertion_index < 0:
            construct_def = re.compile(r"^([ \t]*)def\s+construct\s*\(self\)\s*:")
            for index, line in enumerate(lines):
                match = construct_def.match(line)
                if match:
                    insertion_index = index + 1
                    insertion_indent = match.group(1) + "    "
                    break
        if insertion_index >= 0:
            opening = [
                f"{insertion_indent}problem_card = Text(PROBLEM_TEXT, font_size=40, color=WHITE)",
                f"{insertion_indent}if problem_card.width > 11.0:",
                f"{insertion_indent}    problem_card.scale_to_fit_width(11.0)",
                f"{insertion_indent}if problem_card.height > 5.2:",
                f"{insertion_indent}    problem_card.scale_to_fit_height(5.2)",
                f"{insertion_indent}problem_card.move_to(ORIGIN)",
                f"{insertion_indent}self.play(Write(problem_card))",
                f"{insertion_indent}self.wait(3)",
                f"{insertion_indent}self.play(FadeOut(problem_card))",
                "",
            ]
            lines[insertion_index:insertion_index] = opening
            code = "\n".join(lines)

    # Enforce the cold-start ordering for the common single-line play shape.
    # Local models often initialize a caption correctly but animate it before
    # the question card. Delay those construct-level plays until the question
    # fades, preserving the objects and the rest of the scene unchanged.
    lines = code.splitlines()
    card_index = -1
    card_name = ""
    card_indent = ""
    assignment = re.compile(
        r"^([ \t]*)([A-Za-z_]\w*)\s*=\s*(?:Text|Paragraph)\(\s*(?:self\.)?PROBLEM_TEXT\b"
    )
    for index, line in enumerate(lines):
        match = assignment.match(line)
        if match:
            card_index = index
            card_indent, card_name = match.groups()
            break
    if card_index >= 0:
        early_ranges: list[tuple[int, int]] = []
        index = 0
        while index < card_index:
            if not lines[index].startswith(
                (card_indent + "self.play(", card_indent + "self.add(")
            ):
                index += 1
                continue
            start = index
            depth = lines[index].count("(") - lines[index].count(")")
            while depth > 0 and index + 1 < card_index:
                index += 1
                depth += lines[index].count("(") - lines[index].count(")")
            early_ranges.append((start, index + 1))
            index += 1

        delayed: list[str] = []
        for start, end in early_ranges:
            delayed.extend(lines[start:end])
        for start, end in reversed(early_ranges):
            del lines[start:end]

        # Re-resolve the card after removing any multiline pre-card plays.
        card_index = next(
            (
                index
                for index, line in enumerate(lines)
                if assignment.match(line)
                and assignment.match(line).group(2) == card_name  # type: ignore[union-attr]
            ),
            -1,
        )
        show_index = next(
            (
                index
                for index in range(card_index + 1, len(lines))
                if lines[index].startswith(
                    (card_indent + "self.play(", card_indent + "self.add(")
                )
                and re.search(rf"\b{re.escape(card_name)}\b", lines[index])
            ),
            -1,
        )
        fade_index = next(
            (
                index
                for index in range(show_index + 1, len(lines))
                if show_index >= 0
                and lines[index].startswith(card_indent + "self.play(")
                and "FadeOut" in lines[index]
                and re.search(rf"\b{re.escape(card_name)}\b", lines[index])
            ),
            -1,
        )
        if show_index >= 0 and fade_index > show_index:
            # Keep the reading interval atomic. A caption or solution object
            # inserted between showing and hiding the card competes with the
            # question and may reveal reasoning before the student has read it.
            interstitial_ranges: list[tuple[int, int]] = []
            index = show_index + 1
            while index < fade_index:
                if not lines[index].startswith(
                    (card_indent + "self.play(", card_indent + "self.add(")
                ):
                    index += 1
                    continue
                start = index
                depth = lines[index].count("(") - lines[index].count(")")
                while depth > 0 and index + 1 < fade_index:
                    index += 1
                    depth += lines[index].count("(") - lines[index].count(")")
                block = "\n".join(lines[start : index + 1])
                if not re.search(rf"\b{re.escape(card_name)}\b", block):
                    interstitial_ranges.append((start, index + 1))
                index += 1
            for start, end in interstitial_ranges:
                delayed.extend(lines[start:end])
            for start, end in reversed(interstitial_ranges):
                del lines[start:end]
            fade_index = next(
                (
                    index
                    for index in range(show_index + 1, len(lines))
                    if lines[index].startswith(card_indent + "self.play(")
                    and "FadeOut" in lines[index]
                    and re.search(rf"\b{re.escape(card_name)}\b", lines[index])
                ),
                -1,
            )
            if delayed:
                lines[fade_index + 1 : fade_index + 1] = delayed
                code = "\n".join(lines)
    return code


def _extract_manim_code_with_fallback(done: Any) -> tuple[str, str]:
    """Try done.text first; if no `from manim` showing up, also scan
    done.reasoning. Returns (code, source_label)."""
    candidates: list[tuple[str, str]] = []
    if getattr(done, "text", ""):
        candidates.append(("text", done.text))
    if getattr(done, "reasoning", ""):
        candidates.append(("reasoning", done.reasoning))
    for label, content in candidates:
        code = _sanitize_code(_extract_code(content))
        if code and "from manim" in code:
            return code, label
    return "", "none"


class GenerateManimCodeTool(ITool):
    def __init__(
        self,
        *,
        llm: ILLMProvider,
        prompts: PromptLibrary,
        use_latex: bool,
    ) -> None:
        self._llm = llm
        self._prompts = prompts
        self._use_latex = use_latex

    @property
    def name(self) -> str:
        return "generate_manim_code"

    @property
    def description(self) -> str:
        return (
            "生成或修复 Manim 可视化代码。如果传入 previous_code + error_hint，"
            "则按修复模式工作（最小改动消除错误并保持教学逻辑）。否则按生成模式。"
            "调用前必须已有已验证的 solution_steps、answer 和开放式 visual_plan。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "problem": {"type": "string", "description": "题目原文"},
                "grade": {"type": "string", "description": "学生年级"},
                "solution_steps": {
                    "type": "array",
                    "description": "解题步骤数组，每项含 description / operation / result",
                    "items": {"type": "object"},
                },
                "answer": {"type": "string", "description": "最终答案"},
                "previous_code": {"type": "string"},
                "error_hint": {"type": "string"},
                "extra_instructions": {"type": "string"},
                "fix_scope": {
                    "type": "string",
                    "enum": ["line", "block", "global"],
                    "description": "（可选）显式覆盖修复 scope；缺省自动从 error_hint 分类。"
                    "line=只改 ±1 行，block=改一个 Phase/method 段，global=整文件重写",
                },
            },
            "required": [],
        }

    async def _do_scoped_fix(
        self,
        *,
        fix_scope: sref.Scope,
        previous_code: str,
        error_hint: str,
        ctx: ToolContext,
    ) -> str | None:
        """Surgically fix a region of the code without re-prompting from
        scratch. Returns the patched full code, or None if the fix didn't
        produce something usable (caller should fall back to global)."""
        line_no = sref.extract_error_line(error_hint)
        if line_no is None:
            # Without a concrete traceback location there is no sound block
            # boundary. Picking the file center can splice out construct() or
            # another unrelated phase; fall through to the full-context fix.
            return None

        # RITL-DOC: pull relevant Manim API docs for *both* line and block
        # paths. Smaller, focused fixes benefit even more from "here's the
        # exact API signature" than full rewrites do.
        kb_snippet = ""
        try:
            hits = get_manim_kb().lookup(error_hint, top_k=2)
            if hits:
                kb_snippet = "\n\n" + get_manim_kb().render_section(
                    hits, max_chars=1200 if fix_scope == "line" else 1800
                )
        except Exception:
            logger.exception("RITL-DOC retrieval failed in scoped fix (non-fatal)")

        if fix_scope == "line":
            snippet, lo, hi = sref.extract_line_context(previous_code, line_no=line_no, radius=1)
            instr = (
                "你是 Manim 代码修复器。下面是出错代码的 `±1 行片段`，"
                "**只修复其中的语法/调用错误**，不要重写其它内容。\n\n"
                f"### 错误信息\n{error_hint.strip()[:1000]}\n\n"
                f"### 出错片段（行 {lo}-{hi}）\n```python\n{snippet}\n```"
                f"{kb_snippet}\n\n"
                "**直接输出修复后的同一段 Python 代码块**（行数尽量保持不变；"
                "如果必须增减一行，可以接受），用 ```python``` 包起来。"
                "不要解释、不要输出整文件。"
            )
            max_tokens = 512
        else:  # block
            block_text, lo, hi = sref.extract_enclosing_block(previous_code, line_no=line_no)
            instr = (
                "你是 Manim 代码修复器。下面是出错代码的 `一个 Phase/method 块`，"
                "**只在这个块内修改**，让它满足下面的错误提示。块外代码已经"
                "正常，请不要重写。\n\n"
                f"### 错误信息\n{error_hint.strip()[:1500]}\n\n"
                f"### 出错块（行 {lo}-{hi}）\n```python\n{block_text}\n```"
                f"{kb_snippet}\n\n"
                "**直接输出修复后的整段块代码**（保持开头/结尾的 Phase 注释或"
                "缩进风格不变），用 ```python``` 包起来。不要输出整文件。"
            )
            max_tokens = 1536

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=instr)],
                temperature=0.2,
                max_tokens=max_tokens,
            )
        except Exception:
            logger.exception("scope_refine LLM call failed")
            return None

        snippet_out = _extract_code(getattr(done, "text", "") or "")
        if not snippet_out:
            snippet_out = _extract_code(getattr(done, "reasoning", "") or "")
        if not snippet_out.strip():
            return None

        snippet_out = _sanitize_code(snippet_out)
        patched = sref.splice_lines(
            previous_code, start_line=lo, end_line=hi, replacement=snippet_out
        )

        # Sanity: must still be valid Python; otherwise fall back
        try:
            compile(patched, "<scoped_fix>", "exec")
        except SyntaxError as exc:
            logger.info(
                "scope_refine: patched code still has syntax error %s; falling back",
                exc,
            )
            return None

        # A syntactically valid splice can still erase the scene entry point.
        # Preserve this invariant before accepting a cheap scoped repair.
        try:
            patched_tree = ast.parse(patched)
        except SyntaxError:
            return None
        solution_classes = [
            node
            for node in patched_tree.body
            if isinstance(node, ast.ClassDef) and node.name == "SolutionScene"
        ]
        if len(solution_classes) != 1:
            return None
        constructs = [
            node
            for node in solution_classes[0].body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "construct"
        ]
        if len(constructs) != 1:
            return None

        return patched

    def _build_user_message(
        self,
        *,
        problem: str,
        grade: str,
        solution_steps: list[dict[str, Any]] | None,
        answer: str,
        previous_code: str | None,
        error_hint: str | None,
        extra: str | None,
    ) -> str:
        parts = [
            "### 题目",
            problem.strip() or "（缺失）",
            f"\n年级: {grade}",
            "\n### 解题步骤",
            _format_steps(solution_steps),
            f"\n### 最终答案\n{answer.strip() or '（缺失）'}",
        ]
        if previous_code:
            parts.append(
                "\n### 上一次生成的代码（修复其中的错误）\n"
                f"```python\n{previous_code.strip()[:5000]}\n```"
            )
        if error_hint:
            parts.append(f"\n### 上一次的错误信息\n{error_hint.strip()[:2000]}")
        if extra:
            parts.append(f"\n### 额外指引\n{extra.strip()}")
        return "\n".join(parts)

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        problem = (args.get("problem") or ctx.problem or "").strip()
        grade = args.get("grade") or ctx.grade
        solution_steps = args.get("solution_steps") or ctx.state.get("solution_steps") or []
        answer = args.get("answer") or ctx.state.get("solution_answer") or ""

        if ctx.state.get("solution_verified") is not True:
            return ToolResult(
                success=False,
                summary="解答尚未通过 verify_solution，拒绝生成可能讲错的成片",
                error="solution_not_verified",
            )
        if not solution_steps:
            return ToolResult(
                success=False,
                summary="缺少解题步骤——请先调用 solve_problem 工具",
                error="missing_solution_steps",
            )
        if not isinstance(ctx.state.get("visual_plan"), dict):
            return ToolResult(
                success=False,
                summary="缺少开放式 visual_plan，不能降级为无视觉论证生成",
                error="missing_visual_plan",
            )

        previous_code = args.get("previous_code") or ctx.state.get("latest_manim_code") or ""
        # Pull error hints from multiple state sources in priority order:
        # explicit args → run_manim error → inspect_video visual issues
        error_hint = (
            args.get("error_hint")
            or ctx.state.get("last_run_error")
            or ctx.state.get("last_validation_issues")
            or ctx.state.get("last_visual_issues")
            or ""
        )
        # Defensive: state values can occasionally be non-strings (e.g. dict
        # serialized from an earlier crash payload). Coerce to str so the
        # later .strip()/[:N] calls don't AttributeError.
        if not isinstance(previous_code, str):
            previous_code = str(previous_code) if previous_code else ""
        if not isinstance(error_hint, str):
            error_hint = str(error_hint) if error_hint else ""
        is_fix_mode = bool(previous_code and error_hint)
        if is_fix_mode and ctx.state.get("last_error_source") == "inspect":
            ctx.state["visual_local_fix_attempted"] = True

        # ---- ScopeRefine: decide if we should attempt a small-scope fix ----
        # Three tiers: line / block / global. Smaller is faster & cheaper but
        # risks getting stuck on hard errors. We auto-classify the error and
        # honor an explicit `fix_scope` arg override. Attempts are tracked in
        # state so we can escalate after K failures at one tier.
        fix_scope: sref.Scope = "global"
        if is_fix_mode:
            attempts = dict(ctx.state.get("fix_attempt_count") or {})
            requested = (args.get("fix_scope") or "").strip().lower()
            if requested in {"line", "block", "global"}:
                fix_scope = requested  # type: ignore[assignment]
            else:
                err_source = ctx.state.get("last_error_source") or "run"
                inspect_payload = (
                    ctx.state.get("last_inspect_payload") if err_source == "inspect" else None
                )
                inferred = sref.classify_error_scope(
                    error_hint,
                    source=err_source if err_source in ("validate", "run", "inspect") else "run",
                    inspect_payload=inspect_payload,
                )
                # Escalate if we've already used up budget at the inferred tier
                escalated = sref.next_scope(inferred, attempts_so_far=attempts)
                if escalated is None:
                    # Budget exhausted → tell caller to replan visually
                    ctx.state["force_visual_replan"] = True
                    return ToolResult(
                        success=False,
                        summary="所有修复 scope 预算耗尽，需要重走 visual_plan",
                        error="fix_budget_exhausted",
                        data={"attempts": attempts, "last_error": error_hint[:300]},
                    )
                fix_scope = escalated
            attempts[fix_scope] = attempts.get(fix_scope, 0) + 1
            ctx.state["fix_attempt_count"] = attempts
            ctx.state["last_fix_scope"] = fix_scope

        # Fast path: line/block scope — surgically replace a small region
        # without re-rendering the whole prompt. ~3-5× cheaper, finishes in
        # 5-15s on a 35B local model instead of 30-60s.
        if is_fix_mode and fix_scope in ("line", "block"):
            patched = await self._do_scoped_fix(
                fix_scope=fix_scope,
                previous_code=previous_code,
                error_hint=error_hint,
                ctx=ctx,
            )
            if patched is not None:
                patched = _ensure_problem_text(patched, problem)
                ctx.state["latest_manim_code"] = patched
                ctx.state["last_validation_passed"] = False
                ctx.state.pop("last_validation_issues", None)
                for key in (
                    "latest_video_path",
                    "latest_video_url",
                    "last_visual_review",
                    "last_visual_failed",
                    "last_run_error",
                    "retry_semantic_audit",
                    "semantic_audit_retry_count",
                ):
                    ctx.state.pop(key, None)
                logger.info(
                    "scope_refine: %s-fix succeeded for session %s",
                    fix_scope,
                    ctx.session_id,
                )
                return ToolResult(
                    success=True,
                    summary=f"已通过 {fix_scope}-scope 局部修复",
                    data={"code": patched, "fix_scope": fix_scope},
                    artifacts=[
                        ArtifactSpec(
                            kind="manim_code",
                            content=patched,
                            meta={"fix_scope": fix_scope},
                        ),
                    ],
                )
            # Falls through to global path if the scoped fix returned None
            logger.info(
                "scope_refine: %s-fix failed, falling through to global",
                fix_scope,
            )
            ctx.state["last_fix_scope"] = "global"

        visual_plan = ctx.state.get("visual_plan") or None
        extra = args.get("extra_instructions") or ctx.state.get("extra_directives") or None
        generation_retry_hint = ctx.state.get("last_generation_error") or ""
        if generation_retry_hint:
            retry_text = (
                "上一次源码因输出截断而不完整。请显著压缩实现：删除解释性注释、"
                "重复代码和装饰，只保留完整可运行的教学动画。"
            )
            extra = f"{extra}\n{retry_text}" if extra else retry_text

        # ---- assemble template slot strings ---------------------------------
        latex_section = _LATEX_ON if self._use_latex else _LATEX_OFF
        grade_section = _GRADE_HINT.get(grade, _GRADE_HINT["elementary_upper"])

        # Only the plan derived from this problem is included.  Stored skills,
        # nearest-neighbour examples, and unverified single-session rules are
        # intentionally excluded from cold-start generation.
        visual_plan_section = ""
        if isinstance(visual_plan, dict):
            scenes_raw = visual_plan.get("scenes") or []
            scene_lines = []
            for i, s in enumerate(scenes_raw, start=1):
                if not isinstance(s, dict):
                    scene_lines.append(f"  场景 {i}: {s!r}")
                    continue
                scene_lines.append(
                    f"  场景 {i} ({s.get('role', '?')}, zone {s.get('anchor_zone', '?')}) — "
                    f"key_objects: {(s.get('key_objects') or '')[:80]}; "
                    f"action: {(s.get('action') or '')[:80]}; "
                    f"invariant: {(s.get('invariant') or '')[:60]}; "
                    f"attention: {(s.get('attention_target') or '')[:60]}; "
                    f"exit: {(s.get('exit_condition') or '')[:60]}; "
                    f"teaching_line: {s.get('teaching_line') or ''}; "
                    f"duration_s: {s.get('duration_s') or '?'}"
                )
            forbidden = visual_plan.get("forbidden") or []
            forbidden = forbidden if isinstance(forbidden, list) else []
            forbidden_lines = "\n".join(f"  - {x}" for x in forbidden[:6])
            essence = visual_plan.get("essence_rationale") or ""
            essence = essence.strip() if isinstance(essence, str) else ""
            thesis = visual_plan.get("visual_thesis") or visual_plan.get("primary_pattern") or ""
            ledger = visual_plan.get("symbol_ledger") or []
            ledger_lines = "\n".join(f"  - {item}" for item in ledger[:12])
            visual_ir = {
                "visual_objects": visual_plan.get("visual_objects") or [],
                "scenes": [
                    {
                        "role": scene.get("role"),
                        "actions": scene.get("actions") or [],
                    }
                    for scene in scenes_raw
                    if isinstance(scene, dict)
                ],
            }

            # essence_rationale comes FIRST in the section: it's the
            # north-star. Every animation choice must serve this.
            visual_plan_section = (
                "## 视觉计划（来自 visual_plan，**严格遵照**）\n"
                + (
                    "### ⭐ 本质（essence_rationale，所有动画必须服务于这条）\n"
                    f"> {essence}\n\n"
                    "**写代码时反复回看这条**：每一个 self.play(...) / Transform / "
                    "动画的目的都应该是让观众看到上述的不变量/对应/守恒/变换。"
                    "如果某段动画与这条 rationale 无关，就删掉。\n\n"
                    if essence
                    else ""
                )
                + f"visual_thesis: **{thesis}**\n"
                + "\n符号账本：\n"
                + ledger_lines
                + "\n\n结构化 Visual IR（源码必须逐项实现，文字不能代替）：\n```json\n"
                + json.dumps(visual_ir, ensure_ascii=False, indent=2)
                + "\n```"
                + "\n\n场景脚本：\n"
                + "\n".join(scene_lines)
                + "\n\n禁用反模式：\n"
                + forbidden_lines
                + "\n\n**这份计划是硬约束**：必须有 role=transform 场景；"
                "anchor_zone 描述当前 beat 的主活动区，后续 beat 可以复用；"
                "不允许把 action 退化成纯 Text 切换；key_objects 必须真的出现在画面里。"
            )

        fix_mode_section = ""
        if is_fix_mode:
            fix_mode_section = (
                "## 当前是修复模式\n"
                "保留原有教学逻辑，只针对错误信息做最小修改。"
                "若错误是 LaTeX，将所有 MathTex/Tex 替换为 Text。"
            )

        # RITL-DOC: when fix-mode, retrieve relevant Manim API docs based on
        # the error_hint. Token budget bounded (~2400 chars) so this never
        # blows up the prompt — better-than-nothing context for what the
        # right API actually looks like, instead of letting the model guess
        # again from training memory.
        manim_api_kb_section = ""
        if is_fix_mode and error_hint:
            try:
                kb = get_manim_kb()
                hits = kb.lookup(error_hint, top_k=3)
                if hits:
                    manim_api_kb_section = kb.render_section(hits, max_chars=2400)
                    logger.info(
                        "RITL-DOC: injected %d KB entries for session %s: %s",
                        len(hits),
                        ctx.session_id,
                        [h.name for h in hits],
                    )
            except Exception:
                logger.exception("RITL-DOC retrieval failed (non-fatal)")

        user_message = self._build_user_message(
            problem=problem,
            grade=grade,
            solution_steps=solution_steps,
            answer=answer,
            previous_code=previous_code,
            error_hint=error_hint,
            extra=extra,
        )

        prompt = self._prompts.render(
            "generate_manim",
            latex_section=latex_section,
            grade_section=grade_section,
            visual_plan_section=visual_plan_section,
            fix_mode_section=fix_mode_section,
            manim_api_kb_section=manim_api_kb_section,
            user_message=user_message,
        )

        try:
            done = await self._llm.chat_complete(
                messages=[ChatMessage(role="user", content=prompt)],
                # Production generation optimizes first-pass compliance.
                # Retry diversity is deliberately not used as a quality
                # mechanism; a single evidence-directed fallback is enough.
                temperature=0.2,
                # The prompt enforces a compact implementation, while this
                # ceiling still leaves enough room for CJK strings and a
                # syntactically complete final class on local models.
                max_tokens=5120 if is_fix_mode else 4608,
            )
        except Exception as exc:
            logger.exception("generate_manim_code LLM call failed")
            return ToolResult(success=False, summary="代码生成失败", error=str(exc))

        code, code_source = _extract_manim_code_with_fallback(done)
        if not code:
            logger.warning(
                "generate_manim_code: no code found | finish=%s text_len=%d "
                "reasoning_len=%d text_head=%r reasoning_head=%r",
                getattr(done, "finish_reason", "?"),
                len(getattr(done, "text", "") or ""),
                len(getattr(done, "reasoning", "") or ""),
                (getattr(done, "text", "") or "")[:300],
                (getattr(done, "reasoning", "") or "")[:300],
            )
            return ToolResult(
                success=False,
                summary="模型返回内容中找不到合法的 Manim 代码",
                error="no_code",
                data={
                    "raw_text": (done.text or "")[:800],
                    "raw_reasoning": (done.reasoning or "")[:800],
                    "finish_reason": getattr(done, "finish_reason", None),
                },
            )
        code = _ensure_problem_text(code, problem)
        if getattr(done, "finish_reason", None) == "length":
            try:
                compile(code, "<generated_manim>", "exec")
            except SyntaxError as exc:
                ctx.state["last_generation_error"] = "truncated_output"
                return ToolResult(
                    success=False,
                    summary="模型输出达到长度上限且源码不完整，将用紧凑实现重试",
                    error="truncated_code",
                    data={"syntax_error": f"Line {exc.lineno}: {exc.msg}"},
                )
        if code_source == "reasoning":
            logger.warning("generate_manim_code fell back to reasoning channel")

        ctx.state.pop("last_generation_error", None)

        ctx.state["latest_manim_code"] = code
        ctx.state["last_validation_passed"] = False  # validate must be re-run
        ctx.state.pop("last_validation_issues", None)
        for key in (
            "latest_video_path",
            "latest_video_url",
            "last_visual_review",
            "last_visual_failed",
            "last_run_error",
            "retry_semantic_audit",
            "semantic_audit_retry_count",
        ):
            ctx.state.pop(key, None)

        filename = f"code-turn{ctx.turn_index:02d}.py"
        artifacts = [
            ArtifactSpec(
                kind="manim_code",
                filename=filename,
                content=code,
                meta={
                    "mode": "fix" if is_fix_mode else "generate",
                    "turn_index": ctx.turn_index,
                    "code_source": code_source,
                },
            )
        ]

        return ToolResult(
            success=True,
            summary=(
                f"已{'修复' if is_fix_mode else '生成'}代码 {len(code)} 字符，"
                "请下一步调用 validate_manim_code"
            ),
            data={
                "code": code,
                "length": len(code),
                "mode": "fix" if is_fix_mode else "generate",
                "filename": filename,
                "code_source": code_source,
            },
            artifacts=artifacts,
        )
