/**
 * 冒烟前置：建一个家长账号并登录一次，把会话 cookie 存成 storageState。
 *
 * 账号用接口建（UI 首次初始化页也是一种视图，但它不属于"9 个视图"的冒烟范围），
 * 登录则走真实表单——登录这一步本身就是冒烟的一部分。
 */
import { test as setup, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PARENT = { username: 'e2e-parent', password: 'e2e-pass' }

const here = path.dirname(fileURLToPath(import.meta.url))
const statePath = path.join(here, '..', '.auth', 'parent.json')

setup('建立家长账号并登录', async ({ page, request }) => {
  // 沙箱每次运行都是新库；不过直接建过一次（本地反复跑、或上次没清干净）也要能继续
  const res = await request.post('/api/v1/auth/setup-parent', {
    data: { username: PARENT.username, password: PARENT.password },
  })
  if (!res.ok()) {
    expect(res.status(), 'setup-parent 只允许 409（账号已存在）').toBe(409)
    const login = await request.post('/api/v1/auth/login', {
      data: { username: PARENT.username, password: PARENT.password },
    })
    expect(login.ok(), '已有账号时必须能登录：密码得和 PARENT 一致').toBeTruthy()
  }

  // 走真实登录表单
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
  await page.getByPlaceholder('你的名字').fill(PARENT.username)
  await page.getByPlaceholder('••••').fill(PARENT.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()

  // 登录成功的标志：顶栏导航出现（AuthedApp 才渲染它）
  await expect(page.getByRole('button', { name: '练习', exact: true })).toBeVisible()

  // 练习/问一道题/错题本/探索这四个视图在没有 learner 时只渲染 LearnerGate——
  // 家长账号刚建出来是零 learner，所以先造一个，否则冒烟测的只是"拦截页长得对"。
  // request fixture 与页面共用 cookie，所以这一步是带登录态的。
  const learners = await request.get('/api/v1/learners')
  const existing = ((await learners.json()) as { learners?: unknown[] }).learners ?? []
  if (existing.length === 0) {
    const created = await request.post('/api/v1/learners', {
      data: { name: '小e', level: 'elementary_upper' },
    })
    expect(created.status(), '家长建 learner 应返回 201').toBe(201)
  }

  mkdirSync(path.dirname(statePath), { recursive: true })
  await page.context().storageState({ path: statePath })
})
