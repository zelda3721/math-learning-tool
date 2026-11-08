// 从教材 PDF 生成英语语法节点（确定性，不调用模型）。
//
// 依据：书的单元标题本身就是语法点（Unit 1 am/is/are、Unit 6 I don't …），
// 这是作者定的顺序，比我们编一套"语法主线"可信。切章 + 取每单元正文首段做说明，
// 全程纯逻辑，跑一次几十秒。产物 subjects/english/grammar.graph.json 已入库，
// 只有换了教材或改了切章规则时才需要重跑：pnpm --filter @mathtutor/server build:grammar
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { reconstructLines, splitChapters } from "@mathtutor/knowledge";

const repoRoot = new URL("../../", import.meta.url);
const PDF = fileURLToPath(new URL("Essential Grammar in Use.pdf", repoRoot));
const OUT = fileURLToPath(new URL("subjects/english/grammar.graph.json", repoRoot));

/*
 * 教材原件受版权保护，**不在仓库里**（.gitignore 挡掉了 *.pdf）。
 * 生成产物 subjects/english/grammar.graph.json 已经提交，运行时只读它；
 * 只有想从自己手里的那本书重新生成时才需要这份 PDF——把它放在仓库根目录即可。
 */
if (!existsSync(PDF)) {
  console.error(
    `找不到教材 PDF：${PDF}\n` +
      "它受版权保护，不随仓库分发。subjects/english/grammar.graph.json 已经是生成好的结果，正常使用不需要重跑这个脚本。",
  );
  process.exit(1);
}
const data = new Uint8Array(readFileSync(PDF));
const doc = await getDocument({ data, disableFontFace: true, useSystemFonts: true }).promise;
const pages = [];
for (let i = 1; i <= doc.numPages; i++) {
  const tc = await (await doc.getPage(i)).getTextContent();
  const items = tc.items.flatMap((it) =>
    typeof it.str === "string" && Array.isArray(it.transform) ? [{ str: it.str, transform: it.transform }] : [],
  );
  pages.push({ page: i, text: reconstructLines(items).join("\n") });
}
const chapters = splitChapters(pages).filter((c) => !c.backMatter);

/**
 * PDF 的字距/字模工件：字体把连字、撇号和 "Th" 拆坏了，重建行之后成了
 * 「I ’m」「fall o ff」「! ey」。只收拾这几种确定形状，不做通用纠错——
 * 书里真有的空格、大小写不能被我们改掉（标题在书里就是小写，改了就失真）。
 */
