const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = 'http://127.0.0.1:13511'
const out = path.resolve('output/playwright/active-status-colors')
const threadId = JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
const live = process.env.LIVE_PREVIEW === '1', smoke = process.env.SMOKE === '1'
const blue = 'rgb(14, 165, 233)'
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ headless: true }), results = []
  let lastPage
  try {
    for (const viewport of smoke ? [{ width: 375, height: 812 }] : [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'no-preference', isMobile: viewport.width < 768, hasTouch: viewport.width < 768, serviceWorkers: 'block' })
      await context.addInitScript(value => { if (location.origin === 'http://127.0.0.1:13511') localStorage.setItem('codex-web-local.dark-mode.v1', value) }, theme)
      if (!live) await context.route(base + '/**', async route => {
        const pathname = new URL(route.request().url()).pathname
        const file = pathname === '/' ? path.resolve('dist/index.html') : path.resolve('dist', '.' + pathname)
        if (!pathname.startsWith('/codex-api') && file.startsWith(path.resolve('dist') + '/') && fs.existsSync(file) && fs.statSync(file).isFile()) await route.fulfill({ path: file })
        else await route.continue()
      })
      await context.route('**/codex-api/thread-runtime-state', async route => {
        const response = await route.fetch(), data = await response.json()
        data.data = data.data.map(r => r.threadId === threadId ? { ...r, turnId: 'active-colors-replay', state: 'running', isRunning: true, startedAtIso: new Date().toISOString(), completedAtIso: null } : r)
        await route.fulfill({ response, json: data })
      })
      let progressRequests = 0
      await context.route('**/codex-api/agent-progress?**', async route => {
        progressRequests++
        const now = Date.now()
        await route.fulfill({ json: { data: {
          rootThreadId: threadId, turnId: 'active-colors-replay', status: 'running', phase: 'reasoning', startedAtMs: now - 30000,
          lastActivityAtMs: now, mainLastActivityAtMs: now, updatedAtMs: now, events: [],
          agents: ['running', 'completed', 'completed'].map((status, i) => ({ threadId: `color-agent-${i}`, parentThreadId: threadId, path: `/root/task_${i + 1}`, nickname: '', depth: 1, taskSummary: '', model: 'gpt-6-astra', reasoningEffort: 'high', status, startedAtMs: now - 20000, lastActivityAtMs: now, completedAtMs: status === 'completed' ? now : null, resultAvailable: false }))
        } } })
      })
      const page = await context.newPage(); lastPage = page
      const errors = [], writes = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('request', r => {
        if (r.url().endsWith('/codex-api/rpc') && r.method() === 'POST') {
          const method = r.postDataJSON()?.method
          if (/^(turn\/(start|steer|interrupt)|thread\/(start|settings\/update)|config\/(batchWrite|value\/write))$/.test(method)) writes.push(method)
        }
      })
      await page.goto(`${base}/#/thread/${threadId}`, { waitUntil: 'domcontentloaded' })
      const card = page.locator('.turn-progress-card[data-tone=running]'), dot = card.locator('.turn-progress-pulse')
      await card.waitFor({ timeout: 60000 }); await page.waitForTimeout(2300)
      const colors = await card.evaluate(n => {
        const c = getComputedStyle(n), d = getComputedStyle(n.querySelector('.turn-progress-pulse')), s = getComputedStyle(n.querySelector('.turn-progress-status'))
        return { surface: c.backgroundColor, border: c.borderTopColor, cardShadow: c.boxShadow, dot: d.backgroundColor, halo: d.boxShadow, tagBackground: s.backgroundColor, tagColor: s.color }
      })
      assert.equal(colors.dot, blue); assert(colors.halo.includes('4px'))
      assert.equal(colors.surface, theme === 'dark' ? 'rgb(36, 36, 38)' : 'rgb(255, 255, 255)')
      assert.equal(colors.border, theme === 'dark' ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.12)')
      assert(!colors.cardShadow.includes('inset'))
      assert.equal(colors.tagColor, theme === 'dark' ? 'rgb(125, 211, 252)' : 'rgb(3, 105, 161)')
      assert.equal(colors.tagBackground, theme === 'dark' ? 'rgb(8, 47, 73)' : 'rgb(240, 249, 255)')
      const t0 = await dot.evaluate(n => n.getAnimations()[0].currentTime)
      await page.waitForTimeout(250)
      assert(await dot.evaluate((n, t0) => n.getAnimations()[0].currentTime > t0, t0))
      const frames = await dot.evaluate(n => {
        const a = n.getAnimations()[0]; a.pause()
        const at = time => { a.currentTime = time; const s = getComputedStyle(n), r = n.closest('.turn-progress-card').getBoundingClientRect(); return { opacity: s.opacity, transform: s.transform, cardWidth: r.width, cardHeight: r.height } }
        return [at(0), at(900)]
      })
      assert.notEqual(frames[0].opacity, frames[1].opacity)
      assert.equal(frames[0].cardWidth, frames[1].cardWidth); assert.equal(frames[0].cardHeight, frames[1].cardHeight)
      const screenshot = path.join(out, `${live ? 'live' : 'after'}-${viewport.width}-${theme}.png`)
      await card.screenshot({ path: screenshot })
      await card.locator(viewport.width < 768 ? '.turn-progress-mobile-open' : '.turn-progress-agent-details-toggle').click()
      const activeChild = card.locator('.turn-progress-agent-dot[data-status=running]')
      assert.equal(await activeChild.evaluate(n => getComputedStyle(n).backgroundColor), blue)
      assert.notEqual(await card.locator('.turn-progress-agent-dot[data-status=completed]').first().evaluate(n => getComputedStyle(n).backgroundColor), blue)
      await page.waitForTimeout(2300); await page.screenshot({ path: screenshot.replace('.png', '-expanded.png') })
      if (viewport.width < 768) await page.keyboard.press('Escape')
      const nonRunningColors = {}
      for (const tone of ['completed', 'failed', 'interrupted', 'disconnected', 'stale']) {
        await card.evaluate((n, value) => { n.dataset.tone = value }, tone)
        const state = await page.locator('.turn-progress-pulse').evaluate(n => ({ color: getComputedStyle(n).backgroundColor, animation: getComputedStyle(n).animationName }))
        assert.notEqual(state.color, blue)
        if (tone !== 'stale') assert.equal(state.animation, 'none')
        nonRunningColors[tone] = state.color
        await page.locator('.turn-progress-card').evaluate(n => { n.dataset.tone = 'running' })
      }
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForTimeout(100)
      assert.equal(await dot.evaluate(n => getComputedStyle(n).animationName), 'none')
      assert.equal(await dot.evaluate(n => getComputedStyle(n).backgroundColor), blue)
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      assert.equal(progressRequests, 1); assert.deepEqual(errors, []); assert.deepEqual(writes, [])
      results.push({ url: page.url(), viewport, theme, colors, frames, nonRunningColors, reducedMotionVerified: true, progressRequests, errors, writes, screenshot })
      await context.close(); console.log('PASS', viewport.width, theme)
    }
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {})
    throw error
  } finally { await browser.close() }
  fs.writeFileSync(path.join(out, live ? 'live-browser.json' : 'browser.json'), JSON.stringify(results, null, 2))
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
