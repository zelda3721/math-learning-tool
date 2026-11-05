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

  // 注意：不要再拿 seek(0) 当"本拍的静止画面"。
  // 动作通道让一拍之内也有时间结构（新出现的对象会渐显、被强调的对象会脉冲），
  // 所以"拍的任意时刻"与"拍的起点"本来就不该一样。
  // 转场进度 0 不带位移这条性质，由 motion 的纯函数测试保证（tweenPoint(a,b,0) === a）。
  const beatStart = await seekAt(page, 0)
  expect(early).not.toBe(beatStart)
})

test('seek 与顺序播放走的是同一条时间轴', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  const { duration, beats } = await page.evaluate(() => ({
    duration: window.__playerLab!.duration(),
    beats: window.__playerLab!.beats(),
  }))
  // 总时长 = 拍数 × 每拍 3200：不写死拍数——实验台加一拍就会红，那是噪音不是缺陷
  expect(duration).toBe(3200 * beats)

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

  // 同上：拍内已有时间结构，"起点"不再是整拍的代表帧
  const beatStart = await seekAt(page, 0)
  expect(early).not.toBe(beatStart)
})

test('动作通道：拍内强调随时间变化，且不重建画面', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  // 第 3 拍（6400..9600）只搬运 apples→basket：price 没被碰到，
  // 于是在 spotlight 的窗口里它会被压暗，窗口之外不会。
  const beforeWindow = await seekAt(page, 6400 + 100) // 拍内 0.03，窗口从 0.12 起
  const atPeak = await seekAt(page, 6400 + 1600) // 拍内 0.5，窗口正中

  expect(atPeak, '拍内强调没有随时间变化').not.toBe(beforeWindow)
  // 压暗是具体的：被冷落的那个组降到 0.45
  expect(atPeak).toContain('opacity="0.450"')
  expect(beforeWindow).not.toContain('opacity="0.450"')

  // 通道只改属性、不重建画面，但结果仍然确定：同一时刻两次一致
  await seekAt(page, 9999)
  expect(await seekAt(page, 6400 + 1600)).toBe(atPeak)
})

test('annotate：讲解句钉在被强调的对象旁，且显隐由 t 决定', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  // 标注的文字只出现在 SVG 里（字幕是画布外的 div），所以能据此判断它在不在
  const noteOpacity = (svg: string, text: string): number | null => {
    const m = new RegExp(`<text[^>]*opacity="([\\d.]+)"[^>]*>${text}</text>`).exec(svg)
    return m ? Number(m[1]) : null
  }

  const before = await seekAt(page, 3200 + 100) // 窗口从拍内 0.12 起
  const peak = await seekAt(page, 3200 + 1600) // 窗口正中

  const atPeak = noteOpacity(peak, '拿走 4 个')
  const atBefore = noteOpacity(before, '拿走 4 个')

  expect(atPeak, '标注没有在窗口里出现').not.toBeNull()
  expect(atPeak!).toBeGreaterThan(0.5)
  // 窗口之前：元素已在（画面一画就建好），但透明——显隐是 t 算出来的，不是画的时候淡入
  expect(atBefore === null || atBefore === 0).toBe(true)

  // 仍然是确定的
  await seekAt(page, 9999)
  expect(await seekAt(page, 3200 + 1600)).toBe(peak)
})

test('setState：拍内的数字自己走（数一遍），窗口外停在两端', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  // 第 4 拍（9600..12800）是"数一遍"，real 数量 5：窗口 0.15..0.85
  const before = await seekAt(page, 9600 + 200) // 拍内 0.06，还没开始数
  const done = await seekAt(page, 9600 + 11500) // 拍内 0.9，数完了

  // 计数文字：`>0<` → `>5<`，且只由 state 通道驱动（这一拍没有别的东西产生这两个数）
  expect(before, '窗口之前应当还没开始数').toContain('>0</text>')
  expect(done, '窗口之后应当停在真实数量').toContain('>5</text>')

  // 仍然是确定的
  await seekAt(page, 0)
  expect(await seekAt(page, 9600 + 11500)).toBe(done)
})
