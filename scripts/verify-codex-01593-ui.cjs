// Run only after deploying the worktree to the authorized 13511 acceptance server.
// CODEX_01593_STORAGE_STATE=/private/state.json node scripts/verify-codex-01593-ui.cjs
// Alternatively CODEX_01593_AUTH_HELPER exports async (context, { baseUrl }) => void.
// Credentials/storageState contents are never printed or copied into the report.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { THREAD_A, THREAD_B, DRAFT_KEY, REQUEST_IDS, createRequests, diagnostics, thread } = require('./fixtures/codex-01593-ui.cjs')

const BASE = 'http://127.0.0.1:13511'
const OUTPUT = resolve('output/playwright')
const REPORT_PATH = resolve(OUTPUT, 'codex-01593-ui-report.json')
const VIEWPORTS = [{ width: 1280, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]
const report = { baseUrl: BASE, startedAt: new Date().toISOString(), status: 'running', realRuntime: null, scenarios: [] }
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const hasFixtureId = value => typeof value === 'string' && [THREAD_A, THREAD_B].includes(value)
const bodyOf = request => { try { return request.postDataJSON() || {} } catch { return {} } }

function saveReport() { writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)) }

async function authenticatedContext(browser, options = {}) {
  const storageState = process.env.CODEX_01593_STORAGE_STATE
  const context = await browser.newContext({ serviceWorkers: 'block', ...(storageState ? { storageState: resolve(storageState) } : {}), ...options })
  if (process.env.CODEX_01593_AUTH_HELPER) {
    const helper = require(resolve(process.env.CODEX_01593_AUTH_HELPER))
    const authenticate = typeof helper === 'function' ? helper : helper.authenticate
    assert.equal(typeof authenticate, 'function', 'Auth helper must export a function or authenticate')
    await authenticate(context, { baseUrl: BASE })
  }
  context.setDefaultTimeout(15000)
  return context
}

async function sampleRealRuntime(browser) {
  const context = await authenticatedContext(browser)
  try {
    const sample = async path => {
      const start = Date.now()
      const response = await context.request.get(`${BASE}${path}`, { timeout: 15000 })
      assert.equal(response.status(), 200, `Real ${path.split('?')[0]} must be available; check acceptance authentication/deployment`)
      const payload = await response.json()
      assert(payload.data && typeof payload.data === 'object', 'Runtime endpoint must return a data object')
      return { elapsedMs: Date.now() - start, data: payload.data }
    }
    const info = await sample('/codex-api/runtime-info')
    const ordinary = await sample('/codex-api/runtime-diagnostics')
    const refreshed = await sample('/codex-api/runtime-diagnostics?refresh=1')
    for (const value of [ordinary.data, refreshed.data]) {
      assert(value.webui && value.codex && value.systemCli && value.memory && value.temporaryFeatures, 'Real diagnostics shape')
      assert(['available', 'unsupported', 'unknown'].includes(value.memory.status), 'Real memory status')
      if (value.memory.status !== 'available') {
        assert.equal(value.memory.v2Ready, null)
        assert.equal(value.memory.v2ConsolidatedThreads, null)
      }
    }
    assert.equal(ordinary.data.codex.version, info.data.codex.version, 'Diagnostics must report the same running child as runtime-info')
    const publicFields = row => ({
      webui: row.webui,
      runningCli: { version: row.codex.version, running: row.codex.running, generation: row.codex.generation },
      systemCli: { version: row.systemCli.version, status: row.systemCli.status },
      explicitRuntime: row.explicitRuntime,
      memory: row.memory, temporaryFeatures: row.temporaryFeatures,
    })
    return {
      endpoints: ['/codex-api/runtime-info', '/codex-api/runtime-diagnostics', '/codex-api/runtime-diagnostics?refresh=1'],
      latencyMs: { runtimeInfo: info.elapsedMs, diagnostics: ordinary.elapsedMs, refreshed: refreshed.elapsedMs },
      ordinary: publicFields(ordinary.data), refreshed: publicFields(refreshed.data),
      note: 'Read-only live endpoint sample; visual scenarios use isolated browser fixtures below.',
    }
  } finally { await context.close() }
}

