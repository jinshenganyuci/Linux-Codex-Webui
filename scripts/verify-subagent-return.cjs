const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = 'http://127.0.0.1:13511'
const out = path.resolve('output/playwright/subagent-return')
const root = '01a0797c-faa5-70a0-b29e-b4c92c0bb03c'
const child = '01a07ac1-1655-7340-bead-0637d5eeab63'
const grandchild = '01a07242-4799-7b32-91e8-bdaad746fe78'
const descendants = { [root]: child, [child]: grandchild }
const ids = [root, child, grandchild]
const live = process.env.LIVE_PREVIEW === '1'
const smoke = process.env.SMOKE === '1'
const back = page => page.getByRole('link', { name: '返回上一级对话', exact: true })

function progress(threadId) {
  const now = Date.now(), next = descendants[threadId]
  return { rootThreadId: threadId, turnId: 'navigation-replay', status: 'running', phase: 'executing', startedAtMs: now - 60000, lastActivityAtMs: now, mainLastActivityAtMs: now, updatedAtMs: now,
    agents: next ? [{ threadId: next, parentThreadId: threadId, path: '/root/navigation_check', nickname: '', depth: 1, taskSummary: '', model: 'gpt-6-astra', reasoningEffort: 'high', status: 'completed', startedAtMs: now - 50000, lastActivityAtMs: now, completedAtMs: now, currentActivity: '', resultAvailable: false }] : [], events: [] }
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ headless: true }), results = []
  let lastPage
  try {
    for (const viewport of smoke ? [{ width: 375, height: 812 }] : [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, serviceWorkers: 'block' })
      await context.addInitScript(value => {
        if (location.origin === 'http://127.0.0.1:13511') localStorage.setItem('codex-web-local.dark-mode.v1', value)
      }, theme)
      const errors = [], writes = [], requests = []
      let phase = 'initial'
      context.on('page', p => {
        p.on('pageerror', error => errors.push(error.message))
        p.on('request', r => {
          if (r.url().endsWith('/codex-api/rpc') && r.method() === 'POST') {
            const b = r.postDataJSON(); requests.push({ phase, method: b.method, threadId: b.params?.threadId })
            if (/^(turn\/(start|steer|interrupt)|thread\/(start|settings\/update)|config\/(batchWrite|value\/write))$/.test(b.method)) writes.push(b.method)
          }
          if (r.url().includes('/thread-model-preferences') && ['PUT', 'PATCH', 'DELETE'].includes(r.method())) writes.push(r.method())
        })
      })
      if (!live) await context.route(base + '/**', async route => {
        const url = new URL(route.request().url())
        const file = url.pathname === '/' ? path.resolve('dist/index.html') : path.resolve('dist', '.' + url.pathname)
        if (!url.pathname.startsWith('/codex-api') && file.startsWith(path.resolve('dist') + '/') && fs.existsSync(file) && fs.statSync(file).isFile()) await route.fulfill({ path: file })
        else await route.continue()
      })
      await context.route('**/codex-api/rpc', async route => {
        const b = route.request().postDataJSON()
        if (!['thread/list', 'thread/read', 'thread/resume', 'thread/turns/list'].includes(b.method)) return route.continue()
        const response = await route.fetch(), data = await response.json()
        if (b.method === 'thread/list' && data.result?.data) data.result.data = data.result.data.filter(t => ![child, grandchild].includes(t.id))
        const next = descendants[b.params?.threadId]
        if (next) {
          const turns = data.result?.initialTurnsPage?.data ?? data.result?.thread?.turns ?? data.result?.data
          if (turns?.[0]?.items) turns[0].items.push({ id: 'navigation-activity', type: 'subAgentActivity', kind: 'completed', agentThreadId: next, agentPath: '/root/navigation_check' })
        }
        await route.fulfill({ response, json: data })
      })
      await context.route('**/codex-api/thread-runtime-state', async route => {
        const response = await route.fetch(), data = await response.json()
        data.data = data.data.map(row => ids.includes(row.threadId) ? { ...row, turnId: 'navigation-replay', state: 'running', isRunning: true, startedAtIso: new Date().toISOString(), completedAtIso: null } : row)
        await route.fulfill({ response, json: data })
      })
      await context.route('**/codex-api/agent-progress?**', async route => {
        const id = new URL(route.request().url()).searchParams.get('threadId')
        if (!ids.includes(id)) return route.continue()
        await route.fulfill({ json: { data: progress(id) } })
      })
      const page = await context.newPage(); lastPage = page
      async function loaded(id) {
        console.log('STEP', viewport.width, theme, phase, id)
        await page.waitForURL(url => url.hash.startsWith('#/thread/' + id))
        await page.locator('.conversation-item[data-role=assistant]').first().waitFor({ timeout: 60000 })
        await page.locator('.conversation-loading').waitFor({ state: 'hidden' })
        await page.waitForTimeout(700)
      }
      async function clickAgent() {
        const card = page.locator('.turn-progress-card')
        await card.locator(viewport.width < 768 ? '.turn-progress-mobile-open' : '.turn-progress-agent-details-toggle').click()
        const link = card.locator('.turn-progress-agent-link').first()
        await link.waitFor(); const href = await link.getAttribute('href')
        await link.click(); return href
      }
      await page.goto(base + '/#/thread/' + root, { waitUntil: 'domcontentloaded' }); await loaded(root)
      assert.equal(await back(page).count(), 0)
      phase = 'open-child-card'; const childHref = await clickAgent(); await loaded(child)
      assert.equal(childHref, `#/thread/${child}?from=${root}`)
      assert.equal(await page.locator('.content-title').innerText(), '子任务对话')
      assert.equal(await back(page).getAttribute('href'), `#/thread/${root}`)
      phase = 'open-grandchild'; await clickAgent(); await loaded(grandchild)
      assert.equal(await back(page).getAttribute('href'), `#/thread/${child}?from=${root}`)
      phase = 'return-child'; await back(page).click(); await loaded(child)
      phase = 'return-root'; await back(page).click(); await loaded(root)
      assert.equal(await back(page).count(), 0)
      phase = 'open-child-activity'
      const activity = page.locator('.runtime-item').filter({ has: page.locator('a').filter({ hasText: '打开子任务对话' }) }).first()
      if (!await activity.evaluate(n => n.open)) await activity.locator('summary').click()
      assert.equal(await activity.locator('a').getAttribute('href'), childHref)
      await activity.locator('a').click(); await loaded(child)
      phase = 'refresh-child'; await page.reload({ waitUntil: 'domcontentloaded' }); await loaded(child)
      assert.equal(await back(page).getAttribute('href'), `#/thread/${root}`)
      await page.waitForTimeout(2300)
      const geometry = await back(page).evaluate(n => { const r = n.getBoundingClientRect(), title = document.querySelector('.content-title').getBoundingClientRect(), s = getComputedStyle(n); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, titleX: title.x, titleWidth: title.width, color: s.color } })
      assert(geometry.x >= 0 && geometry.y >= 0 && geometry.right <= geometry.titleX + 1)
      assert(geometry.titleWidth >= 28, 'Return control squeezed the conversation title away')
      if (viewport.width < 768) assert(geometry.width >= 44 && geometry.height >= 44)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      await back(page).focus(); assert.equal(await back(page).evaluate(n => n === document.activeElement), true)
      await back(page).evaluate(n => n.blur())
      await page.waitForTimeout(2300)
      const screenshot = path.join(out, `${live ? 'live' : 'after'}-${viewport.width}-${theme}.png`)
      await page.screenshot({ path: screenshot })
      await page.locator('.content-header').screenshot({ path: screenshot.replace('.png', '-header.png') })
      // A new context page has no browser navigation history to fall back on.
      phase = 'new-tab'; console.log('STEP', viewport.width, theme, phase); const tab = await context.newPage(); await tab.goto(base + '/' + childHref, { waitUntil: 'domcontentloaded' })
      await back(tab).waitFor(); await back(tab).click(); await tab.waitForURL(url => url.hash === '#/thread/' + root)
      await tab.close()
      phase = 'return-after-reload'; await back(page).click(); await loaded(root)
      phase = 'normal-link'; await page.goto(base + '/#/thread/' + child, { waitUntil: 'domcontentloaded' }); await loaded(child)
      assert.equal(await back(page).count(), 0)
      assert.deepEqual(errors, []); assert.deepEqual(writes, [])
      results.push({ url: base + '/' + childHref, viewport, theme, geometry, refreshedReturn: true, nestedReturn: true, bothEntryPoints: true, newTabReturn: true, normalThreadNoBack: true, errors, writes, requests, screenshot })
      fs.writeFileSync(path.join(out, live ? 'live-browser.json' : 'browser.json'), JSON.stringify(results, null, 2))
      await context.close(); console.log('PASS', viewport.width, theme)
    }
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {})
    throw error
  } finally { await browser.close() }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
