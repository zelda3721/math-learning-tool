import { test, expect } from '@playwright/test'

declare global {
  interface Window {
    __playerLab?: {
      seek(tMs: number): void
      duration(): number
      beats(): number
      svg(): string
    }
  }
}

/**
 * 播放器 DoD 的浏览器侧证据：同一时刻 t 的渲染必须完全一致。
 *
 * 比的是 SVG 序列化后的标记，不是截图：
 * - 截图受字体、DPI、抗锯齿影响，红了之后分不清是回退了还是环境变了
 * - 标记是显式的，diff 直接告诉你是哪个元素挪了、挪了多少
 *
 * 页面是 apps/web/player-lab.html（仅测试用，不进产品入口）。
 */
const LAB = '/player-lab.html'

async function seekAt(page: import('@playwright/test').Page, tMs: number): Promise<string> {
  await page.evaluate((t) => window.__playerLab!.seek(t), tMs)
  return page.evaluate(() => window.__playerLab!.svg())
}

test('同一时刻两次渲染逐字节一致', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  for (const t of [0, 1500, 2990, 5000]) {
    const first = await seekAt(page, t)
    // 先跳到别处再跳回来：如果画面依赖"上一帧残留"，这里就会露馅
    await seekAt(page, 9999)
    const second = await seekAt(page, t)
    expect(second, `t=${t}ms 两次渲染不一致`).toBe(first)
  }
})

test('转场窗口内不同进度画出不同的中间帧（补间真的在工作）', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  // 第 0 拍 0..3200，转场窗口 2780..3200
  const early = await seekAt(page, 2780 + 105) // ≈25%
  const late = await seekAt(page, 2780 + 315) // ≈75%
  expect(late).not.toBe(early)

  // 转场起点（进度 0）就是本拍的静止画面：不掺任何位移
  const beatStart = await seekAt(page, 0)
  const transitionStart = await seekAt(page, 2780)
  expect(transitionStart).toBe(beatStart)

  // 转场中必须与静止画面不同——否则"补间在工作"就是句空话
  expect(early).not.toBe(beatStart)
})

test('seek 与顺序播放走的是同一条时间轴', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  const duration = await page.evaluate(() => window.__playerLab!.duration())
  expect(duration).toBe(3200 * 3)

  // 越界 seek 钳制到末尾，与直接跳到 duration 等价
  const atEnd = await seekAt(page, duration)
  const beyond = await seekAt(page, duration + 99_999)
  expect(beyond).toBe(atEnd)
})

test('条也补间：转了 set_value 之后几何随进度变化', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  // 第 0 拍 0..3200（12 条满槽），转场窗口 2780..3200，第 1 拍量降到 8
  const early = await seekAt(page, 2780 + 105)
  const late = await seekAt(page, 2780 + 315)
  expect(late, '条的几何没有随进度变化（set_value 或条补间没生效）').not.toBe(early)

  // 进度 0 仍是本拍的静止画面：不掺任何位移
  const beatStart = await seekAt(page, 0)
  expect(await seekAt(page, 2780)).toBe(beatStart)
})