async function installFixtures(context, theme) {
  const state = {
    pending: createRequests(), replies: [], rpcCounts: {}, blockedWrites: [], diagnosticsCalls: [],
    diagnosticsMode: 'available', responseMode: 'failure', history: [],
  }
  await context.addInitScript(({ theme, base, threadId }) => {
    if (location.origin !== base) return
    localStorage.setItem('codex-web-local.dark-mode.v1', theme)
    localStorage.setItem('codex-web-local.ui-language.v1', 'zh-CN')
    localStorage.setItem('codex-web-local.selected-thread-id.v1', threadId)
    // Preserve real notification transport, but retain references for fixture events.
    const NativeSocket = window.WebSocket
    window.__codex01593Sockets = []
    window.WebSocket = class extends NativeSocket {
      constructor(url, protocols) {
        super(url, protocols)
        if (String(url).includes('/codex-api/ws')) window.__codex01593Sockets.push(this)
      }
    }
  }, { theme, base: BASE, threadId: THREAD_A })

  await context.route(`${BASE}/codex-api/**`, async route => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const body = bodyOf(request)
    const json = (data, status = 200) => route.fulfill({ status, json: data })
    const rpcResult = result => json({ result })
    if (url.pathname === '/codex-api/runtime-diagnostics') {
      state.diagnosticsCalls.push({ refresh: url.searchParams.get('refresh') === '1', mode: state.diagnosticsMode })
      if (state.diagnosticsMode === 'timeout') {
        // Longer than the panel's six-second AbortController deadline.
        await pause(6500)
        return json({ data: diagnostics('unknown') }).catch(() => {})
      }
      return json({ data: diagnostics(state.diagnosticsMode) })
    }
    if (url.pathname === '/codex-api/server-requests/pending') return json({ data: state.pending })
    if (url.pathname === '/codex-api/server-requests/respond') {
      const pending = state.pending.find(row => row.id === body.id && row.generation === body.generation)
      assert(pending, 'Fixture response must refer to its own pending request')
      state.replies.push({ id: body.id, generation: body.generation, result: body.result, outcome: state.responseMode })
      if (state.responseMode === 'failure') return json({ error: 'CODEX_01593_EXPECTED_SUBMIT_FAILURE' }, 503)
      state.pending = state.pending.filter(row => row !== pending)
      return json({ ok: true })
    }
    if (url.pathname === '/codex-api/request-user-input-history') {
      if (method === 'POST') { state.history.push(body); return json({ data: body }) }
      return json({ data: { [THREAD_A]: state.history.filter(row => row.threadId === THREAD_A), [THREAD_B]: [] } })
    }
    if (url.pathname === '/codex-api/plan-summary-history') return json({ data: {} })
    if (url.pathname === '/codex-api/accounts' || url.pathname === '/codex-api/accounts/refresh') return json({ data: { accounts: [], activeAccountId: null, activeStorageId: null } })
    if (url.pathname === '/codex-api/thread-runtime-state') return json({ data: (body.threadIds || []).map(threadId => ({ threadId, turnId: `fixture-turn-${threadId}`, state: 'running', isRunning: true, source: 'local', startedAtIso: new Date().toISOString(), completedAtIso: null, owner: null })) })
    if (url.pathname === '/codex-api/agent-progress') return json({ data: null })
    if (url.pathname === '/codex-api/native-queue-mode') return json({ data: { mode: 'legacy', settings: null } })
    if (url.pathname === '/codex-api/thread-model-preferences' && method !== 'GET') return json({ ok: true, data: body })
    if (url.pathname === '/codex-api/rpc') {
      const rpc = body.method
      const params = body.params || {}
      state.rpcCounts[rpc] = (state.rpcCounts[rpc] || 0) + 1
      if (rpc === 'account/read') return rpcResult({ account: null, requiresOpenaiAuth: false })
      if (rpc === 'account/rateLimits/read') return rpcResult({ rateLimits: null, rateLimitsByLimitId: {} })
      if (rpc === 'thread/list') return rpcResult({ data: params.archived ? [] : [thread(THREAD_A), thread(THREAD_B)], nextCursor: null })
      if (hasFixtureId(params.threadId)) {
        const fixture = thread(params.threadId)
        if (rpc === 'thread/read' || rpc === 'thread/resume') return rpcResult({ thread: fixture, model: fixture.model, modelProvider: 'openai', reasoningEffort: 'high', initialTurnsPage: { data: fixture.turns, nextCursor: null }, approvalPolicy: 'never', sandbox: { type: 'readOnly' } })
        if (rpc === 'thread/turns/list') return rpcResult({ data: fixture.turns, nextCursor: null })
        if (rpc === 'thread/items/list') return rpcResult({ data: fixture.turns[0].items.map(item => ({ item, turnId: fixture.turns[0].id })), nextCursor: null })
        if (rpc === 'thread/goal/get') return rpcResult({ goal: null })
        if (rpc === 'thread/queue/list') return rpcResult({ data: [], nextCursor: null })
        if (rpc === 'thread/settings/read') return rpcResult({ threadSettings: { model: fixture.model, effort: 'high', serviceTier: null } })
      }
      if (!/(?:\/(?:list|read|get|search)$|^plugin\/installed$)/.test(rpc)) {
        state.blockedWrites.push(rpc)
        return json({ error: 'Browser acceptance fixture forbids real CLI/config writes' }, 409)
      }
      return route.continue()
    }
    // Do not let a fixture accidentally persist ordinary turn, auth, or config changes.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      state.blockedWrites.push(`${method} ${url.pathname}`)
      return json({ error: 'Browser acceptance fixture forbids this server mutation' }, 409)
    }
    return route.continue()
  })
  return state
}

