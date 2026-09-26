/* Read-only browser regression: synthetic notifications traverse the real UI.
 * SUBAGENT_EXPECT=bug proves the old build; default expects the fixed behavior.
 * SUBAGENT_CASES=realtime,delayed,search,direct-child; SUBAGENT_VIEWPORTS=375,1440.
 * Production requires both an explicit URL and SUBAGENT_ALLOW_PRODUCTION=1.
 * Browser Use cannot inject native notifications or delay the list response.
 */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const base = (process.env.PROFILE_BASE_URL || 'http://127.0.0.1:13511').replace(/\/$/, '')
assert(['13511', ...(process.env.SUBAGENT_ALLOW_PRODUCTION === '1' ? ['13510'] : [])].includes(new URL(base).port))
const expectBug = process.env.SUBAGENT_EXPECT === 'bug'
assert(!expectBug || new URL(base).port === '13511', 'Only reproduce on acceptance')
const out = path.resolve('output/playwright/subagent-sidebar', process.env.SUBAGENT_RUN_LABEL || (expectBug ? 'before' : 'after'))
const cases = new Set((process.env.SUBAGENT_CASES || 'realtime,delayed,search').split(','))
const widths = (process.env.SUBAGENT_VIEWPORTS || '375,1440').split(',').map(Number)
const themes = (process.env.SUBAGENT_THEMES || 'light,dark').split(',')
const cwd = '/root/codex工作目录/CLIProxyAPI'
const ids = {
  parent: '01a09999-0000-7000-8000-000000000001',
  fork: '01a09999-0000-7000-8000-000000000002',
  spawn: '01a09999-0000-7000-8000-000000000003',
  review: '01a09999-0000-7000-8000-000000000004',
  old: '01a09999-0000-7000-8000-000000000005',
}
const labels = { parent: '侧栏回归父聊天', fork: '正常分支聊天', spawn: '子代理任务 Spawn', review: '子代理任务 Review', old: '历史直链聊天' }
const keyFor = id => Object.keys(ids).find(key => ids[key] === id)
function summary(key, turns = false, running = false) {
  return {
    id: ids[key], name: labels[key], preview: labels[key], cwd,
    createdAt: 1750000000, updatedAt: 1750001000, modelProvider: 'myproxy',
    source: key === 'spawn' ? { subAgent: { thread_spawn: { parent_thread_id: ids.parent, depth: 1 } } }
      : key === 'review' ? { subAgent: 'review' } : 'cli',
    ...(key === 'fork' ? { forkedFrom: ids.parent } : {}),
    status: { type: running ? 'active' : 'idle' }, historyMode: 'legacy', path: null, cliVersion: '0.154.0', gitInfo: null,
    turns: turns ? [{ id: `turn-${key}`, status: running ? 'inProgress' : 'completed', items: [{ id: `answer-${key}`, type: 'agentMessage', text: `SIDEBAR_FIXTURE_CONTENT_${key}` }] }] : [],
  }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = { base, expectBug, startedAt: new Date().toISOString(), cases: [] }
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
let browser

async function session(name, width, theme, options = {}) {
  const viewport = { width, height: width === 375 ? 812 : 900 }
  const context = await browser.newContext({ viewport, colorScheme: theme, serviceWorkers: 'block', isMobile: width === 375, hasTouch: width === 375 })
  assert.deepEqual(await context.storageState(), { cookies: [], origins: [] })
  await context.addInitScript(() => {
    const OriginalSocket = window.WebSocket
    window.__sidebarFixtureSockets = []
    class FixtureSocket extends EventTarget {
      constructor(url, protocols) {
        super()
        if (!String(url).includes('/codex-api/ws')) return new OriginalSocket(url, protocols)
        this.url = String(url)
        this.readyState = 0
        window.__sidebarFixtureSockets.push(this)
        setTimeout(() => {
          this.readyState = 1
          this.dispatchEvent(new Event('open'))
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'ready', params: { ok: true, replayAvailable: true } }) }))
        }, 10)
      }
      dispatchEvent(event) { const value = super.dispatchEvent(event); this[`on${event.type}`]?.(event); return value }
      close() { this.readyState = 3 }
      send() { throw new Error('Fixture must never send WebSocket mutations') }
    }
    for (const [key, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) FixtureSocket[key] = value
    window.WebSocket = FixtureSocket
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const row = { name, viewport, theme, freshStorage: true, cacheDisabled: true, requests: [], blockedWrites: [], errors: [], screenshots: [], metrics: {} }
  report.cases.push(row)
  let firstList = true
  let began = Date.now()
  const runningFixtureKeys = new Set()
  page.on('pageerror', error => row.errors.push(error.message))
  await context.route('**/codex-api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    let body = {}; try { body = request.postDataJSON() || {} } catch {}
    const method = url.pathname === '/codex-api/rpc' ? body.method : ''
    const id = body.params?.threadId || body.threadId || url.searchParams.get('threadId')
    const key = keyFor(id)
    row.requests.push({ path: url.pathname, method: method || request.method(), threadId: id || null, fixtureCwd: url.searchParams.get('cwd') === cwd || body.params?.cwd === cwd, summary: method === 'thread/read' && body.params?.includeTurns === false, atMs: Date.now() - began })
    const json = payload => route.fulfill({ status: 200, json: payload })
    if (method === 'thread/list') {
      if (firstList && options.delayList) { firstList = false; await wait(5000); row.metrics.listReleasedMs = Date.now() - began }
      return json({ result: { data: body.params?.ancestorThreadId ? [] : [summary('parent'), summary('fork')], nextCursor: null } })
    }
    if (key && method === 'thread/read') return json({ result: { thread: summary(key, body.params?.includeTurns === true, runningFixtureKeys.has(key)), model: 'gpt-5.6-luna', modelProvider: 'myproxy' } })
    if (key && method === 'thread/goal/get') return json({ result: { goal: null } })
    if (key && method === 'thread/queue/list') return json({ result: { data: [], nextCursor: null } })
    if (url.pathname === '/codex-api/thread-runtime-state' && (body.threadIds || []).every(keyFor)) return json({ data: [] })
    if (url.pathname === '/codex-api/thread-search') return json({ data: { threadIds: [ids.old], threads: [summary('old')], indexedThreadCount: 3, contentSearchState: 'idle', searchedContentCount: 0, contentThreadCount: 0 } })
    if (url.pathname === '/codex-api/workspace-roots-state' && request.method() === 'GET') return json({ data: { order: [cwd], projectOrder: [cwd], labels: {}, remoteProjects: [] } })
    if (key && ['/codex-api/request-user-input-history', '/codex-api/plan-summary-history'].includes(url.pathname) && request.method() === 'GET') return json({ data: {} })
    if (key && url.pathname === '/codex-api/agent-progress') return json({ data: null })
    const readablePost = method && (/\/(?:read|list|get)$/.test(method) || method === 'initialize')
      || ['/codex-api/thread-runtime-state', '/codex-api/thread-search', '/codex-api/git-status', '/codex-api/git-branch'].includes(url.pathname)
    if (request.method() !== 'GET' && !readablePost) {
      row.blockedWrites.push({ path: url.pathname, method: method || request.method() })
      return route.fulfill({ status: 409, json: { error: 'Read-only sidebar test blocked mutation' } })
    }
    return route.continue()
  })
  async function go(key = 'parent') {
    began = Date.now()
    row.url = `${base}/#/thread/${ids[key]}`
    await page.goto(row.url, { waitUntil: 'domcontentloaded' })
    if (await page.locator('#pw').isVisible()) {
      assert(process.env.WEBUI_TEST_PASSWORD, 'WEBUI_TEST_PASSWORD required')
      await page.locator('#pw').fill(process.env.WEBUI_TEST_PASSWORD)
      await Promise.all([page.waitForNavigation(), page.locator('button[type="submit"]').click()])
    }
  }
  async function history(key) {
    const waitBegan = Date.now()
    await page.locator('.conversation-item').filter({ hasText: `SIDEBAR_FIXTURE_CONTENT_${key}` }).first().waitFor()
    row.metrics.firstHistoryMs ??= Date.now() - began
    row.metrics[`${key}RenderWaitMs`] = Date.now() - waitBegan
  }
  async function openSidebar() {
    if (!await page.locator('.sidebar-new-chat').isVisible()) await page.locator('.sidebar-thread-controls-header-host .sidebar-thread-controls-button').first().click()
    await page.locator('.sidebar-new-chat').waitFor()
  }
  const threadRows = () => page.locator('.thread-row').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-thread-id')))
  async function screenshot(suffix) {
    await page.waitForTimeout(2300)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark')
    const file = path.join(out, `${name}-${suffix}.png`)
    await page.screenshot({ path: file })
    row.screenshots.push(file)
    row.surfaceColors = await page.evaluate(() => Object.fromEntries(['.sidebar-root', '.thread-composer-shell'].map(selector => [selector, document.querySelector(selector) ? getComputedStyle(document.querySelector(selector)).backgroundColor : null])))
  }
  return { context, page, row, go, history, openSidebar, threadRows, screenshot, runningFixtureKeys, elapsed: () => Date.now() - began }
}

