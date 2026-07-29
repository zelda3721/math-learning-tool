"""validate_manim_code — pure-static syntax + quality checks."""

from __future__ import annotations

import ast
import json
import logging
import math
import re
from difflib import SequenceMatcher
from typing import Any

from ....application.interfaces import ChatMessage, ILLMProvider, ITool, ToolContext, ToolResult
from .. import occupancy_table as occ
from ..prompt_library import PromptLibrary

logger = logging.getLogger(__name__)


def _parse_semantic_audit(text: str) -> tuple[bool, list[str], list[str]] | None:
    """Parse the small fail-closed JSON contract returned by the critic."""
    if not text:
        return None
    payload: Any = None
    # Local models sometimes wrap JSON in prose/fences or emit Python-style
    # booleans and quotes. Scan balanced objects one by one instead of taking
    # everything from the first "{" to the final "}".
    for start, char in enumerate(text):
        if char != "{":
            continue
        depth = 0
        quote: str | None = None
        escaped = False
        end = -1
        for index in range(start, len(text)):
            current = text[index]
            if escaped:
                escaped = False
                continue
            if current == "\\" and quote is not None:
                escaped = True
                continue
            if current in {'"', "'"}:
                if quote == current:
                    quote = None
                elif quote is None:
                    quote = current
                continue
            if quote is not None:
                continue
            if current == "{":
                depth += 1
            elif current == "}":
                depth -= 1
                if depth == 0:
                    end = index + 1
                    break
        if end < 0:
            continue
        candidate = text[start:end]
        try:
            payload = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            try:
                payload = ast.literal_eval(candidate)
            except (SyntaxError, ValueError):
                payload = None
        if isinstance(payload, dict):
            break
    if not isinstance(payload, dict):
        return None
    consistent = payload.get("consistent")
    issues = payload.get("issues")
    checked = payload.get("checked_claims")
    if (
        not isinstance(consistent, bool)
        or not isinstance(issues, list)
        or not isinstance(checked, list)
    ):
        return None
    return (
        consistent,
        [str(item) for item in issues if str(item).strip()],
        [str(item) for item in checked if str(item).strip()],
    )


def _extract_zone_map(scenes: list[dict]) -> dict[str, "occ.Zone"]:
    """Heuristic: scan scene's key_objects text for variable-like names
    (e.g. 'title', 'main_group', 'answer_box') and bind each to the scene's
    zone. Empty if we can't infer any var names — better to skip the check
    than emit false positives.
    """
    out: dict[str, "occ.Zone"] = {}
    var_re = re.compile(r"\b([a-z][a-z0-9_]{2,})\b")
    for s in scenes:
        zone_label = (s.get("anchor_zone") or "").strip()
        zone = occ.parse_zone(zone_label) if zone_label else None
        if zone is None:
            continue
        text = (s.get("key_objects") or "").lower()
        # Common pedagogical names
        for token in var_re.findall(text):
            if token in {"the", "and", "with", "for", "from", "this", "that"}:
                continue
            out.setdefault(token, zone)
    return out


_QUALITY_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"self\.play\s*\(", "缺少动画调用 (self.play)"),
    (r"Transform|ReplacementTransform|\.animate\b|MoveAlongPath", "缺少连续状态变换"),
    (r"self\.wait\s*\(", "缺少等待时间 (self.wait)"),
    (r"VGroup|Group", "缺少对象分组"),
)

_LAYOUT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"arrange|arrange_in_grid|next_to|align_to|move_to|to_edge", "缺少明确布局操作"),
)


def _check_syntax(code: str) -> tuple[bool, str | None]:
    try:
        compile(code, "<manim_code>", "exec")
        return True, None
    except SyntaxError as exc:
        return False, f"Line {exc.lineno}: {exc.msg}"


