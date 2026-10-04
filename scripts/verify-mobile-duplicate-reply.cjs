// Browser transport replay against loopback acceptance or explicitly authorized production.
// MODE=before proves the old duplicate; MODE=after requires one row throughout.
// Uses real built App UI, browser-only history/notification fixtures, no model calls.
// Production: PROFILE_BASE_URL=http://127.0.0.1:13510 MOBILE_DUP_ALLOW_PRODUCTION=1 MODE=after
// Run --self-test without a browser; --smoke is limited to the acceptance server.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { installFixtures } = require('./verify-codex-01593-ui.cjs')
const { THREAD_A } = require('./fixtures/codex-01593-ui.cjs')

function verificationTarget(environment = process.env, smoke = false) {
  const target = new URL(environment.PROFILE_BASE_URL || 'http://127.0.0.1:13511')
  assert(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Only explicit HTTP loopback targets are allowed')
  assert(!target.username && !target.password && target.pathname === '/' && !target.search && !target.hash, 'Target must be a plain loopback origin without credentials, path, query, or hash')
  assert(['13511', '13510'].includes(target.port), 'Only ports 13511 and explicitly authorized 13510 are allowed')
  const production = target.port === '13510'
  assert(!production || environment.MOBILE_DUP_ALLOW_PRODUCTION === '1', 'Port 13510 requires MOBILE_DUP_ALLOW_PRODUCTION=1')
  const mode = environment.MODE || (production ? 'after' : 'before')
  assert(['before', 'after'].includes(mode), 'MODE must be before or after')
  assert(!production || mode === 'after', 'Production verification only supports MODE=after')
  assert(!production || !smoke, 'Production verification must run the full five scenarios')
  return { baseUrl: target.origin, mode, production, smoke, label: production ? 'production' : smoke ? `${mode}-smoke` : mode }
}

const TARGET = verificationTarget(process.env, process.argv.includes('--smoke'))
const BASE = TARGET.baseUrl
const MODE = TARGET.mode
const LABEL = TARGET.label
const OUTPUT = path.resolve('output/playwright/mobile-duplicate-reply', TARGET.production ? 'production' : TARGET.smoke ? 'smoke' : '.')
const REPORT = path.join(OUTPUT, `${LABEL}-report.json`)
const TURN_ID = 'mobile-duplicate-turn-a'
const ITEM_ID = 'mobile-duplicate-assistant-a'
const MARKER = 'MOBILE_DUPLICATE_REPLY_20261004'
const TEXT = `${MARKER}\n\n已完成本次检查。同一条回复在完成后应只显示一次。`
const report = { mode: MODE, label: LABEL, production: TARGET.production, baseUrl: BASE, startedAt: new Date().toISOString(), status: 'running', runtime: null, frontend: null, scenarios: [] }
const save = () => fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))

function thread(persisted) {
  const initial = { id: 'mobile-duplicate-initial', status: 'completed', error: null, items: [
    { id: 'mobile-duplicate-user', type: 'userMessage', content: [{ type: 'text', text: '手机重复回复复现：请等待正在恢复的助手回复。', text_elements: [] }] },
  ] }
  const final = { id: TURN_ID, status: 'completed', error: null, items: [
    { id: ITEM_ID, type: 'agentMessage', phase: 'final_answer', text: TEXT },
  ] }
  return {
    id: THREAD_A, name: '手机重复回复复现', preview: '手机重复回复复现',
    cwd: '/tmp/codex-mobile-duplicate-fixture', path: null, model: 'gpt-6-astra', modelProvider: 'openai',
    createdAt: 1791093600, updatedAt: 1791093600, cliVersion: '0.159.3', source: 'appServer', gitInfo: null,
    historyMode: 'paginated', status: { type: 'idle' }, turns: persisted ? [initial, final] : [initial],
  }
}

