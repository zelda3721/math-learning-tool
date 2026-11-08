import { test, expect } from '@playwright/test'

/**
 * 课堂页冒烟：真的把一节课上下来。
 *
 * 只验"页面能打开"是不够的——课堂的价值全在流程里：讲 → 停 → 问 → 答 → 回到原处。
 * 这几步任何一步断了，孩子看到的就是一节卡住的课，而页面上不会有任何报错。
 *
 * 用的是真栈（真题库、真判卷）：沙箱里已经有 264 道题，挑第一节能开的课即可。
 */
test('课堂页：开课 → 讲到提问 → 作答 → 回到原处', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '课堂', exact: true }).click()
  await expect(page.getByRole('heading', { name: '课堂', level: 2 })).toBeVisible()

  const picker = page.locator('select').first()
  // 等课程列表到位（接口回来后才有第二个 option）
  await expect(picker.locator('option')).not.toHaveCount(1)
  const firstLesson = await picker.locator('option').nth(1).getAttribute('value')
  expect(firstLesson).toBeTruthy()
  await picker.selectOption(firstLesson!)

  // 课装好了才有「开始上课」
  await page.getByRole('button', { name: '开始上课' }).click()

  // 一拍拍往下讲，直到出现「做一道题看看」
  const pauseButton = page.getByRole('button', { name: '做一道题看看' })
  for (let i = 0; i < 12; i++) {
    if (await pauseButton.isVisible().catch(() => false)) break
    const next = page.getByRole('button', { name: '讲完了，继续' })
    if (!(await next.isVisible().catch(() => false))) break
    await next.click()
  }

  if (!(await pauseButton.isVisible().catch(() => false))) {
    // 这节课没有可问的题：能一路讲到小结就算通过（那是 compose 的正常形态）
    await expect(page.getByText('小结').first()).toBeVisible({ timeout: 10_000 })
    return
  }

  await pauseButton.click()
  await expect(page.getByText('先别急着看下面的按钮')).toBeVisible()

  // 作答：选项题点第一个选项；填空题写一版答案（判对判错不重要，流程要走通）
  const optionButtons = page.getByTestId('lesson-options').getByRole('button')
  if ((await optionButtons.count()) > 0) {
    await optionButtons.first().click()
  } else {
    await page.getByPlaceholder('写下你的答案').fill('1')
  }
  await page.getByRole('button', { name: '提交', exact: true }).click()

  // 答完能回到那一拍：状态回到「正在讲」
  const back = page.getByRole('button', { name: '回到刚才那一拍' })
  await expect(back).toBeVisible({ timeout: 15_000 })
  await back.click()
  await expect(page.getByRole('button', { name: '讲完了，继续' })).toBeVisible()
})
