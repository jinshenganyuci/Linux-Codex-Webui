/*
 * Run against the isolated, current 13511 acceptance build only.
 * STARTUP_SEND=1 enables one real marker-only conversation, deleted on exit.
 * STARTUP_CASES=fresh,delayed-history,delayed-send,search,refresh,index-status,collapsed-search
 * STARTUP_FRESH_CASES=home-1440-light,thread-1440-light selects narrow auth/cold checks.
 * WEBUI_TEST_PASSWORD is supplied by the caller when the address requires login.
 * This deliberately uses Playwright routes/CDP: delayed APIs, isolated error
 * fixtures and a disabled HTTP cache cannot be exercised by Browser Use.
 */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const base = (process.env.PROFILE_BASE_URL || 'http://127.0.0.1:13511').replace(/\/$/, '')
assert.equal(new URL(base).port, '13511', 'This script must never exercise production 13510')
const out = path.resolve('output/playwright/startup-complete', process.env.STARTUP_RUN_LABEL || 'current')
const oldThreadId = process.env.STARTUP_THREAD_ID || '01a09549-9bb5-71c0-955e-dd74cc8e32be'
const searchThreadId = process.env.STARTUP_SEARCH_THREAD_ID || '019ff3bc-fc05-7a81-8dd9-7f31c96c05c8'
const searchNeedle = process.env.STARTUP_SEARCH_NEEDLE || 'hermes 这些'
const delayMs = 8000
const limits = {
  listMs: Number(process.env.STARTUP_MAX_LIST_MS || 3500),
  historyMs: Number(process.env.STARTUP_MAX_HISTORY_MS || 4000),
  inputMs: Number(process.env.STARTUP_MAX_INPUT_MS || 3000),
  sendAcceptedMs: Number(process.env.STARTUP_MAX_SEND_MS || 5000),
  searchMs: Number(process.env.STARTUP_MAX_SEARCH_MS || 3500),
  nextPageMs: Number(process.env.STARTUP_MAX_NEXT_PAGE_MS || 2500),
}
const selected = new Set((process.env.STARTUP_CASES || 'fresh,delayed-history,delayed-send,search,refresh,index-status,collapsed-search').split(','))
const report = { base, startedAt: new Date().toISOString(), limits, cases: [], skipped: [], ownedThreadIds: [], cleanup: [] }
const historySelector = '.conversation-item[data-role="assistant"], .conversation-item[data-role="user"]'
const ownedThreadIds = new Set()
// Kept in memory only, so cleanup works after a failed authenticated case.
const cleanupStorageStates = new Map()
const ownMarker = `STARTUP_COMPLETE_${Date.now()}`
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let browser

function saveReport() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)) }
function within(value, limit, label) { assert(Number.isFinite(value) && value <= limit, `${label}: ${value} ms exceeds ${limit} ms`) }
function parseBody(request) { try { return request.postDataJSON() || {} } catch { return {} } }
function routeMethod(request) { return new URL(request.url()).pathname === '/codex-api/rpc' ? parseBody(request).method : '' }
function digest(file) { return fs.existsSync(file) ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null }
const guardedConfigPath = process.env.STARTUP_CONFIG_PATH || ''
const originalConfigText = guardedConfigPath && fs.existsSync(guardedConfigPath) ? fs.readFileSync(guardedConfigPath, 'utf8') : null
const originalConfigDigest = guardedConfigPath ? digest(guardedConfigPath) : null
if (guardedConfigPath) assert(originalConfigDigest, 'STARTUP_CONFIG_PATH must identify the actual acceptance config.toml')
if (guardedConfigPath) report.configBeforeSha256 = originalConfigDigest

async function until(predicate, timeout, message) {
  const began = Date.now()
  while (Date.now() - began < timeout) {
    if (await predicate()) return
    await wait(25)
  }
  assert.fail(message)
}

async function rpc(request, method, params) {
  const response = await request.post(`${base}/codex-api/rpc`, { data: { method, params }, timeout: 30000 })
  const result = await response.json()
  assert(response.ok() && !result.error, `${method} failed: HTTP ${response.status()} ${result.error?.message || ''}`)
  return result.result
}

