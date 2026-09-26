/*
 * Read-only plan-card acceptance on the current isolated 13511 build.
 * PLAN_RUN_LABEL=current PLAN_VIEWPORTS=375,768,1440 PLAN_THEMES=light,dark
 * PLAN_CASES=live,identity,restoration selects a bounded subset.
 * Routes and notification injection need Playwright rather than Browser Use.
 * All conversations/plans are browser fixtures; no real messages or writes.
 */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const base = (process.env.PROFILE_BASE_URL || 'http://127.0.0.1:13511').replace(/\/$/, '')
assert.equal(new URL(base).port, '13511', 'Plan acceptance must never target production')
assert(['127.0.0.1', '127.0.0.2', 'localhost'].includes(new URL(base).hostname), 'Use local isolated acceptance')
const out = path.resolve('output/playwright/plan-progress', process.env.PLAN_RUN_LABEL || 'current')
const widths = (process.env.PLAN_VIEWPORTS || '375,768,1440').split(',').map(Number)
const themes = (process.env.PLAN_THEMES || 'light,dark').split(',')
const cases = new Set((process.env.PLAN_CASES || 'live,identity,restoration').split(','))
const ROOT = '01a0aaaa-0000-7000-8000-000000000001'
const CHILD = '01a0aaaa-0000-7000-8000-000000000002'
const OTHER = '01a0aaaa-0000-7000-8000-000000000003'
const TURN = 'turn-plan-progress'
const CWD = '/root/codex工作目录/Linux-Codex-Webui'
const stamp = Date.now()
const iso = n => new Date(stamp + n * 1000).toISOString()
const terminal = state => ['completed', 'incomplete', 'failed', 'interrupted'].includes(state)
const identity = s => JSON.stringify([s.threadId, s.turnId, s.kind, s.kind === 'proposal' ? s.itemId : ''])
const report = { base, startedAt: new Date().toISOString(), fixtureOnly: true, cases: [] }
let browser
function save() { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)) }
function checklist(overrides = {}) {
  return { kind: 'checklist', threadId: ROOT, turnId: TURN, messageId: `${TURN}:plan`,
    text: '- [x] 检查协议\n- [~] 验证计划显示\n- [ ] 完成验收', explanation: '验收夹具：让进度保持可核对。',
    steps: [{ step: '检查协议', status: 'completed' }, { step: '验证计划显示', status: 'inProgress' }, { step: '完成验收', status: 'pending' }],
    revision: 1, generation: 17, createdAtIso: iso(0), updatedAtIso: iso(1), lifecycle: 'live', ...overrides }
}
function proposal(itemId = 'proposal-a', overrides = {}) {
  return { kind: 'proposal', itemId, threadId: ROOT, turnId: TURN, messageId: itemId,
    text: `# 方案文稿 ${itemId}\n\nPROPOSAL_BODY_${itemId}\n\n- [ ] 文稿中的复选框不代表执行清单`, steps: [],
    revision: 1, generation: 17, createdAtIso: iso(0), updatedAtIso: iso(1), lifecycle: 'completed', ...overrides }
}
function toSummary(snapshot) { return { ...snapshot, id: snapshot.kind === 'checklist' ? `plan-summary:${snapshot.turnId}` : `plan-summary:${snapshot.turnId}:proposal:${snapshot.itemId}` } }
function fixture() {
  const state = { snapshots: new Map(), running: true, nativeProposals: [], historyTurns: [TURN], persistenceWarning: false }
  state.put = value => state.snapshots.set(identity(value), structuredClone(value))
  state.ready = () => ({ method: 'ready', params: { ok: true, replayAvailable: true, planSnapshotsVersion: 1, planPersistenceWarning: state.persistenceWarning, activePlans: [...state.snapshots.values()] } })
  state.progress = () => ({ rootThreadId: ROOT, turnId: TURN, status: state.running ? 'running' : 'completed', phase: state.running ? 'executing' : 'completed', startedAtMs: stamp,
    lastActivityAtMs: stamp, mainLastActivityAtMs: stamp, updatedAtMs: stamp, agents: [], events: [] })
  state.thread = (threadId, includeTurns = false) => ({ id: threadId, name: threadId === CHILD ? '计划子任务' : threadId === OTHER ? '其他主聊天' : '计划进度验收',
    preview: '计划卡浏览器验收夹具', cwd: CWD, createdAt: stamp / 1000 - 50, updatedAt: stamp / 1000,
    modelProvider: 'myproxy', source: threadId === CHILD ? { subAgent: { thread_spawn: { parent_thread_id: ROOT, depth: 1 } } } : 'cli',
    status: { type: threadId === ROOT && state.running ? 'active' : 'idle' }, historyMode: 'legacy', path: null, cliVersion: '0.154.0', gitInfo: null,
    turns: includeTurns ? state.historyTurns.map((turnId, index) => ({ id: turnId, status: turnId === TURN && state.running ? 'inProgress' : 'completed',
      items: [{ id: `${turnId}:user`, type: 'userMessage', content: [{ type: 'text', text: `PLAN_FIXTURE_USER_${threadId}_${turnId}` }] },
        ...state.nativeProposals.filter(p => p.turnId === turnId && p.threadId === threadId).map(p => ({ id: p.itemId, type: 'plan', text: p.text })),
        { id: `${turnId}:answer`, type: 'agentMessage', text: `PLAN_FIXTURE_ANSWER_${index}` }] })) : [] })
  return state
}

