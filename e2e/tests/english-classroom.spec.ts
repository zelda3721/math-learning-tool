import { test, expect } from '@playwright/test'

/**
 * 英语语法课走真栈：真的从课程列表里选一节语法课，讲到例句出现。
 *
 * 为什么值得一条 e2e：服务端单测证明"课组得出来"，播放器实验台证明"句子画得出来"，
 * 但这两段之间还隔着一整条产品路径——课堂路由、前端下拉框、播放器装配。
 * 这条路上任何一环断了，孩子点进去都是一节空白课，而页面上不会有任何报错。
 *
 * 断言刻意只依赖"画面上出现了教材例句"这一件事，不锁具体句子内容。
 */
test('课堂页：选中英语语法课，例句真的画到画面上', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '课堂', exact: true }).click()
  await expect(page.getByRole('heading', { name: '课堂', level: 2 })).toBeVisible()

  const picker = page.locator('select').first()
  await expect(picker.locator('option')).not.toHaveCount(1)

  // 英语课按学科分了组（不分组时它们会沉在几十个数学知识点下面，翻不到）
  const grammarOption = picker.locator('option[value^="en:grammar-"]').first()
  await expect(grammarOption).toHaveCount(1)
  const nodeId = await grammarOption.getAttribute('value')
  expect(nodeId).toBeTruthy()
  await picker.selectOption(nodeId!)

  await page.getByRole('button', { name: '开始上课' }).click()

  // 第 1 拍是导语，第 2 拍开始是例句：点一次「讲完了，继续」就该看到英文句子
  await page.getByRole('button', { name: '讲完了，继续' }).click()
  // 课堂里的 SVG 只有播放器这一块（页眉那个标记在 banner 里，不在 main 内）
  const svg = page.locator('main svg').first()
  await expect(svg).toBeVisible()
  const text = await svg.evaluate((el) => el.textContent ?? '')
  // 画面上必须是一句完整的英文（教材例句），而不是空画面或占位符
  expect(text).toMatch(/[A-Za-z]{3,}[^]*[.?!]/)
  expect(text).not.toContain('未知图元')
})

test('课堂页：语法课的题是填空，答完能回到原来那一拍', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '课堂', exact: true }).click()
  const picker = page.locator('select').first()
  await expect(picker.locator('option')).not.toHaveCount(1)
  const grammarOption = picker.locator('option[value^="en:grammar-"]').first()
  const nodeId = await grammarOption.getAttribute('value')
  await picker.selectOption(nodeId!)
  await page.getByRole('button', { name: '开始上课' }).click()

  // 一路讲到提问
  const pauseButton = page.getByRole('button', { name: '做一道题看看' })
  for (let i = 0; i < 12; i++) {
    if (await pauseButton.isVisible().catch(() => false)) break
    const next = page.getByRole('button', { name: '讲完了，继续' })
    if (!(await next.isVisible().catch(() => false))) break
    await next.click()
  }
  await expect(pauseButton).toBeVisible()
  // 提问拍不可跳过：「讲完了，继续」在这一拍上不该存在（宪法第 1 条）
  await expect(page.getByRole('button', { name: '讲完了，继续' })).toHaveCount(0)
  await pauseButton.click()

  await page.getByPlaceholder('写下你的答案').fill('am')
  await page.getByRole('button', { name: '提交', exact: true }).click()

  const back = page.getByRole('button', { name: '回到刚才那一拍' })
  await expect(back).toBeVisible({ timeout: 15_000 })
  await back.click()
  await expect(page.getByRole('button', { name: '讲完了，继续' })).toBeVisible()
})