async function setup(context, theme) {
  const baseFixture = await installFixtures(context, theme, BASE)
  baseFixture.pending = []
  const state = { persisted: false, calls: [], emitted: [], heldHistory: 0, holdHistory: null, releaseHistory: null }
  state.beginHistoryHold = () => {
    state.holdHistory = new Promise(resolve => { state.releaseHistory = resolve })
  }
  state.endHistoryHold = () => { state.releaseHistory?.(); state.holdHistory = null; state.releaseHistory = null }
  await context.route(`${BASE}/codex-api/thread-runtime-state`, route => route.fulfill({ json: { data: [{
    threadId: THREAD_A, turnId: '', state: 'idle', isRunning: false, source: 'none', startedAtIso: null, completedAtIso: null, owner: null,
  }] } }))
  await context.route(`${BASE}/codex-api/rpc`, async route => {
    const body = route.request().postDataJSON(), method = body.method, params = body.params || {}
    state.calls.push({ method, threadId: params.threadId || null, at: Date.now() })
    const result = value => route.fulfill({ json: { result: value } })
    if (method === 'thread/list') return result({ data: params.archived ? [] : [thread(state.persisted)], nextCursor: null })
    if (params.threadId === THREAD_A && ['thread/read', 'thread/resume', 'thread/turns/list', 'thread/items/list'].includes(method)) {
      if (state.holdHistory) { state.heldHistory += 1; await state.holdHistory }
      const value = thread(state.persisted)
      if (method === 'thread/read' || method === 'thread/resume') return result({ thread: value, model: value.model, modelProvider: 'openai', reasoningEffort: 'high', initialTurnsPage: { data: [...value.turns].reverse(), nextCursor: null }, approvalPolicy: 'never', sandbox: { type: 'readOnly' } })
      if (method === 'thread/turns/list') return result({ data: [...value.turns].reverse(), nextCursor: null })
      return result({ data: value.turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))), nextCursor: null })
    }
    return route.fallback()
  })
  return { state, baseFixture }
}

async function emit(page, state, method, params) {
  const frame = { method, params, atIso: new Date().toISOString(), generation: 1 }
  state.emitted.push(frame)
  await page.evaluate(frame => {
    const socket = window.__codex01593Sockets?.findLast(value => value.readyState === WebSocket.OPEN)
    if (!socket) throw new Error('No open App notification socket')
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }, frame)
}

async function snapshot(page, stage) {
  return { stage, at: Date.now(), rows: await page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: MARKER }).evaluateAll(nodes => nodes.map(node => ({ text: node.innerText.trim(), messageType: node.dataset.messageType, visible: node.getClientRects().length > 0 }))) }
}

async function capture(page, result, stage) {
  const rows = page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: MARKER })
  if (await rows.count()) await rows.last().scrollIntoViewIfNeeded()
  await page.waitForTimeout(2300)
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow')
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), result.theme === 'dark')
  const screenshot = path.join(OUTPUT, `${LABEL}-${result.variant}-${stage}-${result.theme}-${result.viewport.width}.png`)
  await page.screenshot({ path: screenshot })
  result.screenshots.push({ stage, url: page.url(), viewport: result.viewport, screenshot })
}