async function makeSession(name, viewport = { width: 1440, height: 900 }, theme = 'light', options = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme, serviceWorkers: 'block', isMobile: viewport.width < 768, hasTouch: viewport.width < 768 })
  assert.deepEqual(await context.storageState(), { cookies: [], origins: [] }, 'Every case must start with no Cookie/localStorage')
  if (options.captureSocket) await context.addInitScript(() => {
    const NativeSocket = window.WebSocket
    window.__startupAcceptanceSockets = []
    window.WebSocket = class extends NativeSocket {
      constructor(url, protocols) {
        super(url, protocols)
        if (String(url).includes('/codex-api/ws')) window.__startupAcceptanceSockets.push(this)
      }
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(7000)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const row = { name, viewport, theme, freshStorage: true, cacheDisabled: true, serviceWorkersBlocked: true, requests: [], notifications: [], requestFailures: [], pageErrors: [], consoleErrors: [], forbiddenWrites: [], screenshots: [], metrics: {} }
  report.cases.push(row)
  const pending = []
  const requestRows = new WeakMap()
  let closing = false
  let startedAt = Date.now()
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    try {
      const message = JSON.parse(String(payload))
      if (typeof message.method !== 'string' || row.notifications.length >= 5000) return
      row.notifications.push({ method: message.method, threadId: message.params?.threadId || message.params?.thread?.id || null, atMs: Date.now() - startedAt })
      if (message.params?.status?.type) row.notifications.at(-1).statusType = message.params.status.type
    } catch { /* Never retain raw frames or conversation content. */ }
  }))
  page.on('pageerror', error => row.pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') row.consoleErrors.push(message.text()) })
  page.on('requestfailed', request => row.requestFailures.push({ path: new URL(request.url()).pathname, method: routeMethod(request), reason: request.failure()?.errorText, closing, atMs: Date.now() - startedAt }))
  page.on('request', request => {
    if (!request.url().includes('/codex-api/')) return
    const body = parseBody(request)
    const requestRow = { path: new URL(request.url()).pathname, method: body.method || request.method(), cursor: body.params?.cursor || null, threadId: body.params?.threadId || null, ancestorThreadId: body.params?.ancestorThreadId || null, atMs: Date.now() - startedAt }
    requestRows.set(request, requestRow)
    row.requests.push(requestRow)
  })
  page.on('requestfinished', request => {
    const requestRow = requestRows.get(request)
    if (!requestRow) return
    pending.push(request.sizes().then(sizes => {
      requestRow.responseBytes = sizes.responseBodySize
      requestRow.durationMs = Math.round(request.timing().responseEnd)
    }).catch(() => {}))
  })
  page.on('response', response => {
    const request = response.request()
    if (!request.url().includes('/codex-api/')) return
    const pathname = new URL(request.url()).pathname
    const method = routeMethod(request)
    const matching = requestRows.get(request)
    if (matching) { matching.status = response.status(); matching.responseMs = Date.now() - startedAt }
    if (method === 'config/read' || pathname === '/codex-api/preferences/new-chat-defaults') {
      pending.push(response.json().then(payload => {
        if (method === 'config/read') {
          const config = payload.result?.config || {}
          // Never write raw config responses, credentials or conversation bodies.
          row.modelConfig = { model: config.model, effort: config.model_reasoning_effort, provider: config.model_provider || 'codex' }
        } else row.newChatDefaults = payload.data?.providers || {}
      }).catch(error => row.pageErrors.push(`Failed to inspect configuration response: ${error.message}`)))
    }
  })
  await context.route('**/codex-api/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    const body = parseBody(request)
    const method = routeMethod(request)
    if (options.intercept && await options.intercept({ route, request, pathname, body, method, row, context, elapsed: () => Date.now() - startedAt })) return
    const configWrite = method && /^(config\/(?:batchWrite|value\/write)|setDefaultModel)$/.test(method)
      || /\/(?:runtime-config|preferences\/(?:new-chat-defaults|sidebar-layout)|provider-config)$/.test(pathname) && request.method() !== 'GET'
    const conversationWrite = ['turn/start', 'thread/start', 'thread/queue/start', 'thread/realtime/start', 'thread/delete', 'thread/archive', 'thread/unarchive', 'thread/name/set'].includes(method)
      || pathname === '/codex-api/thread/start-turn'
    const preferenceWrite = /\/(?:thread-model-preferences|thread-collaboration-preferences)$/.test(pathname) && request.method() !== 'GET'
    if (configWrite || conversationWrite || preferenceWrite && !ownedThreadIds.has(body.threadId)) {
      row.forbiddenWrites.push({ path: pathname, method: method || request.method() })
      await route.fulfill({ status: 409, json: { error: 'Acceptance guard rejected an unexpected mutation' } })
      return
    }
    await route.continue()
  })
  async function go(suffix = '/#/') {
    startedAt = Date.now()
    row.url = `${base}${suffix}`
    if (page.url() === row.url) await page.reload({ waitUntil: 'domcontentloaded' })
    else await page.goto(row.url, { waitUntil: 'domcontentloaded' })
    if (await page.locator('#pw').isVisible()) {
      assert(process.env.WEBUI_TEST_PASSWORD, 'WEBUI_TEST_PASSWORD is needed for a real fresh login')
      await page.locator('#pw').fill(process.env.WEBUI_TEST_PASSWORD)
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('button[type="submit"]').click()])
      row.loginMs = Date.now() - startedAt
      startedAt = Date.now()
    }
    row.postLoginUrl = page.url()
  }
  async function screenshot(suffix = '') {
    await page.waitForTimeout(2300)
    const file = path.join(out, `${name}${suffix ? `-${suffix}` : ''}.png`)
    await page.screenshot({ path: file })
    row.screenshots.push(file)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark', 'Requested theme must reach the actual page')
    row.surfaceColors = await page.evaluate(() => {
      const selectors = ['.sidebar-root', '.thread-composer-shell', '[data-testid="thread-index-status"]', '[data-testid="thread-search-status"]']
      return Object.fromEntries(selectors.map(selector => [selector, document.querySelector(selector) ? getComputedStyle(document.querySelector(selector)).backgroundColor : null]))
    })
  }
  async function verifyNoErrors() {
    await Promise.all(pending)
    const counts = {}
    for (const request of row.requests) {
      const key = `${request.method}:${request.path}:${request.threadId || request.ancestorThreadId || ''}:${request.cursor || ''}`
      counts[key] = (counts[key] || 0) + 1
    }
    row.totalApiKB = Math.round(row.requests.reduce((bytes, request) => bytes + (request.responseBytes || 0), 0) / 1024)
    row.duplicateCounts = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 1))
    row.slowestApiRows = [...row.requests].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 10)
    assert.deepEqual(row.pageErrors, [], 'Unexpected JavaScript errors')
    assert.deepEqual(row.forbiddenWrites, [], 'Read-only visits must not write configuration or create turns')
    assert.deepEqual(row.requestFailures.filter(item => !item.closing && !/ERR_ABORTED/.test(item.reason || '')), [], 'Unexpected failed requests')
    const expected = options.expectedErrorPaths || []
    assert.deepEqual(row.requests.filter(item => item.status >= 400 && !expected.includes(item.path)), [], 'Unexpected HTTP API failures')
  }
  async function close() {
    closing = true
    if (options.beforeClose) await options.beforeClose()
    await context.unrouteAll({ behavior: 'wait' })
    await Promise.allSettled(pending)
    await context.close()
  }
  return { context, page, row, go, screenshot, verifyNoErrors, close, elapsed: () => Date.now() - startedAt }
}

