/*
 * Read-only production startup checks. The caller must authorize 13510 explicitly:
 * VERIFY_PRODUCTION_STARTUP=1 STARTUP_THREAD_ID=<existing-id>
 * STARTUP_PRODUCTION_OUTPUT_DIR=<private-report-directory>
 * WEBUI_TEST_PASSWORD is supplied privately in the environment, never on the CLI.
 * Run from the validated worktree so its existing Playwright install is reused.
 * Native thread/resume may load history into server memory, but no model/config
 * overrides, message sends, preference writes or conversation mutations are allowed.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

assert.equal(process.env.VERIFY_PRODUCTION_STARTUP, '1', 'Explicit production verification authorization is required')
const base = (process.env.PROFILE_BASE_URL || 'http://127.0.0.2:13510').replace(/\/$/, '')
assert.equal(base, 'http://127.0.0.2:13510', 'Use the fixed production address requiring real password authentication')
const threadId = process.env.STARTUP_THREAD_ID || ''
assert(/^[0-9a-f-]{36}$/i.test(threadId), 'STARTUP_THREAD_ID must identify an existing conversation')
assert(process.env.WEBUI_TEST_PASSWORD, 'WEBUI_TEST_PASSWORD must be supplied privately')
assert(process.env.STARTUP_PRODUCTION_OUTPUT_DIR, 'STARTUP_PRODUCTION_OUTPUT_DIR is required')
const output = path.resolve(process.env.STARTUP_PRODUCTION_OUTPUT_DIR)
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright'))
const timeoutMs = 30000
const viewport = { width: 1440, height: 900 }
const historySelector = '.conversation-item[data-role="assistant"], .conversation-item[data-role="user"]'
const readMethods = new Set([
  'account/read', 'account/rateLimits/read', 'collaborationMode/list', 'config/read',
  'experimentalFeature/list', 'model/list', 'skills/list', 'thread/goal/get',
  'thread/list', 'thread/read', 'thread/turns/list',
])
const report = { base, startedAt: new Date().toISOString(), timeoutMs, readOnly: true, cases: [], passed: false }
let browser

function safeError(error) {
  return String(error?.message || error).split(process.env.WEBUI_TEST_PASSWORD).join('[redacted]')
}
function bodyOf(request) {
  try { return request.postDataJSON() || {} } catch { return {} }
}
function methodOf(request) {
  return new URL(request.url()).pathname === '/codex-api/rpc' ? bodyOf(request).method || '' : ''
}
function saveReport() {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
}
function allowedResume(body) {
  const params = body.params
  return params && params.threadId === threadId
    && Object.keys(params).every(key => ['threadId', 'excludeTurns', 'initialTurnsPage'].includes(key))
}

async function runCase(name, theme, existing) {
  const row = {
    name, theme, viewport, url: `${base}/${existing ? `#/thread/${threadId}` : '#/'}`,
    freshStorage: false, cacheDisabled: false, serviceWorkersBlocked: true,
    realLogin: false, metrics: {}, requests: [], forbiddenWrites: [],
    requestFailures: [], pageErrors: [], consoleErrors: [], apiErrors: [], screenshots: [], passed: false,
  }
  report.cases.push(row)
  const context = await browser.newContext({ viewport, colorScheme: theme, serviceWorkers: 'block' })
  const pending = []
  const requestRows = new WeakMap()
  let closing = false
  let caseStartedAt = Date.now()
  let readyStartedAt = null
  let loginAttempts = 0
  const elapsed = () => Date.now() - readyStartedAt
  const page = await context.newPage()
  page.setDefaultTimeout(timeoutMs)
  page.setDefaultNavigationTimeout(timeoutMs)

  try {
    assert.deepEqual(await context.storageState(), { cookies: [], origins: [] }, 'Cookie and localStorage must both start empty')
    row.freshStorage = true
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
    row.cacheDisabled = true

    page.on('pageerror', error => row.pageErrors.push(safeError(error)))
    // Retain no raw console messages, which can contain config or chat content.
    page.on('console', message => {
      if (message.type() === 'error') row.consoleErrors.push({ type: 'error', atMs: Date.now() - caseStartedAt })
    })
    page.on('requestfailed', request => {
      row.requestFailures.push({ path: new URL(request.url()).pathname, method: methodOf(request) || request.method(), reason: request.failure()?.errorText, closing })
    })
    page.on('request', request => {
      const url = new URL(request.url())
      if (!url.pathname.startsWith('/codex-api/')) return
      const body = bodyOf(request)
      const item = {
        path: url.pathname, method: methodOf(request) || request.method(),
        cursor: body.params?.cursor || null, threadId: body.params?.threadId || null,
        ancestorThreadId: body.params?.ancestorThreadId || null, atMs: Date.now() - caseStartedAt,
      }
      row.requests.push(item)
      requestRows.set(request, item)
    })
    page.on('requestfinished', request => {
      const item = requestRows.get(request)
      if (!item) return
      pending.push(request.sizes().then(sizes => {
        item.responseBytes = sizes.responseBodySize
        item.durationMs = Math.round(request.timing().responseEnd)
      }).catch(() => {}))
    })
    page.on('response', response => {
      const request = response.request()
      const url = new URL(request.url())
      if (url.pathname === '/auth/login') {
        row.loginStatus = response.status()
        // Readiness starts once authentication returns, including the subsequent
        // document/assets load. Password entry and authentication are separate.
        readyStartedAt = Date.now()
        row.loginMs = readyStartedAt - caseStartedAt
      }
      const item = requestRows.get(request)
      if (!item) return
      item.status = response.status()
      if (item.path !== '/codex-api/rpc') return
      pending.push(response.json().then(payload => {
        if (payload.error) row.apiErrors.push({ method: item.method, code: payload.error.code ?? null })
        if (item.method === 'config/read') {
          const config = payload.result?.config || {}
          row.modelConfig = { model: config.model, effort: config.model_reasoning_effort, provider: config.model_provider || 'codex' }
        }
      }).catch(() => row.apiErrors.push({ method: item.method, invalidJson: true })))
    })

    await context.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const httpMethod = request.method()
      const body = bodyOf(request)
      let allowed = ['GET', 'HEAD', 'OPTIONS'].includes(httpMethod)
      if (url.origin === base && httpMethod === 'POST') {
        if (url.pathname === '/auth/login' && loginAttempts === 0) {
          loginAttempts++
          allowed = typeof body.password === 'string' && body.password === process.env.WEBUI_TEST_PASSWORD
        } else if (url.pathname === '/codex-api/rpc') {
          allowed = readMethods.has(body.method) || body.method === 'thread/resume' && allowedResume(body)
        } else if (url.pathname === '/codex-api/thread-runtime-state') {
          // Existing endpoint is a read-only batch query despite using POST.
          allowed = true
        }
      }
      if (!allowed) {
        row.forbiddenWrites.push({ path: url.pathname, method: methodOf(request) || httpMethod })
        await route.fulfill({ status: 409, json: { error: 'Production verification rejected an unexpected mutation' } })
        return
      }
      await route.continue()
    })

    caseStartedAt = Date.now()
    await page.goto(row.url, { waitUntil: 'domcontentloaded' })
    await page.locator('#pw').waitFor({ state: 'visible' })
    row.loginFormVisible = true
    await page.locator('#pw').fill(process.env.WEBUI_TEST_PASSWORD)
    const [loginResponse] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === '/auth/login' && response.request().method() === 'POST'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.locator('button[type="submit"]').click(),
    ])
    assert.equal(loginResponse.status(), 200, 'Real password login must succeed')
    assert(readyStartedAt !== null && row.loginMs > 0 && loginAttempts === 1, 'Real login evidence is required')
    row.realLogin = true
    row.postLoginUrl = page.url()

    const remaining = Math.max(1, timeoutMs - elapsed())
    const readiness = [
      page.locator('.thread-composer-input:not(:disabled)').waitFor({ state: 'visible', timeout: remaining })
        .then(() => { row.metrics.inputMs = elapsed() }),
      page.locator('.thread-row').first().waitFor({ state: 'visible', timeout: remaining })
        .then(() => { row.metrics.listMs = elapsed() }),
    ]
    if (existing) readiness.push(page.locator(historySelector).first().waitFor({ state: 'visible', timeout: remaining })
      .then(() => { row.metrics.historyMs = elapsed() }))
    await Promise.all(readiness)
    for (const [metric, value] of Object.entries(row.metrics)) {
      assert(Number.isFinite(value) && value <= timeoutMs, `${metric} exceeded the 30-second functional readiness deadline`)
    }
    if (existing) assert.equal(new URL(page.url()).hash, `#/thread/${threadId}`, 'Late list loading must preserve the selected conversation')
    await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark')
    await page.waitForTimeout(2300)
    const screenshotPath = path.join(output, `${name}.png`)
    await page.screenshot({ path: screenshotPath })
    row.screenshots.push(screenshotPath)
    row.surfaceColors = await page.evaluate(() => Object.fromEntries(
      ['.sidebar-root', '.thread-composer-shell'].map(selector => [selector, document.querySelector(selector) ? getComputedStyle(document.querySelector(selector)).backgroundColor : null]),
    ))
    await Promise.all(pending)
    const counts = {}
    for (const item of row.requests) {
      const key = `${item.method}:${item.path}:${item.threadId || item.ancestorThreadId || ''}:${item.cursor || ''}`
      counts[key] = (counts[key] || 0) + 1
    }
    row.duplicateCounts = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 1))
    row.totalApiKB = Math.round(row.requests.reduce((sum, item) => sum + (item.responseBytes || 0), 0) / 1024)
    row.slowestApiRows = [...row.requests].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 10)
    assert(row.requests.some(item => item.method === 'thread/list' && item.status === 200), 'A real successful thread list request is required')
    assert(row.modelConfig?.model, 'A successful model configuration read is required')
    assert.deepEqual(row.forbiddenWrites, [], 'No chat, preference or configuration writes are allowed')
    assert.deepEqual(row.pageErrors, [], 'Unexpected browser JavaScript errors')
    assert.deepEqual(row.consoleErrors, [], 'Unexpected browser console errors')
    assert.deepEqual(row.apiErrors, [], 'Unexpected native RPC errors')
    assert.deepEqual(row.requests.filter(item => item.status >= 400), [], 'Unexpected API HTTP failures')
    assert.deepEqual(row.requestFailures.filter(item => !item.closing && !/ERR_ABORTED/.test(item.reason || '')), [], 'Unexpected failed requests')
    row.passed = true
  } catch (error) {
    row.error = safeError(error)
    const screenshotPath = path.join(output, `${name}-FAILED.png`)
    await page.screenshot({ path: screenshotPath }).then(() => row.screenshots.push(screenshotPath)).catch(() => {})
    throw error
  } finally {
    closing = true
    await context.close()
    await Promise.allSettled(pending)
    saveReport()
    console.log(JSON.stringify({ name, passed: row.passed, loginMs: row.loginMs, metrics: row.metrics, screenshots: row.screenshots, error: row.error }))
  }
}

;(async () => {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 })
  browser = await chromium.launch({ headless: true })
  try {
    await runCase('production-home-1440-light', 'light', false)
    await runCase('production-thread-1440-dark', 'dark', true)
    report.passed = true
  } finally {
    await browser.close()
    report.finishedAt = new Date().toISOString()
    saveReport()
  }
})().catch(error => {
  report.error = safeError(error)
  report.finishedAt = new Date().toISOString()
  saveReport()
  console.error(safeError(error))
  process.exitCode = 1
})