async function createSession(name, width, theme, data, reducedMotion = false) {
  const viewport = { width, height: width === 375 ? 812 : width === 768 ? 1024 : 900 }
  const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: reducedMotion ? 'reduce' : 'no-preference', serviceWorkers: 'block', isMobile: width === 375, hasTouch: width < 1000 })
  assert.deepEqual(await context.storageState(), { cookies: [], origins: [] }, 'Initial browser storage must be empty')
  await context.exposeBinding('__planFixtureReady', () => data.ready())
  await context.addInitScript(() => {
    const NativeSocket = window.WebSocket
    window.__planFixtureSockets = []
    class FixtureSocket extends EventTarget {
      constructor(url, protocols) {
        super()
        if (!String(url).includes('/codex-api/ws')) return new NativeSocket(url, protocols)
        this.url = String(url); this.readyState = 0
        window.__planFixtureSockets.push(this)
        setTimeout(async () => {
          this.readyState = 1
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(await window.__planFixtureReady()) }))
          this.fixtureReadyDelivered = true
        }, 10)
      }
      dispatchEvent(event) { const value = super.dispatchEvent(event); this[`on${event.type}`]?.(event); return value }
      close() { this.readyState = 3 }
      send() { throw new Error('Read-only fixture attempted a WebSocket write') }
    }
    Object.assign(FixtureSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
    window.WebSocket = FixtureSocket
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const row = { name, viewport, theme, reducedMotion, freshStorage: true, cacheDisabled: true, serviceWorkersBlocked: true, requests: [], errors: [], apiErrors: [], blockedWrites: [], screenshots: [], metrics: {}, assertions: [] }
  report.cases.push(row)
  let started = Date.now(), load = 0, closing = false
  const pending = [], requestRows = new WeakMap()
  page.on('pageerror', error => row.errors.push(error.message))
  page.on('response', response => {
    const request = response.request(), requestRow = requestRows.get(request)
    if (requestRow) requestRow.status = response.status()
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/codex-api/')) row.apiErrors.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  page.on('requestfinished', request => {
    const r = requestRows.get(request)
    if (r) pending.push(request.sizes().then(sizes => { r.responseBytes = sizes.responseBodySize; r.durationMs = Math.round(request.timing().responseEnd) }).catch(() => {}))
  })
  page.on('requestfailed', request => {
    if (!closing && !/ERR_ABORTED/.test(request.failure()?.errorText || '')) row.errors.push(`Request failed: ${new URL(request.url()).pathname}`)
  })
  await context.route('**/codex-api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    let body = {}; try { body = request.postDataJSON() || {} } catch {}
    const method = url.pathname === '/codex-api/rpc' ? body.method || '' : ''
    const threadId = body.params?.threadId || body.threadId || url.searchParams.get('threadId') || ''
    const known = [ROOT, CHILD, OTHER].includes(threadId)
    const requestRow = { path: url.pathname, method: method || request.method(), threadId, load, atMs: Date.now() - started,
      summary: method === 'thread/read' && body.params?.includeTurns === false }
    row.requests.push(requestRow); requestRows.set(request, requestRow)
    const json = value => route.fulfill({ status: 200, json: value })
    if (method === 'thread/list') return json({ result: { data: body.params?.ancestorThreadId ? [] : [data.thread(ROOT), data.thread(OTHER)], nextCursor: null } })
    if (known && method === 'thread/read') return json({ result: { thread: data.thread(threadId, body.params?.includeTurns === true), model: 'gpt-5.6-luna', modelProvider: 'myproxy' } })
    if (known && method === 'thread/goal/get') return json({ result: { goal: null } })
    if (known && method === 'thread/queue/list') return json({ result: { data: [], nextCursor: null } })
    if (url.pathname === '/codex-api/thread-runtime-state' && (body.threadIds || []).every(id => [ROOT, CHILD, OTHER].includes(id))) return json({ data: [] })
    if (known && url.pathname === '/codex-api/agent-progress') return json({ data: threadId === ROOT ? data.progress() : null })
    if (known && url.pathname === '/codex-api/plan-summary-history' && request.method() === 'GET') return json({ data: { [threadId]: [...data.snapshots.values()].filter(s => s.threadId === threadId && terminal(s.lifecycle)).map(toSummary) } })
    if (known && url.pathname === '/codex-api/request-user-input-history' && request.method() === 'GET') return json({ data: {} })
    if (url.pathname === '/codex-api/workspace-roots-state' && request.method() === 'GET') return json({ data: { order: [CWD], projectOrder: [CWD], labels: {}, remoteProjects: [] } })
    const readOnly = method && (/\/(?:read|list|get)$/.test(method) || method === 'initialize')
      || ['/codex-api/thread-runtime-state', '/codex-api/thread-search'].includes(url.pathname)
    if (request.method() !== 'GET' && !readOnly) {
      row.blockedWrites.push({ path: url.pathname, method: method || request.method() })
      return route.fulfill({ status: 409, json: { error: 'Plan acceptance blocks real writes' } })
    }
    return route.continue()
  })
  async function open(threadId = ROOT, reload = false) {
    load++; started = Date.now()
    row.url = `${base}/#/thread/${threadId}`
    if (reload) await page.reload({ waitUntil: 'domcontentloaded' })
    else await page.goto(row.url, { waitUntil: 'domcontentloaded' })
    if (await page.locator('#pw').isVisible()) {
      assert(process.env.WEBUI_TEST_PASSWORD, 'WEBUI_TEST_PASSWORD required for fresh login')
      await page.locator('#pw').fill(process.env.WEBUI_TEST_PASSWORD)
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.locator('button[type="submit"]').click()])
      started = Date.now()
    }
    await page.locator('.conversation-item').filter({ hasText: `PLAN_FIXTURE_USER_${threadId}_` }).first().waitFor()
    row.metrics[`historyLoad${load}Ms`] = Date.now() - started
    await page.waitForFunction(() => window.__planFixtureSockets.some(socket => socket.readyState === 1 && socket.fixtureReadyDelivered))
  }
  async function event(method, params) {
    await page.evaluate(({ method, params }) => {
      const socket = window.__planFixtureSockets.find(socket => socket.readyState === 1)
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params, atIso: new Date().toISOString() }) }))
    }, { method, params })
  }
  async function update(snapshot, persist = true) { if (persist) data.put(snapshot); await event('codex-ui/plan-updated', { snapshot }) }
  async function planCards() { return page.locator('.plan-card').evaluateAll(nodes => nodes.map(node => ({ identity: node.getAttribute('data-plan-identity'), kind: node.getAttribute('data-plan-kind'), lifecycle: node.getAttribute('data-lifecycle') }))) }
  async function checkVisuals() {
    const result = await page.evaluate(() => {
      const root = document.documentElement
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
      const context = canvas.getContext('2d')
      const colorBytes = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1)
        return [...context.getImageData(0, 0, 1, 1).data]
      }
      return { dark: root.classList.contains('dark'), overflow: Math.max(root.scrollWidth, document.body.scrollWidth) - innerWidth,
        reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
        cards: [...document.querySelectorAll('.plan-card')].map(element => ({ background: getComputedStyle(element).backgroundColor,
          backgroundRgba: colorBytes(getComputedStyle(element).backgroundColor), color: getComputedStyle(element).color, width: element.getBoundingClientRect().width })) }
    })
    assert.equal(result.dark, theme === 'dark')
    assert(result.overflow <= 2, `Horizontal overflow ${result.overflow}px`)
    assert.equal(result.reduced, reducedMotion)
    if (theme === 'dark') for (const card of result.cards) {
      if (card.backgroundRgba[3] > 0) assert(Math.max(...card.backgroundRgba.slice(0, 3)) < 150, `Light plan surface in dark theme: ${card.background}`)
    }
    row.visuals = result
  }
  async function screenshot(label, focusLocator) {
    await page.waitForTimeout(2300)
    await checkVisuals()
    if (focusLocator) {
      // A real scroll gesture opts out of the conversation's bottom lock.
      const list = await page.locator('.conversation-list').boundingBox()
      if (list) {
        await page.mouse.move(list.x + list.width / 2, Math.max(70, Math.min(viewport.height - 260, list.y + list.height / 2)))
        await page.mouse.wheel(0, -600)
        await page.waitForTimeout(100)
      }
      await focusLocator.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await page.waitForTimeout(100)
      const bounds = await focusLocator.boundingBox()
      assert(bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `Screenshot target ${label} must be visible`)
    }
    const filename = path.join(out, `${name}-${label}.png`)
    await page.screenshot({ path: filename })
    row.screenshots.push(filename)
  }
  async function finish() {
    await Promise.all(pending)
    const summaries = {}, planReads = {}
    for (const r of row.requests) {
      const key = `${r.load}:${r.threadId}`
      if (r.summary) summaries[key] = (summaries[key] || 0) + 1
      if (r.path === '/codex-api/plan-summary-history' && r.method === 'GET') planReads[key] = (planReads[key] || 0) + 1
    }
    row.summaryCountsByLoad = summaries; row.planHistoryCountsByLoad = planReads
    row.totalApiKB = Math.round(row.requests.reduce((sum, r) => sum + (r.responseBytes || 0), 0) / 1024)
    row.slowestApiRows = [...row.requests].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 8)
    assert(Object.values(summaries).every(count => count <= 1), 'Duplicate thread summaries during one document load')
    assert(Object.values(planReads).every(count => count <= 1), 'Duplicate plan-history requests during one document load')
    assert.deepEqual(row.blockedWrites, [], 'Unexpected mutation attempted')
    assert.deepEqual(row.errors, [], 'Unexpected JavaScript or request failure')
    assert.deepEqual(row.apiErrors, [], 'Unexpected HTTP failure')
  }
  return { page, context, row, data, open, event, update, planCards, screenshot, checkVisuals, finish,
    close: async () => { closing = true; await context.unrouteAll({ behavior: 'wait' }); await context.close() } }
}

