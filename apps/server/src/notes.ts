/**
 * P5 研究笔记（file-first）：data/notes/<learnerId>/<slug>.md
 * YAML frontmatter {title, nodeId, learnerId, created}，正文为 Markdown。
 * 孩子在「探索」里记下的发现是数据资产——纯文件、可读可迁移、无 DB。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { effectiveLearnerId, type AppState } from "./app.js";

export interface ResearchNote {
  slug: string;
  title: string;
  nodeId: string;
  learnerId: string;
  created: string;
  contentMd: string;
}

export interface NoteInput {
  learnerId: string;
  nodeId: string;
  title: string;
  contentMd: string;
}

/** 文件系统安全：learnerId 只保留安全字符（防路径穿越） */
function safeSegment(raw: string): string {
  const s = raw.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!s) throw new Error(`invalid path segment: ${raw}`);
  return s;
}

/** slug = 标题规范化（保留中英文数字，其余折叠为 -）+ 短随机后缀 */
export function slugify(title: string): string {
  const base = title
    .replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .toLowerCase();
  const rand = randomBytes(3).toString("hex");
  return `${base || "note"}-${rand}`;
}

function notesDir(dataDir: string, learnerId: string): string {
  return path.join(dataDir, "notes", safeSegment(learnerId));
}

/** frontmatter 值单行化（我们自己写自己读，逐行 `key: value` 即可） */
function fmValue(v: string): string {
  return v.replace(/\r?\n/g, " ").trim();
}

export function saveNote(dataDir: string, input: NoteInput): ResearchNote {
  const dir = notesDir(dataDir, input.learnerId);
  mkdirSync(dir, { recursive: true });
  const slug = slugify(input.title);
  const created = new Date().toISOString();
  const note: ResearchNote = {
    slug,
    title: fmValue(input.title),
    nodeId: input.nodeId,
    learnerId: input.learnerId,
    created,
    contentMd: input.contentMd,
  };
  const md = [
    "---",
    `title: ${note.title}`,
    `nodeId: ${fmValue(note.nodeId)}`,
    `learnerId: ${fmValue(note.learnerId)}`,
    `created: ${created}`,
    "---",
    "",
    input.contentMd,
    "",
  ].join("\n");
  writeFileSync(path.join(dir, `${slug}.md`), md, "utf8");
  return note;
}

/** 解析单个笔记文件；frontmatter 破损时返回 null（宽容跳过） */
function parseNoteFile(filePath: string, slug: string): ResearchNote | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (!meta["title"] || !meta["learnerId"]) return null;
  return {
    slug,
    title: meta["title"],
    nodeId: meta["nodeId"] ?? "",
    learnerId: meta["learnerId"],
    created: meta["created"] ?? "",
    contentMd: m[2]!.replace(/^\r?\n/, "").replace(/\s+$/, ""),
  };
}

export function listNotes(dataDir: string, learnerId: string, nodeId?: string): ResearchNote[] {
  let files: string[];
  try {
    files = readdirSync(notesDir(dataDir, learnerId));
  } catch {
    return []; // 目录不存在 = 还没有笔记
  }
  const notes: ResearchNote[] = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const note = parseNoteFile(path.join(notesDir(dataDir, learnerId), f), f.slice(0, -3));
    if (!note) continue;
    if (nodeId && note.nodeId !== nodeId) continue;
    notes.push(note);
  }
  return notes.sort((a, b) => b.created.localeCompare(a.created));
}

const SaveNoteSchema = z.object({
  learnerId: z.string().min(1),
  nodeId: z.string().min(1),
  title: z.string().min(1),
  contentMd: z.string().min(1),
});

/** POST / → {ok, slug}；GET /?learnerId=&nodeId= → {notes} */
export function notesRoutes(state: AppState): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = SaveNoteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "需要 learnerId / nodeId / title / contentMd" }, 400);
    parsed.data.learnerId = effectiveLearnerId(c, state, parsed.data.learnerId) ?? parsed.data.learnerId;
    try {
      const note = saveNote(state.config.dataDir, parsed.data);
      return c.json({ ok: true, slug: note.slug });
    } catch {
      return c.json({ error: "保存失败" }, 422);
    }
  });

  app.get("/", (c) => {
    const learnerId = effectiveLearnerId(c, state, c.req.query("learnerId"));
    if (!learnerId) return c.json({ error: "需要 learnerId" }, 400);
    try {
      return c.json({ notes: listNotes(state.config.dataDir, learnerId, c.req.query("nodeId")) });
    } catch {
      return c.json({ notes: [] });
    }
  });

  return app;
}
