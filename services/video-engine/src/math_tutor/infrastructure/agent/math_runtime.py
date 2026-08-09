"""Safe, open-world deterministic mathematics execution.

The LLM compiles a problem into a small capability-oriented request.  This
module interprets that request with exact SymPy operations; it never selects a
question type and never evaluates arbitrary model-authored Python.
"""
from __future__ import annotations

import ast
import math
import re
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any

import sympy as sp

_FUNCTIONS: dict[str, Any] = {
    "Abs": sp.Abs,
    "abs": sp.Abs,
    "acos": sp.acos,
    "asin": sp.asin,
    "atan": sp.atan,
    "ceiling": sp.ceiling,
    "cos": sp.cos,
    "diff": sp.diff,
    "Eq": sp.Eq,
    "exp": sp.exp,
    "factorial": sp.factorial,
    "floor": sp.floor,
    "log": sp.log,
    "Max": sp.Max,
    "Min": sp.Min,
    # Safe data constructor only.  It receives already-whitelisted scalar/list
    # arguments and enables common local-model output such as
    # ``Matrix([[1, 2], [3, 4]])`` without exposing arbitrary SymPy globals.
    "Matrix": sp.Matrix,
    "Rational": sp.Rational,
    "sin": sp.sin,
    "sqrt": sp.sqrt,
    "tan": sp.tan,
}
_CONSTANTS: dict[str, Any] = {
    "E": sp.E,
    "e": sp.E,
    "I": sp.I,
    "oo": sp.oo,
    "pi": sp.pi,
}
_DOMAINS = {
    "real": {"real": True},
    "integer": {"integer": True},
    "positive": {"positive": True},
    "nonnegative": {"nonnegative": True},
    "negative": {"negative": True},
    "nonzero": {"nonzero": True},
    "complex": {"complex": True},
}
_MAX_OPERATIONS = 24
_MAX_EXPRESSION_CHARS = 1200
_REFERENCE_HEAD_RE = re.compile(r"^\$([A-Za-z_][A-Za-z0-9_]*)(.*)$")
_REFERENCE_PART_RE = re.compile(
    r"(?:\[(-?\d+)\]|\.([A-Za-z_][A-Za-z0-9_]*))"
)
# A PURE selector ("$id", "$id[0]", "$id[0].x") resolves as a reference.
# Anything else containing "$id" tokens is a composite expression such as
# "$initial - $eaten": the tokens are stripped and the parser resolves the
# bare ids through prior outputs.
_PURE_REFERENCE_RE = re.compile(
    r"^\$[A-Za-z_][A-Za-z0-9_]*(?:\[-?\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*$"
)
_REFERENCE_TOKEN_RE = re.compile(r"\$(?=[A-Za-z_])")


@dataclass
class MathExecutionResult:
    success: bool
    applicable: bool = True
    operations: list[dict[str, Any]] = field(default_factory=list)
    claims: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    reason: str = ""

    @property
    def all_claims_passed(self) -> bool:
        return bool(self.claims) and all(item.get("passed") is True for item in self.claims)

    def to_dict(self) -> dict[str, Any]:
        return {
            "success": self.success,
            "applicable": self.applicable,
            "all_claims_passed": self.all_claims_passed,
            "operations": self.operations,
            "claims": self.claims,
            "errors": self.errors,
            "reason": self.reason,
        }