async function run(name, width, theme, fn, options) {
  const s = await session(name, width, theme, options)
  try {
    await fn(s)
    assert.deepEqual(s.row.errors, [])
    assert.deepEqual(s.row.blockedWrites, [])
    s.row.summaryCounts = Object.fromEntries(Object.values(ids).map(id => [id, s.row.requests.filter(r => r.threadId === id && r.summary).length]))
    assert(Object.values(s.row.summaryCounts).every(count => count <= 1), 'Thread summary requests must be coalesced')
    s.row.passed = true
  } catch (error) {
    s.row.passed = false; s.row.error = error.stack
    await s.page.screenshot({ path: path.join(out, `${name}-FAILED.png`) }).catch(() => {})
    throw error
  } finally {
    await s.context.unrouteAll({ behavior: 'wait' })
    await s.context.close()
    save()
    console.log(JSON.stringify({ ...s.row, requests: undefined }))
  }
}

async function realtime(s) {
  await s.go()
  await s.history('parent')
  await s.openSidebar()
  await s.page.locator(`[data-thread-id="${ids.fork}"]`).waitFor()
  assert.deepEqual(new Set(await s.threadRows()), new Set([ids.parent, ids.fork]))
  await s.page.waitForFunction(() => window.__sidebarFixtureSockets.some(socket => socket.readyState === 1))
  await s.page.evaluate(({ ids }) => {
    const socket = window.__sidebarFixtureSockets.find(socket => socket.readyState === 1)
    for (const key of ['spawn', 'review']) {
      for (const method of ['turn/started', 'turn/completed']) {
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params: { threadId: ids[key], turn: { id: `turn-${key}`, status: method.endsWith('completed') ? 'completed' : 'inProgress' } } }) }))
      }
    }
  }, { ids })
  await s.page.waitForTimeout(2400)
  for (const key of ['spawn', 'review']) assert(s.row.requests.some(r => r.threadId === ids[key] && r.summary), `Real background history flow must read ${key}`)
  const after = await s.threadRows()
  s.row.afterNotifications = after
  assert.equal(after.includes(ids.spawn), expectBug)
  assert.equal(after.includes(ids.review), expectBug)
  assert(after.includes(ids.fork), 'Ordinary fork remains in sidebar')
  await s.screenshot('sidebar')
  if (expectBug) return
  await s.page.evaluate(id => { location.hash = `/thread/${id}` }, ids.spawn)
  await s.history('spawn')
  assert((await s.page.title()).includes(labels.spawn), 'Direct child keeps thread title')
  await s.openSidebar()
  assert(!(await s.threadRows()).includes(ids.spawn), 'Direct child does not join sidebar')
  await s.page.locator(`[data-thread-id="${ids.parent}"]`).click()
  await s.history('parent')
}

