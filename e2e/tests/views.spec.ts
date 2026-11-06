/**
 * 10 个视图的冒烟：登录态下逐页点进去，确认页面真的渲染出来、且没有未捕获异常。
 *
 * 这里的"DoD"很朴素：每个视图都能打开、页头在、控制台没有未捕获报错。
 * 引擎是离线降级启动的，所以涉及讲解/视频的接口本来就会失败——那不是断言的失败条件，
 * 冒烟要保证的是：后端不可用时，页面要"好好地说不可用"，而不是白屏或抛异常。
 */
import { test as base, expect, type Page } from '@playwright/test'

/** 收集未捕获异常：任何一个视图抛出 JS 错误，这一页就算没通过 */
const test = base.extend<{ pageErrors: string[] }>({
  pageErrors: async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message || String(e)))
    await use(errors)
    expect(errors, `页面有未捕获异常：\n${errors.join('\n')}`).toEqual([])
  },
})

interface ViewCase {
  /** 顶栏导航按钮上的字 */
  nav: string
  /** 打开后必须看得见的页头（`<h2>`） */
  heading?: string
  /** 页头之外还要核对的可见元素 */
  extra?: (page: Page) => Promise<void>
}

const VIEWS: Record<string, ViewCase> = {
  practice: { nav: '练习', heading: '今日练习' },
  ask: { nav: '问一道题', heading: '问一道题' },
  atlas: {
    nav: '星图',
    // 星图没有页头：它整页就是画布。数据到位后才会画出 info 面板（数据源那行）
    extra: async (page) => {
      await expect(page.locator('.atlas-canvas')).toBeVisible()
      await expect(page.locator('.soft-glass-panel').first()).toBeVisible()
    },
  },
  mistakes: { nav: '错题本', heading: '错题本' },
  explore: { nav: '探索', heading: '数学探索' },
  solve: { nav: '讲解', heading: '讲解' },
  ingest: { nav: '录题', heading: '题库录入' },
  bank: { nav: '题库', heading: '题库' },
  textbook: { nav: '教材', heading: '教材' },
  parent: { nav: '家长', heading: '家长中心' },
}

for (const [key, view] of Object.entries(VIEWS)) {
  test(`视图 ${key} 能打开`, async ({ page, pageErrors }) => {
    void pageErrors // 断言在 fixture 收尾时做；这里引用一下避免 lint 认为未使用
    await page.goto('/')
    await page.getByRole('button', { name: view.nav, exact: true }).click()

    if (view.heading) {
      await expect(page.getByRole('heading', { name: view.heading, level: 2 })).toBeVisible()
    }
    if (view.extra) await view.extra(page)
  })
}

test('家长能看到全部 10 个视图入口，孩子看不到录题/题库/教材/家长', async ({ page, pageErrors }) => {
  void pageErrors
  await page.goto('/')
  const labels = ['练习', '问一道题', '星图', '错题本', '探索', '讲解', '录题', '题库', '教材', '家长']
  for (const label of labels) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
  }

  // 孩子自注册后只应看到学习面——顺手把这条角色隔离在真栈上验一次
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
  await page.getByRole('button', { name: /我是新同学/ }).click()
  await page.getByPlaceholder('同学、老师都这么叫你').fill('e2e-child')
  await page.getByPlaceholder('••••').fill('e2e-pass')
  await page.getByRole('button', { name: '注册并开始', exact: true }).click()

  await expect(page.getByRole('button', { name: '练习', exact: true })).toBeVisible()
  for (const label of ['录题', '题库', '教材', '家长']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0)
  }
})
