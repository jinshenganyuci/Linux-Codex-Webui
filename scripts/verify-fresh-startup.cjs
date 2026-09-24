const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const base = process.env.PROFILE_BASE_URL || 'http://127.0.0.1:13511'
const baseline = process.env.STARTUP_BASELINE === '1'
const send = process.env.STARTUP_SEND === '1'
const out = path.resolve('output/playwright/fresh-startup')
const hostSuffix = new URL(base).hostname === '127.0.0.1' ? '' : '-' + new URL(base).hostname
const results = []
let oldThread = process.env.STARTUP_THREAD_ID || ''
const stamp = `STARTUP_OK_${Date.now()}`

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ headless: true })
  try {
    for (const [name, viewport, theme, existing] of [
      ['home-light', { width: 1440, height: 900 }, 'light', false],
      ['home-dark', { width: 1440, height: 900 }, 'dark', false],
      ['thread-light', { width: 1440, height: 900 }, 'light', true],
      ['thread-mobile-dark', { width: 375, height: 812 }, 'dark', true],
    ].filter(row => !process.env.STARTUP_CASE || row[0] === process.env.STARTUP_CASE)) {
      if (existing) assert(oldThread, 'No existing thread was returned by the real list')
      const context = await browser.newContext({ viewport, colorScheme: theme, serviceWorkers: 'block' })
      assert.deepEqual(await context.storageState(), { cookies: [], origins: [] })
      // An intercepted request is needed to compare the old native scan against
      // the indexed read while keeping the server, data and frontend identical.
      if (baseline) await context.route('**/codex-api/rpc', async route => {
        const body = route.request().postDataJSON()
        if (body.method === 'thread/list') body.params = { ...body.params, useStateDbOnly: false }
        await route.continue({ postData: JSON.stringify(body) })
      })
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      const errors = [], requests = [], pending = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('requestfinished', request => {
        if (!request.url().includes('/codex-api/')) return
        pending.push((async () => {
          const response = await request.response()
          const body = request.method() === 'POST' && request.url().endsWith('/rpc') ? request.postDataJSON() : null
          const timing = request.timing()
          const row = { path: new URL(request.url()).pathname, method: body?.method, cursor: body?.params?.cursor || null,
            ms: Math.round(timing.responseEnd), status: response.status() }
          requests.push(row)
          if (body?.method === 'thread/list' && !body.params?.cursor && !oldThread) {
            const payload = await response.json()
            const rows = payload.result?.data || []
            oldThread = rows[Math.min(10, rows.length - 1)]?.id || ''
          }
        })())
      })
      const url = base + (existing ? '/#/thread/' + oldThread : '/#/')
      let start = Date.now()
      let loginMs = null
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        if (await page.locator('#pw').isVisible()) {
          assert(process.env.WEBUI_TEST_PASSWORD, 'Set WEBUI_TEST_PASSWORD to exercise a fresh authenticated visit')
          await page.locator('#pw').fill(process.env.WEBUI_TEST_PASSWORD)
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.locator('button[type="submit"]').click(),
          ])
          loginMs = Date.now() - start
          start = Date.now()
        }
        // A mobile thread route intentionally unmounts the closed sidebar.
        const listReady = viewport.width < 768 && existing
          ? Promise.resolve(null)
          : page.locator('.thread-row').first().waitFor({ state: 'attached', timeout: 45000 }).then(() => Date.now() - start)
        const historyReady = existing
          ? page.locator('.conversation-item[data-role="assistant"], .conversation-item[data-role="user"]').first().waitFor({ timeout: 45000 }).then(() => Date.now() - start)
          : Promise.resolve(null)
        // Observe each milestone independently; waiting for the list must not
        // artificially inflate the measured composer or history readiness.
        void listReady.catch(() => {})
        void historyReady.catch(() => {})
        await page.locator('.thread-composer-input:not(:disabled)').waitFor({ timeout: 45000 })
        const inputMs = Date.now() - start
        await page.locator('.thread-composer-input').fill('输入可用检查，不发送')
        await page.locator('.thread-composer-submit:not(:disabled)').waitFor({ timeout: 15000 })
        const readyMs = Date.now() - start
        await page.locator('.thread-composer-input').fill('')
        const [listMs, historyMs] = await Promise.all([listReady, historyReady])
        await Promise.all(pending)
        const startupFirstPageRequests = requests.filter(row => row.method === 'thread/list' && !row.cursor).length
        if (viewport.width < 768 && existing) {
          await page.locator('.content-header .sidebar-thread-controls-button').first().click()
          await page.locator('.thread-row').first().waitFor({ state: 'visible', timeout: 45000 })
          await page.locator('.mobile-drawer').getByRole('button', { name: /^(折叠侧边栏|Collapse sidebar)$/ }).click()
        }
        let replyMs = null
        let createdThreadId = null
        if (send && !baseline && name === 'home-light') {
          await page.locator('.thread-composer-input').fill(`这是性能验收，只回复 ${stamp}。不要使用工具，不要修改文件。`)
          const sentAt = Date.now()
          await page.locator('.thread-composer-submit').click()
          await page.waitForURL(url => url.hash.startsWith('#/thread/'), { timeout: 45000 })
          await page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: stamp }).first().waitFor({ timeout: 120000 })
          replyMs = Date.now() - sentAt
          createdThreadId = page.url().split('#/thread/')[1].split('?')[0]
        }
        await page.waitForTimeout(2300)
        const screenshot = path.join(out, `${baseline ? 'before' : send ? 'after-send' : 'after'}-${name}${hostSuffix}${existing ? '-' + oldThread.slice(0, 8) : ''}.png`)
        await page.screenshot({ path: screenshot })
        assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark')
        assert.deepEqual(errors, [])
        await Promise.all(pending)
        const lists = requests.filter(row => row.method === 'thread/list' && !row.cursor)
        const row = { name, url, viewport, theme, baseline, freshStorage: true, browserCacheDisabled: true,
          inputMs, listMs, historyMs, readyMs, loginMs, replyMs, createdThreadId, startupFirstPageRequests, firstPageRequests: lists.length,
          requests, errors, screenshot, currentUrl: page.url() }
        results.push(row)
        fs.writeFileSync(path.join(out, (baseline ? 'before' : send ? 'after-send' : 'after') + (process.env.STARTUP_CASE ? '-' + process.env.STARTUP_CASE : '') + hostSuffix + '.json'), JSON.stringify(results, null, 2))
        console.log(JSON.stringify({ ...row, requests: undefined }))
      } catch (error) {
        await page.screenshot({ path: path.join(out, `${baseline ? 'before' : 'after'}-${name}-failed.png`) }).catch(() => {})
        throw error
      } finally {
        await context.unrouteAll({ behavior: 'wait' })
        await Promise.allSettled(pending)
        await context.close()
      }
    }
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
