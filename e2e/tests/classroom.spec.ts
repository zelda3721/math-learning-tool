import { test, expect } from '@playwright/test'

/**
 * 课堂驱动**真实**播放器：验的是状态机下发的指令真的改变了画面，
 * 而不只是假播放器里记了两笔。
 */

const LAB = '/player-lab.html'

const beatLabel = (svg: string) => /aria-label="([^"]*)"/.exec(svg)?.[1]

test('开始上课 → 画面停在第 1 拍', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  const phase = await page.evaluate(() => window.__playerLab!.classroom.start())
  expect(phase).toBe('explaining')

  const svg = await page.evaluate(() => window.__playerLab!.classroom.svg())
  // 实验台第 0 拍的讲解句
  expect(beatLabel(svg)).toBe('篮子里有 12 个苹果')
})

test('讲完一拍 → 真实画面跟着换页', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  await page.evaluate(() => window.__playerLab!.classroom.start())
  await page.evaluate(() => window.__playerLab!.classroom.beatFinished())

  const index = await page.evaluate(() => window.__playerLab!.classroom.beatIndex())
  expect(index).toBe(1)
  const svg = await page.evaluate(() => window.__playerLab!.classroom.svg())
  expect(beatLabel(svg)).toBe('拿走 4 个')
})

test('暂停提问时画面不动；答完回来还是那一页', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  await page.evaluate(() => {
    const c = window.__playerLab!.classroom
    c.start()
    c.beatFinished()
  })
  const before = await page.evaluate(() => window.__playerLab!.classroom.svg())

  await page.evaluate(() => window.__playerLab!.classroom.pauseQuestion('你觉得现在还剩几个？'))
  const during = await page.evaluate(() => window.__playerLab!.classroom.svg())
  expect(during, '提问时不该把画面推走').toBe(before)

  await page.evaluate(() => window.__playerLab!.classroom.resume())
  const after = await page.evaluate(() => window.__playerLab!.classroom.svg())
  expect(after, '回来应当还是原场景').toBe(before)
  expect(beatLabel(after)).toBe('拿走 4 个')
})