async function runCase(name, fn, viewport, theme, options) {
  const session = await makeSession(name, viewport, theme, options)
  try {
    await fn(session)
    await session.verifyNoErrors()
    session.row.passed = true
  } catch (error) {
    session.row.passed = false
    session.row.error = error.stack
    const file = path.join(out, `${name}-FAILED.png`)
    await session.page.screenshot({ path: file }).then(() => session.row.screenshots.push(file)).catch(() => {})
    throw error
  } finally {
    await session.close()
    saveReport()
    console.log(JSON.stringify({ ...session.row, requests: undefined, newChatDefaults: undefined }))
  }
}

function delayedList() {
  const gate = { beganAt: null, releasedAt: null, responseAt: null, firstPageIds: [], count: 0 }
  gate.intercept = async ({ route, body, method, elapsed }) => {
    if (method !== 'thread/list' || body.params?.cursor || body.params?.ancestorThreadId || gate.count) return false
    gate.count++
    gate.beganAt = elapsed()
    await wait(delayMs)
    gate.releasedAt = elapsed()
    const response = await route.fetch()
    const payload = await response.json()
    gate.responseAt = elapsed()
    gate.firstPageIds = (payload.result?.data || []).map(thread => thread.id)
    await route.fulfill({ response })
    return true
  }
  return gate
}

