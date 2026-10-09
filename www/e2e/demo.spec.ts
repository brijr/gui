import { expect, type Page, test } from '@playwright/test'

// "Try it now" (src/components/Demo.astro): the page shrinks into a Gui window, a scripted
// session underlines two words of the headline, and the visitor can then try changes.

const demo = (page: Page) => page.locator('[data-demo]')
const stateOf = (page: Page) => demo(page).getAttribute('data-state')

async function open(page: Page) {
  await page.getByRole('button', { name: 'Try it now' }).click()
  await expect(page.getByRole('dialog', { name: 'Gui demo' })).toBeVisible()
}

async function untilIdle(page: Page) {
  await expect(demo(page)).toHaveAttribute('data-state', 'idle', { timeout: 40_000 })
}

/** The page box's transform, as [scale, x, y] */
async function pageTransform(page: Page) {
  return page.locator('[data-page]').evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform)
    return [m.a, m.e, m.f]
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('the page shrinks into the preview of a Gui window', async ({ page }) => {
  await open(page)
  await expect(demo(page)).toHaveAttribute('data-state', /intro|idle/)

  const [scale] = await pageTransform(page)
  expect(scale).toBeGreaterThan(0.5)
  expect(scale).toBeLessThan(0.81)

  // The scaled page fills the window's preview exactly, with the chat on its left.
  const shown = await page.locator('[data-page]').boundingBox()
  const area = await page.locator('[data-marks]').boundingBox()
  const chat = await page.getByRole('complementary', { name: 'Chat' }).boundingBox()
  if (!shown || !area || !chat) throw new Error('missing boxes')
  expect(Math.abs(shown.x - area.x)).toBeLessThan(1)
  expect(Math.abs(shown.y - area.y)).toBeLessThan(1)
  expect(Math.abs(shown.width - area.width)).toBeLessThan(1)
  expect(Math.abs(shown.height - area.height)).toBeLessThan(1)
  expect(Math.abs(shown.x - (chat.x + chat.width))).toBeLessThan(1)

  await expect(page.getByRole('button', { name: 'Close demo' })).toBeFocused()
})

test('only transform and opacity animate while it opens', async ({ page }) => {
  await page.getByRole('button', { name: 'Try it now' }).click()
  const properties = await page.evaluate(() =>
    document.getAnimations().flatMap((a) =>
      (a.effect as KeyframeEffect)
        .getKeyframes()
        .flatMap((k) => Object.keys(k))
        .filter((key) => !['offset', 'computedOffset', 'easing', 'composite'].includes(key)),
    ),
  )
  expect(properties.length).toBeGreaterThan(0)
  expect(new Set(properties)).toEqual(new Set(['transform', 'opacity']))
})