def _check_structure(code: str, *, use_latex: bool) -> list[str]:
    issues: list[str] = []
    if len(code) > 24000:
        issues.append(f"代码异常冗长 ({len(code)} 字符 > 24000)")
    if not re.search(
        r"class\s+SolutionScene\s*\(\s*(?:Scene|MovingCameraScene|ThreeDScene)\s*\)",
        code,
    ):
        issues.append("缺少继承 Scene/MovingCameraScene/ThreeDScene 的 SolutionScene 类")
    if not use_latex and ("MathTex(" in code or "Tex(" in code or "Matrix(" in code):
        issues.append("LaTeX 未启用但代码包含 MathTex/Tex/Matrix")
    if re.search(r"\bText\([^\n]+\)\.scale_to_fit_width\(", code):
        issues.append(
            "禁止对临时 Text(...) 链式 scale_to_fit_width：短文字会被放大；"
            "请赋值后仅在 width 超限时缩小"
        )
    if "from manim" not in code:
        issues.append("缺少 from manim import *")
    try:
        tree = ast.parse(code)
    except SyntaxError:
        tree = None
    if tree is not None and any(isinstance(node, ast.While) for node in ast.walk(tree)):
        issues.append("禁止使用 while 循环：渲染帧数必须由 self.play/run_time 有界控制")
    if tree is not None:
        solution_classes = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and node.name == "SolutionScene"
        ]
        if solution_classes:
            constructs = [
                node
                for node in solution_classes[0].body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == "construct"
            ]
            if len(constructs) != 1:
                issues.append(
                    f"SolutionScene 必须且只能定义一个 construct，当前为 {len(constructs)} 个"
                )
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                continue
            if node.func.id != "range" or not node.args:
                continue
            numeric_args = [
                arg.value
                for arg in node.args
                if isinstance(arg, ast.Constant) and isinstance(arg.value, int)
            ]
            if numeric_args and max(abs(value) for value in numeric_args) > 300:
                issues.append("range 循环上界过大，可能导致渲染超时")
                break
        issues.extend(_check_scene_reference_shadowing(tree))
        issues.extend(_check_animation_api_misuse(tree))
        issues.extend(_check_class_helper_scope_leaks(tree))
        issues.extend(_check_stale_loop_indices(tree))
    # Display labels often contain unique IDs (R1, R2, ...). Comparing their
    # complete text answers "same individual?", not "same semantic class?".
    # Generated code must keep category metadata separately instead of using
    # rendered text as hidden program state.
    if re.search(r"\.get_text\(\)\s*(?:==|!=)\s*[^\n]+\.get_text\(\)", code):
        issues.append(
            "禁止用完整显示文本判断语义类别：编号标签不同不等于类别不同；请使用独立元数据"
        )
    return issues


def _target_names(target: ast.AST) -> set[str]:
    return {node.id for node in ast.walk(target) if isinstance(node, ast.Name)}


def _check_stale_loop_indices(tree: ast.AST) -> list[str]:
    """Reject accidental reuse of a previous loop's terminal index.

    Python deliberately keeps loop variables alive after a loop. In generated
    layout code, reading that stale value from a later loop almost always
    collapses an intended row/column dimension to one terminal coordinate.
    """
    issues: list[str] = []

    def check_body(body: list[ast.stmt]) -> None:
        prior_indices: set[str] = set()
        for statement in body:
            if isinstance(statement, ast.For):
                assigned_here = {
                    name
                    for node in ast.walk(statement)
                    if isinstance(node, ast.For)
                    for name in _target_names(node.target)
                }
                loaded = {
                    node.id
                    for node in ast.walk(statement)
                    if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
                }
                stale = sorted((loaded & prior_indices) - assigned_here)
                if stale:
                    issues.append(
                        "后续循环读取了未重新绑定的旧循环索引 "
                        + ", ".join(stale)
                        + "；Python 会使用上个循环的末值并使布局维度塌缩"
                    )
                prior_indices.update(assigned_here)
            if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                check_body(statement.body)

    check_body(getattr(tree, "body", []))
    return issues


def _check_visual_evidence_contract(
    code: str, visual_plan: dict[str, Any] | None
) -> list[str]:
    """Enforce objective evidence properties declared by the current plan.

    This routes from free-form plan semantics, not from a problem-type enum.
    """
    issues: list[str] = []
    plan_text = json.dumps(visual_plan or {}, ensure_ascii=False).lower()
    countable_signals = (
        "逐项",
        "可数",
        "数一数",
        "单位小方",
        "单位面积",
        "网格",
        "方块",
        "tile",
    )
    if any(signal in plan_text for signal in countable_signals):
        invisible_repeated_tile = False
        try:
            tree = ast.parse(code)
        except SyntaxError:
            tree = None
        if tree is not None:
            for loop in (node for node in ast.walk(tree) if isinstance(node, ast.For)):
                for node in ast.walk(loop):
                    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
                        continue
                    if node.func.id not in {"Rectangle", "Square"}:
                        continue
                    zero_edge = any(
                        keyword.arg in {"stroke_width", "stroke_opacity"}
                        and isinstance(keyword.value, ast.Constant)
                        and keyword.value.value == 0
                        for keyword in node.keywords
                    )
                    if zero_edge:
                        invisible_repeated_tile = True
                        break
                if invisible_repeated_tile:
                    break
        if invisible_repeated_tile:
            issues.append(
                "视觉计划要求单位可逐项计数，但批量 tile 使用零宽/透明边框，"
                "成片会变成实心色块；请保留清晰单元边界或间距"
            )

    # Two independently shown labels with an identical next_to anchor occupy
    # the same pixels unless the earlier label exits first.
    placements: dict[tuple[str, str, str], list[tuple[str, int]]] = {}
    placement_re = re.compile(
        r"(?m)^[ \t]*(?P<var>[A-Za-z_]\w*)\.next_to\(\s*"
        r"(?P<anchor>[A-Za-z_]\w*)\s*,\s*(?P<direction>UP|DOWN|LEFT|RIGHT)"
        r"\s*,\s*buff\s*=\s*(?P<buff>[^)]+)\)"
    )
    for match in placement_re.finditer(code):
        signature = (
            match.group("anchor"),
            match.group("direction"),
            match.group("buff").strip(),
        )
        placements.setdefault(signature, []).append((match.group("var"), match.start()))
    for signature, values in placements.items():
        if len(values) < 2:
            continue
        values.sort(key=lambda item: item[1])
        for (earlier, _), (later, later_pos) in zip(values, values[1:]):
            later_show = re.search(
                rf"(?:FadeIn|Write|Create)\(\s*{re.escape(later)}\b", code[later_pos:]
            )
            if later_show is None:
                continue
            later_show_pos = later_pos + later_show.start()
            earlier_exit = re.search(
                rf"(?:FadeOut|Unwrite|Uncreate|Transform|ReplacementTransform)"
                rf"\(\s*{re.escape(earlier)}\b",
                code[:later_show_pos],
            )
            if earlier_exit is None:
                anchor, direction, buff = signature
                issues.append(
                    f"确定性标签重叠：{earlier} 与 {later} 同时占用 "
                    f"{anchor}.{direction}(buff={buff})，且前者未先离场或变换"
                )
    return issues