async function waitValue(locator, expected) {
  await locator.waitFor()
  await locator.evaluate((element, value) => new Promise((done, reject) => {
    const deadline = Date.now() + 5000
    const check = () => {
      if (element.value === value) return done(true)
      if (Date.now() > deadline) return reject(new Error('Input did not restore expected draft'))
      setTimeout(check, 30)
    }
    check()
  }), expected)
}

async function assertNoHorizontalOverflow(page) {
  const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }))
  assert(size.document <= size.width + 1 && size.body <= size.width + 1, `Horizontal overflow: ${JSON.stringify(size)}`)
  return size
}

async function capture(page, scenario, surface, locator) {
  await locator.scrollIntoViewIfNeeded()
  await locator.waitFor({ state: 'visible' })
  await page.waitForTimeout(2300)
  const geometry = await assertNoHorizontalOverflow(page)
  const path = resolve(OUTPUT, `codex-01593-ui-${surface}-${scenario.theme}-${scenario.viewport.width}.png`)
  await page.screenshot({ path })
  const surfacePath = path.replace('.png', '-surface.png')
  await locator.screenshot({ path: surfacePath })
  const colors = await locator.evaluate(element => {
    const own = getComputedStyle(element)
    let surface = element
    while (surface.parentElement && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(surface).backgroundColor)) surface = surface.parentElement
    return { background: getComputedStyle(surface).backgroundColor, color: own.color, dark: document.documentElement.classList.contains('dark') }
  })
  assert.equal(colors.dark, scenario.theme === 'dark', 'Theme wiring must match screenshot')
  const rgb = colors.background.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (scenario.theme === 'dark' && rgb) assert(Math.max(...rgb) < 160, `Light surface on dark theme: ${colors.background}`)
  scenario.screenshots.push({ surface, path, surfacePath, url: page.url(), viewport: scenario.viewport, geometry, colors })
}

async function openSettings(page) {
  const button = page.locator('.sidebar-settings-button')
  if (!await button.isVisible()) {
    const toggle = page.getByRole('button', { name: /Expand sidebar|展开侧边栏/ }).first()
    await toggle.click()
  }
  await button.click()
  await page.getByTestId('runtime-info-panel').waitFor()
}