class _ExpressionParser:
    def __init__(
        self,
        symbols: dict[str, sp.Symbol],
        outputs: dict[str, Any] | None = None,
    ) -> None:
        self._symbols = symbols
        self._outputs = outputs if outputs is not None else {}

    def parse(self, value: Any) -> Any:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return sp.Rational(str(value))
        if isinstance(value, list):
            return [self.parse(item) for item in value]
        if not isinstance(value, str) or not value.strip():
            raise ValueError("expression must be a non-empty string or number")
        if len(value) > _MAX_EXPRESSION_CHARS:
            raise ValueError("expression exceeds character budget")
        # "$id" reference tokens inside a composite expression become bare
        # identifiers; Name resolution below looks prior outputs up anyway.
        normalized = _REFERENCE_TOKEN_RE.sub("", value.replace("^", "**"))
        return self._visit(ast.parse(normalized, mode="eval").body)

    def _visit(self, node: ast.AST) -> Any:
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return sp.Rational(str(node.value))
        if isinstance(node, ast.Name):
            if node.id in self._symbols:
                return self._symbols[node.id]
            if node.id in _CONSTANTS:
                return _CONSTANTS[node.id]
            # Deterministically normalize an exact prior operation id.  The
            # canonical wire form remains "$id", but this avoids spending an
            # LLM repair attempt on a harmless omitted prefix.
            if node.id in self._outputs:
                return self._outputs[node.id]
            raise ValueError(f"undeclared symbol: {node.id}")
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = self._visit(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp):
            if isinstance(node.op, ast.BitAnd):
                # ``Eq(a, b) & Eq(c, d)`` is a common local-model spelling of
                # an equation system; flatten the conjunction into a list.
                parts: list[Any] = []
                for side in (self._visit(node.left), self._visit(node.right)):
                    parts.extend(side if isinstance(side, list) else [side])
                return parts
            left, right = self._visit(node.left), self._visit(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            if isinstance(node.op, ast.Pow):
                return left**right
            raise ValueError("unsupported arithmetic operator")
        if isinstance(node, (ast.List, ast.Tuple)):
            return [self._visit(item) for item in node.elts]
        if isinstance(node, ast.Dict):
            # Mapping literals such as ``{x: 23, y: 12}`` appear in claims
            # about multi-variable solve results.
            mapping: dict[Any, Any] = {}
            for key_node, value_node in zip(node.keys, node.values):
                if key_node is None:
                    raise ValueError("unsupported dict expansion")
                if isinstance(key_node, ast.Constant) and isinstance(key_node.value, str):
                    key: Any = sp.Symbol(key_node.value)
                else:
                    key = self._visit(key_node)
                mapping[key] = self._visit(value_node)
            return mapping
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            function = _FUNCTIONS.get(node.func.id)
            if function is None or node.keywords:
                raise ValueError(f"unsupported function: {node.func.id}")
            return function(*(self._visit(item) for item in node.args))
        if isinstance(node, ast.Subscript):
            container = self._visit(node.value)
            index_node = node.slice
            if isinstance(index_node, ast.Constant) and isinstance(index_node.value, int):
                try:
                    return container[index_node.value]
                except (IndexError, KeyError, TypeError) as exc:
                    raise ValueError(f"invalid subscript on prior result: {exc}")
            if isinstance(index_node, ast.Constant) and isinstance(index_node.value, str):
                # "$solve[0]['x']" / "$solve['x']": key access, with the
                # single-solution list unwrapped first.
                container = _unwrap_single_solution(container)
                if isinstance(container, dict):
                    for key, item in container.items():
                        if str(key) == index_node.value:
                            return item
                raise ValueError(f"unknown key on prior result: {index_node.value}")
            raise ValueError("only constant integer/string subscripts are supported")
        if isinstance(node, ast.Attribute):
            container = _unwrap_single_solution(self._visit(node.value))
            if isinstance(container, dict):
                for key, item in container.items():
                    if str(key) == node.attr:
                        return item
            raise ValueError(f"unknown attribute on prior result: {node.attr}")
        raise ValueError(f"unsupported expression node: {type(node).__name__}")


def _serialize(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _serialize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, sp.FiniteSet)):
        return [_serialize(item) for item in value]
    if isinstance(value, sp.MatrixBase):
        return [[str(item) for item in row] for row in value.tolist()]
    if isinstance(value, sp.Basic):
        return str(value)
    return value