const tidy = (text) =>
  text
    // 字体把 "Th" 映射成了 "!"（"They" → "!ey"）：与引文核验用同一条规则
    // （packages/knowledge/src/compile.ts 的 normalizeForMatch）
    .replace(/!\s?([A-Za-z])/g, (_, ch) => `th${ch.toLowerCase()}`)
    .replace(/([A-Za-z])\s+(ff|fi|fl|ft)\b/g, "$1$2")
    .replace(/\s+’/g, "’")
    .replace(/’\s+([a-z])/g, "’$1")
    .replace(/\s+([,.?!;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

/** 句子开头的大写：`tidy` 把「! ey」修成「they」之后，句首就落回小写了 */
const capitalizeSentences = (text) => text.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead, ch) => lead + ch.toUpperCase());

/**
 * 只保留真正的单元：标题形如 Unit N …
 *
 * 练习页会被切章器认成「Unit 27 Exercises」这种标题——它不是一个新单元，
 * 是上一个单元的练习，所以折回上一单元（内容和页码都并进去），不另立节点。
 */
const units = [];
for (const chapter of chapters) {
  const m = /^unit\s+(\d+)\s*(.*)$/i.exec(chapter.title.trim());
  if (!m) continue;
  const number = Number(m[1]);
  let title = tidy(m[2] ?? "");
  // 有些单元的标题被版式拆成了多行（实测 Unit 113 只剩编号）。
  // 这时从正文里取一行像标题的短句补上；取不到就留空，不编。
  if (!title) {
    const candidate = chapter.text
      .split(/\n/)
      .map((l) => l.trim())
      .find((l) => l.length >= 4 && l.length <= 60 && !/^\d+$/.test(l) && !/^unit\b/i.test(l));
    title = tidy(candidate ?? "");
  }
  const previous = units[units.length - 1];
  if (/^exercises?$/i.test(title) && previous && previous.number === number) {
    // 只并进正文语料，不并进 prose：例句只从讲解部分取，
    // 否则练习题指令（`Complete the sentences in the same way.`）会混进例句里
    previous.text += `\n${chapter.text}`;
    previous.toPage = chapter.toPage;
    continue;
  }
  units.push({
    number,
    title,
    fromPage: chapter.fromPage,
    toPage: chapter.toPage,
    text: chapter.text,
    prose: chapter.text,
  });
}
units.sort((a, b) => a.number - b.number);

/**
 * 编号 → 学段。
 *
 * **书本身没分学段**（整本是 elementary，A1–A2），这里的三段只是按单元顺序等分，
 * 用来让星图上的三个学段带都有内容、并大致跟随难度（be 动词 → 时态 → 关系从句）。
 * 它是版面参数，不是书的分级结论——需要按学段查正时，应当核对教材自己的级别。
 */
const stageOf = (number) => (number <= 40 ? "primary" : number <= 100 ? "junior" : "senior");

/** 标题 → id 片段：am/is/are (questions) → am-is-are-questions */
const slug = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "unit";

/**
 * 练习题指令（`Complete the sentences in the same way.`、`Write the short form.`）。
 *
 * 书的练习区和讲解区常常在同一章里，这些句子以句号收尾、长得也像例句，
 * 混进来会让「这个单元讲什么」变成一句做题指令。判据不是"祈使句"——
 * 祈使句本身也可以是语法点（`Put it on.` 就是 Unit 115 的例句），而是
 * 祈使动词 + 句子/空/表格这类**练习对象**的组合。
 */
const isExerciseInstruction = (line) =>
  /\b(?:complete|write|put|fill|choose|answer|match|rewrite|correct|change|make)\b.{0,40}\b(?:sent\w*|words?|gaps?|blanks?|forms?|questions?|story|text|list|table|brackets?)\b/i.test(
    line,
  );

/**
 * 单元的例句（书的 A 节通常在开头给规则 + 例句）。
 *
 * 只取**完整句子**：这本教材的 A 节大量是表格，行重建会把表头（`positive`／`question`）
 * 和内容交错成 "positive question What's your name? I am am I?" 这种碎片。
 * 收完整句子（以 . ? ! 收尾）就只剩真例句，读起来是书里的原话，而不是被表格搅碎的碎片。
 * 原文照抄，不改写、不总结——改写要模型，那是另一回事。
 */
function examplesOf(text) {
  const looksLikeSentence = (line) =>
    /[.?!]$/.test(line) && // 完整句子
    line.length >= 12 && // 太短的多半是表格里的孤立词（`David.`）
    line.split(/\s+/).length >= 4 && // 至少四个词，排除 `he he?`
    /^[A-Z(“"]/.test(line) && // 以大写/引号/括号开头，排除 `am am not (…` 这类规则记号串
    !isExerciseInstruction(line) &&
    // 表格/选项串：`Write my / our / your / his`、`SARAH = PHILIP` —— 不是句子
    (line.match(/\s\/\s/g) ?? []).length < 2 &&
    !line.includes(" = ");
  const sentences = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\d+$/.test(l) && !/^unit\b/i.test(l) && looksLikeSentence(l));
  const taken = [];
  for (const line of sentences) {
    if (taken.includes(line)) continue; // 例句区常把同一句印两遍（左右栏）
    taken.push(line);
    if (taken.join(" ").length > 160) break;
  }
  return capitalizeSentences(tidy(taken.slice(0, 3).join(" "))).slice(0, 220);
}

/** 标题里的词当关键词：am/is/are → am、is、are；present simple → present、simple */
function keywordsOf(title) {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 2);
  const extra = [];
  if (/\(questions?\)/i.test(title)) extra.push("questions", "问句");
  if (/negative/i.test(title)) extra.push("negative", "否定");
  if (/present/i.test(title)) extra.push("present", "一般现在时");
  if (/past/i.test(title)) extra.push("past", "一般过去时");
  return [...new Set([...words, ...extra])].slice(0, 10);
}

const nodes = units
  .filter((unit) => unit.title)
  .map((unit) => {
    const name = `Unit ${unit.number} ${unit.title}`;
    const summary = examplesOf(unit.prose) || unit.title;
    return {
      // 前缀必须过 lint：英语学科的合法前缀是 english: 或 en:
      id: `en:grammar-${unit.number}-${slug(unit.title)}`,
      name,
      nameEn: unit.title,
      subject: "english",
      stage: stageOf(unit.number),
      strand: "english-grammar",
      lane: unit.number <= 40 ? 0 : unit.number <= 100 ? 1 : 2,
      order: unit.number,
      summary,
      whatIsIt: summary,
      keywords: keywordsOf(unit.title),
      // 书里每个单元自成一体；不做"上一单元是下一单元的先修"这种编造，
      // 只有书自己标了的（后续人工补）才算先修
      prerequisites: [],
      evolvesTo: [],
      relatedTo: [],
      applications: [],
      misconceptions: [],
      sources: [{ title: `Essential Grammar in Use（第 ${unit.number} 单元，p${unit.fromPage}–${unit.toPage}）` }],
      // 从书的单元结构抽取而来：不是模型编的，也还没逐条人工核对
      status: "extracted",
    };
  });

// 写成一张完整的小图（stages / strands / nodes），而不是裸数组：
// 加载器把它当"另一个学科的图谱"合并进来，字段与数学图同构。
const graph = {
  $comment:
    "英语语法主线，由 Essential Grammar in Use 的单元结构确定性生成（生成脚本：apps/server/build-english-grammar.mjs）。" +
    "单元标题即语法点，顺序即书的顺序；只收书里真有的单元，不补编。" +
    "stage 是按单元顺序三等分的版面参数（书本身只是一本 elementary 教材，没分学段），别当成分级结论。" +
    "要更新请重跑那个脚本。",
  stages: [
    { id: "primary", name: "小学", order: 1 },
    { id: "junior", name: "初中", order: 2 },
    { id: "senior", name: "高中", order: 3 },
  ],
  strands: [
    { id: "english-grammar", name: "英语语法", color: "#1f9d6b", icon: "✏️", oneLine: "从 be 动词到时态与句型" },
  ],
  nodes,
};

writeFileSync(OUT, JSON.stringify(graph, null, 2) + "\n", "utf8");
console.log(`单元 ${nodes.length} 个 → ${OUT}`);
console.log("前 6 个：", nodes.slice(0, 6).map((n) => n.name).join(" | "));
console.log("后 3 个：", nodes.slice(-3).map((n) => n.name).join(" | "));
console.log("摘要示例：", nodes[0]?.summary.slice(0, 120));
