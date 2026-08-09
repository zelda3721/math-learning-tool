from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace

from math_tutor.infrastructure.manim.executor import ManimExecutor


def _executor(tmp_path: Path) -> ManimExecutor:
    return ManimExecutor(output_dir=str(tmp_path), quality="low", render_timeout_s=90)


def test_executor_preserves_get_text_calls(tmp_path: Path) -> None:
    executor = _executor(tmp_path)
    source = (
        "from manim import *\n"
        "class SolutionScene(Scene):\n"
        "    def construct(self):\n"
        "        value = label.get_text()\n"
    )
    assert executor._sanitize_code(source).strip() == source.strip()


def test_preflight_uses_skip_animations_and_low_quality(monkeypatch, tmp_path: Path) -> None:
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    ok, error = _executor(tmp_path)._run_preflight(tmp_path / "scene.py", "SolutionScene")
    assert ok is True and error == ""
    assert "-ql" in calls[0]
    assert "-s" in calls[0]


def test_preflight_returns_bounded_runtime_error(monkeypatch, tmp_path: Path) -> None:
    def fake_run(cmd, **kwargs):
        return SimpleNamespace(returncode=1, stdout="", stderr="x" * 7000)

    monkeypatch.setattr(subprocess, "run", fake_run)
    ok, error = _executor(tmp_path)._run_preflight(tmp_path / "scene.py", "SolutionScene")
    assert ok is False
    assert len(error) == 5000


def test_preflight_timeout_is_inconclusive_not_a_false_rejection(
    monkeypatch, tmp_path: Path
) -> None:
    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", fake_run)
    ok, error = _executor(tmp_path)._run_preflight(tmp_path / "scene.py", "SolutionScene")
    assert ok is True and error == ""
