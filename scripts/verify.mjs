#!/usr/bin/env node
/**
 * 一条命令跑完全部检查（docs/PLAN.md 阶段 0 的 DoD）。
 *
 * 顺序是刻意的，从快到慢、从便宜到贵：先让类型错误立刻报出来，
 * 再跑单测，最后才是要起真栈、真浏览器的冒烟。任何一步红了就停——
 * 后面的步骤在前面的错误之上跑不出有意义的结果。
 *
 *   node scripts/verify.mjs            全跑
 *   node scripts/verify.mjs --fast     跳过 e2e 与 python（改前端时的快循环）
 *   node scripts/verify.mjs --no-e2e   只跳 e2e
 *   node scripts/verify.mjs --no-python 只跳 pytest 与黄金集校验
 */
import { accessSync, constants } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const fast = args.has('--fast')
const skipE2e = fast || args.has('--no-e2e')
const skipPython = fast || args.has('--no-python')

const engineDir = path.join(repoRoot, 'services', 'video-engine')
const enginePython = path.join(engineDir, '.venv', 'bin', 'python')
const systemPython = 'python3'

function hasEngineVenv() {
  try {
    accessSync(enginePython, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const py = hasEngineVenv() ? enginePython : systemPython

/** ts 侧命令统一走 pnpm -r，保证每个包各自跑自己的脚本 */
const steps = [
  { name: 'typecheck', cmd: 'pnpm', argv: ['-r', 'typecheck'] },
  { name: 'build', cmd: 'pnpm', argv: ['-r', 'build'] },
  { name: 'test(unit)', cmd: 'pnpm', argv: ['-r', 'test'] },
  {
    name: 'golden(check)',
    cmd: py,
    argv: ['scripts/golden_check.py'],
    skip: skipPython,
  },
  {
    name: 'test(engine/pytest)',
    cmd: py,
    argv: ['-m', 'pytest', '-q'],
    cwd: engineDir,
    skip: skipPython,
    // 系统 python3 一般没装 pytest 与引擎依赖：没 venv 就不假装跑过
    skipWhen: () => !hasEngineVenv(),
    skipReason: 'services/video-engine/.venv 不存在，先按 README 建虚拟环境',
  },
  {
    name: 'test(e2e)',
    cmd: 'pnpm',
    // 用 e2e 包自己的 test:e2e：该包**故意**没有 `test` 脚本，
    // 否则 `pnpm -r test` 会把冒烟一起拉进来（它要起真栈，不该混在单测里）。
    // 也正因为如此，这里绝不能写成 `pnpm --filter … test`——脚本不存在时 pnpm 返回 0，
    // 那会变成"什么都没跑却报全绿"。
    argv: ['--filter', '@mathtutor/e2e', 'test:e2e'],
    skip: skipE2e,
  },
]

const results = []

for (const step of steps) {
  const skip = step.skip || (step.skipWhen && step.skipWhen())
  if (skip) {
    const why = step.skipReason ?? '按参数跳过'
    console.log(`\n⏭  ${step.name} —— ${why}`)
    results.push({ name: step.name, status: 'skipped' })
    continue
  }

  console.log(`\n▶  ${step.name}: ${step.cmd} ${step.argv.join(' ')}`)
  const started = Date.now()
  const proc = spawnSync(step.cmd, step.argv, {
    cwd: step.cwd ?? repoRoot,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  if (proc.error) {
    console.error(`\n✘  ${step.name} 起不来：${proc.error.message}`)
    results.push({ name: step.name, status: 'failed', seconds })
    break
  }
  if (proc.status !== 0) {
    console.error(`\n✘  ${step.name} 失败（${seconds}s，退出码 ${proc.status}）`)
    results.push({ name: step.name, status: 'failed', seconds })
    break
  }
  console.log(`✔  ${step.name} 通过（${seconds}s）`)
  results.push({ name: step.name, status: 'passed', seconds })
}

const failed = results.filter((r) => r.status === 'failed')
const skipped = results.filter((r) => r.status === 'skipped')
console.log('\n──────── verify ────────')
for (const r of results) {
  const mark = r.status === 'passed' ? '✔' : r.status === 'failed' ? '✘' : '⏭'
  console.log(`  ${mark} ${r.name}${r.seconds ? `  ${r.seconds}s` : ''}`)
}

if (failed.length > 0) {
  console.error(`\n[FAIL] ${failed[0].name} 未通过——修好再往下走（阶段门槛：不满足 DoD 不进入下一阶段）`)
  process.exit(1)
}
if (skipped.length > 0) {
  console.log(`\n[OK] 全绿（跳过了 ${skipped.length} 步）`)
} else {
  console.log('\n[OK] 全绿')
}
