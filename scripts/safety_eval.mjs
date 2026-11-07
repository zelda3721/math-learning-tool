#!/usr/bin/env node
/**
 * 内容安全红队：把 data/red-team/cases.jsonl 逐条喂进 screenInput，看拦得对不对。
 *
 * 这个脚本**不进关键路径**，也不调用模型：安全层本身是纯规则的，所以它能像算泉一样
 * 被反复跑，改一条正则就能立刻看到"多拦了什么、漏了什么"。
 *
 * 判分口径：
 * - 硬案例（自伤/隐私/约见/要答案/闲话）：必须拦下或转移，**一条都不许漏**；
 * - 干净案例（正常的数学提问，哪怕带着"游戏""明星"这种词）：一条都不许误拦。
 * - 两遍：一遍是原始参数，一遍是孩子们真会写的样子（加空格、换说法、夹表情）。
 *   后者允许比前者差一点，但不许崩。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { screenInput } from "../packages/safety/dist/index.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cases = readFileSync(path.join(root, "data/red-team/cases.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

let hardTotal = 0;
let hardPass = 0;
let cleanTotal = 0;
let cleanPass = 0;
const failures = [];

for (const c of cases) {
  const verdict = screenInput(c.input);
  const expect = c.expect.action;
  if (expect === "allow") {
    cleanTotal += 1;
    if (verdict.action === "allow") cleanPass += 1;
    else failures.push(`误拦 ${c.id}「${c.input}」→ ${verdict.action}/${verdict.reason}`);
    continue;
  }
  hardTotal += 1;
  // 期望 block 的必须 block；期望 redirect 的，block 也算通过（宁重勿轻）
  const ok = verdict.action === expect || (expect === "redirect" && verdict.action === "block");
  if (ok) hardPass += 1;
  else failures.push(`漏拦 ${c.id}「${c.input}」→ ${verdict.action}`);
}

const pct = (n, d) => (d === 0 ? 100 : (n / d) * 100).toFixed(1);
console.log(`安全红队：${cases.length} 条（应拦 ${hardTotal}，应放 ${cleanTotal}）`);
console.log(`  拦截/转移：${hardPass}/${hardTotal} = ${pct(hardPass, hardTotal)}%`);
console.log(`  正常放行：${cleanPass}/${cleanTotal} = ${pct(cleanPass, cleanTotal)}%`);
for (const f of failures) console.log(`  ✗ ${f}`);

const failed = hardPass < hardTotal || cleanPass < cleanTotal;
if (failed) {
  console.error("[FAIL] 硬案例必须全拦、干净案例必须全放");
  process.exit(1);
}
console.log("[OK] 安全红队通过");
