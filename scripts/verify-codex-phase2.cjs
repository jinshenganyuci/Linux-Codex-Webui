const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const baseUrl = process.env.PHASE2_BASE_URL || 'http://127.0.0.1:4173'
const threadId = process.env.PHASE2_THREAD_ID || JSON.parse(readFileSync('output/playwright/phase2-runtime-bootstrap.json', 'utf8')).threadId
const output = resolve('output/playwright')
const turnId = 'phase2-fixture-running-turn'
const reports = []
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

async function verify(browser, theme, viewport) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const calls = []
  let fixture = false
  let running = true
  let mode = 'native'
  let settingsStatus = 'targetUnavailable'
  let rejectSteer = true
  let goal = null
  let queue = []
  let settings = { model: 'gpt-6-astra', effort: 'low', serviceTier: null, permissionProfile: ':read-only' }
  let actualThread
  const fixtureTurn = () => ({ id: turnId, status: running ? 'inProgress' : 'completed', error: null, items: [{ id: 'phase2-fixture-agent', type: 'agentMessage', text: 'PHASE2_UI_RUNNING' }] })
  const thread = () => ({ ...actualThread, historyMode: 'legacy', status: { type: running ? 'active' : 'idle', activeFlags: [] }, turns: [fixtureTurn()] })
  async function emit(method, params) {
    for (const target of context.pages()) {
      await target.evaluate(frame => {
        const socket = window.__phase2Sockets?.findLast(socket => socket.readyState === WebSocket.OPEN)
        socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
      }, { method, params, atIso: new Date().toISOString() }).catch(error => {
        if (!/Execution context was destroyed|Target page, context or browser has been closed/.test(error.message)) throw error
      })
    }
  }
  async function notify(method, params) { await pause(30); await emit(method, params) }
  await context.addInitScript(theme => {
    localStorage.setItem('codex-web-local.dark-mode.v1', theme)
    const NativeWebSocket = window.WebSocket
    window.__phase2Sockets = []
    window.WebSocket = class extends NativeWebSocket {
      constructor(url, protocols) { super(url, protocols); if (String(url).includes('/codex-api/ws')) window.__phase2Sockets.push(this) }
    }
  }, theme)
  await context.route('**/codex-api/native-queue-mode*', async route => {
    if (!fixture) return route.continue()
    if (route.request().method() === 'PUT') {
      mode = route.request().postDataJSON().mode
      await route.fulfill({ json: { ok: true } })
      await notify('codex-ui/native-queue-mode', { threadId, mode })
    } else await route.fulfill({ json: { data: { mode, settings } } })
  })
  await context.route('**/codex-api/thread-runtime-state*', async route => {
    if (!fixture) return route.continue()
    await route.fulfill({ json: { data: [{ threadId, turnId, state: running ? 'running' : 'completed', isRunning: running, source: 'local', startedAtIso: new Date().toISOString(), completedAtIso: running ? null : new Date().toISOString(), owner: null }] } })
  })
  await context.route('**/codex-api/rpc', async route => {
    const body = route.request().postDataJSON()
    if (!fixture) return route.continue()
    calls.push(body)
    const params = body.params || {}
    const method = body.method
    const result = value => route.fulfill({ json: { result: value } })
    if (method === 'permissionProfile/list') return result({ data: [{ id: ':read-only', allowed: true, description: '只读验收权限' }, { id: ':workspace', allowed: true }, { id: ':forbidden', allowed: false }], nextCursor: null })
    if (method === 'experimentalFeature/list') return result({ data: [{ name: 'step_model_switching', enabled: true }], nextCursor: null })
    if (method === 'thread/list') {
      const response = await route.fetch()
      const payload = await response.json()
      payload.result.data = payload.result.data.map(item => item.id === threadId ? thread() : item)
      return route.fulfill({ response, json: payload })
    }
    if (params.threadId === threadId) {
      if (method === 'thread/read' || method === 'thread/resume') return result({ thread: thread(), model: settings.model, reasoningEffort: settings.effort, serviceTier: settings.serviceTier, activePermissionProfile: { id: settings.permissionProfile }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never' })
      if (method === 'thread/turns/list') return result({ data: [fixtureTurn()], nextCursor: null })
      if (method === 'thread/items/list') return result({ data: fixtureTurn().items.map(item => ({ turnId, item })), nextCursor: null })
      if (method === 'thread/goal/get') return result({ goal })
      if (method === 'thread/goal/set') {
        goal = { threadId, objective: '', status: 'active', tokenBudget: null, tokensUsed: 321, timeUsedSeconds: 12, createdAt: 1, ...goal, ...params, updatedAt: Date.now() }
        await result({ goal })
        return notify('thread/goal/updated', { threadId, goal })
      }
      if (method === 'thread/goal/clear') { goal = null; await result({}); return notify('thread/goal/cleared', { threadId }) }
      if (method === 'thread/settings/update') {
        settings = { ...settings, ...params, ...(params.permissions ? { permissionProfile: params.permissions } : {}) }
        await result({})
        return notify('thread/settings/updated', { threadId, threadSettings: settings })
      }
      if (method === 'turn/settings/update') return result({ status: settingsStatus })
      if (method === 'turn/steer') return rejectSteer ? route.fulfill({ status: 409, json: { error: 'PHASE2_STEER_REJECTED' } }) : result({ turnId })
      if (method === 'thread/queue/list') return result({ data: queue, nextCursor: null })
      if (method === 'thread/queue/add') {
        const queuedSubmission = { id: `fixture-${queue.length + 1}`, clientUserMessageId: params.clientUserMessageId, input: params.input }
        queue.push(queuedSubmission)
        await result({ queuedSubmission })
        return notify('thread/queue/changed', { threadId })
      }
      if (method === 'thread/queue/update') {
        const queuedSubmission = queue.find(item => item.id === params.queuedSubmissionId)
        queuedSubmission.input = params.input
        await result({ queuedSubmission })
        return notify('thread/queue/changed', { threadId })
      }
      if (method === 'thread/queue/reorder') { queue = params.queuedSubmissionIds.map(id => queue.find(item => item.id === id)); await result({}); return notify('thread/queue/changed', { threadId }) }
      if (method === 'thread/queue/delete' || method === 'thread/queue/start') {
        queue = queue.filter(item => item.id !== params.queuedSubmissionId)
        await result(method.endsWith('/start') ? { turn: fixtureTurn() } : {})
        return notify('thread/queue/changed', { threadId })
      }
      if (method === 'turn/start' || method === 'turn/interrupt') return route.fulfill({ status: 409, json: { error: 'Fixture forbids accidental real turn mutation' } })
    }
    if (method === 'config/batchWrite' || method === 'config/value/write') return route.fulfill({ status: 409, json: { error: 'Fixture forbids global config changes' } })
    return route.continue()
  })

  const url = `${baseUrl}/#/thread/${threadId}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('.thread-composer-input').waitFor({ timeout: 30000 })
  await page.locator('.conversation-item').filter({ hasText: 'PHASE2_READY_20260905' }).last().waitFor({ timeout: 30000 })
  const fileLink = page.locator('.conversation-item[data-role="assistant"] a').filter({ hasText: /^README\.md$/ }).last()
  const link = await fileLink.evaluate(element => ({ href: element.getAttribute('href'), title: element.getAttribute('title'), text: element.textContent }))
  const linkResult = { hrefOk: link.href === '/codex-local-browse/tmp/codex-webui-phase2-TestChat/README.md', titleOk: link.title === 'README.md', textOk: link.text === 'README.md' }
  assert(Object.values(linkResult).every(Boolean), JSON.stringify(link))
  await page.waitForTimeout(2300)
  const realScreenshot = resolve(output, `testchat-phase2-${theme}-${viewport.width}-cjs.png`)
  await page.screenshot({ path: realScreenshot })
  actualThread = (await (await page.request.post(`${baseUrl}/codex-api/rpc`, { data: { method: 'thread/read', params: { threadId, includeTurns: true } } })).json()).result.thread
  fixture = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('PHASE2_UI_RUNNING', { exact: true }).waitFor({ timeout: 30000 })
  await page.waitForFunction(() => window.__phase2Sockets?.some(socket => socket.readyState === WebSocket.OPEN))
  await page.getByTestId('native-controls-toggle').click()
  await page.getByTestId('native-apply-turn').waitFor()
  await page.getByTestId('native-apply-turn').click()
  await page.getByRole('status').filter({ hasText: '没有生效' }).waitFor()
  settingsStatus = 'applied'
  await page.getByTestId('native-apply-turn').click()
  await page.getByRole('status').filter({ hasText: '后续步骤' }).waitFor()
  await page.getByTestId('native-apply-thread').click()
  await page.getByRole('status').filter({ hasText: '未修改全局默认' }).waitFor()
  const currentPatch = calls.find(item => item.method === 'turn/settings/update').params
  assert.equal(currentPatch.turnId, turnId)
  assert.equal(currentPatch.threadId, threadId)
  assert.equal(Object.hasOwn(currentPatch, 'permissions'), false)
  await page.getByTestId('native-permission-picker').locator('button').click()
  assert.equal(await page.getByRole('option', { name: ':forbidden', exact: true }).count(), 0)
  await page.getByRole('option', { name: ':workspace', exact: true }).click()
  await page.getByTestId('native-permission-picker').getByText(':workspace', { exact: true }).waitFor()
  await page.getByTestId('native-goal-objective').fill('PHASE2_GOAL_UI')
  await page.getByTestId('native-goal-budget').fill('1000')
  await page.getByTestId('native-goal-save').click()
  await page.getByTestId('native-goal-usage').filter({ hasText: '321' }).waitFor()
  await page.getByTestId('native-goal-budget').fill('2000')
  await page.getByTestId('native-goal-save').click()
  await page.getByTestId('native-goal-usage').filter({ hasText: '2,000' }).waitFor()
  assert.equal(Object.hasOwn(calls.filter(item => item.method === 'thread/goal/set').at(-1).params, 'objective'), false)
  await page.getByTestId('native-goal-toggle').click()
  await page.getByTestId('native-goal-toggle').filter({ hasText: '启用目标' }).waitFor()
  await page.getByTestId('native-controls-toggle').click()
  const composer = page.locator('.thread-composer-input')
  await page.locator('.thread-composer-attach-trigger').click()
  await page.locator('.thread-composer-attach-mode-button').first().click()
  await page.keyboard.press('Escape')
  await composer.fill('PHASE2_KEEP_DRAFT')
  await page.locator('.thread-composer-submit').click()
  await page.getByText(/PHASE2_STEER_REJECTED/).first().waitFor()
  assert.equal(await composer.inputValue(), 'PHASE2_KEEP_DRAFT')
  assert.equal(calls.filter(item => item.method === 'turn/start').length, 0)
  assert.equal(calls.filter(item => item.method === 'turn/steer').at(-1).params.expectedTurnId, turnId)
  rejectSteer = false
  await page.locator('.thread-composer-submit').click()
  await page.waitForFunction(() => document.querySelector('.thread-composer-input').value === '')
  await page.locator('.thread-composer-attach-trigger').click()
  await page.locator('.thread-composer-attach-mode-button').last().click()
  await page.keyboard.press('Escape')
  await composer.fill('PHASE2_QUEUE_UI')
  await page.locator('.thread-composer-submit').click()
  await page.locator('[data-queue-id]').first().waitFor()
  const attachment = { type: 'skill', name: 'audit', path: '/fixture/SKILL.md' }
  queue[0].input.push(attachment)
  queue.push({ id: 'fixture-extra', clientUserMessageId: 'extra', input: [{ type: 'text', text: 'PHASE2_QUEUE_SECOND' }] })
  await emit('thread/queue/changed', { threadId })
  const first = page.locator('[data-queue-id="fixture-1"]')
  await first.getByText('包含 1 项附加输入，编辑时保留。', { exact: true }).waitFor()
  await first.getByRole('button', { name: '编辑', exact: true }).click()
  await first.locator('textarea').fill('PHASE2_QUEUE_EDITED_UI')
  await first.getByRole('button', { name: '保存编辑', exact: true }).click()
  await first.getByText('PHASE2_QUEUE_EDITED_UI', { exact: true }).waitFor()
  assert.deepEqual(queue[0].input[1], attachment)
  await first.getByRole('button', { name: '下移', exact: true }).click()
  await pause(250)
  assert.equal(queue[1].id, 'fixture-1')
  await page.locator('[data-queue-id="fixture-extra"]').getByRole('button', { name: '删除', exact: true }).click()
  await page.locator('[data-queue-id="fixture-extra"]').waitFor({ state: 'hidden' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.native-goal-summary').filter({ hasText: 'PHASE2_GOAL_UI' }).waitFor({ timeout: 30000 })
  await page.locator('[data-queue-id="fixture-1"]').waitFor()
  await page.getByTestId('native-controls-toggle').click()
  await page.getByTestId('native-goal-objective').waitFor()
  assert.equal(await page.getByTestId('native-goal-objective').inputValue(), 'PHASE2_GOAL_UI')
  const background = await page.getByTestId('native-thread-controls').evaluate(element => getComputedStyle(element).backgroundColor)
  assert.equal(background, theme === 'dark' ? 'rgb(24, 24, 27)' : 'rgb(250, 250, 250)')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal page overflow')
  const controlsBox = await page.getByTestId('native-thread-controls').boundingBox()
  assert(controlsBox.height <= viewport.height * 0.5 + 2, 'Controls must leave room for chat and composer')
  await page.getByTestId('native-goal-objective').scrollIntoViewIfNeeded()
  await page.waitForTimeout(2300)
  const screenshot = resolve(output, `phase2-native-${theme}-${viewport.width}.png`)
  await page.screenshot({ path: screenshot })
  if (viewport.width === 1280 && theme === 'light') {
    const other = await context.newPage()
    await other.goto(url, { waitUntil: 'domcontentloaded' })
    await other.locator('.native-goal-summary').waitFor({ timeout: 30000 })
    goal = { ...goal, status: 'budgetLimited' }
    await emit('thread/goal/updated', { threadId, goal })
    await page.locator('.native-goal-summary').filter({ hasText: '预算受限' }).waitFor()
    await other.locator('.native-goal-summary').filter({ hasText: '预算受限' }).waitFor()
    await other.close()
  }
  await page.getByTestId('native-goal-clear').click()
  await page.getByTestId('native-goal-clear').click()
  await page.getByTestId('native-goal-usage').waitFor({ state: 'hidden' })
  running = false
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[data-queue-id="fixture-1"]').getByRole('button', { name: '开始此条', exact: true }).click()
  await page.locator('[data-queue-id="fixture-1"]').waitFor({ state: 'hidden' })
  await page.getByTestId('native-controls-toggle').click()
  await page.getByTestId('native-queue-toggle').click()
  await page.getByTestId('native-queue-toggle').filter({ hasText: '启用原生队列' }).waitFor()
  assert.equal(calls.filter(item => item.method === 'config/batchWrite' || item.method === 'turn/start').length, 0)
  assert.deepEqual(errors, [])
  reports.push({ url, theme, viewport, linkResult, background, scopeChecks: true, goalCrudAndRefresh: true, retainedRejectedDraft: true, queueCrudAndAttachmentPreservation: true, forbiddenProfileHidden: true, noGlobalConfigWrite: true, screenshot, realScreenshot, pageErrors: errors })
  console.log(`${theme} ${viewport.width}x${viewport.height}: passed`)
  await context.unrouteAll({ behavior: 'wait' })
  await context.close()
}

;(async () => {
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) {
      for (const theme of ['light', 'dark']) await verify(browser, theme, viewport)
    }
    writeFileSync(resolve(output, 'phase2-browser-report.json'), JSON.stringify(reports, null, 2))
  } catch (error) {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      console.error((await page.locator('body').innerText()).slice(-5000))
      await page.screenshot({ path: resolve(output, 'phase2-browser-failed.png') }).catch(() => {})
    }
    throw error
  } finally { await browser.close() }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