async function freshCases() {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) {
    for (const theme of ['light', 'dark']) {
      for (const existing of [false, true]) {
        const name = `${existing ? 'thread' : 'home'}-${viewport.width}-${theme}`
        const freshFilter = process.env.STARTUP_FRESH_CASES || process.env.STARTUP_FRESH_CASE
        if (freshFilter && !freshFilter.split(',').includes(name)) continue
        await runCase(name, async session => {
          const { page, row } = session
          await session.go(existing ? `/#/thread/${oldThreadId}` : '/#/')
          const listReady = viewport.width < 768 ? Promise.resolve(null) : page.locator('.thread-row').first().waitFor({ state: 'visible', timeout: limits.listMs + 1500 }).then(() => session.elapsed())
          const historyReady = existing ? page.locator(historySelector).first().waitFor({ timeout: limits.historyMs + 1500 }).then(() => session.elapsed()) : Promise.resolve(null)
          // Attach handlers immediately so an early deadline failure is never unhandled.
          void listReady.catch(() => {})
          void historyReady.catch(() => {})
          await page.locator('.thread-composer-input:not(:disabled)').waitFor({ timeout: limits.inputMs + 1500 })
          row.metrics.inputMs = session.elapsed()
          ;[row.metrics.listMs, row.metrics.historyMs] = await Promise.all([listReady, historyReady])
          within(row.metrics.inputMs, limits.inputMs, 'Composer usable')
          if (row.metrics.listMs !== null) within(row.metrics.listMs, limits.listMs, 'Thread list visible')
          if (existing) within(row.metrics.historyMs, limits.historyMs, 'Old conversation visible')
          if (existing) assert.equal(new URL(page.url()).hash, `#/thread/${oldThreadId}`, 'A late list must not replace the requested old conversation')
          await session.screenshot()
          const firstPages = row.requests.filter(item => item.method === 'thread/list' && !item.cursor && !item.ancestorThreadId)
          assert.equal(firstPages.length, 1, 'Startup must not duplicate the first thread page, including delayed resume notifications')
        }, viewport, theme)
      }
    }
  }
}

async function delayedHistory() {
  const gate = delayedList()
  await runCase('delayed-history', async session => {
    await session.go(`/#/thread/${oldThreadId}`)
    await session.page.locator(historySelector).first().waitFor({ timeout: limits.historyMs + 1500 })
    const historyMs = session.elapsed()
    within(historyMs, limits.historyMs, 'History with 8-second list delay')
    assert(gate.beganAt !== null, 'The list delay must actually have started')
    assert.equal(gate.releasedAt, null, 'History must appear before the list is released')
    session.row.metrics = { historyMs, listDelayMs: delayMs, historyBeforeList: true }
    await session.screenshot('while-list-pending')
    await until(() => gate.responseAt !== null, delayMs + 3000, 'Delayed list never recovered')
    await session.page.locator('.thread-row').first().waitFor({ state: 'visible' })
    session.row.listGate = gate
  }, undefined, 'dark', { intercept: gate.intercept })
}

