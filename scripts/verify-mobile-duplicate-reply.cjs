// Browser transport replay against the authorized acceptance server only.
// MODE=before proves the old duplicate; MODE=after requires one row throughout.
// Uses real built App UI, browser-only history/notification fixtures, no model calls.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { installFixtures } = require('./verify-codex-01593-ui.cjs')
const { THREAD_A } = require('./fixtures/codex-01593-ui.cjs')

const BASE = 'http://127.0.0.1:13511'
const MODE = process.env.MODE || 'before'
assert(['before', 'after'].includes(MODE), 'MODE must be before or after')
const OUTPUT = path.resolve('output/playwright/mobile-duplicate-reply')
const REPORT = path.join(OUTPUT, `${MODE}-report.json`)
const TURN_ID = 'mobile-duplicate-turn-a'
const ITEM_ID = 'mobile-duplicate-assistant-a'
const MARKER = 'MOBILE_DUPLICATE_REPLY_20261004'
const TEXT = `${MARKER}\n\n已完成本次检查。同一条回复在完成后应只显示一次。`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { mode: MODE, baseUrl: BASE, startedAt: new Date().toISOString(), status: 'running', runtime: null, scenarios: [] }
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
  const baseFixture = await installFixtures(context, theme)
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
  const screenshot = path.join(OUTPUT, `${MODE}-${result.variant}-${stage}-${result.theme}-${result.viewport.width}.png`)
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
    console.log(`PASS ${MODE} ${variant} ${theme} ${viewport.width}x${viewport.height}: live ${expected}, refresh 1`)
  } catch (error) {
    result.status = 'failed'; result.error = error.message
    result.snapshots.push(await snapshot(page, 'failure').catch(() => ({ stage: 'failure', rows: [] })))
    result.notificationFrames = state.emitted; result.calls = state.calls; result.blockedWrites = baseFixture.blockedWrites
    const screenshot = path.join(OUTPUT, `${MODE}-${variant}-failed-${theme}-${viewport.width}.png`)
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
    assert.equal(response.status(), 200, '13511 runtime must be available without authentication error')
    const runtime = (await response.json()).data
    report.runtime = { webui: runtime.webui, runningCli: runtime.codex.version }
    if (MODE === 'before') assert(runtime.webui.commit.startsWith('51df375'), 'Before baseline must be the verified 51df375 build')
    await probe.close()
    for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }]) {
      for (const theme of ['light', 'dark']) await runScenario(browser, theme, viewport, 'missing-turn-start')
    }
    await runScenario(browser, 'dark', { width: 375, height: 812 }, 'reconnect-before-history')
    report.status = 'passed'
  } catch (error) { report.status = 'failed'; report.error = error.message; throw error }
  finally { report.finishedAt = new Date().toISOString(); save(); await browser.close() }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
module.exports = { BASE, TEXT, MARKER, thread, setup, emit, snapshot }
