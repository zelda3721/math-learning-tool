import { test, expect } from '@playwright/test'

/**
 * 播放器的**像素**证据（计划阶段 2 的 DoD 真正落地的地方）。
 *
 * `player.spec.ts` 比的是 SVG 标记：它能证明"该在的元素在、属性对"，但证明不了
 * 画出来真的那样——字体回退、样式被覆盖、KaTeX 的 foreignObject 没栅格化，标记
 * 都可以一模一样。
 *
 * ## 为什么不是"逐字节相等"
 *
 * 实测（2026-11-06，本机 Chrome）：同一时刻 t 取两次截图，**DOM 逐字节相同**
 * （`#stage.innerHTML` 相等），像素却有 1721 个点不同，最大单通道差 Δ=4/255。
 * 差异集中在一块 136×230 的区域，是**合成器图层提升**造成的抗锯齿差异——
 * 跳到别处再跳回来时，元素进过合成层，回来之后仍留在合成的栅格化路径上。
 * 同样两次不做任何 seek 的连续截图则逐字节相同，说明这不是"画面残留"。
 *
 * 所以口径定成两句，两句都要成立：
 * 1. **几何**：同一时刻的 DOM 标记逐字节相同（`player.spec.ts`，严格）。
 * 2. **观感**：同一时刻的像素差异在肉眼阈值以内——单通道 Δ ≤ 8/255、
 *    差异像素占比 ≤ 1%。条数写死是因为它必须可失败：真出问题（元素没回到位、
 *    透明度残留）差的是几十上百，不是 4。
 */

const LAB = '/player-lab.html'

/** 肉眼阈值：单通道差（0..255 的合计差再除 3）与差异像素占比 */
const MAX_CHANNEL_DELTA = 8
const MAX_DIFF_RATIO = 0.01

async function settle(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

async function shotAt(page: import('@playwright/test').Page, selector: string, tMs: number): Promise<string> {
  await page.evaluate((t) => window.__playerLab!.seek(t), tMs)
  await settle(page)
  return (await page.locator(selector).screenshot()).toString('base64')
}

interface PixelDiff {
  differing: number
  ratio: number
  maxChannelDelta: number
}

/** 在页面里用 canvas 比两张 PNG：不引第三方图像库，diff 口径写在测试里 */
async function pixelDiff(
  page: import('@playwright/test').Page,
  b64a: string,
  b64b: string,
): Promise<PixelDiff> {
  return page.evaluate(
    async ([a, b]) => {
      const decode = (b64: string) =>
        new Promise<ImageData>((resolve) => {
          const img = new Image()
          img.onload = () => {
            const canvas = document.createElement('canvas')
            canvas.width = img.width
            canvas.height = img.height
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(img, 0, 0)
            resolve(ctx.getImageData(0, 0, canvas.width, canvas.height))
          }
          img.src = `data:image/png;base64,${b64}`
        })
      const da = await decode(a!)
      const db = await decode(b!)
      let differing = 0
      let maxChannelDelta = 0
      for (let i = 0; i < da.data.length; i += 4) {
        const d = Math.max(
          Math.abs(da.data[i]! - db.data[i]!),
          Math.abs(da.data[i + 1]! - db.data[i + 1]!),
          Math.abs(da.data[i + 2]! - db.data[i + 2]!),
          Math.abs(da.data[i + 3]! - db.data[i + 3]!),
        )
        if (d > 0) {
          differing++
          maxChannelDelta = Math.max(maxChannelDelta, d)
        }
      }
      return { differing, ratio: differing / (da.width * da.height), maxChannelDelta }
    },
    [b64a, b64b],
  )
}

test.beforeEach(async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))
  // 字体没就绪就截图，等于在测"随机字体回退"
  await page.evaluate(() => document.fonts.ready)
})

test('同一时刻两次渲染：像素差异在肉眼阈值内（先跳到别处再跳回来）', async ({ page }) => {
  for (const t of [0, 1500, 2990]) {
    const first = await shotAt(page, '#stage', t)
    await shotAt(page, '#stage', 9999)
    const second = await shotAt(page, '#stage', t)
    const diff = await pixelDiff(page, first, second)
    expect(diff.maxChannelDelta, `t=${t}ms 单通道差 ${diff.maxChannelDelta}`).toBeLessThanOrEqual(
      MAX_CHANNEL_DELTA,
    )
    expect(diff.ratio, `t=${t}ms 差异像素占比 ${(diff.ratio * 100).toFixed(2)}%`).toBeLessThanOrEqual(
      MAX_DIFF_RATIO,
    )
  }
})

test('转场中间帧的像素确实不同（补间在像素上也看得见）', async ({ page }) => {
  const early = await shotAt(page, '#stage', 2780 + 105)
  const late = await shotAt(page, '#stage', 2780 + 315)
  const diff = await pixelDiff(page, early, late)
  // 25% 与 75% 的中间帧若"看起来一样"，补间就是假的
  expect(diff.ratio).toBeGreaterThan(0.01)
})

test('基准画面：第 0 拍起点与转场终点', async ({ page }) => {
  await page.evaluate(() => window.__playerLab!.seek(0))
  await settle(page)
  await expect(page.locator('#stage')).toHaveScreenshot('beat0-start.png', { maxDiffPixelRatio: 0.002 })

  await page.evaluate(() => window.__playerLab!.seek(3150))
  await settle(page)
  await expect(page.locator('#stage')).toHaveScreenshot('beat0-end.png', { maxDiffPixelRatio: 0.002 })
})

test('基准画面：公式逐项显现（KaTeX 排版不动，只动可见性）', async ({ page }) => {
  // 一个原子都不显 vs 全部显出来——两张基线同时盯着"排版位置"和"可见性"，
  // 这正是 SVG 标记看起来一模一样时最容易坏的地方（字体回退、宽度变化）
  const hidden = await page.evaluate(() => window.__mathLab!.seek(0))
  await settle(page)
  expect(hidden).toBe(0)
  await expect(page.locator('#math-stage')).toHaveScreenshot('math-hidden.png', { maxDiffPixelRatio: 0.002 })

  const revealed = await page.evaluate(() => window.__mathLab!.seek(1))
  await settle(page)
  expect(revealed).toBeGreaterThan(0)
  await expect(page.locator('#math-stage')).toHaveScreenshot('math-shown.png', { maxDiffPixelRatio: 0.002 })
})

test('公式逐项显现时排版宽度恒定（一像素都不能跳）', async ({ page }) => {
  const widthAt = async (local: number) => {
    await page.evaluate((v) => window.__mathLab!.seek(v), local)
    await settle(page)
    return page.evaluate(() => window.__mathLab!.width())
  }
  const none = await widthAt(0)
  const half = await widthAt(0.5)
  const all = await widthAt(1)
  expect(half).toBe(none)
  expect(all).toBe(none)
})
