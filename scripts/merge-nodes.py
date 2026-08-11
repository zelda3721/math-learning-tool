# -*- coding: utf-8 -*-
"""把补充节点并进 graph.json：校验 id 不冲突、引用都存在、字段齐全。"""
import json, importlib.util, pathlib, sys

def load(path, *names):
    spec = importlib.util.spec_from_file_location("m", path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return [getattr(m, n) for n in names]

(P,) = load("scripts/new-nodes-primary.py", "NODES")
J, S, U = load("scripts/new-nodes-rest.py", "JUNIOR", "SENIOR", "UNIVERSITY")

g = json.load(open("data/knowledge/graph.json"))
existing = {n["id"] for n in g["nodes"]}
added = []
for stage, rows in (("primary", P), ("junior", J), ("senior", S), ("university", U)):
    for (nid, name, en, strand, lane, order, summary, kws, prereq, evolves, what, why) in rows:
        if nid in existing:
            print("跳过已存在:", nid); continue
        added.append({
            "id": nid, "name": name, "nameEn": en, "stage": stage, "strand": strand,
            "lane": lane, "order": order, "summary": summary, "whatIsIt": what, "why": why,
            "keywords": kws, "prerequisites": prereq,
            "evolvesTo": [{"to": to, "how": how} for to, how in evolves],
            "relatedTo": [], "applications": [], "misconceptions": [],
            # 明确标注来源：这些是按课标补写的，尚未逐条人工核对
            "status": "ai-generated",
            "sources": [{"kind": "curriculum",
                         "title": "义务教育数学课程标准（2022年版）/ 普通高中数学课程标准（2017年版2020年修订）"}],
        })
        existing.add(nid)

g["nodes"].extend(added)
ids = {n["id"] for n in g["nodes"]}

# 引用完整性：prerequisites / evolvesTo 指向的节点必须存在
broken = []
for n in g["nodes"]:
    for p in n.get("prerequisites", []):
        if p not in ids: broken.append((n["id"], "prerequisites", p))
    for e in n.get("evolvesTo", []):
        if e["to"] not in ids: broken.append((n["id"], "evolvesTo", e["to"]))
if broken:
    print("❌ 悬空引用:", broken[:10]); sys.exit(1)

json.dump(g, open("data/knowledge/graph.json", "w"), ensure_ascii=False, indent=1)
import collections
print("新增", len(added), "→ 总节点", len(g["nodes"]))
print("学段:", dict(collections.Counter(n["stage"] for n in g["nodes"])))
print("主线:", dict(collections.Counter(n["strand"] for n in g["nodes"])))
print("有关键词:", sum(1 for n in g["nodes"] if n.get("keywords")), "/", len(g["nodes"]))