async function textIncludes(locator, text) { await locator.filter({ hasText: text }).waitFor() }
async function liveCase(s) {
  const initial = checklist(); s.data.put(initial)
  await s.open()
  const card = s.page.locator('.plan-card[data-plan-kind="checklist"]')
  await card.waitFor()
  assert.equal(await card.count(), 1)
  await textIncludes(card.locator('.plan-card-summary'), '1/3')
  await textIncludes(card.locator('.plan-card-current-step'), '验证计划显示')
  assert(!/%/.test(await card.innerText()), 'Step counts must not claim task completion percentage')
  await card.locator('.plan-card-header').click()
  assert.equal(await card.getAttribute('data-collapsed'), 'true')
  await s.update(checklist({ revision: 2, updatedAtIso: iso(2), steps: [initial.steps[0], { step: '验证计划显示（更新）', status: 'inProgress' }, initial.steps[2]] }))
  await textIncludes(card.locator('.plan-card-current-step'), '更新')
  assert.equal(await card.getAttribute('data-collapsed'), 'true', 'A live update must preserve manual collapse')
  await s.screenshot('current-step')
  await s.open(ROOT, true)
  assert.equal(await card.getAttribute('data-collapsed'), 'true', 'Manual collapse survives refresh')
  await s.event('codex-ui/agent-progress', { threadId: ROOT, progress: s.data.progress() })
  const jump = s.page.locator('.turn-progress-plan-link')
  await jump.waitFor()
  await jump.click()
  assert.equal(await card.getAttribute('data-collapsed'), 'false', 'Current plan shortcut opens the matching checklist')
  assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute('data-plan-identity')), await card.getAttribute('data-plan-identity'), 'Shortcut focuses the current root plan itself')
  const allDone = checklist({ revision: 3, updatedAtIso: iso(3), steps: initial.steps.map(step => ({ ...step, status: 'completed' })) })
  await s.update(allDone)
  await textIncludes(card.locator('.plan-card-summary'), '3/3')
  assert.equal(await card.getAttribute('data-lifecycle'), 'live', 'All steps confirmed while turn runs keeps live lifecycle')
  assert(!/^(计划完成|已完成)$/.test((await card.locator('.plan-card-badge').innerText()).trim()), 'A running turn must not claim terminal plan completion')
  await s.update(checklist({ revision: 4, updatedAtIso: iso(4), steps: initial.steps.map((step, i) => ({ ...step, status: i ? 'pending' : 'completed' })) }))
  await textIncludes(card.locator('.plan-card-current-step'), '等待')
  await s.update(checklist({ revision: 5, updatedAtIso: iso(5), steps: initial.steps.map((step, i) => ({ ...step, status: i ? 'inProgress' : 'completed' })) }))
  const current = await card.locator('.plan-card-current-step').innerText()
  assert(current.includes('验证计划显示') && current.includes('完成验收'), 'Multiple running steps must remain visible')
  s.data.running = false
  const incomplete = checklist({ revision: 6, updatedAtIso: iso(6), lifecycle: 'incomplete' })
  await s.update(incomplete)
  await s.event('turn/completed', { threadId: ROOT, turn: { id: TURN, status: 'completed' } })
  await textIncludes(card.locator('.plan-card-summary'), '1/3')
  assert.equal(await card.getAttribute('data-lifecycle'), 'incomplete')
  assert(!/^(计划完成|已完成)$/.test((await card.locator('.plan-card-badge').innerText()).trim()), '1/3 at turn end is incomplete')
  await s.update(checklist({ revision: 5, updatedAtIso: iso(5) }), false)
  await s.event('ready', { planSnapshotsVersion: 1, activePlans: [checklist({ revision: 4 })], replayAvailable: true })
  await s.update(checklist({ revision: 99, updatedAtIso: iso(99) }), false)
  await s.page.waitForTimeout(150)
  assert.equal(await card.getAttribute('data-lifecycle'), 'incomplete', 'Old handshake and even higher-revision late live events cannot revive a closed plan')
  await s.screenshot('incomplete')
  s.row.assertions.push('current-step', 'manual-collapse-live-and-refresh', 'root-plan-shortcut', 'all-steps-live', 'waiting-and-multiple-steps', 'incomplete-1-of-3', 'late-live-rejected')
}