def sample_real_expression(
    expression: str,
    *,
    variable: str = "x",
    start: float = -3.0,
    end: float = 3.0,
    y_min: float = -3.0,
    y_max: float = 3.0,
    samples: int = 81,
) -> list[list[list[float]]]:
    """Safely sample a real expression into drawable continuous segments.

    The same AST whitelist used by Math IR is applied before SymPy creates the
    numeric callable. Invalid, complex, non-finite and far-out-of-frame values
    split the path instead of being joined across an asymptote.
    """
    if not variable.isidentifier():
        raise ValueError("invalid curve variable")
    if not all(math.isfinite(value) for value in (start, end, y_min, y_max)):
        raise ValueError("curve range must be finite")
    if end <= start or y_max <= y_min:
        raise ValueError("curve range must be increasing")
    count = min(max(int(samples), 17), 161)
    symbol = sp.Symbol(variable, real=True)
    parsed = _ExpressionParser({variable: symbol}).parse(expression)
    callable_expression = sp.lambdify(symbol, parsed, modules="math")
    margin = max(y_max - y_min, 1.0)
    lower, upper = y_min - margin, y_max + margin
    jump_limit = max(2.5 * margin, 2.0)
    segments: list[list[list[float]]] = []
    current: list[list[float]] = []
    for index in range(count):
        x_value = start + (end - start) * index / (count - 1)
        try:
            raw_y = callable_expression(x_value)
            if isinstance(raw_y, complex):
                if abs(raw_y.imag) > 1e-9:
                    raise ValueError("complex curve value")
                raw_y = raw_y.real
            y_value = float(raw_y)
            valid = math.isfinite(y_value) and lower <= y_value <= upper
        except (ArithmeticError, TypeError, ValueError, OverflowError):
            valid = False
            y_value = 0.0
        if valid and current and abs(y_value - current[-1][1]) > jump_limit:
            if len(current) >= 2:
                segments.append(current)
            current = []
        if valid:
            current.append([round(x_value, 8), round(y_value, 8)])
        else:
            if len(current) >= 2:
                segments.append(current)
            current = []
    if len(current) >= 2:
        segments.append(current)
    if not segments:
        raise ValueError("expression has no drawable real segment in range")
    return segments


