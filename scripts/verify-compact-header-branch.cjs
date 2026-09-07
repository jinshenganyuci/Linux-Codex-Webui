const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = 'http://127.0.0.1:13511'
const out = path.resolve('output/playwright/compact-header-branch')
const parent = '01a0797c-faa5-70a0-b29e-b4c92c0bb03c'
const child = '01a07ac1-1655-7340-bead-0637d5eeab63'
const url = `${base}/#/thread/${child}?from=${parent}`
const baseline = process.env.BASELINE === '1', live = process.env.LIVE_PREVIEW === '1', smoke = process.env.SMOKE === '1'
const prefix = baseline ? 'before' : live ? 'live' : 'after'
;(async () => {
  fs.mkdirSync(out, { recursive: true })
  const browser = await chromium.launch({ headless: true }), results = []
  let lastPage
  try {
    for (const viewport of baseline || smoke ? [{ width: 375, height: 812 }] : [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) for (const theme of baseline ? ['light'] : ['light', 'dark']) {
      const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: viewport.width < 768, serviceWorkers: 'block' })
      await context.addInitScript(theme => { if (location.origin === 'http://127.0.0.1:13511') localStorage.setItem('codex-web-local.dark-mode.v1', theme) }, theme)
      if (!baseline && !live) await context.route(base + '/**', async route => {
        const pathname = new URL(route.request().url()).pathname
        const file = pathname === '/' ? path.resolve('dist/index.html') : path.resolve('dist', '.' + pathname)
        if (!pathname.startsWith('/codex-api') && file.startsWith(path.resolve('dist') + '/') && fs.existsSync(file) && fs.statSync(file).isFile()) await route.fulfill({ path: file })
        else await route.continue()
      })
      await context.route('**/codex-api/rpc', async route => {
        if (route.request().postDataJSON().method !== 'thread/list') return route.continue()
        const response = await route.fetch(), data = await response.json()
        if (data.result?.data) data.result.data = data.result.data.filter(t => t.id !== child)
        await route.fulfill({ response, json: data })
      })
      const page = await context.newPage(); lastPage = page
      const errors = [], writes = []
      page.on('pageerror', e => errors.push(e.message))
      page.on('request', r => {
        if (r.url().endsWith('/codex-api/rpc') && r.method() === 'POST') {
          const method = r.postDataJSON()?.method
          if (/^(turn\/(start|steer|interrupt)|thread\/(start|settings\/update)|config\/(batchWrite|value\/write)|git\/(checkout|reset))$/.test(method)) writes.push(method)
        }
        if (/checkout|reset-branch/.test(new URL(r.url()).pathname)) writes.push(r.url())
      })
      await page.goto(url, { waitUntil: 'domcontentloaded' })
      await page.locator('.conversation-item[data-role=assistant]').first().waitFor({ timeout: 60000 })
      const button = page.locator('.content-header-branch-dropdown .header-git-trigger')
      await button.waitFor(); await page.waitForTimeout(2300)
      const geometry = await button.evaluate(n => {
        const b = n.getBoundingClientRect(), t = document.querySelector('.content-title'), r = t.getBoundingClientRect(), icon = n.querySelector('.header-git-trigger-icon').getBoundingClientRect()
        return { width: b.width, height: b.height, x: b.x, right: b.right, titleWidth: r.width, titleRight: r.right, titleClipped: t.scrollWidth > t.clientWidth, labelVisible: getComputedStyle(n.querySelector('.header-git-trigger-label')).display !== 'none', iconOffset: Math.abs(icon.x + icon.width/2 - b.x - b.width/2) }
      })
      if (!baseline) {
        if (viewport.width < 768) { assert.deepEqual([geometry.width, geometry.height], [44, 44]); assert(!geometry.labelVisible); assert(!geometry.titleClipped); assert(geometry.titleWidth >= 120); assert(geometry.iconOffset < 1) }
        else assert(geometry.labelVisible)
        assert(geometry.titleRight <= geometry.x && geometry.right <= viewport.width)
        assert.equal(await page.getByRole('link', { name: '返回上一级对话' }).count(), 1)
      }
      const screenshot = path.join(out, `${prefix}-${viewport.width}-${theme}.png`)
      await page.locator('.content-header').screenshot({ path: screenshot })
      if (!baseline) {
        const label = await button.getAttribute('aria-label'); assert(label && label === await button.getAttribute('title'))
        await button.click()
        const state = page.locator('.header-git-state-value'); await state.waitFor()
        assert(label.includes(await state.innerText()))
        const menu = page.locator('.header-git-menu'); const rect = await menu.boundingBox()
        assert(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1)
        assert.equal(await page.locator('.header-git-search[placeholder="搜索分支..."]').count(), 1)
        const background = await menu.evaluate(n => getComputedStyle(n).backgroundColor)
        if (theme === 'dark') assert.notEqual(background, 'rgb(255, 255, 255)')
        // Exercise a long branch name without changing any repository state.
        if (viewport.width < 768) {
          await state.evaluate(n => { n.textContent = 'feature/' + 'very-long-branch-name-'.repeat(8) })
          assert(await state.evaluate(n => n.scrollWidth <= n.clientWidth && n.getBoundingClientRect().height > 30))
        }
        await page.waitForTimeout(2300)
        await page.screenshot({ path: screenshot.replace('.png', '-menu.png') })
        await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' })
        if (viewport.width < 768) {
          const badge = await button.evaluateHandle(n => {
            const s = document.createElement('span'); s.className = 'header-git-dirty-dot'
            for (const name of n.getAttributeNames().filter(name => name.startsWith('data-v-'))) s.setAttribute(name, '')
            n.append(s); return s
          })
          assert(await badge.evaluate(n => { const r = n.getBoundingClientRect(), p = n.parentElement.getBoundingClientRect(); return r.width > 0 && r.x >= p.x && r.right <= p.right && r.y >= p.y && r.bottom <= p.bottom }))
          await badge.evaluate(n => n.remove())
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      }
      assert.deepEqual(errors, []); assert.deepEqual(writes, [])
      results.push({ url, viewport, theme, geometry, menuVerified: !baseline, errors, writes, screenshot })
      await context.unrouteAll({ behavior: 'wait' }); await context.close(); console.log('PASS', viewport.width, theme, geometry.titleWidth)
    }
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) await lastPage.screenshot({ path: path.join(out, 'failed.png') }).catch(() => {})
    throw error
  } finally { for (const context of browser.contexts()) await context.unrouteAll({ behavior: 'ignoreErrors' }); await browser.close() }
  fs.writeFileSync(path.join(out, baseline ? 'baseline.json' : live ? 'live-browser.json' : 'browser.json'), JSON.stringify(results, null, 2))
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