async function identityCase(s) {
  const check = checklist(), draft = proposal('proposal-a'), second = proposal('proposal-b')
  s.data.nativeProposals = [draft, second]
  for (const value of [check, draft, second]) s.data.put(value)
  await s.open()
  await s.page.locator('.plan-card').nth(2).waitFor()
  assert.equal(await s.page.locator('.plan-card[data-plan-kind="checklist"]').count(), 1)
  assert.equal(await s.page.locator('.plan-card[data-plan-kind="proposal"]').count(), 2)
  const identities = (await s.planCards()).map(card => card.identity)
  assert.equal(new Set(identities).size, 3, 'Same-turn checklist and two proposals have independent identities')
  const drafts = s.page.locator('.plan-card[data-plan-kind="proposal"]')
  for (let i = 0; i < 2; i++) if (await drafts.nth(i).getAttribute('data-collapsed') === 'true') await drafts.nth(i).locator('.plan-card-header').click()
  await textIncludes(drafts.nth(0), 'PROPOSAL_BODY_')
  assert.equal(await s.page.locator('.plan-card[data-plan-kind="checklist"] .plan-card-implement-button').count(), 0)
  assert.equal(await s.page.locator('.plan-card[data-plan-kind="proposal"] .plan-card-implement-button').count(), 2)
  await s.update(checklist({ revision: 2, steps: check.steps.map((step, i) => ({ ...step, status: i === 2 ? 'inProgress' : 'completed' })) }))
  for (const p of [draft, second]) assert((await s.page.locator('.plan-card[data-plan-kind="proposal"]').allTextContents()).some(text => text.includes(`PROPOSAL_BODY_${p.itemId}`)), 'Checklist updates must preserve proposal document')
  await drafts.nth(0).locator('.plan-card-header').click()
  assert.equal(await drafts.nth(0).getAttribute('data-collapsed'), 'true')
  assert.equal(await drafts.nth(1).getAttribute('data-collapsed'), 'false', 'Collapsing one proposal must not collapse a second same-turn proposal')
  assert.equal(await s.page.locator('.plan-card[data-plan-kind="checklist"]').getAttribute('data-collapsed'), 'false', 'Proposal collapse must not change execution checklist')
  await s.update(checklist({ threadId: CHILD, messageId: 'child-plan', steps: [{ step: 'CHILD_PLAN_MUST_NOT_LEAK', status: 'inProgress' }], revision: 4 }))
  await s.page.waitForTimeout(100)
  assert(!await s.page.locator('.plan-card').filter({ hasText: 'CHILD_PLAN_MUST_NOT_LEAK' }).count(), 'Child plan must not enter parent timeline')
  assert.equal(await s.page.locator(`.thread-row[data-thread-id="${CHILD}"]`).count(), 0)
  await s.screenshot('distinct-plans')
  await s.open(ROOT, true)
  assert.equal(await s.page.locator('.plan-card[data-plan-kind="proposal"]').count(), 2, 'Reload keeps both proposal documents')
  assert.equal(await s.page.locator('.plan-card[data-plan-kind="checklist"]').count(), 1)
  assert.equal(await drafts.nth(0).getAttribute('data-collapsed'), 'true', 'First proposal keeps its independent manual collapse after reload')
  assert.equal(await drafts.nth(1).getAttribute('data-collapsed'), 'false', 'Second proposal keeps its independent manual expansion after reload')
  s.row.assertions.push('proposal-checklist-independent', 'two-proposals-same-turn', 'implement-only-proposal', 'child-plan-isolation', 'reload-identity')
}

