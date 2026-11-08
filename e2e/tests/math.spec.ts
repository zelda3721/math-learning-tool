import { test, expect } from '@playwright/test'

/**
 * 公式逐项显现：验的不是"能淡入"，而是**淡入时排版一点没动**。
 *
 * 拆错方式的典型症状就是宽度变——拆成几段各自渲染再拼，间距按段重算，
 * 整条公式的宽度会随可见项数一起变。那种"公式在跳"比不做动画还糟。
 */

const LAB = '/player-lab.html'

async function seek(page: import('@playwright/test').Page, local: number): Promise<number> {
  return page.evaluate((p) => window.__mathLab!.seek(p), local)
}


test('整条公式被切成多个顶层原子', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__mathLab))

  const atoms = await page.evaluate(() => window.__mathLab!.atoms())
  // x^2 + 3x - 4 = 0 至少是五六项；太少说明切分没生效（整条被当成一个原子）
  expect(atoms).toBeGreaterThanOrEqual(5)
})

test('进度推进时可见原子变多，而公式宽度恒定', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__mathLab))

  const total = await page.evaluate(() => window.__mathLab!.atoms())
  const widthAtStart = await page.evaluate(() => window.__mathLab!.width())

  expect(await seek(page, 0)).toBe(0)
  const seen: number[] = []
  for (const p of [0.2, 0.4, 0.6, 0.8, 1]) {
    seen.push(await seek(page, p))
    // 每一步都核对宽度：这是"排版没动"的直接证据
    expect(await page.evaluate(() => window.__mathLab!.width())).toBeCloseTo(widthAtStart, 1)
  }

  // 单调递增，最后全部可见
  for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!)
  expect(seen[seen.length - 1]).toBe(total)
})

test('同一进度两次设置得到同样的透明度', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__mathLab))

  const read = async (p: number) => {
    await seek(page, p)
    return page.evaluate(() =>
      Array.from(document.querySelectorAll('#math-stage .base > *'))
        .map((n) => (n as HTMLElement).style.opacity)
        .join(','),
    )
  }

  const first = await read(0.5)
  await read(0.9)
  expect(await read(0.5)).toBe(first)
})

test('播放器里的公式：真的由 KaTeX 渲染，且随拍内进度逐项显现', async ({ page }) => {
  await page.goto(LAB)
  await page.waitForFunction(() => Boolean(window.__playerLab))

  const frame = async (t: number) =>
    page.evaluate((ms) => {
      window.__playerLab!.seek(ms)
      return window.__playerLab!.svg()
    }, t)

  const early = await frame(0 + 200)
  const late = await frame(0 + 2800)

  // 公式走 foreignObject（SVG 里塞 HTML），不是把 $...$ 当纯文本画
  expect(early).toContain('<foreignObject')
  expect(early).not.toContain('$8x-3y$')

  // 原子透明度随拍内进度变化：同一块公式，晚一点看到的可见项更多
  const visibleAtoms = (svg: string): number =>
    (svg.match(/opacity:\s*1(?:\.0*)?;?/g) ?? []).length
  expect(visibleAtoms(late)).toBeGreaterThan(visibleAtoms(early))

  // 仍然是确定的
  await frame(99999)
  expect(await frame(2800)).toBe(late)
})