def evaluate_real_expression_at(
    expression: str,
    *,
    variable: str = "x",
    point: float = 0.0,
) -> float | None:
    """Return a finite real point value, or ``None`` when it is undefined."""
    if not variable.isidentifier() or not math.isfinite(point):
        raise ValueError("invalid expression evaluation point")
    symbol = sp.Symbol(variable, real=True)
    parsed = _ExpressionParser({variable: symbol}).parse(expression)
    value = parsed.subs(symbol, sp.Rational(str(point)))
    if value.has(sp.zoo, sp.nan, sp.oo, -sp.oo) or value.is_real is False:
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def extract_linear_mix_structure(request: Any) -> dict[str, Any] | None:
    """Detect a two-kind linear mix from verified Math IR, by shape only.

    The structure: two unit kinds sharing a fixed total count N, per-unit
    values a != b, and a fixed total value M — solvable by visible
    swap-and-watch-the-delta reasoning. Detection reads the equation
    coefficients ([[1,1],[a,b]]), never the problem text, so any wording
    (animals/wheels/coins/scores) with this shape qualifies.
    """
    if not isinstance(request, dict):
        return None
    for operation in request.get("operations") or []:
        if not isinstance(operation, dict):
            continue
        if str(operation.get("op") or "").lower() != "solve":
            continue
        expressions = operation.get("expression")
        variables = operation.get("variables") or operation.get("variable")
        if not isinstance(expressions, list) or len(expressions) != 2:
            continue
        if not isinstance(variables, list) or len(variables) != 2:
            continue
        names = [str(item) for item in variables]
        symbols = {name: sp.Symbol(name, positive=True) for name in names}
        parser = _ExpressionParser(dict(symbols))
        rows: list[tuple[Fraction, Fraction, Fraction]] = []
        try:
            for expression in expressions:
                parsed = parser.parse(expression)
                if isinstance(parsed, sp.Eq):
                    parsed = parsed.lhs - parsed.rhs
                polynomial = sp.Poly(sp.expand(parsed), *symbols.values())
                if polynomial.total_degree() != 1:
                    raise ValueError("not linear")
                coefficient_a = polynomial.coeff_monomial(symbols[names[0]])
                coefficient_b = polynomial.coeff_monomial(symbols[names[1]])
                constant = polynomial.coeff_monomial(1)
                rows.append(
                    (
                        Fraction(str(coefficient_a)),
                        Fraction(str(coefficient_b)),
                        -Fraction(str(constant)),
                    )
                )
        except (ValueError, TypeError, sp.SympifyError):
            continue
        count_rows = [row for row in rows if row[0] == 1 and row[1] == 1]
        value_rows = [row for row in rows if row not in count_rows]
        if len(count_rows) != 1 or len(value_rows) != 1:
            continue
        total_units = count_rows[0][2]
        value_a, value_b, total_value = value_rows[0]
        if value_a == value_b or value_a <= 0 or value_b <= 0:
            continue
        # Solve the 2x2 exactly; trust arithmetic, not stringified evidence.
        denominator = value_b - value_a
        count_b = (total_value - value_a * total_units) / denominator
        count_a = total_units - count_b
        values = [total_units, value_a, value_b, total_value, count_a, count_b]
        if not all(value.denominator == 1 and value >= 0 for value in values):
            continue
        payload = {
            "name_a": names[0],
            "name_b": names[1],
            "total_units": int(total_units),
            "value_a": int(value_a),
            "value_b": int(value_b),
            "total_value": int(total_value),
            "count_a": int(count_a),
            "count_b": int(count_b),
        }
        # Canonical orientation: assume the SMALLER-value kind first, so each
        # swap visibly ADDS marks (removing drawn marks would read as loss).
        if payload["value_a"] > payload["value_b"]:
            payload = {
                **payload,
                "name_a": payload["name_b"],
                "name_b": payload["name_a"],
                "value_a": payload["value_b"],
                "value_b": payload["value_a"],
                "count_a": payload["count_b"],
                "count_b": payload["count_a"],
            }
        # Countable-visual budget: units drawn individually, values as
        # per-unit marks (the template caps marks at 6 per unit).
        if payload["total_units"] < 2 or payload["total_units"] > 64:
            continue
        if payload["value_a"] > 6 or payload["value_b"] > 6:
            continue
        if payload["count_b"] < 1 or payload["count_a"] < 0:
            continue
        return payload
    return None


