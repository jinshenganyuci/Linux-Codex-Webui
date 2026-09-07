const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = process.env.UI_PREVIEW_BASE_URL || 'http://127.0.0.1:13511'
const output = path.resolve('output/playwright/ios-home-height')
fs.mkdirSync(output, { recursive: true })
const built = process.env.LIVE_PREVIEW !== '1'
const cases = [
  { width: 376, height: 694, scale: 1, name: 'browser-bars' },
  { width: 376, height: 640, scale: 1, name: 'short' },
  { width: 360, height: 568, scale: 1.3, name: 'large-text' },
  { width: 375, height: 812, scale: 1, name: 'phone' },
  { width: 768, height: 1024, scale: 1, name: 'tablet' },
  { width: 1440, height: 900, scale: 1, name: 'desktop' },
]
async function geometry(page) {
  return page.evaluate(() => {
    const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom } }
    const empty = document.querySelector('.new-thread-empty')
    return { mark: box('.new-thread-hero-mark'), actions: box('.new-thread-folder-actions'), composer: box('.thread-composer-shell'), empty: box('.new-thread-empty'), scrollHeight: empty.scrollHeight, clientHeight: empty.clientHeight, pageOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight + 1 }
  })
}
(async () => {
  const browser = await chromium.launch({ headless: true })
  const results = []
  for (const viewport of cases) for (const theme of ['light', 'dark']) {
    console.log('CHECK', viewport.name, theme)
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.width < 768 ? 2.5 : 1, hasTouch: viewport.width < 768, isMobile: viewport.width < 768, colorScheme: theme, serviceWorkers: built ? 'block' : 'allow' })
    await context.addInitScript(theme => localStorage.setItem('codex-web-local.dark-mode.v1', theme), theme)
    const page = await context.newPage()
    const errors = [], calls = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('request', r => { if (r.url().includes('/codex-api/')) calls.push(new URL(r.url()).pathname) })
    if (built) await page.route('**/*', route => {
      const url = new URL(route.request().url())
      const file = url.origin === base ? url.pathname === '/' ? path.resolve('dist/index.html') : url.pathname.startsWith('/assets/') ? path.resolve('dist' + url.pathname) : null : null
      return file && fs.existsSync(file) ? route.fulfill({ path: file }) : route.continue()
    })
    await page.goto(base + '/#/')
    await page.locator('.new-thread-suggestions').waitFor()
    if (viewport.scale > 1) await page.addStyleTag({ content: '.new-thread-suggestions span, .new-thread-folder-action, .new-thread-folder-dropdown .composer-dropdown-trigger { font-size: 18px !important; line-height: 1.6 !important; }' })
    await page.waitForTimeout(2200)
    const initial = await geometry(page)
    assert(!initial.pageOverflow, 'outer page overflows')
    assert(Math.abs(initial.mark.width - initial.mark.height) < 1, 'hero mark compressed')
    assert(initial.empty.bottom <= initial.composer.y - 4, 'home scrollport overlaps composer')
    if (viewport.height >= 640 && viewport.width < 768) assert(initial.actions.bottom <= initial.empty.bottom, 'normal phone actions should fit immediately')
    await page.screenshot({ path: path.join(output, `home-${viewport.name}-${theme}.png`), scale: 'css' })
    const actions = page.locator('.new-thread-folder-actions')
    await actions.scrollIntoViewIfNeeded()
    const after = await geometry(page)
    assert(after.actions.y >= after.empty.y && after.actions.bottom <= after.empty.bottom + 1, 'project actions unreachable')
    assert.deepEqual(after.composer, initial.composer, 'scroll moves composer')
    for (const button of await actions.locator('button').all()) {
      assert(await button.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }), 'button covered by composer')
    }
    await actions.getByRole('button', { name: '创建项目', exact: true }).click()
    await page.locator('.new-thread-project-modal').waitFor()
    await page.locator('.new-thread-project-modal .new-thread-open-folder-close').click()
    await page.locator('.new-thread-project-modal').waitFor({ state: 'hidden' })
    // Grow the draft and shrink the viewport as a browser toolbar/keyboard can do.
    await page.locator('.thread-composer-input').fill('暂存的输入内容\n第二行\n第三行\n第四行')
    await page.setViewportSize({ width: viewport.width, height: Math.min(viewport.height, 600) })
    await page.waitForTimeout(200)
    await actions.scrollIntoViewIfNeeded()
    const draft = await geometry(page)
    assert(draft.actions.bottom <= draft.empty.bottom + 1 && draft.empty.bottom <= draft.composer.y - 4, 'growing draft hides actions')
    await page.locator('.thread-composer-input').fill('')
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    if (viewport.scale === 1) {
      await page.reload()
      await page.locator('.new-thread-suggestions').waitFor()
      await actions.scrollIntoViewIfNeeded()
      const refreshed = await geometry(page)
      assert(refreshed.actions.bottom <= refreshed.empty.bottom + 1, 'refresh restores overlap')
    }
    assert.deepEqual(errors, [])
    results.push({ viewport, theme, initial, after, draft, apiRequests: calls.length, errors })
    await context.close()
  }
  await browser.close()
  fs.writeFileSync(path.join(output, built ? 'result.json' : 'live-result.json'), JSON.stringify(results, null, 2))
  console.log('PASS', results.length)
})().catch(error => { console.error(error); process.exit(1) })