/** Times every frame for a while after `act`, in the page: [count, p95 gap, longest gap] */
async function frames(page: Page, act: string, ms: number) {
  const gaps = await page.evaluate(
    async ([selector, duration]) => {
      const times: number[] = []
      document.querySelector<HTMLElement>(selector as string)?.click()
      const start = performance.now()
      await new Promise<void>((resolve) => {
        const tick = (t: number) => {
          times.push(t)
          if (t - start < (duration as number)) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      return times.slice(1).map((t, i) => t - times[i])
    },
    [act, ms],
  )
  gaps.sort((a, b) => a - b)
  return [gaps.length, gaps[Math.floor(gaps.length * 0.95)], gaps.at(-1) ?? 0]
}

test('opening and closing run at a steady frame rate', async ({ page }) => {
  // A dropped frame or two is fine; a stall is not. The wallpaper loads while the page is idle,
  // as it does for a visitor who reads before trying it, so it is in every frame measured here.
  await expect(page.locator('[data-wallpaper]')).toHaveClass(/is-ready/)
  const [count, p95, longest] = await frames(page, '[data-demo-open]', 900)
  console.log(`opening: ${count} frames, p95 ${p95.toFixed(1)}ms, longest ${longest.toFixed(1)}ms`)
  expect(count).toBeGreaterThan(30)
  expect(p95).toBeLessThan(34)

  await expect(demo(page)).toHaveAttribute('data-state', /intro|idle/)
  const [count2, p952, longest2] = await frames(page, '.done', 750)
  console.log(
    `closing: ${count2} frames, p95 ${p952.toFixed(1)}ms, longest ${longest2.toFixed(1)}ms`,
  )
  expect(count2).toBeGreaterThan(25)
  expect(p952).toBeLessThan(34)
})

test('the scripted session makes the words bold, and Undo takes it back', async ({ page }) => {
  await open(page)
  await untilIdle(page)

  const words = page.locator('[data-demo-target]')
  const weight = () => words.evaluate((el) => getComputedStyle(el).fontWeight)
  await expect.poll(weight).toBe('600')
  // Only the two words: the rest of the headline stays light.
  expect(await page.locator('.lede').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('250')
  const chat = page.getByRole('complementary', { name: 'Chat' })
  await expect(chat).toContainText('Make these words bold.')
  await expect(chat).toContainText('I changed the weight of “real app” from 250 to 600.')
  await expect(chat).toContainText('Worked for')
  await expect(page.getByText('Point at something to change')).toBeHidden()

  // The selection outline and its label are on the words.
  await expect(page.locator('[data-selected]')).toHaveClass(/is-on/)
  await expect(page.locator('[data-selected] .mark-label')).toContainText('span')

  await chat.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(weight).toBe('250')
  await chat.getByRole('button', { name: 'Redo' }).click()
  await expect.poll(weight).toBe('600')
})

test('the visitor selects an element and tries a suggestion', async ({ page }) => {
  await open(page)
  await untilIdle(page)

  const sub = page.locator('.sub')
  const before = await sub.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontWeight))
  await sub.click({ position: { x: 20, y: 8 } })
  await expect(page.locator('[data-selected] .mark-label')).toContainText(/^p/)
  await expect(page.getByText('Try a change to the selected p:')).toBeVisible()

  await page.getByRole('button', { name: 'Make this bolder' }).click()
  await expect(demo(page)).toHaveAttribute('data-state', 'working')
  await untilIdle(page)
  await expect
    .poll(() => sub.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontWeight)))
    .toBeGreaterThan(before)
  await expect(page.getByRole('complementary', { name: 'Chat' })).toContainText(
    `I changed the weight of the p from ${before}`,
  )
})

test('links on the page do not navigate while the demo is open', async ({ page }) => {
  await open(page)
  await untilIdle(page)
  await page.locator('[data-page]').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  await page.getByRole('link', { name: 'WIP' }).click()
  await expect(page).toHaveURL(/127.0.0.1:4329\/$/)
  await expect(page.locator('[data-selected] .mark-label')).toContainText(/^a/)
})

test('a message the demo can not do gets an honest answer', async ({ page }) => {
  await open(page)
  await untilIdle(page)
  const input = page.getByRole('textbox', { name: 'Message' })
  await input.fill('Make the whole page pink')
  await input.press('Enter')
  await untilIdle(page)
  await expect(page.getByRole('complementary', { name: 'Chat' })).toContainText(
    'This demo has no agent',
  )
})

test('closing puts the page back as it was', async ({ page }) => {
  await page.evaluate(() => scrollTo(0, 400))
  await open(page)
  await untilIdle(page)
  await page.locator('.sub').click({ position: { x: 20, y: 8 } })
  await page.getByRole('button', { name: 'Make this blue' }).click()
  await untilIdle(page)
  await page.locator('[data-page]').evaluate((el) => {
    el.scrollTop = 250
  })

  await page.keyboard.press('Escape')
  await expect(demo(page)).toHaveAttribute('data-state', 'closed')
  await expect(demo(page)).toBeHidden()

  expect(await page.evaluate(() => scrollY)).toBe(250)
  expect(await page.locator('[data-page]').getAttribute('style')).toBeNull()
  expect(await page.locator('[data-page]').getAttribute('class')).toBe('page')
  expect(await page.locator('.sub').getAttribute('style')).toBeNull()
  expect(await page.locator('[data-demo-target]').getAttribute('class')).toBeNull()
  expect(await page.locator('[data-demo-target]').getAttribute('style')).toBeNull()
  expect(await page.evaluate(() => document.documentElement.className)).toBe('')
  await expect(page.getByRole('button', { name: 'Try it now' })).toBeFocused()

  // And it opens again from the start.
  await open(page)
  await expect(page.getByText('Point at something to change')).toBeVisible()
})

test('closing while it opens turns it around', async ({ page }) => {
  await page.getByRole('button', { name: 'Try it now' }).click()
  await page.waitForTimeout(250)
  const [midway] = await pageTransform(page)
  expect(midway).toBeLessThan(1)
  await page.getByRole('button', { name: 'Close demo' }).click()
  await expect(demo(page)).toHaveAttribute('data-state', 'closed')
  expect(await page.locator('[data-page]').getAttribute('style')).toBeNull()
})

