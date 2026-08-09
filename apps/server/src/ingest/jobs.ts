import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BatchProgress } from "./batch.js";

export interface IngestJob {
  id: string;
  status: "running" | "done" | "failed";
  batchName: string;
  progress: BatchProgress | Record<string, never>;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 批量抽取任务状态（运行时数据，app.sqlite）。单机单发：进程内串行执行。 */
export class JobStore {
  constructor(private readonly db: DatabaseSync) {
    // 进程重启后残留的 running 任务已死，标记失败（不静默装作还在跑）
    this.db
      .prepare("UPDATE ingest_jobs SET status = 'failed', error = '服务重启，任务中断，请重新上传' WHERE status = 'running'")
      .run();
  }

  create(batchName: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO ingest_jobs (id, status, batch_name, created_at, updated_at) VALUES (?, 'running', ?, ?, ?)",
      )
      .run(id, batchName, now, now);
    return id;
  }

  updateProgress(id: string, progress: BatchProgress): void {
    this.db
      .prepare("UPDATE ingest_jobs SET progress_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(progress), new Date().toISOString(), id);
  }

  finish(id: string, result: unknown): void {
    this.db
      .prepare("UPDATE ingest_jobs SET status = 'done', result_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), new Date().toISOString(), id);
  }

  fail(id: string, error: string): void {
    this.db
      .prepare("UPDATE ingest_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
      .run(error, new Date().toISOString(), id);
  }

  get(id: string): IngestJob | undefined {
    const r = this.db.prepare("SELECT * FROM ingest_jobs WHERE id = ?").get(id);
    if (!r) return undefined;
    return {
      id: String(r.id),
      status: r.status as IngestJob["status"],
      batchName: String(r.batch_name),
      progress: JSON.parse(String(r.progress_json ?? "{}")),
      result: r.result_json === null || r.result_json === undefined ? null : JSON.parse(String(r.result_json)),
      error: r.error === null || r.error === undefined ? null : String(r.error),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
}
