/**
 * 冒烟沙箱准备：给 e2e 一套**只属于它自己**的运行时数据，真实 data/ 一个字节都不动。
 *
 * 为什么必须在网关启动**之前**跑：网关启动时 openDb() 就把 app.sqlite 打开了（WAL 模式），
 * 那时候再删库，删的是另一个 inode，网关仍写在旧文件上——测试就会看到上一轮残留的账号。
 * 所以这个脚本被串进 webServer 的启动命令里（`node prepare-sandbox.mjs && node …/index.js`）。
 *
 * 知识层（graph/problems/questions）是 file-first 的只读输入，用软链指过去即可，
 * 不复制——复制一份 200KB 的图谱只会在改图谱后变成过期副本。
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')
const sandbox = path.join(repoRoot, 'data', '.e2e')

mkdirSync(sandbox, { recursive: true })

for (const f of ['app.sqlite', 'app.sqlite-shm', 'app.sqlite-wal']) {
  rmSync(path.join(sandbox, f), { force: true })
}

const knowledgeLink = path.join(sandbox, 'knowledge')
if (!existsSync(knowledgeLink)) {
  symlinkSync(path.join('..', 'knowledge'), knowledgeLink, 'dir')
}

console.log(`[e2e] sandbox ready: ${sandbox}`)