async function delayedSend() {
  if (process.env.STARTUP_SEND !== '1') { report.skipped.push('delayed-send: STARTUP_SEND=1 required'); return }
  const gate = delayedList()
  let accepted = null
  const intercept = async args => {
    if (await gate.intercept(args)) return true
    if (args.pathname !== '/codex-api/thread/start-turn') return false
    assert(args.body.turn?.input?.some(item => item.type === 'text' && item.text.includes(ownMarker)), 'Only the unique acceptance marker may be sent')
    const requestAt = args.elapsed()
    const response = await args.route.fetch({ timeout: 30000 })
    const payload = await response.json()
    const data = payload.data || {}
    const threadId = data.threadId || data.thread?.id || data.id
    if (threadId) {
      ownedThreadIds.add(threadId)
      report.ownedThreadIds = [...ownedThreadIds]
      cleanupStorageStates.set(threadId, await args.context.storageState())
    }
    accepted = { requestAt, acceptedAt: args.elapsed(), status: response.status(), threadId, turnId: data.turn?.id,
      cwd: args.body.thread?.cwd,
      model: args.body.turn?.model || args.body.thread?.model,
      effort: args.body.turn?.effort,
      collaborationModel: args.body.turn?.collaborationMode?.settings?.model,
      collaborationEffort: args.body.turn?.collaborationMode?.settings?.reasoning_effort,
      responseModel: data.model || data.thread?.model }
    await args.route.fulfill({ response })
    return true
  }
  await runCase('delayed-send', async session => {
    await session.go()
    await session.page.locator('.thread-composer-input:not(:disabled)').waitFor({ timeout: limits.inputMs + 1500 })
    await session.page.locator('.thread-composer-input').fill(`这是隔离性能验收，只回复 ${ownMarker}。禁止使用工具，禁止读写文件，禁止执行其他任务。`)
    await session.page.locator('.thread-composer-submit:not(:disabled)').click()
    await until(() => accepted !== null, limits.sendAcceptedMs + 1500, 'No real thread/start + turn/start acceptance before deadline')
    session.row.accepted = accepted
    assert(accepted.status < 400 && accepted.threadId && accepted.turnId, 'Combined start endpoint must accept a real thread and turn')
    within(accepted.acceptedAt, limits.sendAcceptedMs, 'Real turn acceptance from a fresh page')
    assert(gate.beganAt !== null && gate.releasedAt === null, 'Real turn must be accepted before the 8-second list delay is released')
    await until(() => session.row.modelConfig, 1000, 'No config/read evidence for the submitted model')
    const config = session.row.modelConfig
    const provider = config.provider.toLowerCase().replace(/_/g, '-')
    const prefs = session.row.newChatDefaults?.[provider === 'openai' ? 'codex' : provider] || {}
    const expected = { model: prefs.model || config.model, effort: prefs.reasoningEffort || config.effort }
    session.row.expectedSubmission = expected
    assert.equal(accepted.model, expected.model, 'Fast send must use the loaded model configuration')
    assert.equal(accepted.effort, expected.effort, 'Fast send must use the loaded effort configuration')
    if (accepted.collaborationModel) assert.equal(accepted.collaborationModel, expected.model)
    if (accepted.collaborationEffort) assert.equal(accepted.collaborationEffort, expected.effort)
    await session.page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: ownMarker }).first().waitFor({ timeout: 120000 })
    session.row.metrics = { acceptedMs: accepted.acceptedAt, replyMs: session.elapsed(), acceptedBeforeList: true }
    await session.screenshot('real-reply')
    await until(async () => {
      const result = await rpc(session.context.request, 'thread/read', { threadId: accepted.threadId, includeTurns: false })
      return result.thread?.status?.type !== 'active'
    }, 15000, 'The marker turn did not finish before cleanup')
    await session.page.goto(`${base}/#/`, { waitUntil: 'domcontentloaded' })
    await rpc(session.context.request, 'thread/delete', { threadId: accepted.threadId })
    report.cleanup.push({ threadId: accepted.threadId, deleted: true })
    ownedThreadIds.delete(accepted.threadId)
    cleanupStorageStates.delete(accepted.threadId)
  }, undefined, 'light', { intercept })
}

async function searchOlder() {
  let releasePages
  const pagesGate = new Promise(resolve => { releasePages = resolve })
  let firstPageIds = []
  const intercept = async ({ route, method, body }) => {
    if (method !== 'thread/list') return false
    if (body.params?.cursor) { await pagesGate; await route.continue(); return true }
    const response = await route.fetch()
    const payload = await response.json()
    firstPageIds = (payload.result?.data || []).map(thread => thread.id)
    await route.fulfill({ response })
    return true
  }
  try {
    await runCase('search-beyond-first-page', async session => {
      await session.go()
      await session.page.locator('.thread-row').first().waitFor({ state: 'visible' })
      assert.equal(firstPageIds.length, 50, 'Test requires a real native first page of 50')
      assert(!firstPageIds.includes(searchThreadId), 'Search fixture must actually be absent from the native first page')
      session.row.nativeFirstPageIds = firstPageIds
      await session.page.locator('.sidebar-search-toggle').click()
      const began = Date.now()
      await session.page.locator('.sidebar-search-input').fill(searchNeedle)
      const match = session.page.locator(`.thread-row[data-thread-id="${searchThreadId}"]`).first()
      await match.waitFor({ state: 'visible', timeout: limits.searchMs + 1500 })
      session.row.metrics.searchMs = Date.now() - began
      within(session.row.metrics.searchMs, limits.searchMs, 'Unloaded old thread search')
      await session.screenshot('result')
      await match.locator('.thread-main-button').click()
      await session.page.waitForURL(url => url.hash === `#/thread/${searchThreadId}`, { timeout: 5000 })
      const openedAt = Date.now()
      await session.page.locator(historySelector).first().waitFor({ timeout: limits.historyMs + 1500 })
      within(Date.now() - openedAt, limits.historyMs, 'Search result history opens')
      session.row.searchThreadId = searchThreadId
      session.row.searchBeforeBackgroundPages = true
      releasePages()
      await session.screenshot('opened')
    }, undefined, 'dark', { intercept, beforeClose: releasePages })
  } finally { releasePages() }
}

