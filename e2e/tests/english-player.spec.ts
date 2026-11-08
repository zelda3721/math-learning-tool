import { test, expect } from '@playwright/test'

/**
 * 英语语法课的画面：句子必须**逐字**画出来，正在练的那一段必须被框住。
 *
 * 为什么要在真浏览器里验：纯函数层只能证明"解算出了 sentence 形状、区间算对了"，
 * 证明不了 DOM 上真的画出了这句话。这一层断了，孩子看到的是一节空白的课——
 * 页面上不会有任何报错。
 *
 * 比的是文字内容与标记，不是截图：截图受字体与抗锯齿影响，红了之后分不清是回退了
 * 还是环境变了。页面是独立的 apps/web/english-lab.html（不与像素基线的实验台同页，
 * 否则多一个 KaTeX 渲染器就会让那张基线漂几像素）。
 */
const LAB = '/english-lab.html'

test('例句原样画出（弯撇号不被"整理"），被练的那一段单独高亮', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__englishLab))

  await page.evaluate(() => window.__englishLab!.seek(0))
  const svg = await page.evaluate(() => window.__englishLab!.svg())

  // 整句都在（含弯撇号）：高亮把句子切成几段 tspan，所以按文字内容比对
  const sentence = await page.evaluate(
    () => document.querySelector('#stage svg text')?.textContent ?? '',
  )
  expect(sentence).toBe('She’s eating an apple.')
  expect(sentence).not.toContain("She's")
  // 练的形式单独成一段，且加粗、带下划线——"变的是哪个词"要看得见
  expect(svg).toContain('font-weight="700"')
  expect(svg).toMatch(/font-weight="700"[^>]*>eating</)
})

test('词卡那一拍画出正面词与中文释义', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__englishLab))

  const total = await page.evaluate(() => window.__englishLab!.duration())
  await page.evaluate((t) => window.__englishLab!.seek(t), total - 100)
  const svg = await page.evaluate(() => window.__englishLab!.svg())
  expect(svg).toContain('half past eight')
  expect(svg).toContain('八点半')
})
