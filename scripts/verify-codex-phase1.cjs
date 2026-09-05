const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const baseUrl = process.env.PHASE1_BASE_URL || 'http://127.0.0.1:4173'
const threadId = process.env.PHASE1_THREAD_ID
if (!threadId) throw new Error('PHASE1_THREAD_ID must name an isolated TestChat thread')
const outputDir = resolve('output/playwright')
mkdirSync(outputDir, { recursive: true })
const reports = []
const fixtureTurnId = 'phase1-ui-fixture-turn'
const fixtureItems = [
  { id: 'phase1-sleep', type: 'sleep', durationMs: 250 },
  { id: 'phase1-output', type: 'functionCallOutput', name: 'lookup', output: 'PHASE1_TOOL_OUTPUT <script>not executable</script>' },
  { id: 'phase1-agent', type: 'subAgentActivity', agentPath: '/child', agentThreadId: 'phase1-child', kind: 'completed' },
  { id: 'phase1-hook', type: 'hookPrompt', fragments: [{ hookRunId: 'phase1-hook-run', text: 'PHASE1_HOOK_CONTEXT' }] },
  { id: 'phase1-future', type: 'futureItem', secret: 'PHASE1_MUST_NOT_EXPOSE' },
]

async function verifyPage(browser, theme, viewport) {
  const page = await browser.newPage({ viewport })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  let fixtureMode = false
  let pending = []
  let notices = []
  let runtimeReadCount = 0
  const request = {
    id: 'phase1-question', generation: 9, method: 'item/tool/requestUserInput', receivedAtIso: new Date().toISOString(),
    params: { threadId, turnId: fixtureTurnId, itemId: 'phase1-question-item', isBlocking: false, questions: [{ id: 'scope', header: 'PHASE1_QUESTION', question: 'Optional clarification while work continues', options: [{ label: 'Continue', description: 'Keep working' }, { label: 'Review', description: 'Review first' }] }] },
  }
  await page.addInitScript(theme => {
    localStorage.setItem('codex-web-local.dark-mode.v1', theme)
    const NativeWebSocket = window.WebSocket
    window.__phase1Sockets = []
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) {
        super(url, protocols)
        if (String(url).includes('/codex-api/ws')) window.__phase1Sockets.push(this)
      }
    }
  }, theme)
  await page.route('**/codex-api/server-requests/pending', route => fixtureMode ? route.fulfill({ json: { data: pending } }) : route.continue())
  await page.route('**/codex-api/server-requests/respond', async route => {
    const body = route.request().postDataJSON()
    if (fixtureMode && body.id === request.id) {
      pending = []
      await route.fulfill({ json: { ok: true } })
    } else await route.continue()
  })
  await page.route('**/codex-api/runtime-info', async route => {
    runtimeReadCount += 1
    await route.continue()
  })
  await page.route('**/codex-api/thread-runtime-state', async route => {
    const response = await route.fetch()
    const payload = await response.json()
    if (fixtureMode) payload.data = (payload.data || []).map(state => state.threadId === threadId ? { ...state, turnId: fixtureTurnId, state: 'running', isRunning: true, runtimeNotices: notices } : state)
    await route.fulfill({ response, json: payload })
  })
  await page.route('**/codex-api/rpc', async route => {
    if (!fixtureMode) return route.continue()
    const body = route.request().postDataJSON()
    const response = await route.fetch()
    const payload = await response.json()
    const result = payload.result
    if (result && body.method === 'thread/list') {
      result.data = result.data.map(thread => thread.id === threadId ? { ...thread, historyMode: 'legacy', status: { type: 'active', activeFlags: [] } } : thread)
    }
    if (result?.thread?.id === threadId) {
      result.thread = { ...result.thread, historyMode: 'legacy', turns: [{ id: fixtureTurnId, status: 'inProgress', error: null, items: fixtureItems }], status: { type: 'active', activeFlags: [] } }
      delete result.initialTurnsPage
    }
    if (result && body.params?.threadId === threadId && body.method === 'thread/turns/list') {
      result.data = [{ id: fixtureTurnId, status: 'inProgress', error: null, items: fixtureItems }]
      result.nextCursor = null
    }
    if (result && body.params?.threadId === threadId && body.method === 'thread/items/list') {
      result.data = fixtureItems.map(item => ({ turnId: fixtureTurnId, item }))
      result.nextCursor = null
    }
    await route.fulfill({ response, json: payload })
  })

  const url = `${baseUrl}/#/thread/${threadId}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.thread-composer-input', { timeout: 30000 })
  await page.locator('.conversation-item').filter({ hasText: 'PHASE1_ASTRA_20260905' }).last().waitFor({ timeout: 30000 })
  const fileLink = page.locator('.conversation-item[data-role="assistant"] a').filter({ hasText: /^README\.md$/ }).last()
  const link = await fileLink.evaluate(link => ({ href: link.getAttribute('href'), title: link.getAttribute('title'), text: link.textContent }))
  const linkResult = { hrefOk: link.href === '/codex-local-browse/tmp/codex-webui-phase1-TestChat/README.md', titleOk: link.title === 'README.md', textOk: link.text === 'README.md' }
  assert.ok(Object.values(linkResult).every(Boolean), JSON.stringify(link))
  if (viewport.width >= 1000) {
    await page.locator('.model-reasoning-trigger').click()
    await page.getByRole('option', { name: /^Ultra/ }).waitFor()
    const efforts = await page.locator('.model-reasoning-menu .model-reasoning-option').allTextContents()
    assert.equal(efforts.length, 6)
    await page.keyboard.press('Escape')
  }
  await page.waitForTimeout(2300)
  const realScreenshot = resolve(outputDir, `testchat-phase1-${theme}-${viewport.width}-cjs.png`)
  await page.screenshot({ path: realScreenshot })

  fixtureMode = true
  console.log(`Native fixtures: ${theme} ${viewport.width}x${viewport.height}`)
  pending = [request]
  notices = [{ kind: 'verification', threadId, turnId: fixtureTurnId, title: 'Account verification required', details: ['trustedAccessForCyber'], requiresAction: true }]
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.runtime-item').first().waitFor({ timeout: 30000 }).catch(async error => {
    await page.screenshot({ path: resolve(outputDir, `phase1-failed-${theme}-${viewport.width}.png`) })
    console.error((await page.locator('body').innerText()).slice(0, 4000))
    throw error
  })
  assert.equal(await page.locator('.runtime-item').count(), fixtureItems.length)
  await page.getByText('可稍后回答 · 任务继续运行').first().waitFor({ timeout: 15000 })
  await page.locator('.runtime-notice[data-kind="verification"]').waitFor({ timeout: 15000 })
  assert.equal(await page.locator('.thread-composer-input').isEnabled(), true)
  assert.equal(await page.getByText('Codex 需要你的回答后才能继续。', { exact: true }).count(), 0)
  await page.getByText('可以稍后在此回答；普通聊天消息不会作为这个问题的答案。', { exact: true }).waitFor()
  assert.equal(await page.getByText('PHASE1_MUST_NOT_EXPOSE').count(), 0)
  await page.waitForFunction(() => window.__phase1Sockets?.some(socket => socket.readyState === WebSocket.OPEN))
  async function emit(method, params, generation = 9) {
    await page.evaluate(frame => {
      const socket = window.__phase1Sockets.findLast(socket => socket.readyState === WebSocket.OPEN)
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
    }, { method, params, generation, atIso: new Date().toISOString() })
  }
  notices.push({ kind: 'safety', threadId, turnId: fixtureTurnId, title: 'Safety buffering · task is still running', details: ['gpt-6-astra'], requiresAction: false })
  await emit('model/safetyBuffering/updated', { threadId, turnId: fixtureTurnId, model: 'gpt-6-astra', showBufferingUi: true, reasons: [] })
  await page.locator('.runtime-notice[data-kind="safety"]').waitFor()
  const background = await page.locator('.runtime-notice').first().evaluate(element => getComputedStyle(element).backgroundColor)
  assert.equal(background, theme === 'dark' ? 'rgb(24, 30, 43)' : 'rgb(248, 250, 252)')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.waitForTimeout(2300)
  const fixtureScreenshot = resolve(outputDir, `phase1-native-${theme}-${viewport.width}.png`)
  await page.screenshot({ path: fixtureScreenshot })

  pending = []
  await emit('serverRequest/resolved', { threadId, requestId: request.id })
  await page.getByText('PHASE1_QUESTION').first().waitFor({ state: 'hidden' })
  await emit('serverRequest/resolved', { threadId, requestId: request.id })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.runtime-item').first().waitFor({ timeout: 30000 })
  assert.equal(await page.getByText('PHASE1_QUESTION').count(), 0)
  await page.locator('.runtime-notice[data-kind="verification"]').waitFor({ timeout: 15000 })
  assert.equal(await page.locator('.runtime-item').count(), fixtureItems.length)
  if (viewport.width >= 1000) {
    await page.locator('.sidebar-settings-button').click()
    await page.locator('.runtime-info-panel summary').click()
    await page.locator('.runtime-info-panel').getByText('0.153.4', { exact: true }).waitFor()
    assert.equal(runtimeReadCount, 1)
    await page.waitForTimeout(2300)
    await page.screenshot({ path: resolve(outputDir, `phase1-runtime-${theme}.png`) })
  }
  assert.deepEqual(errors, [])
  reports.push({ url, theme, viewport, linkResult, nativeItems: fixtureItems.length, nonblockingInputEnabled: true, resolvedAfterRefresh: true, verificationRestored: true, background, runtimeReadCount, realScreenshot, fixtureScreenshot, pageErrors: errors })
  await page.unrouteAll({ behavior: 'wait' })
  await page.close()
}

;(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) {
      for (const theme of ['light', 'dark']) await verifyPage(browser, theme, viewport)
    }
    writeFileSync(resolve(outputDir, 'phase1-browser-report.json'), JSON.stringify(reports, null, 2))
    console.log(JSON.stringify(reports, null, 2))
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