async function refreshPagination() {
  await runCase('repeat-refresh-pagination', async session => {
    session.row.refreshRounds = []
    for (let round = 0; round < 3; round++) {
      const offset = session.row.requests.length
      await session.go()
      await until(() => session.row.requests.slice(offset).some(item => item.method === 'thread/list' && item.cursor), limits.nextPageMs + 1500, 'Background pagination starved after refresh')
      const requests = session.row.requests.slice(offset).filter(item => item.method === 'thread/list')
      const nextPage = requests.find(item => item.cursor)
      within(nextPage.atMs, limits.nextPageMs, 'Second page begins after refresh')
      session.row.refreshRounds.push({ round: round + 1, secondPageAtMs: nextPage.atMs, firstPageCount: requests.filter(item => !item.cursor).length })
      assert.equal(requests.filter(item => !item.cursor).length, 1, 'Refresh duplicated the first page')
      await until(() => session.row.requests.slice(offset).some(item => item.method === 'thread/list' && item.cursor && item.status === 200), 5000, 'Second page never completes')
    }
    await session.screenshot()
  })
  await runCase('notification-refresh-pagination', async session => {
    await session.go()
    await session.page.waitForFunction(() => window.__startupAcceptanceSockets?.some(socket => socket.readyState === WebSocket.OPEN))
    const began = Date.now()
    for (let count = 0; count < 35; count++) {
      await session.page.evaluate(threadId => {
        const socket = window.__startupAcceptanceSockets.findLast(socket => socket.readyState === WebSocket.OPEN)
        // Replay an ordinary metadata notification through the actual client
        // transport handler; it refreshes lists without mutating the server.
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'thread/name/updated', params: { threadId }, atIso: new Date().toISOString() }) }))
      }, oldThreadId)
      await wait(100)
    }
    const lists = session.row.requests.filter(item => item.method === 'thread/list')
    const firstPages = lists.filter(item => !item.cursor)
    const completedPages = lists.filter(item => item.cursor && item.status === 200)
    assert(firstPages.length >= 3, 'The replay must actually refresh the first page repeatedly')
    assert(completedPages.length >= 2, 'Background pages must advance while notifications repeatedly refresh the first page')
    assert.equal(new Set(completedPages.map(item => item.cursor)).size, completedPages.length, 'Repeated refresh must not rewind background cursors')
    session.row.metrics = { notificationWindowMs: Date.now() - began, firstPageRefreshes: firstPages.length, completedBackgroundPages: completedPages.length }
    session.row.syntheticNotifications = true
    session.row.nativeBackgroundPageLimit = 10
    await session.screenshot()
  }, undefined, 'light', { captureSocket: true, intercept: async ({ route, method, body }) => {
    if (method !== 'thread/list' || !body.params?.cursor) return false
    await wait(500)
    // Keep native data and cursor semantics, but use smaller valid pages so a
    // root-only inventory with 85 threads can exercise several in-flight pages.
    body.params.limit = 10
    await route.continue({ postData: JSON.stringify(body) })
    return true
  } })
}