def extract_linear_balance_structure(request: Any) -> dict[str, Any] | None:
    """Detect a one-variable linear equation a·x + b = c from verified IR.

    The balance metaphor needs the ORIGINAL two sides, so constants are
    recovered from the raw expression's term signs (canonical sympy form
    collapses "…+5-13" into "-8"): positive constants stay on the unknown's
    side, negated constants are the other pan. Detection is coefficient
    shape only — no problem wording.
    """
    if not isinstance(request, dict):
        return None
    for operation in request.get("operations") or []:
        if not isinstance(operation, dict):
            continue
        if str(operation.get("op") or "").lower() != "solve":
            continue
        expression = operation.get("expression")
        variables = operation.get("variables") or operation.get("variable")
        if isinstance(variables, list):
            if len(variables) != 1:
                continue
            variable = str(variables[0])
        else:
            variable = str(variables or "").strip()
        if not isinstance(expression, str) or not variable.isidentifier():
            continue
        symbol = sp.Symbol(variable, real=True)
        try:
            parsed = _ExpressionParser({variable: symbol}).parse(expression)
            if isinstance(parsed, sp.Eq):
                lhs, rhs = parsed.lhs, parsed.rhs
            else:
                lhs, rhs = parsed, sp.Integer(0)
            normalized = sp.expand(lhs - rhs)
            polynomial = sp.Poly(normalized, symbol)
            if polynomial.degree() != 1:
                continue
            coefficient = Fraction(str(polynomial.coeff_monomial(symbol)))
            constant_term = Fraction(str(polynomial.coeff_monomial(1)))
        except (ValueError, TypeError, sp.SympifyError):
            continue
        if coefficient == 0:
            continue
        if coefficient < 0:
            coefficient, constant_term = -coefficient, -constant_term
        solution = -constant_term / coefficient
        # Recover the pans: positive constant terms sit with the unknown,
        # negated ones form the other side. Falls back to b=0 when the raw
        # split is unavailable (e.g. already-normalized "2*x - 8").
        left_constant = Fraction(0)
        right_constant = Fraction(0)
        if isinstance(parsed, sp.Eq):
            try:
                left_constant = Fraction(str(sp.expand(lhs).coeff(symbol, 0)))
                right_constant = Fraction(str(sp.expand(rhs).coeff(symbol, 0)))
                if Fraction(str(sp.expand(rhs).coeff(symbol, 1))) != 0:
                    left_constant, right_constant = Fraction(0), Fraction(0)
            except (ValueError, TypeError):
                left_constant = right_constant = Fraction(0)
        if right_constant == 0:
            raw_terms = re.findall(
                r"[+-]?\s*\d+(?:\.\d+)?(?![\w.*/])",
                expression.replace("−", "-"),
            )
            positives = [Fraction(t.replace(" ", "")) for t in raw_terms]
            left_constant = sum(
                (value for value in positives if value > 0), Fraction(0)
            )
            right_constant = -sum(
                (value for value in positives if value < 0), Fraction(0)
            )
        if left_constant - right_constant != constant_term:
            left_constant, right_constant = (
                (Fraction(0), -constant_term)
                if constant_term <= 0
                else (constant_term, Fraction(0))
            )
        values = [coefficient, left_constant, right_constant, solution]
        if not all(value.denominator == 1 and value >= 0 for value in values):
            continue
        payload = {
            "variable": variable,
            "coefficient": int(coefficient),
            "constant": int(left_constant),
            "total": int(right_constant),
            "solution": int(solution),
        }
        # Countable pans: boxes and dots must stay individually readable.
        if not 1 <= payload["coefficient"] <= 4:
            continue
        if not 0 <= payload["constant"] <= 12:
            continue
        if not 1 <= payload["total"] <= 24:
            continue
        if not 1 <= payload["solution"] <= 12:
            continue
        if payload["constant"] == 0 and payload["coefficient"] == 1:
            continue  # x = c directly; nothing to demonstrate
        if (
            payload["coefficient"] * payload["solution"] + payload["constant"]
            != payload["total"]
        ):
            continue
        return payload
    return None


def _unwrap_single_solution(container: Any) -> Any:
    """A one-element solution list is its element for key/field access."""
    if (
        isinstance(container, (list, tuple))
        and len(container) == 1
        and isinstance(container[0], dict)
    ):
        return container[0]
    return container


def _resolve_reference(value: str, outputs: dict[str, Any]) -> Any:
    match = _REFERENCE_HEAD_RE.fullmatch(value)
    if match is None or match.group(1) not in outputs:
        raise ValueError(f"unknown operation reference: {value}")
    current = outputs[match.group(1)]
    tail = match.group(2)
    position = 0
    for part in _REFERENCE_PART_RE.finditer(tail):
        if part.start() != position:
            raise ValueError(f"invalid operation reference selector: {value}")
        position = part.end()
        raw_index, raw_key = part.groups()
        if raw_index is not None:
            if not isinstance(current, (list, tuple, sp.MatrixBase)):
                raise ValueError(f"reference is not indexable: {value}")
            index = int(raw_index)
            try:
                current = current[index]
            except IndexError as exc:
                raise ValueError(f"reference index out of range: {value}") from exc
            continue
        # "$solve[0].x" and "$solve.x" describe the same single solution:
        # unwrap a one-element solution list before field access.
        if (
            isinstance(current, (list, tuple))
            and len(current) == 1
            and isinstance(current[0], dict)
        ):
            current = current[0]
        if not isinstance(current, dict):
            raise ValueError(f"reference has no keyed field: {value}")
        matching_key = next(
            (key for key in current if str(key) == raw_key),
            None,
        )
        if matching_key is None:
            raise ValueError(f"unknown reference field: {value}")
        current = current[matching_key]
    if position != len(tail):
        raise ValueError(f"invalid operation reference selector: {value}")
    return current