async function runScenario(browser, theme, viewport, variant) {
  const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: true, serviceWorkers: 'block' })
  const { state, baseFixture } = await setup(context, theme)
  const page = await context.newPage()
  const result = { theme, viewport, variant, status: 'running', snapshots: [], screenshots: [], pageErrors: [] }
  report.scenarios.push(result)
  page.on('pageerror', error => result.pageErrors.push(error.message))
  try {
    await page.goto(`${BASE}/#/thread/${THREAD_A}`, { waitUntil: 'domcontentloaded' })
    await page.locator('.conversation-item[data-role="user"]').filter({ hasText: '手机重复回复复现' }).waitFor()
    await page.waitForFunction(() => window.__codex01593Sockets?.some(socket => socket.readyState === WebSocket.OPEN))
    await page.waitForTimeout(600)
    assert.equal((await snapshot(page, 'initial')).rows.length, 0)

    // Missing turn/started is intentional: phone resumes mid-stream before hydration.
    if (variant === 'reconnect-before-history') {
      state.beginHistoryHold()
      await emit(page, state, 'ready', { ok: true, streamId: `mobile-fixture-reconnect-${Date.now()}`, replayAvailable: false })
      await page.waitForTimeout(100)
    }
    await emit(page, state, 'item/agentMessage/delta', { threadId: THREAD_A, turnId: TURN_ID, itemId: ITEM_ID, delta: TEXT })
    await page.waitForTimeout(260)
    result.snapshots.push(await snapshot(page, 'delta-flushed'))
    assert.equal(result.snapshots.at(-1).rows.length, 1, 'Initial streamed reply should produce one row')
    await emit(page, state, 'item/completed', { threadId: THREAD_A, turnId: TURN_ID, item: { id: ITEM_ID, type: 'agentMessage', text: TEXT, phase: 'final_answer' } })
    await page.waitForTimeout(260)
    result.snapshots.push(await snapshot(page, 'item-completed'))
    const expected = MODE === 'before' ? 2 : 1
    assert.equal(result.snapshots.at(-1).rows.length, expected, `${MODE}: same assistant item after streamed completion`)
    await capture(page, result, 'completed-live')
    result.snapshots.push(await snapshot(page, 'live-stable-after-screenshot'))
    assert.equal(result.snapshots.at(-1).rows.length, expected, 'Reply count must remain stable while history has not hydrated')
    if (variant === 'reconnect-before-history') assert(state.heldHistory > 0, 'Reconnect must actually start a held history hydration request')

    state.persisted = true
    state.endHistoryHold()
    // A refresh discards transient live rows and rehydrates one canonical item.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: MARKER }).first().waitFor()
    await capture(page, result, 'after-refresh')
    result.snapshots.push(await snapshot(page, 'after-refresh'))
    assert.equal(result.snapshots.at(-1).rows.length, 1, 'Canonical history after refresh must contain one assistant reply')
    assert.deepEqual(baseFixture.blockedWrites, [], 'No attempt to mutate the real CLI or config')
    assert.deepEqual(result.pageErrors, [])
    result.status = 'passed'
    result.notificationFrames = state.emitted
    result.rpcCounts = state.calls.reduce((acc, row) => ({ ...acc, [row.method]: (acc[row.method] || 0) + 1 }), {})
    result.heldHistoryRequests = state.heldHistory
    result.blockedWrites = baseFixture.blockedWrites
    save()
    console.log(`PASS ${LABEL} ${variant} ${theme} ${viewport.width}x${viewport.height}: live ${expected}, refresh 1`)
  } catch (error) {
    result.status = 'failed'; result.error = error.message
    result.snapshots.push(await snapshot(page, 'failure').catch(() => ({ stage: 'failure', rows: [] })))
    result.notificationFrames = state.emitted; result.calls = state.calls; result.blockedWrites = baseFixture.blockedWrites
    const screenshot = path.join(OUTPUT, `${LABEL}-${variant}-failed-${theme}-${viewport.width}.png`)
    await page.screenshot({ path: screenshot }).catch(() => {})
    result.failureScreenshot = screenshot
    save(); throw error
  } finally {
    state.endHistoryHold()
    await context.unrouteAll({ behavior: 'ignoreErrors' })
    await context.close()
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const probe = await browser.newContext()
    const response = await probe.request.get(`${BASE}/codex-api/runtime-info`)
    assert.equal(response.status(), 200, 'Selected loopback runtime must be available without authentication error')
    const runtime = (await response.json()).data
    report.runtime = { webui: runtime.webui, runningCli: runtime.codex.version }
    // A static frontend release does not replace the backend process or runtime-info.
    // Capture the bytes actually served, independently of the backend build marker.
    const indexResponse = await probe.request.get(`${BASE}/`)
    assert.equal(indexResponse.status(), 200)
    const html = await indexResponse.text()
    const assets = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map(match => match[1]).filter(value => value.startsWith('/assets/') && value.endsWith('.js'))
    assert(assets.length > 0, 'App index must reference a built frontend asset')
    const frontendAssets = []
    for (const asset of assets) {
      const assetResponse = await probe.request.get(`${BASE}${asset}`)
      assert.equal(assetResponse.status(), 200)
      const body = await assetResponse.body()
      frontendAssets.push({ path: asset, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') })
    }
    report.frontend = { indexSha256: createHash('sha256').update(html).digest('hex'), assets: frontendAssets, note: 'Hashes describe the served frontend; runtime.webui describes the independently running backend.' }
    if (MODE === 'before') assert(runtime.webui.commit.startsWith('51df375'), 'Before baseline must be the verified 51df375 build')
    await probe.close()
    for (const viewport of TARGET.smoke ? [{ width: 375, height: 812 }] : [{ width: 375, height: 812 }, { width: 768, height: 1024 }]) {
      for (const theme of TARGET.smoke ? ['dark'] : ['light', 'dark']) await runScenario(browser, theme, viewport, 'missing-turn-start')
    }
    if (!TARGET.smoke) await runScenario(browser, 'dark', { width: 375, height: 812 }, 'reconnect-before-history')
    report.status = 'passed'
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error }
  finally { report.finishedAt = new Date().toISOString(); save(); await browser.close() }
}

async function selfTest() {
  const defaults = verificationTarget({})
  assert.equal(defaults.baseUrl, 'http://127.0.0.1:13511')
  assert.equal(defaults.mode, 'before')
  const production = verificationTarget({ PROFILE_BASE_URL: 'http://127.0.0.1:13510', MOBILE_DUP_ALLOW_PRODUCTION: '1' })
  assert.equal(production.mode, 'after'); assert.equal(production.label, 'production')
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) assert.equal(verificationTarget({ PROFILE_BASE_URL: `http://${host}:13511/`, MODE: 'after' }).mode, 'after')
  for (const environment of [
    { PROFILE_BASE_URL: 'http://127.0.0.1:13510' },
    { PROFILE_BASE_URL: 'http://127.0.0.1:13510', MOBILE_DUP_ALLOW_PRODUCTION: 'true' },
    { PROFILE_BASE_URL: 'http://127.0.0.1:13510', MOBILE_DUP_ALLOW_PRODUCTION: '1', MODE: 'before' },
    { PROFILE_BASE_URL: 'http://127.0.0.1:5173' },
    { PROFILE_BASE_URL: 'http://127.0.0.1:4173' },
    { PROFILE_BASE_URL: 'http://example.com:13511' },
    { PROFILE_BASE_URL: 'https://127.0.0.1:13511' },
    { PROFILE_BASE_URL: 'http://127.0.0.1:13511/path' },
    { PROFILE_BASE_URL: 'http://127.0.0.1:13511/?query=1' },
    { PROFILE_BASE_URL: 'http://127.0.0.1:13511/#thread' },
    { PROFILE_BASE_URL: 'http://user:password@127.0.0.1:13511' },
  ]) assert.throws(() => verificationTarget(environment))
  assert.throws(() => verificationTarget({ PROFILE_BASE_URL: production.baseUrl, MOBILE_DUP_ALLOW_PRODUCTION: '1' }, true))
  const routes = [], initScripts = []
  const fakeContext = { addInitScript: async (fn, args) => initScripts.push({ fn, args }), route: async (pattern, handler) => routes.push({ pattern, handler }) }
  await installFixtures(fakeContext, 'dark', production.baseUrl)
  assert.equal(initScripts[0].args.base, production.baseUrl, 'Initialization and WebSocket filtering must target production origin')
  assert.equal(routes[0].pattern, `${production.baseUrl}/codex-api/**`, 'HTTP fixture must target production, not acceptance')
  for (const [pathname, method, body] of [
    ['/codex-api/rpc', 'POST', { method: 'turn/start', params: {} }],
    ['/codex-api/rpc', 'POST', { method: 'config/value/write', params: {} }],
    ['/codex-api/rpc', 'POST', { method: 'thread/start', params: {} }],
    ['/codex-api/unexpected-mutation', 'POST', {}],
  ]) {
    let fulfilled = null, network = false
    await routes[0].handler({ request: () => ({ url: () => production.baseUrl + pathname, method: () => method, postDataJSON: () => body }), fulfill: async result => { fulfilled = result }, continue: async () => { network = true } })
    assert.equal(network, false, 'Forbidden production mutations must never reach the network')
    assert.equal(fulfilled.status, 409)
  }
  console.log('PASS target gates and production fixture mutation isolation; no browser or network used')
}

if (require.main === module) (process.argv.includes('--self-test') ? selfTest() : main()).catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { BASE, TEXT, MARKER, thread, setup, emit, snapshot, verificationTarget, selfTest }
