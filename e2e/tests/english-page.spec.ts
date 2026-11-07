import { test, expect } from '@playwright/test'

/**
 * 英语页冒烟：词汇卡能作答、阅读能读进去。
 *
 * 为什么值得一条 e2e：词汇与阅读的判卷是**确定性**的（词表 / 原文出处），
 * 但"卡片到底有没有换成下一个词""短文能不能打开"这类问题只有真栈知道。
 * 判对判错不重要——这里验的是流程与反馈不能断。
 *
 * 注意：这条用例要在 views.spec 之前跑（那条会吊销家长会话）。
 */
test('英语页：词汇卡能作答，阅读能打开并答题', async ({ page, request }) => {
  // 家长账号下可能还没有孩子：英语页需要一个 learner 才拉得到词卡
  const created = await request.post('/api/v1/learners', {
    data: { name: 'e2e-en', level: 'elementary_upper' },
  })
  expect([200, 201, 409]).toContain(created.status())

  await page.goto('/')
  await page.getByRole('button', { name: '英语', exact: true }).click()
  await expect(page.getByRole('heading', { name: '英语', level: 2 })).toBeVisible()

  // 词汇 tab（默认）：等词卡真的出来再找输入框（占位符随方向变，两种都认）
  const input = page.getByPlaceholder('写英文单词').or(page.getByPlaceholder('写出中文意思')).first()
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill('definitely-not-the-word')
  await input.press('Enter')

  // 答错必须给出参考答案与例句，并且有出口（下一个 / 再记一次）
  await expect(page.getByText(/正确的写法是|参考答案/).first()).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('button', { name: /下一个|再记一次/ }).first()).toBeVisible()

  // 阅读 tab：打开第一篇短文，短文与题目同屏
  await page.getByRole('button', { name: '阅读', exact: true }).click()
  await page.getByRole('button', { name: /At the Supermarket/ }).click()
  await expect(page.getByRole('button', { name: /返回短文列表/ })).toBeVisible({ timeout: 10_000 })
  await expect(page.getByPlaceholder(/用英语写下答案/)).toBeVisible()
})
