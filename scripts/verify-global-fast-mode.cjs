const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = 'http://127.0.0.1:13511'
const out = path.resolve('output/playwright/global-fast')
const live = process.env.LIVE_PREVIEW === '1'
const threadId = JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
fs.mkdirSync(out, { recursive: true })
async function rpc(method, params = {}) {
  const response = await fetch(base + '/codex-api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(15000) })
  assert.ok(response.ok)
  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  return data.result
}
const speedFields = config => ({ serviceTier: config.service_tier ?? null, feature: config.features?.fast_mode ?? null })
const fastSwitch = page => page.locator('.thread-composer-attach-menu [role="switch"]').filter({ hasText: /Fast mode|快速模式/ })
async function openPlus(page) {
  if (page.url().includes('/thread/')) await page.locator('.conversation-item[data-role="assistant"]').first().waitFor()
  if (!(await page.locator('.thread-composer-attach-menu').isVisible())) await page.locator('.thread-composer-attach-trigger').click()
  await fastSwitch(page).waitFor()
  assert.equal(await fastSwitch(page).count(), 1)
}
async function checked(page, value) {
  await page.waitForFunction(value => {
    const node = [...document.querySelectorAll('.thread-composer-attach-menu [role="switch"]')].find(node => /Fast mode|快速模式/.test(node.textContent))
    return node && !node.disabled && node.getAttribute('aria-checked') === String(value)
  }, value, { timeout: 10000 }).catch(async error => {
    await page.screenshot({ path: path.join(out, 'failure.png') })
    console.error('Visible switches:', await fastSwitch(page).count())
    throw error
  })
  if (value) await page.locator('.model-reasoning-trigger-fast-icon').waitFor()
}
;(async () => {
  const original = speedFields((await rpc('config/read', { includeLayers: false })).config)
  const thread = (await rpc('thread/read', { threadId, includeTurns: true })).thread
  assert.equal(thread.status.type, 'idle', 'Requires an idle acceptance thread')
  const browser = await chromium.launch({ headless: true })
  const report = { base, live, cases: [], writes: [], failedWrites: 0, rpcCounts: {}, pageErrors: [], turnsSent: 0 }
  async function setup(viewport, theme, blockServiceWorkers = false) {
    const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, serviceWorkers: live && !blockServiceWorkers ? 'allow' : 'block' })
    await context.addInitScript(theme => localStorage.setItem('codex-web-local.dark-mode.v1', theme), theme)
    const page = await context.newPage()
    page.on('pageerror', e => report.pageErrors.push(e.message))
    page.on('response', async response => {
      if (response.url().endsWith('/codex-api/rpc') && response.request().postDataJSON()?.method === 'config/batchWrite') {
        const payload = await response.json().catch(() => ({}))
        if (payload.error) console.error('Config write error:', payload.error.message)
      }
    })
    page.on('request', request => {
      if (!request.url().endsWith('/codex-api/rpc') || request.method() !== 'POST') return
      const body = request.postDataJSON()
      report.rpcCounts[body.method] = (report.rpcCounts[body.method] || 0) + 1
      if (body.method === 'turn/start') report.turnsSent++
      if (body.method === 'config/batchWrite') report.writes.push(body.params.edits)
    })
    if (!live) await page.route('**/*', route => {
      const url = new URL(route.request().url())
      const file = url.origin === base ? url.pathname === '/' ? path.resolve('dist/index.html') : url.pathname.startsWith('/assets/') ? path.resolve('dist' + url.pathname) : null : null
      return file && fs.existsSync(file) ? route.fulfill({ path: file }) : route.continue()
    })
    await page.goto(`${base}/#/thread/${threadId}`, { waitUntil: 'domcontentloaded' })
    await page.locator('.thread-composer-input').waitFor()
    await page.locator('.conversation-item[data-role="assistant"]').first().waitFor()
    await page.waitForFunction(() => document.querySelector('.model-reasoning-trigger')?.textContent.includes('6 Astra'))
    return { context, page }
  }
  let restored = false
  try {
    const desktop = await setup({ width: 1440, height: 900 }, 'light')
    const page = desktop.page
    await openPlus(page)
    await checked(page, original.serviceTier === 'priority' || original.serviceTier === 'fast')
    if (await fastSwitch(page).getAttribute('aria-checked') === 'true') { await fastSwitch(page).click(); await checked(page, false) }
    await page.reload({ waitUntil: 'domcontentloaded' }); await openPlus(page); await checked(page, false)
    assert.equal((await rpc('config/read')).config.service_tier ?? null, null)
    const beforeEnable = report.writes.length
    await fastSwitch(page).click(); await checked(page, true)
    assert.equal(report.writes.length - beforeEnable, 1, 'One global write per toggle')
    assert.deepEqual(report.writes.at(-1), [
      { keyPath: 'features.fast_mode', value: true, mergeStrategy: 'upsert' },
      { keyPath: 'service_tier', value: 'priority', mergeStrategy: 'upsert' },
    ])
    assert.equal((await rpc('config/read')).config.service_tier, 'priority')
    await page.reload({ waitUntil: 'domcontentloaded' }); await openPlus(page); await checked(page, true)
    // Home/new-chat context must inherit the same saved preference.
    await page.goto(base + '/#/', { waitUntil: 'domcontentloaded' }); await openPlus(page); await checked(page, true)
    await desktop.context.close()
    for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) {
      for (const theme of ['light', 'dark']) {
        const { context, page } = await setup(viewport, theme)
        await openPlus(page); await checked(page, true)
        await page.reload({ waitUntil: 'domcontentloaded' }); await openPlus(page); await checked(page, true)
        const menu = page.locator('.thread-composer-attach-menu')
        const bounds = await menu.boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1)
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1)
        if (viewport.width < 768) assert.ok(Math.abs(bounds.x - (viewport.width - bounds.x - bounds.width)) <= 1, 'Mobile menu centered')
        await fastSwitch(page).scrollIntoViewIfNeeded()
        assert.ok((await menu.innerText()).includes('所有聊天共用，刷新后保留'))
        const boltColor = await page.locator('.model-reasoning-trigger-fast-icon').evaluate(node => getComputedStyle(node).color)
        assert.equal(boltColor, 'rgb(249, 115, 22)')
        await page.waitForTimeout(2300)
        const menuScreenshot = path.join(out, `plus-${viewport.width}-${theme}.png`)
        await page.screenshot({ path: menuScreenshot })
        await page.locator('.thread-composer-attach-trigger').click()
        await page.locator('.model-reasoning-trigger').click()
        await page.getByRole('button', { name: '选择模型', exact: true }).click()
        assert.equal(await page.locator('.model-config-speed, .model-config-speed-trigger, .model-config-speed-options').count(), 0)
        assert.ok(await page.locator('.model-reasoning-option').count() > 0)
        const surface = await page.locator('.model-reasoning-layer').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color, dark: document.documentElement.classList.contains('dark') }))
        assert.equal(surface.dark, theme === 'dark')
        await page.waitForTimeout(2300)
        const modelScreenshot = path.join(out, `models-${viewport.width}-${theme}.png`)
        await page.screenshot({ path: modelScreenshot })
        await page.keyboard.press('Escape')
        assert.equal(await page.locator('.model-reasoning-option').count(), 0)
        await page.getByRole('slider').waitFor()
        await page.keyboard.press('Escape')
        assert.equal(await page.locator('.model-reasoning-layer').count(), 0)
        report.cases.push({ url: page.url(), viewport, theme, freshBrowserFast: true, afterReloadFast: true, noModelSpeedOption: true, boltColor, menuBounds: bounds, surface, screenshots: [menuScreenshot, modelScreenshot] })
        await context.close()
      }
    }
    const failed = await setup({ width: 375, height: 812 }, 'dark', true)
    await openPlus(failed.page); await checked(failed.page, true)
    await failed.page.route('**/codex-api/rpc', route => {
      if (route.request().postDataJSON()?.method === 'config/batchWrite') {
        report.failedWrites++
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: { code: -32603, message: 'FAST_SAVE_TEST_FAILURE' } }) })
      }
      return route.fallback()
    })
    await fastSwitch(failed.page).click(); await checked(failed.page, true)
    assert.equal(report.failedWrites, 1)
    assert.equal((await rpc('config/read')).config.service_tier, 'priority')
    await failed.page.unroute('**/codex-api/rpc')
    await fastSwitch(failed.page).click(); await checked(failed.page, false)
    await failed.page.reload({ waitUntil: 'domcontentloaded' }); await openPlus(failed.page); await checked(failed.page, false)
    await failed.context.close()
    const other = await setup({ width: 1440, height: 900 }, 'light')
    await openPlus(other.page); await checked(other.page, false)
    await other.context.close()
    report.disabledAfterReloadAndNewBrowser = true
    assert.deepEqual(report.pageErrors, [])
    assert.equal(report.turnsSent, 0)
  } finally {
    await browser.close()
    const current = speedFields((await rpc('config/read')).config)
    if (JSON.stringify(current) !== JSON.stringify(original)) await rpc('config/batchWrite', { edits: [
      { keyPath: 'features.fast_mode', value: original.feature, mergeStrategy: original.feature === null ? 'replace' : 'upsert' },
      { keyPath: 'service_tier', value: original.serviceTier, mergeStrategy: original.serviceTier === null ? 'replace' : 'upsert' },
    ], filePath: null, expectedVersion: null })
    assert.deepEqual(speedFields((await rpc('config/read')).config), original)
    restored = true
    report.originalSettingsRestored = restored
    fs.writeFileSync(path.join(out, live ? 'live-result.json' : 'build-result.json'), JSON.stringify(report, null, 2))
  }
  console.log(JSON.stringify({ cases: report.cases.length, globalWrites: report.writes.length - report.failedWrites, failedWrites: report.failedWrites, disabledAfterReloadAndNewBrowser: report.disabledAfterReloadAndNewBrowser, turnsSent: report.turnsSent, restored }))
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