async function indexStatus() {
  for (const theme of ['light', 'dark']) {
    for (const failStatusRequest of [false, true]) {
    let repaired = false
    const fixture = { state: 'partial', lastCheckedAt: new Date().toISOString(), scannedFiles: 3, indexedThreads: 2, missingThreads: 1, repairedThreads: 0, failedThreads: 1, truncated: false, error: '验收模拟：一条历史记录尚未同步' }
    const intercept = async ({ route, pathname }) => {
      if (!pathname.startsWith('/codex-api/thread-index/')) return false
      if (pathname.endsWith('/repair')) repaired = true
      if (failStatusRequest && !repaired) {
        await route.fulfill({ status: 503, json: { error: 'STARTUP_ACCEPTANCE_STATUS_FAILURE' } })
        return true
      }
      await route.fulfill({ json: { data: repaired ? { ...fixture, state: 'ready', missingThreads: 0, repairedThreads: 1, failedThreads: 0, error: null } : fixture } })
      return true
    }
    await runCase(`index-${failStatusRequest ? 'request-error' : 'partial'}-${theme}`, async session => {
      await session.go()
      const status = session.page.getByTestId('thread-index-status')
      await status.waitFor({ state: 'visible', timeout: 5000 })
      await session.page.locator('.thread-row').first().waitFor({ state: 'visible', timeout: limits.listMs + 1500 })
      assert(await session.page.locator('.thread-composer-input').isEnabled(), 'Recovery status must not disable chatting')
      await session.screenshot('before-retry')
      await session.page.getByTestId('retry-history-sync').click()
      await status.waitFor({ state: 'hidden', timeout: 5000 })
      assert(repaired, 'Retry must call the controlled repair endpoint')
      session.row.fixtureOnly = true
      session.row.realRecoveryNotCoveredHere = true
      session.row.injectedStatusFailure = failStatusRequest
    }, undefined, theme, { intercept, expectedErrorPaths: failStatusRequest ? ['/codex-api/thread-index/status'] : [] })
    }
  }
}