def _resolve(value: Any, parser: _ExpressionParser, outputs: dict[str, Any]) -> Any:
    if isinstance(value, str) and value.strip().startswith("$"):
        stripped = value.strip()
        if _PURE_REFERENCE_RE.fullmatch(stripped):
            return _resolve_reference(stripped, outputs)
        # Composite expression built from references ("$a - $b"): not a
        # selector — hand to the parser, which resolves bare prior-output ids.
    return parser.parse(value)


def _simplify_composite(value: Any) -> Any:
    if isinstance(value, list):
        return [_simplify_composite(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_simplify_composite(item) for item in value)
    if isinstance(value, dict):
        return {key: _simplify_composite(item) for key, item in value.items()}
    if isinstance(value, sp.MatrixBase):
        return value.applyfunc(sp.simplify)
    return sp.simplify(value)


def _execute_operation(
    operation: dict[str, Any],
    parser: _ExpressionParser,
    symbols: dict[str, sp.Symbol],
    outputs: dict[str, Any],
) -> Any:
    op = str(operation.get("op") or "").strip().lower()
    op = {
        "define": "evaluate",
        "derivative": "differentiate",
        "diff": "differentiate",
        "subs": "substitute",
    }.get(op, op)
    raw_variable = operation.get("variable")
    if isinstance(raw_variable, list) and not operation.get("variables"):
        # Local models sometimes put the variable list under the singular key.
        operation = {**operation, "variables": raw_variable, "variable": ""}
        raw_variable = ""
    expression = _resolve(operation.get("expression"), parser, outputs)
    variable_name = str(raw_variable or "").strip()
    variable = symbols.get(variable_name)

    def apply_substitutions(value: Any) -> Any:
        substitutions = operation.get("substitutions")
        if substitutions is None and "substitution" in operation:
            if variable is None:
                raise ValueError(
                    "scalar substitution requires a declared variable"
                )
            substitutions = {variable_name: operation.get("substitution")}
        substitutions = substitutions or {}
        if not isinstance(substitutions, dict):
            raise ValueError("substitutions must be an object")
        pairs = {}
        for name, raw in substitutions.items():
            symbol = symbols.get(str(name))
            if symbol is None:
                raise ValueError(f"undeclared substitution symbol: {name}")
            pairs[symbol] = _resolve(raw, parser, outputs)
        return sp.simplify(value.subs(pairs))

    if op in {"evaluate", "simplify"}:
        # Local models frequently attach ``substitutions`` to evaluate rather
        # than emitting a separate substitute operation.  The intent is
        # unambiguous and remains inside the same safe symbolic capability.
        if operation.get("substitutions") is not None:
            return apply_substitutions(expression)
        return _simplify_composite(expression)
    if op == "expand":
        return sp.expand(expression)
    if op == "factor":
        return sp.factor(expression)
    if op == "differentiate":
        if variable is None:
            raise ValueError("differentiate requires a declared variable")
        return sp.diff(expression, variable, int(operation.get("order") or 1))
    if op == "integrate":
        if variable is None:
            raise ValueError("integrate requires a declared variable")
        bounds = operation.get("bounds")
        if isinstance(bounds, list) and len(bounds) == 2:
            return sp.integrate(
                expression,
                (variable, parser.parse(bounds[0]), parser.parse(bounds[1])),
            )
        return sp.integrate(expression, variable)
    if op == "limit":
        if variable is None:
            raise ValueError("limit requires a declared variable")
        point = parser.parse(operation.get("point"))
        direction = str(operation.get("direction") or "+-")
        return sp.limit(expression, variable, point, dir=direction)
    if op == "solve":
        variables = operation.get("variables") or [variable_name]
        resolved = [symbols.get(str(item)) for item in variables]
        if not resolved or any(item is None for item in resolved):
            raise ValueError("solve requires declared variables")
        equations = expression if isinstance(expression, list) else [expression]
        if len(resolved) == 1:
            subject = equations[0] if len(equations) == 1 else equations
            return sp.solve(subject, resolved[0], dict=False)
        return sp.solve(equations, resolved, dict=True)
    if op == "substitute":
        return apply_substitutions(expression)
    if op == "determinant":
        return sp.Matrix(expression).det()
    if op == "summation":
        if variable is None:
            raise ValueError("summation requires a declared variable")
        bounds = operation.get("bounds") or []
        if len(bounds) != 2:
            raise ValueError("summation requires two bounds")
        return sp.summation(
            expression,
            (variable, parser.parse(bounds[0]), parser.parse(bounds[1])),
        )
    if op == "product":
        if variable is None:
            raise ValueError("product requires a declared variable")
        bounds = operation.get("bounds") or []
        if len(bounds) != 2:
            raise ValueError("product requires two bounds")
        return sp.product(
            expression,
            (variable, parser.parse(bounds[0]), parser.parse(bounds[1])),
        )
    raise ValueError(f"unsupported operation: {op or '?'}")


def _check_claim(
    claim: dict[str, Any], parser: _ExpressionParser, outputs: dict[str, Any]
) -> tuple[bool, str, Any, Any]:
    relation = str(claim.get("relation") or "equal").strip().lower()
    left = _resolve(claim.get("left"), parser, outputs)
    right = _resolve(claim.get("right", 0), parser, outputs)
    def values_equal(first: Any, second: Any) -> bool:
        # A one-solution solution set equals its element: ``solve`` returns
        # ``[{x: 23, y: 12}]`` while claims naturally state the mapping.
        if (
            isinstance(first, (list, tuple))
            and len(first) == 1
            and not isinstance(second, (list, tuple))
        ):
            return values_equal(first[0], second)
        if (
            isinstance(second, (list, tuple))
            and len(second) == 1
            and not isinstance(first, (list, tuple))
        ):
            return values_equal(first, second[0])
        if isinstance(first, sp.MatrixBase) or isinstance(second, sp.MatrixBase):
            if not isinstance(first, sp.MatrixBase) or not isinstance(second, sp.MatrixBase):
                return False
            return first.shape == second.shape and all(
                values_equal(a, b) for a, b in zip(first, second)
            )
        if isinstance(first, (list, tuple)) or isinstance(second, (list, tuple)):
            if not isinstance(first, (list, tuple)) or not isinstance(
                second, (list, tuple)
            ):
                return False
            return len(first) == len(second) and all(
                values_equal(a, b) for a, b in zip(first, second)
            )
        if isinstance(first, dict) or isinstance(second, dict):
            if not isinstance(first, dict) or not isinstance(second, dict):
                return False
            first_keys = {str(key): key for key in first}
            second_keys = {str(key): key for key in second}
            return first_keys.keys() == second_keys.keys() and all(
                values_equal(first[first_keys[key]], second[second_keys[key]])
                for key in first_keys
            )
        return sp.simplify(first - second) == 0

    if relation in {"equal", "equivalent"}:
        passed = values_equal(left, right)
    elif relation == "not_equal":
        passed = not values_equal(left, right)
    elif relation == "less":
        passed = bool(sp.ask(sp.Q.negative(left - right)))
    elif relation == "less_equal":
        difference = sp.simplify(left - right)
        passed = difference == 0 or bool(sp.ask(sp.Q.negative(difference)))
    elif relation == "greater":
        passed = bool(sp.ask(sp.Q.positive(left - right)))
    elif relation == "greater_equal":
        difference = sp.simplify(left - right)
        passed = difference == 0 or bool(sp.ask(sp.Q.positive(difference)))
    else:
        raise ValueError(f"unsupported claim relation: {relation}")
    return passed, relation, left, right


def execute_math_request(request: Any) -> MathExecutionResult:
    if not isinstance(request, dict):
        return MathExecutionResult(False, errors=["math request must be an object"])
    engine = str(request.get("engine") or "sympy").strip().lower()
    if engine in {"none", "logical"}:
        return MathExecutionResult(
            True,
            applicable=False,
            reason=str(request.get("reason") or "结论不适合确定性计算"),
        )
    if engine != "sympy":
        return MathExecutionResult(False, errors=[f"unsupported engine: {engine}"])

    raw_symbols = request.get("symbols") or {}
    if not isinstance(raw_symbols, dict) or len(raw_symbols) > 32:
        return MathExecutionResult(False, errors=["symbols must be an object of at most 32"])
    symbols: dict[str, sp.Symbol] = {}
    try:
        for name, spec in raw_symbols.items():
            if not isinstance(name, str) or not name.isidentifier():
                raise ValueError(f"invalid symbol name: {name}")
            domain = (
                str((spec or {}).get("domain") or "complex")
                if isinstance(spec, dict)
                else str(spec)
            )
            # Matrices are concrete composite values, not scalar symbols with
            # assumptions.  Ignore this harmless model-authored declaration;
            # a later use of the bare name still fails as undeclared unless an
            # earlier operation actually constructed that matrix.
            if domain == "matrix":
                continue
            assumptions = _DOMAINS.get(domain)
            if assumptions is None:
                raise ValueError(f"unsupported symbol domain: {domain}")
            symbols[name] = sp.Symbol(name, **assumptions)
    except ValueError as exc:
        return MathExecutionResult(False, errors=[str(exc)])

    outputs: dict[str, Any] = {}
    parser = _ExpressionParser(symbols, outputs)
    operations = request.get("operations") or []
    claims = request.get("claims") or []
    if not isinstance(operations, list) or len(operations) > _MAX_OPERATIONS:
        return MathExecutionResult(False, errors=["invalid operations list or budget exceeded"])
    if not isinstance(claims, list) or len(claims) > _MAX_OPERATIONS:
        return MathExecutionResult(False, errors=["invalid claims list or budget exceeded"])

    result = MathExecutionResult(True)
    seen_ids: set[str] = set()
    for index, operation in enumerate(operations, start=1):
        if not isinstance(operation, dict):
            result.errors.append(f"operation {index} must be an object")
            result.success = False
            break
        operation_id = str(operation.get("id") or f"operation_{index}")
        if not operation_id.isidentifier() or operation_id in seen_ids:
            result.errors.append(f"invalid or duplicate operation id: {operation_id}")
            result.success = False
            break
        if operation_id in symbols or operation_id in _CONSTANTS or operation_id in _FUNCTIONS:
            result.errors.append(f"operation id conflicts with a reserved name: {operation_id}")
            result.success = False
            break
        try:
            value = _execute_operation(operation, parser, symbols, outputs)
        except Exception as exc:
            result.errors.append(f"{operation_id}: {type(exc).__name__}: {exc}")
            result.success = False
            break
        outputs[operation_id] = value
        seen_ids.add(operation_id)
        result.operations.append(
            {
                "id": operation_id,
                "op": operation.get("op"),
                "result": _serialize(value),
            }
        )

    if result.success:
        for index, claim in enumerate(claims, start=1):
            if not isinstance(claim, dict):
                result.errors.append(f"claim {index} must be an object")
                result.success = False
                break
            try:
                passed, relation, left, right = _check_claim(claim, parser, outputs)
            except Exception as exc:
                result.errors.append(f"claim {index}: {type(exc).__name__}: {exc}")
                result.success = False
                break
            result.claims.append(
                {
                    "id": str(claim.get("id") or f"claim_{index}"),
                    "relation": relation,
                    "left": _serialize(left),
                    "right": _serialize(right),
                    "passed": passed,
                }
            )
    return result