def _check_class_helper_scope_leaks(tree: ast.AST) -> list[str]:
    """Reject class helpers that read construct-only local variables.

    A method defined beside construct() is not a closure over construct's
    frame. Generated code commonly puts layout constants inside construct and
    later references them from ``self.set_caption()``, causing a late NameError.
    """
    issues: list[str] = []
    solution_class = next(
        (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and node.name == "SolutionScene"
        ),
        None,
    )
    if solution_class is None:
        return issues
    methods = [node for node in solution_class.body if isinstance(node, ast.FunctionDef)]
    construct = next((node for node in methods if node.name == "construct"), None)
    if construct is None:
        return issues
    construct_locals = _assigned_names(construct)
    module_names = {
        target.id
        for node in getattr(tree, "body", [])
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    construct_only = construct_locals - module_names
    for method in methods:
        if method is construct:
            continue
        params = {arg.arg for arg in method.args.args + method.args.kwonlyargs}
        params.update(arg.arg for arg in method.args.posonlyargs)
        local_names = _assigned_names(method) | params
        loaded = {
            node.id
            for node in ast.walk(method)
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
        }
        leaked = sorted((loaded - local_names) & construct_only)
        if leaked:
            issues.append(
                f"类辅助方法 {method.name} 引用了 construct 局部变量 "
                f"{', '.join(leaked)}；类方法不会捕获 construct 作用域，"
                "请改为参数传入或模块/类常量"
            )
    return issues


def _call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return ""


def _check_animation_api_misuse(tree: ast.AST) -> list[str]:
    """Reject generic Manim patterns that run but express no animation."""
    issues: list[str] = []
    source_parent: dict[ast.AST, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            source_parent[child] = parent

    generated_targets: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr == "generate_target" and isinstance(node.func.value, ast.Name):
            generated_targets.add(node.func.value.id)

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = _call_name(node.func)
        if name == "Transform" and len(node.args) >= 2:
            left, right = node.args[:2]
            if isinstance(left, ast.Name) and isinstance(right, ast.Name) and left.id == right.id:
                issues.append(f"禁止 Transform({left.id}, {left.id})：同对象变换没有可见变化")
        if name == "MoveToTarget" and node.args and isinstance(node.args[0], ast.Name):
            target = node.args[0].id
            if target not in generated_targets:
                issues.append(
                    f"MoveToTarget({target}) 缺少 {target}.generate_target() 和 target 状态"
                )
        if name == "FadeOut" and node.args:
            first = node.args[0]
            if (
                isinstance(first, ast.Call)
                and isinstance(first.func, ast.Name)
                and first.func.id in {"Text", "Paragraph"}
            ):
                issues.append("FadeOut(Text(...)) 创建了未在场的新对象，无法清除原字幕")
        if isinstance(node.func, ast.Attribute) and node.func.attr == "play":
            for arg in node.args:
                if (
                    isinstance(arg, ast.Call)
                    and isinstance(arg.func, ast.Attribute)
                    and isinstance(arg.func.value, ast.Name)
                    and arg.func.value.id == "self"
                ):
                    issues.append(
                        f"self.play(self.{arg.func.attr}(...)) 不能确认返回 Animation；"
                        "辅助方法应在内部调用 self.play，或显式返回 Animation"
                    )
        if isinstance(node.func, ast.Attribute) and node.func.attr == "become":
            value = node.func.value
            if isinstance(value, ast.Attribute) and value.attr == "animate":
                parent = source_parent.get(node)
                inside_play = False
                while parent is not None:
                    if (
                        isinstance(parent, ast.Call)
                        and isinstance(parent.func, ast.Attribute)
                        and parent.func.attr == "play"
                    ):
                        inside_play = True
                        break
                    parent = source_parent.get(parent)
                if not inside_play:
                    issues.append(".animate.become(...) 未传给 self.play，不会产生动画")
    return list(dict.fromkeys(issues))


def _assigned_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for child in ast.walk(node):
        if isinstance(child, (ast.Assign, ast.AnnAssign, ast.AugAssign)):
            targets = child.targets if isinstance(child, ast.Assign) else [child.target]
            for target in targets:
                if isinstance(target, ast.Name):
                    names.add(target.id)
    return names


def _fadeout_names(nodes: list[ast.stmt]) -> set[str]:
    names: set[str] = set()
    for statement in nodes:
        for child in ast.walk(statement):
            if not isinstance(child, ast.Call):
                continue
            function_name = child.func.id if isinstance(child.func, ast.Name) else ""
            if function_name != "FadeOut":
                continue
            names.update(arg.id for arg in child.args if isinstance(arg, ast.Name))
    return names


def _check_scene_reference_shadowing(tree: ast.AST) -> list[str]:
    """Catch a stale on-screen object whose variable is rebound in a loop.

    Rebinding ``v_bar`` while the original bar remains on screen means the
    later ``FadeOut(v_bar)`` targets the new object, leaking the old one into
    the next beat. This is content-agnostic lifecycle validation.
    """
    issues: list[str] = []
    for function in (node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)):
        defined: set[str] = set()
        body = function.body
        for index, statement in enumerate(body):
            if isinstance(statement, (ast.For, ast.AsyncFor)):
                rebound = defined & _assigned_names(statement)
                leaked = rebound & _fadeout_names(body[index + 1 :])
                if leaked:
                    issues.append("循环内覆盖仍需退场的场景对象引用：" + ", ".join(sorted(leaked)))
            defined.update(_assigned_names(statement))
    return issues


def _check_patterns(code: str, patterns: tuple[tuple[str, str], ...]) -> list[str]:
    return [desc for pattern, desc in patterns if not re.search(pattern, code)]


def _normalize_teaching_text(value: str) -> str:
    return re.sub(r"[\s，。！？；：,.!?;:'\"“”‘’（）()\-—]", "", value).lower()


def _extract_display_strings(code: str) -> list[str]:
    """Collect user-visible/string-table literals without matching comments."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return []
    values: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            value = node.value.strip()
            if len(_normalize_teaching_text(value)) >= 4:
                values.append(value)
    return list(dict.fromkeys(values))


def _teaching_similarity(planned: str, candidate: str) -> float:
    left = _normalize_teaching_text(planned)
    right = _normalize_teaching_text(candidate)
    if not left or not right:
        return 0.0
    length_ratio = min(len(left), len(right)) / max(len(left), len(right))
    if length_ratio >= 0.5 and (left in right or right in left):
        return 1.0
    sequence = SequenceMatcher(None, left, right).ratio()
    if re.search(r"[\u3400-\u9fff]", left + right):
        left_units, right_units = set(left), set(right)
    else:
        left_units = set(re.findall(r"[a-z0-9]+", planned.lower()))
        right_units = set(re.findall(r"[a-z0-9]+", candidate.lower()))
    overlap = len(left_units & right_units) / max(1, min(len(left_units), len(right_units)))
    return max(sequence, overlap * 0.75)


def _check_problem_opening(code: str, problem: str) -> list[str]:
    """Require a faithful, visible cold-start question card.

    This is deliberately content-agnostic: it checks the current raw problem,
    not a problem type or a catalog of expected fields.
    """
    expected = _normalize_teaching_text(problem)
    if not expected:
        return ["当前题目为空，无法验证题目开场"]
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return ["代码无法解析，无法验证题目开场"]

    problem_text: str | None = None
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        if not any(
            isinstance(target, ast.Name) and target.id == "PROBLEM_TEXT" for target in targets
        ):
            continue
        value = node.value
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            problem_text = value.value
            break

    issues: list[str] = []
    if problem_text is None:
        return ["缺少字符串常量 PROBLEM_TEXT，成片无法保证先展示当前题目"]
    actual = _normalize_teaching_text(problem_text)
    if actual != expected:
        similarity = _teaching_similarity(problem, problem_text)
        issues.append(
            "PROBLEM_TEXT 未忠实复制当前题目"
            f"（语义相似度 {similarity:.2f}；不得遗漏或改动条件、数值与问题）"
        )

    def contains_problem_text_ctor(node: ast.AST) -> bool:
        if not isinstance(node, ast.Call):
            return False
        problem_arg = bool(node.args) and (
            isinstance(node.args[0], ast.Name)
            and node.args[0].id == "PROBLEM_TEXT"
            or isinstance(node.args[0], ast.Attribute)
            and isinstance(node.args[0].value, ast.Name)
            and node.args[0].value.id == "self"
            and node.args[0].attr == "PROBLEM_TEXT"
        )
        if (
            isinstance(node.func, ast.Name)
            and node.func.id in {"Text", "Paragraph"}
            and problem_arg
        ):
            return True
        # Recognize fluent layout such as Text(PROBLEM_TEXT).scale(...).
        return isinstance(node.func, ast.Attribute) and contains_problem_text_ctor(node.func.value)

    visible_vars: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        value = node.value
        if not contains_problem_text_ctor(value):
            continue
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        visible_vars.update(target.id for target in targets if isinstance(target, ast.Name))
    if not visible_vars:
        issues.append("PROBLEM_TEXT 未传给可见的 Text/Paragraph 题目卡")
        return issues

    # A question Text is commonly wrapped in a VGroup with a background
    # rectangle, then the wrapper is animated.  Follow simple assignment
    # dependencies so `self.play(Write(question_panel))` is recognized as
    # displaying the contained `question_text`.  This is deliberately generic
    # data flow rather than a requirement for a particular variable name or
    # visual style.
    propagated = True
    while propagated:
        propagated = False
        for node in ast.walk(tree):
            if not isinstance(node, (ast.Assign, ast.AnnAssign)):
                continue
            referenced = {child.id for child in ast.walk(node.value) if isinstance(child, ast.Name)}
            if not referenced & visible_vars:
                continue
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            derived = {
                target.id for target in targets if isinstance(target, ast.Name)
            } - visible_vars
            if derived:
                visible_vars.update(derived)
                propagated = True

    solution_class = next(
        (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and node.name == "SolutionScene"
        ),
        None,
    )
    construct = next(
        (
            node
            for node in (solution_class.body if solution_class else [])
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "construct"
        ),
        None,
    )

    # ast.walk(construct) also descends into nested helper definitions. Calls
    # written inside such a helper are not executed at their source location;
    # treating them as early scene beats creates false opening-order failures.
    def walk_construct(node: ast.AST) -> list[ast.AST]:
        found: list[ast.AST] = [node]
        for child in ast.iter_child_nodes(node):
            if child is not construct and isinstance(
                child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
            ):
                continue
            found.extend(walk_construct(child))
        return found

    construct_nodes = walk_construct(construct) if construct is not None else []
    scene_calls: list[ast.Call] = []
    for node in construct_nodes:
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr not in {"play", "add"}:
            continue
        if not isinstance(node.func.value, ast.Name) or node.func.value.id != "self":
            continue
        scene_calls.append(node)
    scene_calls.sort(key=lambda node: (node.lineno, node.col_offset))

    shown = False
    for node in scene_calls:
        referenced = {child.id for child in ast.walk(node) if isinstance(child, ast.Name)}
        if referenced & visible_vars:
            shown = True
            break
    if not shown:
        issues.append("题目卡未在 SolutionScene.construct 中通过 self.play/self.add 显示")
    play_calls = [node for node in scene_calls if node.func.attr == "play"]
    if shown and play_calls:
        first_referenced = {
            child.id for child in ast.walk(play_calls[0]) if isinstance(child, ast.Name)
        }
        if not first_referenced & visible_vars:
            issues.append("题目卡不是 construct 的第一个动画 beat，视频仍会从解答或字幕开场")

    if len(expected) >= 45 and problem_text.count("\n") < 2:
        issues.append("长题目卡未分成至少 3 行，缩成单行会导致字号过小")

    constructor_lines = [
        node.lineno for node in construct_nodes if contains_problem_text_ctor(node)
    ]
    problem_line = min(constructor_lines, default=10**9)
    camera_before_problem = any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in {"scale", "move_to", "shift", "rotate", "set_width"}
        and "camera.frame" in ast.unparse(node.func.value)
        and node.lineno < problem_line
        for node in construct_nodes
    )
    if camera_before_problem:
        issues.append("题目卡展示前修改了 camera.frame，默认安全画幅失效并有裁切风险")
    return issues


def _check_teaching_contract(
    code: str, visual_plan: dict[str, Any] | None
) -> tuple[list[str], int, int]:
    """Require the generated code to carry most planned teaching lines.

    This checks a semantic contract from the current plan, not a catalog of
    problem types. WebVTT is generated separately from the same source.
    """
    scenes = (visual_plan or {}).get("scenes") or []
    planned = [
        str(scene.get("teaching_line") or "").strip()
        for scene in scenes
        if isinstance(scene, dict) and str(scene.get("teaching_line") or "").strip()
    ]
    if not planned:
        return ["视觉计划缺少可执行 teaching_line，无法生成教学字幕"], 0, 0
    # Match planned lines to distinct source string literals. This prevents a
    # single generic caption from satisfying every beat while allowing normal
    # paraphrases from multilingual/local models.
    candidates = _extract_display_strings(code)
    pairs = sorted(
        (
            (_teaching_similarity(line, candidate), line_i, candidate_i)
            for line_i, line in enumerate(planned)
            for candidate_i, candidate in enumerate(candidates)
        ),
        reverse=True,
    )
    used_lines: set[int] = set()
    used_candidates: set[int] = set()
    for score, line_i, candidate_i in pairs:
        if score < 0.35:
            break
        if line_i in used_lines or candidate_i in used_candidates:
            continue
        used_lines.add(line_i)
        used_candidates.add(candidate_i)
    matched = len(used_lines)
    required = max(1, math.ceil(len(planned) * 0.7))
    # Local models often split or merge a planned sentence while preserving
    # every teaching beat. String similarity is only a hint; a stronger
    # structural signal is a TEACHING_LINES literal with enough distinct
    # entries that are actually passed to Text(...). Semantic correctness is
    # checked independently by the source critic and rendered-video review.
    declared_line_count = 0
    try:
        tree = ast.parse(code)
    except SyntaxError:
        tree = None
    if tree is not None:
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            if not any(
                isinstance(target, ast.Name) and target.id == "TEACHING_LINES"
                for target in node.targets
            ):
                continue
            if isinstance(node.value, (ast.List, ast.Tuple)):
                declared_line_count = sum(
                    isinstance(item, ast.Constant) and isinstance(item.value, str)
                    for item in node.value.elts
                )
            break
    displayed_indices = {
        int(value) for value in re.findall(r"Text\(\s*TEACHING_LINES\[\s*(\d+)\s*\]", code)
    }
    structurally_displayed = min(declared_line_count, len(displayed_indices))
    if structurally_displayed >= required:
        matched = max(matched, required)
    issues: list[str] = []
    if matched < required:
        issues.append(
            f"教学字幕契约未满足：计划 {len(planned)} 条，代码仅语义落实 {matched} 条，"
            f"至少需要 {required} 条"
        )
    if len(_TEXT_CTOR_RE.findall(code)) < required:
        issues.append("教学字幕契约未满足：Text 对象不足以承载计划讲解")
    return issues, matched, len(planned)


_ORIGIN_POS_RE = re.compile(
    r"\.move_to\s*\(\s*(?:ORIGIN|np\.array\(\s*\[\s*0\s*,\s*0\s*,?\s*0?\s*\]\s*\)|\[\s*0\s*,\s*0\s*,?\s*0?\s*\])\s*\)"
)
_PLAY_RE = re.compile(r"\bself\.play\s*\(")
_WAIT_RE = re.compile(r"\bself\.wait\s*\(")
_TEXT_CTOR_RE = re.compile(r"\bText\s*\(")
_TO_EDGE_RE = re.compile(r"\.to_edge\s*\(")
_WRITE_RE = re.compile(
    r"\b(?:Write|FadeIn|AddTextLetterByLetter)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)"
)
_FADEOUT_RE = re.compile(r"\bFadeOut\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[\),]")


def _check_overlap_risk(code: str) -> list[str]:
    """Heuristics that catch the most common 'visually broken' patterns."""
    issues: list[str] = []

    # 1) Multiple things move_to(ORIGIN) without arrange/next_to nearby ↓
    origin_moves = len(_ORIGIN_POS_RE.findall(code))
    arrange_count = len(re.findall(r"\barrange|\barrange_in_grid\b", code))
    next_to_count = len(re.findall(r"\bnext_to\b", code))
    if origin_moves >= 2 and (arrange_count + next_to_count) == 0:
        issues.append(f"重叠风险：{origin_moves} 个对象 move_to(ORIGIN) 且无 arrange/next_to")

    # 2) Animation density: 3+ consecutive self.play without a self.wait
    play_positions = [m.start() for m in _PLAY_RE.finditer(code)]
    wait_positions = [m.start() for m in _WAIT_RE.finditer(code)]
    if play_positions:
        consecutive = 0
        max_consecutive = 0
        wi = 0
        for p in play_positions:
            # advance wait pointer until wait > previous play
            while wi < len(wait_positions) and wait_positions[wi] < p:
                wi += 1
            if wi >= len(wait_positions):
                consecutive += 1
            else:
                # there is a wait somewhere later, but is it before next play?
                next_play = (
                    play_positions[play_positions.index(p) + 1]
                    if play_positions.index(p) + 1 < len(play_positions)
                    else None
                )
                if next_play is not None and wait_positions[wi] < next_play:
                    consecutive = 0
                else:
                    consecutive += 1
            max_consecutive = max(max_consecutive, consecutive)
        if max_consecutive >= 4:
            issues.append(f"动画过密：连续 {max_consecutive} 个 self.play 之间没有 self.wait")

    # 3) Many Text objects but no to_edge calls — likely overlap with graphics
    text_count = len(_TEXT_CTOR_RE.findall(code))
    to_edge_count = len(_TO_EDGE_RE.findall(code))
    if text_count >= 4 and to_edge_count == 0:
        issues.append(
            f"布局风险：{text_count} 个 Text 对象但完全没有 to_edge 分区，文字很可能与图形堆叠"
        )

    # 4) wait(0) or extremely short waits
    if re.search(r"self\.wait\s*\(\s*0(?:\.0)?\s*\)", code):
        issues.append("等待时间为 0：题目/答案展示时间不足")

    # 5) Multiple Write/FadeIn of different vars without FadeOut in between
    #    — classic stacked-text-overlap signature (the user has hit this)
    written = _WRITE_RE.findall(code)
    faded = set(_FADEOUT_RE.findall(code))
    if len(written) >= 3:
        unfaded = [v for v in written if v not in faded]
        if len(unfaded) >= 3:
            issues.append(
                f"文字堆叠风险：{len(unfaded)} 个对象 Write/FadeIn 后从未 FadeOut "
                f"（{', '.join(unfaded[:3])}...），它们会在屏幕上一直累积"
            )

    return issues


class ValidateManimCodeTool(ITool):
    def __init__(
        self,
        llm: ILLMProvider | None = None,
        prompts: PromptLibrary | None = None,
    ) -> None:
        self._llm = llm
        self._prompts = prompts

    @property
    def name(self) -> str:
        return "validate_manim_code"

    @property
    def description(self) -> str:
        return (
            "对 Manim 代码做静态校验：Python 语法、必要类、长度、"
            "布局规则、动画质量模式；静态通过后独立核对源码是否忠实实现已验证解答。"
            "校验失败时返回详细问题列表，"
            "你应将这些问题作为 error_hint 传给下一次 generate_manim_code。"
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "完整的 Manim Python 代码",
                },
                "use_latex": {
                    "type": "boolean",
                    "description": "环境是否启用 LaTeX（缺省按系统设置）",
                },
            },
            "required": [],
        }

    async def execute(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        code = args.get("code") or ctx.state.get("latest_manim_code") or ""
        if not code.strip():
            return ToolResult(
                success=False,
                summary="没有代码可校验",
                error="empty_code",
            )

        use_latex = bool(
            args.get("use_latex")
            if args.get("use_latex") is not None
            else ctx.state.get("use_latex", False)
        )

        syntax_ok, syntax_error = _check_syntax(code)
        structure_issues = _check_structure(code, use_latex=use_latex)
        missing_quality = _check_patterns(code, _QUALITY_PATTERNS)
        missing_layout = _check_patterns(code, _LAYOUT_PATTERNS)
        overlap_issues = _check_overlap_risk(code)

        # Occupancy table — extract placements + check against visual_plan zones.
        placements = occ.parse_placements_from_code(code)
        occupancy_overlap = occ.detect_overlap(placements)
        zone_violations: list[str] = []
        visual_plan = ctx.state.get("visual_plan") or {}
        scenes = visual_plan.get("scenes") or []
        visual_evidence_issues = _check_visual_evidence_contract(code, visual_plan)
        teaching_issues, teaching_lines_matched, teaching_lines_planned = _check_teaching_contract(
            code, visual_plan
        )
        problem_opening_issues = _check_problem_opening(code, ctx.problem or "")
        if scenes:
            # Build {var_pattern: Zone} from key_objects (use scene index as
            # the var prefix is unrealistic; fall back to "all elements in
            # any zone"). Conservative: just check no cell has 3+ vars and
            # log a summary.
            declared = _extract_zone_map(scenes)
            if declared:
                zone_violations = occ.detect_zone_violation(placements, declared_zones=declared)

        ctx.state["occupancy_report"] = occ.build_occupancy_report(placements)

        static_valid = (
            syntax_ok
            and not structure_issues
            and not teaching_issues
            and not problem_opening_issues
            and not visual_evidence_issues
        )
        semantic_issues: list[str] = []
        semantic_checked_claims: list[str] = []
        semantic_consistent: bool | None = None
        semantic_audit_warning: str | None = None
        audit_format_failed = False
        if static_valid and self._llm is not None and self._prompts is not None:
            steps = ctx.state.get("solution_steps") or []
            audit_prompt = self._prompts.render(
                "audit_manim_semantics",
                problem=ctx.problem or "",
                answer=ctx.state.get("solution_answer") or "",
                steps_text=json.dumps(steps, ensure_ascii=False, indent=2),
                visual_plan_text=json.dumps(visual_plan, ensure_ascii=False, indent=2),
                code=code,
            )
            try:
                audit_done = await self._llm.chat_complete(
                    messages=[ChatMessage(role="user", content=audit_prompt)],
                    temperature=0.0,
                    max_tokens=1536,
                    extra_body={"chat_template_kwargs": {"enable_thinking": False}},
                )
                audit_text = (getattr(audit_done, "text", "") or "") or (
                    getattr(audit_done, "reasoning", "") or ""
                )
                audit = _parse_semantic_audit(audit_text)
            except Exception as exc:
                logger.exception("Manim semantic audit failed")
                audit = None
                semantic_issues = [f"语义审计调用失败: {exc}"]
            if audit is None:
                audit_format_failed = True
                semantic_consistent = False
                if not semantic_issues:
                    semantic_issues = ["独立语义审计返回格式无效，不能放行教学画面"]
            else:
                semantic_consistent, semantic_issues, semantic_checked_claims = audit
                if not semantic_consistent and not semantic_issues:
                    semantic_issues = ["源码与已验证解答不一致，但审计器未给出具体原因"]

                # A local critic sometimes marks its own hedged commentary as
                # inconsistent even while describing matching counts and
                # mappings.  Only the prompt's machine-auditable contract may
                # block rendering; all other commentary is retained as a
                # warning and the rendered-video critic remains authoritative.
                if not semantic_consistent:
                    blocking = [
                        issue
                        for issue in semantic_issues
                        if issue.strip().startswith("BLOCKING:")
                        and "observed=" in issue
                        and "expected=" in issue
                    ]
                    if blocking:
                        semantic_issues = blocking
                    else:
                        semantic_issues = []
                        semantic_audit_warning = (
                            "语义审计未给出可证伪的 observed/expected 冲突，已交由成片审查复核"
                        )

        if audit_format_failed:
            # Malformed critic output is not a code defect. The independently
            # verified solution, static gates, Manim preflight and rendered
            # video critic remain active, so degrade in this same turn instead
            # of showing repeated red failures or rewriting valid source.
            ctx.state.pop("retry_semantic_audit", None)
            ctx.state.pop("semantic_audit_retry_count", None)
            semantic_consistent = None
            semantic_issues = []
            semantic_audit_warning = "独立语义审计格式无效，已降级到静态与成片审查"
        else:
            ctx.state.pop("retry_semantic_audit", None)
            ctx.state.pop("semantic_audit_retry_count", None)

        valid = static_valid and not semantic_issues
        # Layout heuristics remain warnings; missing planned teaching cues are
        # a hard contract failure because captions cannot be recovered later.

        data = {
            "valid": valid,
            "syntax_ok": syntax_ok,
            "syntax_error": syntax_error,
            "structure_issues": structure_issues,
            "missing_quality_patterns": missing_quality,
            "missing_layout_patterns": missing_layout,
            "overlap_risk_issues": overlap_issues,
            "occupancy_overlap_issues": occupancy_overlap,
            "zone_violations": zone_violations,
            "teaching_contract_issues": teaching_issues,
            "teaching_lines_matched": teaching_lines_matched,
            "teaching_lines_planned": teaching_lines_planned,
            "problem_opening_issues": problem_opening_issues,
            "visual_evidence_issues": visual_evidence_issues,
            "semantic_consistent": semantic_consistent,
            "semantic_audit_issues": semantic_issues,
            "semantic_checked_claims": semantic_checked_claims,
            "semantic_audit_warning": semantic_audit_warning,
            "code_length": len(code),
        }

        if valid:
            ctx.state["last_validation_passed"] = True
            ctx.state.pop("last_validation_issues", None)
            warn_count = (
                len(missing_quality)
                + len(missing_layout)
                + len(overlap_issues)
                + len(occupancy_overlap)
                + len(zone_violations)
                + int(semantic_audit_warning is not None)
            )
            summary = "校验通过"
            if warn_count:
                summary += f"，但有 {warn_count} 条质量警告"
                priority_warns = occupancy_overlap[:1] + zone_violations[:1] + overlap_issues[:1]
                if priority_warns:
                    summary += "（含布局问题：" + "；".join(priority_warns[:2]) + "）"
                elif semantic_audit_warning:
                    summary += f"（{semantic_audit_warning}）"
            return ToolResult(success=True, summary=summary, data=data)

        ctx.state["last_validation_passed"] = False
        problems: list[str] = []
        if syntax_error:
            problems.append(f"语法错误: {syntax_error}")
        problems.extend(structure_issues)
        problems.extend(teaching_issues)
        problems.extend(problem_opening_issues)
        problems.extend(visual_evidence_issues)
        problems.extend(semantic_issues)
        ctx.state["last_validation_issues"] = problems
        ctx.state["last_error_source"] = "validate"
        return ToolResult(
            success=False,
            summary="校验未通过：" + "；".join(problems[:3]),
            data=data,
            error="validation_failed",
        )