async function collapsedSearch() {
  for (const theme of ['light', 'dark']) {
    const projectCwd = '/tmp/startup-ui-project'
    const ids = ['project-match', 'project-unrelated', 'chat-match', 'pinned-match'].map((name, index) => `00000000-0000-4000-8000-${String(index + 71).padStart(12, '0')}`)
    const threads = ids.map((id, index) => ({ id, name: index === 1 ? 'STARTUP_UNRELATED' : `STARTUP_MATCH_${index}`, preview: index === 1 ? 'STARTUP_UNRELATED' : `STARTUP_MATCH_${index}`, cwd: index === 2 ? '/root/Documents/Codex/2026-09-26/startup-ui-chat' : projectCwd, createdAt: 1700000000, updatedAt: 1700000000 + index, status: { type: 'notLoaded' }, source: 'cli' }))
    const intercept = async ({ route, request, pathname, method }) => {
      if (pathname === '/codex-api/preferences/sidebar-layout' && request.method() === 'GET') {
        await route.fulfill({ json: { data: { version: 1, revision: 1, persisted: true, sections: { pinned: false, chats: false, projects: false }, collapsedProjects: { [projectCwd]: true, 'startup-ui-project': true } } } })
      } else if (pathname === '/codex-api/workspace-roots-state' && request.method() === 'GET') {
        await route.fulfill({ json: { data: { order: [projectCwd], active: [projectCwd], labels: {}, projectOrder: [projectCwd] } } })
      } else if (pathname === '/codex-api/thread-pins' && request.method() === 'GET') {
        await route.fulfill({ json: { data: { threadIds: [ids[3]] } } })
      } else if (method === 'thread/list') {
        await route.fulfill({ json: { result: { data: threads, nextCursor: null } } })
      } else if (pathname === '/codex-api/thread-search') {
        await route.fulfill({ json: { data: { threads: threads.filter((_, index) => index !== 1), threadIds: ids.filter((_, index) => index !== 1), indexedThreadCount: 4, contentSearchState: 'idle', searchedContentCount: 0, contentThreadCount: 100 } } })
      } else return false
      return true
    }
    await runCase(`collapsed-search-${theme}`, async session => {
      await session.go()
      const sections = ['chats', 'projects', 'pinned'].map(section => session.page.getByTestId(`toggle-${section}-section`))
      for (const section of sections) {
        await section.waitFor({ state: 'visible' })
        assert.equal(await section.getAttribute('aria-expanded'), 'false', 'The fixture must actually begin collapsed')
      }
      await session.page.locator('.sidebar-search-toggle').click()
      await session.page.locator('.sidebar-search-input').fill('STARTUP_MATCH')
      for (const index of [0, 2, 3]) await session.page.locator(`.thread-row[data-thread-id="${ids[index]}"]`).waitFor({ state: 'visible' })
      assert.equal(await session.page.locator(`.thread-row[data-thread-id="${ids[1]}"]`).count(), 0, 'A matching project must not expose its nonmatching siblings')
      for (const section of sections) assert.equal(await section.getAttribute('aria-expanded'), 'true')
      await session.screenshot('expanded-results')
      await session.page.locator('.sidebar-search-clear').click()
      for (const section of sections) assert.equal(await section.getAttribute('aria-expanded'), 'false', 'Clearing search must restore saved collapsed state')
      assert.equal(await session.page.locator('.thread-row').count(), 0)
      await session.screenshot('restored-collapsed')
      session.row.fixtureOnly = true
      session.row.noPersistedLayoutMutation = true
    }, undefined, theme, { intercept })
  }
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  browser = await chromium.launch({ headless: true })
  try {
    for (const [name, execute] of [['fresh', freshCases], ['delayed-history', delayedHistory], ['delayed-send', delayedSend], ['search', searchOlder], ['refresh', refreshPagination], ['index-status', indexStatus], ['collapsed-search', collapsedSearch]]) {
      if (selected.has(name)) await execute()
    }
    report.passed = report.cases.every(row => row.passed)
    report.completeAcceptance = report.passed && report.skipped.length === 0
      && ['fresh', 'delayed-history', 'delayed-send', 'search', 'refresh', 'index-status', 'collapsed-search'].every(name => selected.has(name))
      && !process.env.STARTUP_FRESH_CASE && !process.env.STARTUP_FRESH_CASES
  } finally {
    // Only IDs created by this exact run may be removed. Never touch fixture or
    // user conversations, even when assertions fail halfway through the run.
    for (const threadId of ownedThreadIds) {
      const cleanup = { threadId, deleted: false }
      try {
        const context = await browser.newContext({ serviceWorkers: 'block', storageState: cleanupStorageStates.get(threadId) })
        await rpc(context.request, 'thread/delete', { threadId })
        cleanup.deleted = true
        await context.close()
      } catch (error) { cleanup.error = error.message }
      report.cleanup.push(cleanup)
    }
    await browser.close()
    cleanupStorageStates.clear()
    report.finishedAt = new Date().toISOString()
    if (guardedConfigPath) {
      report.configAfterSha256 = digest(guardedConfigPath)
      report.configUnchanged = report.configAfterSha256 === originalConfigDigest
      if (!report.configUnchanged) {
        try {
          // Raw TOML travels only through the child process stdin, never shell
          // arguments, logs, fixtures, screenshots or report.json.
          const comparison = JSON.parse(execFileSync('python3', ['-c', `import sys,json,tomllib,copy
d=json.load(sys.stdin)
a=tomllib.loads(d['before']);b=tomllib.loads(d['after'])
def walk(a,b,p=''):
 for k in sorted(set(a)|set(b)):
  q=p+'.'+k if p else k
  if isinstance(a.get(k,{}),dict) and isinstance(b.get(k,{}),dict): yield from walk(a.get(k,{}),b.get(k,{}),q)
  elif a.get(k)!=b.get(k): yield q
changed=list(walk(a,b))
remaining=copy.deepcopy(b)
registrations=[]
for cwd in d['createdCwds']:
 if cwd not in a.get('projects',{}) and b.get('projects',{}).get(cwd)=={'trust_level':'trusted'}:
  del remaining['projects'][cwd]
  registrations.append(cwd)
if not remaining.get('projects') and 'projects' not in a: remaining.pop('projects',None)
print(json.dumps({'changedKeys':changed,'onlyNewOwnedProjectTrust':bool(registrations) and remaining==a,'registeredCwds':registrations}))`], { input: JSON.stringify({ before: originalConfigText, after: fs.readFileSync(guardedConfigPath, 'utf8'), createdCwds: report.cases.map(row => row.accepted?.cwd).filter(Boolean) }), encoding: 'utf8' }))
          report.configChangedKeys = comparison.changedKeys
          report.configPermittedNativeRegistration = comparison.onlyNewOwnedProjectTrust
          report.configRegisteredCwds = comparison.registeredCwds
        } catch { report.configChangedKeys = ['Unable to parse configuration diff safely'] }
      }
      assert(report.configUnchanged || report.configPermittedNativeRegistration, 'Acceptance changed configuration beyond the new owned test project trust registration')
    }
    saveReport()
    assert(report.cleanup.every(row => row.deleted), 'An owned acceptance conversation could not be cleaned up; inspect report.json')
  }
})().catch(error => { report.passed = false; report.error = error.stack; saveReport(); console.error(error.stack); process.exitCode = 1 })
