#!/usr/bin/env node
/**
 * 对齐评测：教材概念 → 图谱节点的候选，到底准不准。
 *
 * 为什么要有它：`/textbook/align` 出的候选是家长确认的**唯一入口**，
 * 而在这个脚本之前，"对齐是否可用"只能靠翻几本书看着像不像。
 * 关键的是它测的是**对齐质量**，不是管道形状——草稿怎么来的、存到哪，
 * 那些已经有单测了。
 *
 * 判定口径（都写在 case 里，不在这里猜）：
 * - 正向：候选第一名命中 `nodeId`（或 `alsoAccept` 里的等价节点）＝ top1 对；
 *   前三名里有命中 ＝ top3 对。教材对齐留几个候选给家长挑是常态，
 *   所以 top3 才是"可用的下限"，top1 衡量的是"能不能省事"。
 * - 反向：`nodeId: null` 的题（英语语法、古诗押韵这种不该进数学图谱的内容）
 *   必须**一个候选都不给**——硬凑一个节点让家长去否决，比空着更糟。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadKnowledge, proposeAlignment } from "../packages/knowledge/dist/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const casesFile = path.join(root, "data/golden/align/cases.jsonl");

const knowledge = loadKnowledge({
  graphPath: path.join(root, "data/knowledge/graph.json"),
  problemsPath: path.join(root, "data/knowledge/problems.json"),
});

const cases = readFileSync(casesFile, "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

let top1 = 0;
let top3 = 0;
let negativePassed = 0;
let negatives = 0;
const misses = [];
const rankMisses = [];
const falsePositives = [];

for (const c of cases) {
  const acceptable = new Set([c.expect.nodeId, ...(c.expect.alsoAccept ?? [])].filter(Boolean));
  const items = proposeAlignment(knowledge.index, [{ title: c.title, text: c.text }]).items;
  const candidates = items[0]?.candidates ?? [];

  if (c.expect.nodeId === null) {
    negatives += 1;
    if (candidates.length === 0) {
      negativePassed += 1;
    } else {
      falsePositives.push(`${c.id}: 不该有候选，却给了 ${candidates.map((x) => x.nodeName).join("、")}`);
    }
    continue;
  }

  const rank = candidates.findIndex((x) => acceptable.has(x.nodeId));
  if (rank === 0) top1 += 1;
  if (rank >= 0 && rank < 3) {
    top3 += 1;
    // 第一名不对、但正确节点在前三里：不影响可用性，但它是"该调词表"的信号
    if (rank > 0) rankMisses.push(`${c.id} 「${c.title}」正确节点排在第 ${rank + 1} 位（可接受，无需修）`);
  }
  else {
    misses.push(
      `${c.id} 「${c.title}」期望 ${[...acceptable].join("/")}，实际 ${
        candidates.map((x) => `${x.nodeName}(${x.score.toFixed(0)})`).join("、") || "无候选"
      }`,
    );
  }
}

const positives = cases.length - negatives;
const rate = (n, d) => (d === 0 ? 1 : n / d);

console.log(`对齐评测集：${cases.length} 题（正向 ${positives}，反向 ${negatives}）`);
console.log(`  top1 命中 : ${top1}/${positives} = ${(rate(top1, positives) * 100).toFixed(1)}%`);
console.log(`  top3 命中 : ${top3}/${positives} = ${(rate(top3, positives) * 100).toFixed(1)}%`);
console.log(`  反向不硬凑: ${negativePassed}/${negatives}`);
for (const m of rankMisses) console.log(`  · ${m}`);
for (const m of misses) console.log(`  ✗ ${m}`);
for (const f of falsePositives) console.log(`  ✗ ${f}`);

const MIN_TOP1 = 0.75;
const MIN_TOP3 = 0.9;
const failed =
  rate(top1, positives) < MIN_TOP1 || rate(top3, positives) < MIN_TOP3 || negativePassed !== negatives;
if (failed) {
  console.error(
    `[FAIL] 门槛：top1 ≥ ${MIN_TOP1 * 100}%，top3 ≥ ${MIN_TOP3 * 100}%，反向全过`,
  );
  process.exit(1);
}
console.log("[OK] 对齐评测通过");
