"""讲解生成数据集：每一次生成都留一条可训练的记录。

为什么要单独存一份，而不是靠 sessions/ 目录：
sessions 是**调试留痕**（按会话散落成十几个文件，schema 随工具演进而变），
数据集是**训练语料**（一行一条、字段稳定、能直接喂给微调或偏好学习）。
两者目标冲突，混在一起迟早两头不讨好。

一条记录要能独立回答三个问题：
  1. 输入是什么——题干、年级、以及**独立验证过的 Math IR**（这是唯一的地面真值）；
  2. 产出是什么——走了哪条路（确定性构造器 / 模型写计划 / 模型写 HTML），产物本身；
  3. 好不好——门禁判定（结构性、可复算）+ 成片审查评分 + 日后补录的人工反馈。

第 3 项是关键：没有标签的生成记录训不出东西。门禁给的是**确定性标签**
（答案画错了没有、宣称的数量画出来没有），比人工打分便宜且不会漂。

追加写用「先写临时文件再 rename」保证并发下不撕行；schema 变更一律加字段，
不改不删——旧行必须永远可读，否则前面攒的语料就作废了。
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

logger = logging.getLogger(__name__)

#: 记录格式版本；只增字段不改语义，破坏性变更才 +1
DATASET_VERSION = 1

#: 画面由谁设计
ROUTE_DETERMINISTIC = "deterministic"  # 9 个构造器之一，从已验证 Math IR 直接算
ROUTE_LLM_PLAN = "llm_plan"  # 模型写 SceneSpec，由固定播放器渲染
ROUTE_LLM_HTML = "llm_html"  # 模型直接写 HTML（表达上限最高，靠门禁兜底）


@dataclass
class GenerationRecord:
    """一次讲解生成的完整记录。字段只增不减。"""

    id: str
    ts: str
    version: int
    route: str
    problem: str
    grade: str | None = None
    learner_id: str | None = None
    session_id: str | None = None
    #: 确定性构造器盖的章；模型路径为 None
    grounding_source: str | None = None
    #: 地面真值：独立验证过的 Math IR 请求与证据
    math_request: Any = None
    math_evidence: Any = None
    #: 产物。llm_html 存 HTML 全文，其余存计划 JSON
    artifact_kind: str = "plan"
    artifact: Any = None
    #: 结构性门禁判定（确定性标签，训练时最可靠的监督信号）
    gate: dict[str, Any] = field(default_factory=dict)
    #: 成片/画面审查评分（有则填）
    review: dict[str, Any] = field(default_factory=dict)
    #: 日后补录：家长/孩子的人工反馈
    feedback: dict[str, Any] = field(default_factory=dict)


def dataset_path(data_dir: str | os.PathLike[str]) -> Path:
    return Path(data_dir) / "dataset" / "explanations.jsonl"


def append_record(data_dir: str | os.PathLike[str], record: GenerationRecord) -> Path:
    """追加一条记录。写失败只记日志不抛——采语料绝不能拖垮出讲解这件正事。"""
    path = dataset_path(data_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(asdict(record), ensure_ascii=False, default=str)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError as err:  # pragma: no cover - 磁盘异常
        logger.warning("讲解数据集写入失败（不影响讲解产出）: %s", err)
    return path


def record_generation(
    data_dir: str | os.PathLike[str],
    *,
    route: str,
    problem: str,
    grade: str | None = None,
    learner_id: str | None = None,
    session_id: str | None = None,
    grounding_source: str | None = None,
    math_request: Any = None,
    math_evidence: Any = None,
    artifact: Any = None,
    artifact_kind: str = "plan",
    gate: dict[str, Any] | None = None,
    review: dict[str, Any] | None = None,
) -> GenerationRecord:
    record = GenerationRecord(
        id=str(uuid.uuid4()),
        ts=datetime.now(timezone.utc).isoformat(),
        version=DATASET_VERSION,
        route=route,
        problem=problem,
        grade=grade,
        learner_id=learner_id,
        session_id=session_id,
        grounding_source=grounding_source,
        math_request=math_request,
        math_evidence=math_evidence,
        artifact_kind=artifact_kind,
        artifact=artifact,
        gate=dict(gate or {}),
        review=dict(review or {}),
    )
    append_record(data_dir, record)
    return record


def read_records(data_dir: str | os.PathLike[str]) -> Iterator[dict[str, Any]]:
    """逐行读回。坏行跳过——一条脏数据不该让整份语料读不出来。"""
    path = dataset_path(data_dir)
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                logger.debug("跳过损坏的数据集行")
                continue


def attach_feedback(
    data_dir: str | os.PathLike[str], record_id: str, feedback: dict[str, Any]
) -> bool:
    """给已有记录补人工反馈（整份重写，家庭规模够用）。"""
    path = dataset_path(data_dir)
    if not path.exists():
        return False
    rows = list(read_records(data_dir))
    hit = False
    for row in rows:
        if row.get("id") == record_id:
            row.setdefault("feedback", {}).update(feedback)
            hit = True
    if not hit:
        return False
    tmp = tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=str(path.parent), delete=False, suffix=".tmp"
    )
    try:
        with tmp:
            for row in rows:
                tmp.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
        os.replace(tmp.name, path)
    except OSError:  # pragma: no cover
        Path(tmp.name).unlink(missing_ok=True)
        return False
    return True


def summarize(data_dir: str | os.PathLike[str]) -> dict[str, Any]:
    """按路线聚合：各条路各生成了多少、门禁通过率多少。

    这就是「该往哪条路使劲」的依据——不统计就只能凭感觉。
    """
    by_route: dict[str, dict[str, int]] = {}
    total = 0
    for row in read_records(data_dir):
        total += 1
        route = str(row.get("route") or "unknown")
        bucket = by_route.setdefault(route, {"count": 0, "gate_ok": 0, "with_feedback": 0})
        bucket["count"] += 1
        if (row.get("gate") or {}).get("ok"):
            bucket["gate_ok"] += 1
        if row.get("feedback"):
            bucket["with_feedback"] += 1
    return {"total": total, "by_route": by_route}