async function delayed(s) {
  await s.go('old')
  await s.history('old')
  assert(s.elapsed() < 3500, 'Direct history must not wait for 5 second list delay')
  assert((await s.page.title()).includes(labels.old), 'Direct old thread title available before list')
  assert(!s.row.metrics.listReleasedMs, 'History rendered before list release')
  assert(s.row.requests.some(request => request.fixtureCwd && request.path === '/codex-api/git/branches'), 'Direct old thread cwd reaches the header before list')
  await s.openSidebar()
  if (!expectBug) assert(!(await s.threadRows()).includes(ids.old), 'A metadata read does not grant sidebar membership')
  await s.page.waitForTimeout(5200 - s.elapsed())
  await s.screenshot('direct')
}

async function search(s) {
  await s.go()
  await s.history('parent')
  await s.openSidebar()
  await s.page.locator('.sidebar-search-toggle').click()
  const began = Date.now()
  await s.page.locator('.sidebar-search-input').fill(labels.old)
  await s.page.locator(`[data-thread-id="${ids.old}"]`).waitFor()
  s.row.metrics.searchMs = Date.now() - began
  await s.page.locator(`[data-thread-id="${ids.old}"]`).click()
  await s.history('old')
  assert((await s.page.title()).includes(labels.old))
  await s.screenshot('search')
}

async function directChild(s) {
  s.runningFixtureKeys.add('review')
  await s.go('review')
  await s.history('review')
  assert((await s.page.title()).includes(labels.review), 'Fresh child URL preserves title')
  await s.page.locator('.thread-composer-stop').waitFor()
  const previousLists = s.row.requests.filter(request => request.method === 'thread/list').length
  await s.page.evaluate(() => {
    const socket = window.__sidebarFixtureSockets.find(socket => socket.readyState === 1)
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'codex-ui/thread-index-updated', params: {} }) }))
  })
  await s.page.waitForTimeout(500)
  assert(s.row.requests.filter(request => request.method === 'thread/list').length > previousLists, 'Native index notification must refresh main list')
  assert(await s.page.locator('.thread-composer-stop').isVisible(), 'Sidebar refresh must preserve a directly opened child running state')
  s.row.runningChildSurvivedListRefresh = true
  await s.openSidebar()
  await s.page.locator(`[data-thread-id="${ids.parent}"]`).waitFor()
  assert.deepEqual(new Set(await s.threadRows()), new Set([ids.parent, ids.fork]), 'Fresh child URL must not add sidebar membership')
  await s.screenshot('child-direct')
  await s.page.locator(`[data-thread-id="${ids.parent}"]`).click()
  await s.history('parent')
}

;(async () => {
  fs.mkdirSync(out, { recursive: true })
  browser = await chromium.launch({ headless: true })
  try {
    for (const width of widths) for (const theme of themes) {
      if (cases.has('realtime')) await run(`realtime-${width}-${theme}`, width, theme, realtime)
      if (cases.has('delayed')) await run(`delayed-${width}-${theme}`, width, theme, delayed, { delayList: true })
      if (cases.has('search')) await run(`search-${width}-${theme}`, width, theme, search)
      if (cases.has('direct-child')) await run(`direct-child-${width}-${theme}`, width, theme, directChild)
    }
    report.passed = true
  } finally { report.finishedAt = new Date().toISOString(); save(); await browser.close() }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
