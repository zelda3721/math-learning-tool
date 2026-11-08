import { test, expect } from '@playwright/test'

/**
 * 英语语法这条线：英语页 → 单元列表 → 单元详情 → 去课堂学这一课 → 课堂真的打开了那一单元。
 *
 * 为什么值得一条 e2e：这条路上三个模块各自都有单测（单元目录、课堂组课、课堂页），
 * 但它们之间的**交接**没有：点「听老师讲这一课」要不要真的把节点带过去、
 * 课堂会不会打开正确的那节课、题拍停不停得住。任何一环断了，孩子看到的都是
 * "点了没反应"或"上错课"，而页面上不会有任何报错。
 *
 * 注意：与 english-page.spec 一样，要在 views.spec 之前跑（那条会吊销家长会话）。
 */
test('英语语法：单元 → 课堂语法课 → 讲到提问拍 → 答题回到原处', async ({ page, request }) => {
  const created = await request.post('/api/v1/learners', {
    data: { name: 'e2e-grammar', level: 'elementary_upper' },
  })
  expect([200, 201, 409]).toContain(created.status())

  await page.goto('/')
  await page.getByRole('button', { name: '英语', exact: true }).click()
  await expect(page.getByRole('heading', { name: '英语', level: 2 })).toBeVisible()

  // 语法 tab
  await page.getByRole('button', { name: '语法', exact: true }).click()
  const search = page.getByPlaceholder('搜单元名，比如 am/is/are、过去时')
  await expect(search).toBeVisible({ timeout: 10_000 })
  await search.fill('Unit 3')
  const unit = page.locator('li', { hasText: 'Unit 3' }).first()
  await expect(unit).toBeVisible({ timeout: 10_000 })
  await unit.getByRole('button', { name: '学这一单元' }).click()

  // 单元详情：讲什么 + 去课堂
  await expect(page.getByRole('button', { name: '听老师讲这一课' })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '听老师讲这一课' }).click()

  // 课堂：应当已经选中了刚才那个单元（预选生效），并且课真的组出来了
  await expect(page.getByRole('heading', { name: '课堂', level: 2 })).toBeVisible({ timeout: 10_000 })
  // 注意用 heading：下拉框里的 option 也含同一串字，但它是隐藏的
  await expect(page.getByRole('heading', { name: /I am doing \(present continuous\)/ })).toBeVisible({
    timeout: 30_000,
  })

  await page.getByRole('button', { name: '开始上课' }).click()

  // 一路讲到提问拍：提问拍上不渲染「继续」（宪法第 1 条：理解由行为验证）
  const pauseButton = page.getByRole('button', { name: '做一道题看看' })
  for (let i = 0; i < 12; i++) {
    if (await pauseButton.isVisible().catch(() => false)) break
    const next = page.getByRole('button', { name: '讲完了，继续' })
    if (!(await next.isVisible().catch(() => false))) break
    await next.click()
  }
  await expect(pauseButton).toBeVisible()
  await expect(page.getByRole('button', { name: '讲完了，继续' })).toHaveCount(0)
  await pauseButton.click()

  // 语法课的问法是填空：写一个答案交上去，答完能回到原来那一拍
  const input = page.getByPlaceholder('写下你的答案')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.fill('is raining')
  await page.getByRole('button', { name: '提交' }).click()
  await expect(page.getByRole('button', { name: '回到刚才那一拍' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '回到刚才那一拍' }).click()

  // 回到原处之后，「继续」回来了（这一拍已经答过）
  await expect(page.getByRole('button', { name: '讲完了，继续' })).toBeVisible({ timeout: 10_000 })
})
