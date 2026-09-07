const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = 'http://127.0.0.1:13511'
const out = path.resolve('output/playwright/agent-progress-surface')
const threadId = JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
const before = process.env.BASELINE === '1'
const live = process.env.LIVE_PREVIEW === '1'
const smoke = process.env.SMOKE === '1'
const fixtureTurn = 'agent-progress-ui-replay'
const detailsToggle = (card, mobile) => card.locator(mobile ? '.turn-progress-mobile-open' : '.turn-progress-agent-details-toggle')

function snapshot(now, count = 3) {
  const names = ['identity_protocol_audit', 'identity_lifecycle_audit', 'proxy_routing_audit', 'nested_check', 'interrupted_check', 'failed_check']
  const statuses = ['running', 'completed', 'completed', 'running', 'interrupted', 'errored']
  return {
    rootThreadId: threadId, turnId: fixtureTurn, status: 'running', phase: 'executing', startedAtMs: now - 420000,
    lastActivityAtMs: now, mainLastActivityAtMs: now, updatedAtMs: now,
    agents: names.slice(0, count).map((name, i) => ({
      threadId: `replay-agent-${i}`, parentThreadId: i === 3 ? 'replay-agent-0' : threadId,
      path: `/root/${name}`, nickname: '', depth: i === 3 ? 2 : 1, taskSummary: '',
      model: i % 2 ? 'gpt-5.6-sol' : 'gpt-6-astra', reasoningEffort: i % 2 ? 'high' : 'ultra',
      status: statuses[i], startedAtMs: now - 360000, lastActivityAtMs: now,
      completedAtMs: statuses[i] === 'running' ? null : now - 30000,
      currentActivity: statuses[i] === 'running' ? 'executing' : '', resultAvailable: statuses[i] === 'completed',
    })),
    events: [{ id: 'phase-replay', atMs: now, kind: 'phaseChanged', threadId, agentThreadId: '', phase: 'executing', detail: 'executing' }],
  }
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ headless: true }), results = []
  let lastPage
  try {
    const views = before || smoke ? [{ width: 375, height: 812 }] : [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]
    for (const viewport of views) for (const theme of before ? ['light'] : smoke ? ['dark'] : ['light', 'dark']) {
      const now = Date.now()
      const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, serviceWorkers: 'block' })
      await context.addInitScript(value => localStorage.setItem('codex-web-local.dark-mode.v1', value), theme)
      const page = await context.newPage(); lastPage = page
      let resultRequests = 0, progressRequests = 0, count = 3
      const errors = [], mutations = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('request', r => {
        if (r.url().endsWith('/codex-api/rpc')) {
          const method = r.postDataJSON()?.method
          if (/^(turn\/(start|steer|interrupt)|thread\/start|config\/batchWrite)$/.test(method)) mutations.push(method)
        }
        if (r.url().endsWith('/thread-model-preferences') && ['PUT', 'PATCH', 'DELETE'].includes(r.method())) mutations.push(r.method())
      })
      if (!before && !live) await page.route(base + '/**', async route => {
        const url = new URL(route.request().url())
        const file = url.pathname === '/' ? path.resolve('dist/index.html') : path.resolve('dist', '.' + url.pathname)
        if (!url.pathname.startsWith('/codex-api') && file.startsWith(path.resolve('dist') + '/') && fs.existsSync(file) && fs.statSync(file).isFile()) {
          await route.fulfill({ path: file })
        } else await route.continue()
      })
      await page.route('**/codex-api/thread-runtime-state', async route => {
        const response = await route.fetch(), data = await response.json()
        data.data = data.data.map(row => row.threadId === threadId ? { ...row, turnId: fixtureTurn, state: 'running', isRunning: true, startedAtIso: new Date(now - 420000).toISOString(), completedAtIso: null } : row)
        await route.fulfill({ response, json: data })
      })
      await page.route('**/codex-api/agent-progress?**', async route => {
        progressRequests++
        await route.fulfill({ json: { data: snapshot(now, count) } })
      })
      await page.route('**/codex-api/agent-result?**', async route => {
        resultRequests++
        await route.fulfill({ json: { data: { threadId: 'replay-agent-1', text: '回放验收：子任务完成结果。', truncated: false } } })
      })
      await page.goto(`${base}/#/thread/${threadId}`, { waitUntil: 'domcontentloaded' })
      const card = page.locator('.turn-progress-card')
      await card.waitFor(); await page.waitForTimeout(2300)
      if (!before) {
        assert((await card.innerText()).includes('主推理模型'))
        assert((await card.locator('.turn-progress-summary').first().innerText()).includes('1 个活动 · 已完成 2/3'))
        assert.equal(await card.locator('.turn-progress-tree').isVisible(), false)
        assert(/Model:.*Thinking:.*Speed:/.test(await card.locator('.turn-progress-main-model-details').innerText()))
        const colors = await card.evaluate(n => ({ background: getComputedStyle(n).backgroundColor, border: getComputedStyle(n).borderTopColor, shadow: getComputedStyle(n).boxShadow, dot: getComputedStyle(n.querySelector('.turn-progress-pulse')).backgroundColor, status: getComputedStyle(n.querySelector('.turn-progress-status')).color }))
        assert.equal(colors.background, theme === 'dark' ? 'rgb(36, 36, 38)' : 'rgb(255, 255, 255)')
        assert.equal(colors.border, theme === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.12)')
        assert(!colors.shadow.includes('inset'), 'Old blue inset highlight remains')
        assert.equal(colors.dot, 'rgb(133, 133, 139)')
        assert.equal(colors.status, theme === 'dark' ? 'rgb(208, 208, 213)' : 'rgb(87, 87, 94)')
      }
      const rect = await card.boundingBox()
      const compactScreenshot = path.join(out, `${before ? 'before' : live ? 'live' : 'after'}-compact-${viewport.width}-${theme}.png`)
      await page.screenshot({ path: compactScreenshot })
      if (before) { results.push({ viewport, theme, height: rect.height, screenshot: compactScreenshot }); await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); continue }
      assert(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1)
      assert.equal(resultRequests, 0, 'Results were eagerly loaded')
      const toggle = detailsToggle(card, viewport.width < 768)
      assert.equal(await toggle.evaluate(n => getComputedStyle(n).color), theme === 'dark' ? 'rgb(208, 208, 213)' : 'rgb(87, 87, 94)')
      await toggle.click()
      const body = card.locator('.turn-progress-body')
      await body.waitFor({ state: 'visible' })
      assert.equal(await body.evaluate(n => getComputedStyle(n).backgroundColor), theme === 'dark' ? 'rgb(36, 36, 38)' : 'rgb(255, 255, 255)')
      assert.equal(await body.getByRole('listitem').count(), 3)
      assert.equal(await body.locator('.turn-progress-agent-model-details').count(), 3)
      assert((await body.locator('.turn-progress-agent-model-details').first().innerText()).includes('Model: gpt-6-astra · Thinking: ultra'))
      const firstResult = body.locator('.turn-progress-result-button').first()
      await firstResult.click(); await body.locator('.turn-progress-result pre').waitFor()
      assert.equal(resultRequests, 1)
      if (viewport.width < 768) {
        assert.equal(await body.getAttribute('aria-modal'), 'true')
        for (const surface of [toggle, card.locator('.turn-progress-mobile-sheet-header')]) {
          assert.equal(await surface.evaluate(n => getComputedStyle(n).backgroundColor), theme === 'dark' ? 'rgb(36, 36, 38)' : 'rgb(255, 255, 255)')
        }
        await card.locator('.turn-progress-close').focus(); await page.keyboard.press('Shift+Tab')
        assert(await body.evaluate(n => n.contains(document.activeElement)))
      }
      await page.waitForTimeout(2300)
      const expandedScreenshot = path.join(out, `${live ? 'live' : 'after'}-expanded-${viewport.width}-${theme}.png`)
      await page.screenshot({ path: expandedScreenshot })
      if (viewport.width < 768) {
        await page.keyboard.press('Escape'); assert.equal(await body.isVisible(), false)
        assert(await toggle.evaluate(n => document.activeElement === n))
      } else await toggle.click()
      // Reload proves state recovery renders the same three child references.
      await page.reload({ waitUntil: 'domcontentloaded' }); await card.waitFor(); await page.waitForTimeout(2300)
      assert((await card.locator('.turn-progress-summary').first().innerText()).includes('1 个活动 · 已完成 2/3'))
      // Include a nested child and terminal states, then the no-child case.
      count = 6
      await page.reload({ waitUntil: 'domcontentloaded' }); await card.waitFor(); await page.waitForTimeout(1000)
      await detailsToggle(card, viewport.width < 768).click()
      assert.equal(await card.locator('.turn-progress-agent-row').count(), 6)
      assert.equal(await card.locator('.turn-progress-agent-row[data-depth="2"]').count(), 1)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      count = 0
      await page.reload({ waitUntil: 'domcontentloaded' }); await card.waitFor(); await page.waitForTimeout(1000)
      assert((await card.locator('.turn-progress-summary').first().innerText()).includes('0 个活动 · 已完成 0/0'))
      await detailsToggle(card, viewport.width < 768).waitFor()
      assert.deepEqual(errors, []); assert.deepEqual(mutations, [])
      results.push({ url: page.url(), viewport, theme, height: rect.height, children: 3, reloadChildren: 3, nestedSix: true, originalContentRestored: true, neutralRunningStyle: true, solidThemeSurface: true, resultRequests, progressRequests, errors, mutations, screenshots: [compactScreenshot, expandedScreenshot] })
      await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); console.log('PASS', viewport.width, theme, rect.height)
    }
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {})
    throw error
  } finally { if (lastPage && !lastPage.isClosed()) await lastPage.unrouteAll({ behavior: 'ignoreErrors' }); await browser.close() }
  fs.writeFileSync(path.join(out, before ? 'baseline.json' : live ? 'live-browser.json' : 'browser.json'), JSON.stringify(results, null, 2))
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
