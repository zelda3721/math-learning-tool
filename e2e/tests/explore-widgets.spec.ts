import { test, expect } from '@playwright/test'

/**
 * 探索页的「动手试一试」：组件真的画出来、真的能被操作。
 *
 * 为什么值得一条 e2e：组件是 SVG 里算出来的，算错一个坐标浏览器不会报错，
 * 只会默默不画——单测能挡 NaN 与越界，但"页面上到底有没有东西"只有真栈知道。
 *
 * 走的是真栈：真图谱、真题库。
 */
test('探索页：选中知识点 → 动手组件能操作 → 收尾题出现', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '探索', exact: true }).click()

  // 下拉里只列"掌握中"的节点（新账号一个都没有），全图搜索才是入口。
  // 「面积」在图谱里对应「面积与面积单位」，配的是 area_grid。
  const search = page.getByPlaceholder('搜索全部知识点…')
  await search.fill('面积')
  const hit = page.locator('button', { hasText: '面积' }).first()
  await expect(hit).toBeVisible({ timeout: 10_000 })
  await hit.click()

  await expect(page.getByText('动手试一试', { exact: false }).first()).toBeVisible({ timeout: 10_000 })

  // 画面真的画出来了：组件里得有一个 SVG（别拿页面图标当证据）
  const host = page.getByTestId('widget-host')
  const svg = host.locator('svg').first()
  await expect(svg).toBeVisible()

  // 动一下滑杆，画面要跟着变（比较序列化后的标记，不依赖像素）
  const before = await svg.evaluate((el) => el.outerHTML)
  const slider = host.locator('input[type="range"]').first()
  if ((await slider.count()) > 0) {
    const max = await slider.getAttribute('max')
    await slider.fill(String(Math.max(1, Number(max ?? 10) - 1)))
    const after = await svg.evaluate((el) => el.outerHTML)
    expect(after).not.toBe(before)
  }

  // 「我看明白了」→ 收尾题那一段出现
  await page.getByRole('button', { name: '我看明白了，做题' }).click()
  await expect(page.getByText('收尾题 · 动手不算分，这道题算')).toBeVisible({ timeout: 10_000 })
})