test('the desk around the window closes the demo', async ({ page }) => {
  await open(page)
  await expect(demo(page)).toHaveAttribute('data-state', /intro|idle/)
  await page.mouse.click(8, 8)
  await expect(demo(page)).toHaveAttribute('data-state', 'closed')
})

test('Start again replays the session from a clean page', async ({ page }) => {
  await open(page)
  await untilIdle(page)
  await page.getByRole('button', { name: 'Start the demo again' }).click()
  await expect(page.getByText('Point at something to change')).toBeVisible()
  await untilIdle(page)
  await expect
    .poll(() =>
      page.locator('[data-demo-target]').evaluate((el) => getComputedStyle(el).fontWeight),
    )
    .toBe('600')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the chat goes under the preview, all on screen', async ({ page }) => {
    await open(page)
    await expect(demo(page)).toHaveAttribute('data-state', /intro|idle/)
    const shown = await page.locator('[data-page]').boundingBox()
    const chat = await page.getByRole('complementary', { name: 'Chat' }).boundingBox()
    if (!shown || !chat) throw new Error('missing boxes')
    expect(shown.y + shown.height).toBeLessThanOrEqual(chat.y)
    expect(chat.x).toBeGreaterThanOrEqual(0)
    expect(chat.x + chat.width).toBeLessThanOrEqual(390)
    expect(chat.y + chat.height).toBeLessThanOrEqual(844)
    await expect(page.getByRole('button', { name: 'Close demo' })).toBeVisible()
    await untilIdle(page)
    await expect
      .poll(() =>
        page.locator('[data-demo-target]').evaluate((el) => getComputedStyle(el).fontWeight),
      )
      .toBe('600')
  })
})

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('it fades in place of the shrink and still plays', async ({ page }) => {
    await page.getByRole('button', { name: 'Try it now' }).click()
    // No movement: the page is at its final size from the first frame.
    const [scale] = await pageTransform(page)
    expect(scale).toBeLessThan(0.81)
    await untilIdle(page)
    await page.keyboard.press('Escape')
    await expect(demo(page)).toHaveAttribute('data-state', 'closed')
  })
})

test('it looks right in dark mode', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await open(page)
  await untilIdle(page)
  await info.attach('dark', { body: await page.screenshot(), contentType: 'image/png' })
  const bg = await page
    .getByRole('complementary', { name: 'Chat' })
    .evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).toBe('rgb(32, 32, 35)')
})

test('state is reported for each step', async ({ page }) => {
  expect(await stateOf(page)).toBeNull()
  await page.getByRole('button', { name: 'Try it now' }).click()
  expect(await stateOf(page)).toBe('opening')
})

test.describe('How it works', () => {
  test('each step is drawn in Gui’s interface, not a screenshot', async ({ page }) => {
    const steps = page.locator('.steps > li')
    await expect(steps).toHaveCount(4)
    await expect(page.locator('.steps img')).toHaveCount(0)
    for (const kind of ['select', 'describe', 'watch', 'compare']) {
      const stage = page.locator(`.stage[data-kind="${kind}"]`)
      await expect(stage).toHaveAttribute('role', 'img')
      expect((await stage.getAttribute('aria-label'))?.length).toBeGreaterThan(20)
      // 4:3, like the screenshots were
      const box = await stage.boundingBox()
      if (!box) throw new Error('no box')
      expect(Math.abs(box.width / box.height - 4 / 3)).toBeLessThan(0.02)
    }
    await expect(page.locator('[data-kind="select"] .label')).toContainText('span')
    await expect(page.locator('[data-kind="describe"]')).toContainText('Make these words bold.')
    await expect(page.locator('[data-kind="compare"] .bold')).toHaveCSS('font-weight', '600')
  })

  test('the stages stay inside their cards on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    for (const kind of ['select', 'describe', 'watch', 'compare']) {
      const fits = await page.locator(`.stage[data-kind="${kind}"]`).evaluate((stage) => {
        const outer = stage.getBoundingClientRect()
        const inner = (
          stage.querySelector('.panel, .page-bit') as HTMLElement
        ).getBoundingClientRect()
        return (
          inner.left >= outer.left && inner.right <= outer.right && inner.bottom <= outer.bottom
        )
      })
      expect(fits, kind).toBe(true)
    }
  })

  test('the Working timer counts while it is on screen', async ({ page }) => {
    const timer = page.locator('[data-timer]')
    await timer.scrollIntoViewIfNeeded()
    const first = await timer.textContent()
    await expect(timer).not.toHaveText(first ?? '', { timeout: 3000 })
  })
})