async function verifyScenario(browser, theme, viewport) {
  const context = await authenticatedContext(browser, { viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 })
  const state = await installFixtures(context, theme)
  const page = await context.newPage()
  const scenario = { theme, viewport, status: 'running', screenshots: [], assertions: [], pageErrors: [] }
  report.scenarios.push(scenario)
  page.on('pageerror', error => scenario.pageErrors.push(error.message))
  const inbox = page.locator('.thread-pending-request-inbox')
  const input = () => inbox.locator('input[data-question-id="answer"]')
  const select = async id => {
    const button = inbox.locator(`.pending-input-inbox-item[data-request-id="${id}"]`)
    await button.click()
    assert.equal(await button.getAttribute('aria-pressed'), 'true')
  }
  const gotoThread = async (id, reload = false) => {
    if (reload) await page.reload({ waitUntil: 'domcontentloaded' })
    else await page.goto(`${BASE}/#/thread/${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(url => url.hash === `#/thread/${id}`)
    const title = id === THREAD_A ? '多问题草稿验收' : '跨会话草稿验收'
    await page.locator('.conversation-item').filter({ hasText: `CODEX_01593_UI_READY ${title}` }).last().waitFor({ timeout: 45000 })
    await inbox.waitFor()
  }
  const storage = () => page.evaluate(key => localStorage.getItem(key) || '', DRAFT_KEY)
  try {
    await gotoThread(THREAD_A)
    assert.equal(await inbox.locator('.pending-input-inbox-item').count(), 3)
    assert.equal(await inbox.locator('.pending-input-inbox-item').first().getAttribute('data-request-id'), String(REQUEST_IDS.blocking), 'Blocking question must be prioritized')
    assert.equal(await inbox.locator('.pending-input-inbox-state').getAttribute('class').then(value => value.includes('is-blocking')), true)
    await input().fill('BLOCKING_DRAFT_01593')
    await select(REQUEST_IDS.optional)
    await input().fill('OPTIONAL_DRAFT_01593')
    assert.equal(await inbox.locator('.pending-input-inbox-state').getAttribute('class').then(value => value.includes('is-blocking')), false)
    await select(REQUEST_IDS.blocking)
    await waitValue(input(), 'BLOCKING_DRAFT_01593')
    await select(REQUEST_IDS.optional)
    await waitValue(input(), 'OPTIONAL_DRAFT_01593')
    await pause(350)
    assert((await storage()).includes('OPTIONAL_DRAFT_01593'))
    assert.equal(state.replies.length, 0, 'Draft/switch interactions must never send an answer')
    scenario.assertions.push('blocking-first and explicit selection', 'optional task-continues state', 'per-question draft restoration', 'no automatic submission')
    await capture(page, scenario, 'questions', inbox)

    await gotoThread(THREAD_B)
    await waitValue(input(), '')
    await input().fill('THREAD_B_DRAFT_01593')
    await gotoThread(THREAD_A)
    await select(REQUEST_IDS.optional)
    await waitValue(input(), 'OPTIONAL_DRAFT_01593')
    await gotoThread(THREAD_A, true)
    await select(REQUEST_IDS.optional)
    await waitValue(input(), 'OPTIONAL_DRAFT_01593')
    await gotoThread(THREAD_B)
    await waitValue(input(), 'THREAD_B_DRAFT_01593')
    await gotoThread(THREAD_A)
    await select(REQUEST_IDS.optional)
    await waitValue(input(), 'OPTIONAL_DRAFT_01593')
    scenario.assertions.push('thread-isolated drafts', 'drafts restored after real page reload')
    await capture(page, scenario, 'questions-after-refresh', inbox)

    await select(REQUEST_IDS.secret)
    assert.equal(await input().getAttribute('type'), 'password')
    await input().fill('FIXTURE_SECRET_MUST_NEVER_PERSIST_01593')
    await pause(350)
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('FIXTURE_SECRET_MUST_NEVER_PERSIST_01593'))), false, 'Secret answer must not enter localStorage')
    await gotoThread(THREAD_A, true)
    await select(REQUEST_IDS.secret)
    await waitValue(input(), '')
    scenario.assertions.push('secret field uses password input and is absent from localStorage/reload')

    await select(REQUEST_IDS.optional)
    await waitValue(input(), 'OPTIONAL_DRAFT_01593')
    await inbox.locator('.thread-pending-request-primary').click()
    await page.getByText('CODEX_01593_EXPECTED_SUBMIT_FAILURE', { exact: false }).first().waitFor()
    await waitValue(input(), 'OPTIONAL_DRAFT_01593')
    assert((await storage()).includes('OPTIONAL_DRAFT_01593'), 'Failed submission must retain its draft')
    assert.equal(state.replies.length, 1)
    state.responseMode = 'success'
    await inbox.locator('.thread-pending-request-primary').click()
    await inbox.locator(`[data-request-id="${REQUEST_IDS.optional}"]`).waitFor({ state: 'hidden' })
    await pause(350)
    const afterSuccess = await storage()
    assert(!afterSuccess.includes('OPTIONAL_DRAFT_01593'), 'Successful submission must remove only its own draft')
    assert(afterSuccess.includes('BLOCKING_DRAFT_01593') && afterSuccess.includes('THREAD_B_DRAFT_01593'))
    assert.equal(state.replies.length, 2)
    assert.equal(state.replies[1].id, REQUEST_IDS.optional)
    scenario.assertions.push('failed submit retains draft', 'successful explicit submit clears only the submitted question')

    assert.equal(state.diagnosticsCalls.length, 0, 'Ordinary thread flow must not fetch extra runtime diagnostics')
    await openSettings(page)
    const panel = page.getByTestId('runtime-info-panel')
    assert.equal(await panel.getAttribute('open'), null)
    await pause(500)
    assert.equal(state.diagnosticsCalls.length, 0, 'Opening settings with diagnostics collapsed must not fetch diagnostics')
    await panel.locator('summary').click()
    await panel.getByTestId('runtime-diagnostics').waitFor()
    assert.equal(state.diagnosticsCalls.length, 1)
    assert.equal(await panel.getByTestId('system-cli-version').locator('strong').innerText(), '0.159.3')
    assert.equal(await panel.getByTestId('running-cli-version').locator('strong').innerText(), '0.154.0')
    const memory = panel.getByTestId('memory-capability')
    assert.equal(await memory.locator('[data-status]').getAttribute('data-status'), 'available')
    assert.match(await memory.innerText(), /7/)
    scenario.assertions.push('collapsed diagnostics makes zero requests', 'system CLI and running app-server versions are distinct', 'confirmed memory state and count')
    await capture(page, scenario, 'runtime', panel)

    const refresh = panel.getByRole('button').last()
    const beforeRefresh = state.diagnosticsCalls.length
    await refresh.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-info-panel"] button')?.disabled === false)
    assert.equal(state.diagnosticsCalls.length, beforeRefresh + 1, 'Refresh must perform one diagnostics request')
    assert.equal(state.diagnosticsCalls.at(-1).refresh, true)
    await panel.locator('summary').click()
    const whenClosed = state.diagnosticsCalls.length
    await pause(600)
    assert.equal(state.diagnosticsCalls.length, whenClosed, 'Closing diagnostics must not fetch again')
    await panel.locator('summary').click()
    await panel.getByTestId('runtime-diagnostics').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="runtime-info-panel"] button')?.disabled === false)

    state.diagnosticsMode = 'unsupported'
    const beforeUnsupported = state.diagnosticsCalls.length
    await refresh.click()
    await memory.locator('[data-status="unsupported"]').waitFor()
    assert.equal(state.diagnosticsCalls.length, beforeUnsupported + 1)
    assert.doesNotMatch(await memory.innerText(), /(?:Consolidated threads|已整合会话|整合线程).*:\s*0/i, 'Unsupported memory must not look like confirmed zero usage')
    await capture(page, scenario, 'runtime-unsupported', panel)
    state.diagnosticsMode = 'unknown'
    await refresh.click()
    await memory.locator('[data-status="unknown"]').waitFor()
    scenario.assertions.push('one request per refresh', 'unsupported and unknown capability states')

    if (theme === 'light' && viewport.width === 1280) {
      state.diagnosticsMode = 'timeout'
      const beforeTimeout = state.diagnosticsCalls.length
      await refresh.click()
      assert.equal(await refresh.isDisabled(), true, 'Loading prevents duplicate refreshes')
      await panel.locator('.runtime-diagnostics-error').waitFor({ timeout: 10000 })
      assert.equal(state.diagnosticsCalls.length, beforeTimeout + 1)
      assert.equal(await refresh.isDisabled(), false, 'Timeout releases the refresh button')
      await capture(page, scenario, 'runtime-timeout', panel)
      state.diagnosticsMode = 'available'
      await refresh.click()
      await memory.locator('[data-status="available"]').waitFor()
      assert.equal(state.diagnosticsCalls.length, beforeTimeout + 2, 'Retry after timeout must make exactly one request')
      scenario.assertions.push('six-second request timeout preserves retry and prevents duplicate requests')
    }
    assert.deepEqual(state.blockedWrites, [], 'No accidental real CLI/config/auth write attempted')
    assert.deepEqual(scenario.pageErrors, [])
    scenario.status = 'passed'
    scenario.replyCount = state.replies.length
    scenario.diagnosticsCalls = state.diagnosticsCalls
    scenario.rpcCounts = state.rpcCounts
    scenario.blockedWrites = state.blockedWrites
    saveReport()
    console.log(`PASS ${theme} ${viewport.width}x${viewport.height}`)
  } catch (error) {
    scenario.status = 'failed'
    scenario.error = error.message
    scenario.rpcCounts = state.rpcCounts
    scenario.blockedWrites = state.blockedWrites
    scenario.diagnosticsCalls = state.diagnosticsCalls
    const path = resolve(OUTPUT, `codex-01593-ui-failed-${theme}-${viewport.width}.png`)
    await page.screenshot({ path }).catch(() => {})
    scenario.failureScreenshot = path
    saveReport()
    throw error
  } finally {
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
  }
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true })
  // This script intentionally has no configurable host/port to protect production.
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    report.realRuntime = await sampleRealRuntime(browser)
    saveReport()
    for (const viewport of VIEWPORTS) for (const theme of ['light', 'dark']) await verifyScenario(browser, theme, viewport)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    throw error
  } finally {
    report.finishedAt = new Date().toISOString()
    saveReport()
    await browser.close()
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { BASE, sampleRealRuntime, installFixtures, verifyScenario }
