const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = 'http://127.0.0.1:13511'
const out = path.resolve('output/playwright/composer-round-stop')
const threadId = JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
const turnId = 'composer-round-stop-replay'
const live = process.env.LIVE_PREVIEW === '1'
const baseline = process.env.BASELINE === '1'
const smoke = process.env.SMOKE === '1'

async function geometry(button) {
  return button.evaluate(n => {
    const r = n.getBoundingClientRect(), s = getComputedStyle(n)
    const icon = n.querySelector('svg').getBoundingClientRect()
    return { width: r.width, height: r.height, radius: s.borderRadius, shrink: s.flexShrink, x: r.x, right: r.right, iconOffsetX: icon.x + icon.width / 2 - (r.x + r.width / 2), iconOffsetY: icon.y + icon.height / 2 - (r.y + r.height / 2) }
  })
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ headless: true }), results = []
  let lastPage
  try {
    const viewports = baseline || smoke ? [{ width: 375, height: 812 }] : [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]
    for (const viewport of viewports) for (const theme of baseline ? ['light'] : smoke ? ['dark'] : ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, serviceWorkers: 'block' })
      await context.addInitScript(value => localStorage.setItem('codex-web-local.dark-mode.v1', value), theme)
      const page = await context.newPage(); lastPage = page
      const errors = [], writes = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('request', r => {
        if (r.url().endsWith('/codex-api/rpc') && r.method() === 'POST') {
          const method = r.postDataJSON()?.method
          if (/^(turn\/(start|steer|interrupt)|thread\/start|config\/batchWrite)$/.test(method)) writes.push(method)
        }
      })
      if (!live && !baseline) await page.route(base + '/**', async route => {
        const url = new URL(route.request().url())
        const file = url.pathname === '/' ? path.resolve('dist/index.html') : path.resolve('dist', '.' + url.pathname)
        if (!url.pathname.startsWith('/codex-api') && file.startsWith(path.resolve('dist') + '/') && fs.existsSync(file) && fs.statSync(file).isFile()) await route.fulfill({ path: file })
        else await route.continue()
      })
      await page.route('**/codex-api/thread-runtime-state', async route => {
        const response = await route.fetch(), data = await response.json()
        data.data = data.data.map(r => r.threadId === threadId ? { ...r, turnId, state: 'running', isRunning: true, startedAtIso: new Date().toISOString(), completedAtIso: null } : r)
        await route.fulfill({ response, json: data })
      })
      await page.route('**/codex-api/agent-progress?**', async route => {
        const now = Date.now()
        await route.fulfill({ json: { data: { rootThreadId: threadId, turnId, status: 'running', phase: 'executing', startedAtMs: now - 1000, lastActivityAtMs: now, mainLastActivityAtMs: now, updatedAtMs: now, agents: [], events: [] } } })
      })
      await page.goto(`${base}/#/thread/${threadId}`, { waitUntil: 'domcontentloaded' })
      const button = page.locator('.thread-composer-stop')
      await button.waitFor(); await page.waitForTimeout(2300)
      const normal = await geometry(button)
      if (baseline) assert.deepEqual([normal.width, normal.height], [40, 44])
      else {
        const size = viewport.width < 768 ? 44 : 36
        assert.deepEqual([normal.width, normal.height], [size, size])
        assert.equal(normal.shrink, '0')
        assert(normal.radius === '50%' || normal.radius.includes('calc') || parseFloat(normal.radius) >= size / 2)
        assert(Math.abs(normal.iconOffsetX) < 1 && Math.abs(normal.iconOffsetY) < 1)
        assert(normal.x >= 0 && normal.right <= viewport.width)
        await button.evaluate(n => { n.disabled = true })
        const disabled = await geometry(button)
        assert.deepEqual([disabled.width, disabled.height], [size, size])
        await button.evaluate(n => { n.disabled = false })
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      }
      const screenshot = path.join(out, `${baseline ? 'before' : live ? 'live' : 'after'}-${viewport.width}-${theme}.png`)
      await page.locator('.thread-composer-shell').screenshot({ path: screenshot })
      assert.deepEqual(errors, []); assert.deepEqual(writes, [])
      results.push({ url: page.url(), viewport, theme, normal, disabledStillCircular: !baseline, errors, writes, screenshot })
      await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close()
      console.log('PASS', viewport.width, theme, normal.width, normal.height)
    }
  } finally {
    if (lastPage && !lastPage.isClosed()) await lastPage.unrouteAll({ behavior: 'ignoreErrors' })
    await browser.close()
  }
  fs.writeFileSync(path.join(out, baseline ? 'baseline.json' : live ? 'live-browser.json' : 'browser.json'), JSON.stringify(results, null, 2))
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