async function restorationCase(s) {
  s.data.running = false
  const states = ['completed', 'failed', 'interrupted', 'unconfirmed']
  s.data.historyTurns = [...states.map(state => `turn-${state}`), 'turn-truncated']
  for (const [index, lifecycle] of states.entries()) s.data.put(checklist({ turnId: `turn-${lifecycle}`, messageId: `turn-${lifecycle}:plan`,
    lifecycle, revision: 10 + index, steps: [{ step: `RESTORED_${lifecycle}`, status: lifecycle === 'completed' ? 'completed' : 'inProgress' }], createdAtIso: iso(index), updatedAtIso: iso(index + 10) }))
  s.data.put(checklist({ turnId: 'turn-truncated', messageId: 'turn-truncated:plan', lifecycle: 'incomplete', truncated: true,
    revision: 20, steps: [{ step: 'Shown step completed; additional steps excluded', status: 'completed' }] }))
  await s.open()
  await s.page.locator('.plan-card').nth(4).waitFor()
  for (const state of states) {
    const card = s.page.locator(`.plan-card[data-lifecycle="${state}"]`)
    assert.equal(await card.count(), 1, `Restore ${state} card exactly once`)
    if (state !== 'completed') assert(!/^(计划完成|已完成)$/.test((await card.locator('.plan-card-badge').innerText()).trim()))
  }
  const completed = s.page.locator('.plan-card[data-lifecycle="completed"]')
  assert.equal(await completed.getAttribute('data-collapsed'), 'true')
  assert.equal(await completed.getAttribute('data-compact-completed'), 'true')
  await textIncludes(completed.locator('.plan-card-summary'), '1/1')
  assert.equal(await completed.locator('.plan-card-current-step').count(), 0, 'Completed compact card omits redundant current-step line')
  const compact = await completed.evaluate(element => {
    const selectors = ['.plan-card-title', '.plan-card-summary', '.plan-card-header-actions']
    return { height: element.getBoundingClientRect().height, centers: selectors.map(selector => {
      const box = element.querySelector(selector).getBoundingClientRect()
      return box.top + box.height / 2
    }) }
  })
  assert(compact.height <= 52, `Completed plan should be a compact row, measured ${compact.height}px`)
  assert(Math.max(...compact.centers) - Math.min(...compact.centers) <= 4, 'Completed title, count and badge must share one row')
  s.row.metrics.completedCardHeightPx = compact.height
  await s.screenshot('completed-compact', completed)
  const unconfirmed = s.page.locator('.plan-card[data-lifecycle="unconfirmed"]')
  assert(/确认|恢复/.test(await unconfirmed.innerText()), 'Recovered active progress must disclose uncertain status')
  const current = unconfirmed.locator('.plan-card-current-step')
  if (await current.count()) assert(!/正在执行|当前执行/.test(await current.innerText()), 'Unconfirmed snapshot must not claim active execution')
  const truncated = s.page.locator('.plan-card[data-lifecycle="incomplete"]')
  assert(/未展示/.test(await truncated.locator('.plan-card-summary').innerText()), 'Truncated checklist must disclose missing steps')
  assert(!/步骤已完成/.test(await truncated.locator('.plan-card-current-step').innerText()), 'Truncated 1/1 cannot claim all steps completed')
  const warning = s.page.locator('.plan-persistence-warning')
  s.data.persistenceWarning = true
  await s.event('codex-ui/plan-persistence-warning', { active: true, message: 'PRIVATE_TEST_DETAIL /fixture/private-plan-data ACCESS_TOKEN_PLACEHOLDER' })
  await warning.waitFor()
  assert.equal(await warning.getAttribute('role'), 'status')
  assert(!/PRIVATE_TEST_DETAIL|\/fixture\/private-plan-data|ACCESS_TOKEN_PLACEHOLDER/.test(await warning.innerText()), 'Warning displays fixed safe copy instead of backend details')
  await s.screenshot('restored-states', warning)
  await s.open(ROOT, true)
  await warning.waitFor()
  s.data.persistenceWarning = false
  await s.event('codex-ui/plan-persistence-warning', { active: false, message: '' })
  await warning.waitFor({ state: 'hidden' })
  assert.equal(await s.page.locator('.plan-card').count(), 5, 'Snapshot and persisted summary must deduplicate after refresh')
  const terminalBefore = await s.page.locator('.plan-card[data-lifecycle="completed"]').getAttribute('data-plan-identity')
  await s.event('ready', { planSnapshotsVersion: 1, activePlans: [...s.data.snapshots.values()].reverse(), replayAvailable: true })
  assert.equal(await s.page.locator('.plan-card').count(), 5)
  assert.equal(await s.page.locator('.plan-card[data-lifecycle="completed"]').getAttribute('data-plan-identity'), terminalBefore)
  s.row.assertions.push('terminal-and-unconfirmed-restoration', 'completed-single-compact-row', 'truncated-does-not-claim-completion', 'summary-snapshot-dedup', 'reconnect-order-independent', 'persistence-warning-safe-refresh-recovery', 'reduced-motion')
}

async function run(kind, width, theme) {
  const data = fixture()
  const s = await createSession(`${kind}-${width}-${theme}`, width, theme, data, kind === 'restoration')
  try {
    await ({ live: liveCase, identity: identityCase, restoration: restorationCase })[kind](s)
    await s.finish(); s.row.passed = true
  } catch (error) {
    s.row.passed = false; s.row.error = error.stack
    const filename = path.join(out, `${s.row.name}-FAILED.png`)
    await s.page.screenshot({ path: filename }).then(() => s.row.screenshots.push(filename)).catch(() => {})
    throw error
  } finally { await s.close(); save(); console.log(JSON.stringify({ ...s.row, requests: undefined })) }
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  browser = await chromium.launch({ headless: true })
  try {
    for (const width of widths) for (const theme of themes) for (const kind of cases) await run(kind, width, theme)
    report.passed = true
  } finally { report.finishedAt = new Date().toISOString(); save(); await browser.close() }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
