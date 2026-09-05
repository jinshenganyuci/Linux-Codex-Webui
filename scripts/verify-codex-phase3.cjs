const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const { resolve } = require('node:path')
const base = process.env.PHASE3_BASE_URL || 'http://127.0.0.1:4173'
const threadId = process.env.PHASE3_THREAD_ID || JSON.parse(readFileSync('output/playwright/phase3-runtime-bootstrap.json', 'utf8')).threadId
const output = resolve('output/playwright')
const childId = 'phase3-child-fixture'
const turnId = 'phase3-active-fixture'
const reports = []

async function verify(browser, theme, viewport) {
  console.log(`Starting ${theme} ${viewport.width}`)
  const context = await browser.newContext({ viewport })
  context.setDefaultTimeout(15000)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const requests = []
  let fixture = false
  let actualThread
  let realtime = null
  let rejectStart = true
  let remote = { status: 'disabled', serverName: 'phase3-test', installationId: 'installation-fixture', environmentId: null }
  let clients = [{ clientId: 'client-fixture', displayName: 'PHASE3_DEVICE', platform: 'fixture' }]
  const feature = (name, enabled, stage = 'stable') => ({ name, enabled, defaultEnabled: enabled, stage, displayName: null, description: null })
  const info = { threadId, cliVersion: '0.153.4', provider: 'myproxy', accountType: null, descendantThreads: true, requirementsKnown: true, featureRequirements: { memories: true }, warnings: [], features: [feature('plugins', true), feature('apps', true), feature('tool_suggest', true), feature('memories', true), feature('realtime_conversation', true, 'underDevelopment'), feature('context_management', true, 'underDevelopment'), feature('remote_compaction_v2', true), feature('multi_agent', true), feature('remote_control', false, 'removed')] }
  const children = [{ id: childId, parentThreadId: threadId, agentNickname: 'PHASE3_CHILD', agentRole: 'reviewer', preview: 'PHASE3_CHILD_TASK', model: 'gpt-6-astra', reasoningEffort: 'low', status: { type: 'notLoaded' }, updatedAt: 1 }]
  const activeTurn = { id: turnId, status: 'inProgress', error: null, items: [{ id: 'phase3-agent', type: 'agentMessage', text: 'PHASE3_ACTIVITY_UI' }] }
  const currentThread = () => ({ ...actualThread, status: { type: 'active', activeFlags: [] }, historyMode: 'legacy', turns: [activeTurn] })
  const progress = { rootThreadId: threadId, turnId, status: 'running', phase: 'waitingForAgents', startedAtMs: Date.now(), lastActivityAtMs: Date.now(), mainLastActivityAtMs: Date.now(), updatedAtMs: Date.now(), agents: [{ threadId: childId, parentThreadId: threadId, path: '/reviewer', nickname: 'PHASE3_CHILD', depth: 1, taskSummary: 'PHASE3_CHILD_TASK', model: 'gpt-6-astra', reasoningEffort: 'low', status: 'running', startedAtMs: Date.now(), lastActivityAtMs: Date.now(), completedAtMs: null, currentActivity: 'Reading', resultAvailable: false }], events: [] }
  async function emit(method, params) {
    await page.evaluate(frame => {
      const socket = window.__phase3Sockets?.findLast(socket => socket.readyState === WebSocket.OPEN)
      socket?.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
    }, { method, params, atIso: new Date().toISOString() }).catch(error => { if (!/Execution context was destroyed|Target page, context or browser has been closed/.test(error.message)) throw error })
  }
  await context.addInitScript(theme => {
    localStorage.setItem('codex-web-local.dark-mode.v1', theme)
    const NativeSocket = window.WebSocket
    window.__phase3Sockets = []
    window.WebSocket = class extends NativeSocket { constructor(url, protocols) { super(url, protocols); if (String(url).includes('/codex-api/ws')) window.__phase3Sockets.push(this) } }
    window.__phase3Media = { opened: 0, stopped: 0, closed: 0, offers: 0, answers: 0 }
    navigator.mediaDevices.getUserMedia = async () => {
      window.__phase3Media.opened += 1
      let stopped = false
      return { getTracks: () => [{ stop: () => { if (!stopped) { stopped = true; window.__phase3Media.stopped += 1 } } }] }
    }
    HTMLMediaElement.prototype.play = async () => {}
    HTMLMediaElement.prototype.pause = () => {}
    window.RTCPeerConnection = class {
      connectionState = 'new'
      signalingState = 'stable'
      localDescription = null
      onconnectionstatechange = null
      ontrack = null
      addTrack() {}
      createDataChannel() { return {} }
      async createOffer() { window.__phase3Media.offers += 1; return { type: 'offer', sdp: 'PHASE3_OFFER' } }
      async setLocalDescription(value) { this.localDescription = value; this.signalingState = 'have-local-offer' }
      async setRemoteDescription(value) {
        if (value.sdp !== 'PHASE3_ANSWER') throw new Error('Unexpected answer')
        window.__phase3Media.answers += 1
        this.signalingState = 'stable'
        this.connectionState = 'connected'
        this.onconnectionstatechange?.()
        this.ontrack?.({ streams: [new MediaStream()] })
      }
      close() { if (this.connectionState !== 'closed') window.__phase3Media.closed += 1; this.connectionState = 'closed' }
    }
  }, theme)
  await context.route('**/codex-api/native-extension-info*', route => fixture ? route.fulfill({ json: { data: info } }) : route.continue())
  await context.route('**/codex-api/realtime-session*', async route => {
    if (!fixture) return route.continue()
    if (route.request().method() === 'GET') { const ownerId = new URL(route.request().url()).searchParams.get('ownerId'); return route.fulfill({ json: { data: { active: Boolean(realtime), owned: realtime?.ownerId === ownerId, phase: realtime ? 'accepted' : 'idle' } } }) }
    const body = route.request().postDataJSON()
    requests.push({ method: `realtime/${body.action}`, params: body })
    if (body.action === 'start' && rejectStart) { rejectStart = false; return route.fulfill({ status: 502, json: { error: 'PHASE3_PROVIDER_REJECTED' } }) }
    if (body.action === 'start') {
      assert.equal(body.options.version, 'v1'); assert.equal(body.options.outputModality, 'audio'); assert.equal(body.options.transport.type, 'webrtc')
      realtime = { ownerId: body.ownerId }
      await route.fulfill({ json: { data: { active: true, owned: true, phase: 'accepted' } } })
      await emit('thread/realtime/started', { threadId, realtimeSessionId: 'fixture-session', version: 'v1' })
      await emit('thread/realtime/sdp', { threadId, sdp: 'PHASE3_ANSWER' })
      return
    }
    if (body.action === 'stop') realtime = null
    return route.fulfill({ json: { data: { active: Boolean(realtime), owned: Boolean(realtime), phase: realtime ? 'accepted' : 'idle' } } })
  })
  await context.route('**/codex-api/agent-progress*', route => fixture ? route.fulfill({ json: { data: progress } }) : route.continue())
  await context.route('**/codex-api/thread-runtime-state*', route => fixture ? route.fulfill({ json: { data: [{ threadId, turnId, state: 'running', isRunning: true, source: 'local', startedAtIso: new Date().toISOString(), completedAtIso: null, owner: null }] } }) : route.continue())
  await context.route('**/codex-api/rpc', async route => {
    if (!fixture) return route.continue()
    const body = route.request().postDataJSON()
    const method = body.method
    const params = body.params || {}
    requests.push(body)
    const result = value => route.fulfill({ json: { result: value } })
    if (method === 'experimentalFeature/list') return result({ data: info.features, nextCursor: null })
    if (method === 'experimentalFeature/enablement/set') { for (const [name, enabled] of Object.entries(params.enablement)) info.features.find(row => row.name === name).enabled = enabled; return result({ enablement: params.enablement }) }
    if (method === 'plugin/installed') return result({ marketplaces: [{ name: 'fixture', plugins: [{ id: 'blocked-plugin', name: 'PHASE3_PLUGIN', installed: true, enabled: false, availability: 'DISABLED_BY_ADMIN', disabledReason: 'disabled_by_admin', localVersion: '1.0', version: '1.1' }] }], marketplaceLoadErrors: [] })
    if (method === 'thread/list' && params.ancestorThreadId) { assert.equal(params.ancestorThreadId, threadId); return result({ data: params.archived ? [] : children, nextCursor: null }) }
    if (method === 'thread/list') {
      const response = await route.fetch(); const value = await response.json()
      value.result.data = value.result.data.map(row => row.id === threadId ? currentThread() : row)
      return route.fulfill({ response, json: value })
    }
    if (params.threadId === threadId && ['thread/read', 'thread/resume'].includes(method)) return result({ thread: currentThread(), model: 'gpt-6-astra', reasoningEffort: 'low' })
    if (params.threadId === threadId && method === 'thread/turns/list') return result({ data: [activeTurn], nextCursor: null })
    if (params.threadId === threadId && method === 'thread/items/list') return result({ data: activeTurn.items.map(item => ({ item, turnId })), nextCursor: null })
    if (method === 'thread/realtime/listVoices') return result({ voices: { v1: ['cove', 'sol'], v2: ['marin'], defaultV1: 'cove', defaultV2: 'marin' } })
    if (method === 'remoteControl/status/read') return result(remote)
    if (method === 'remoteControl/enable') {
      assert.equal(params.ephemeral, true)
      remote = { ...remote, status: 'connected', environmentId: 'environment-fixture' }
      await emit('remoteControl/status/changed', remote)
      return result({ ...remote, status: 'connecting' })
    }
    if (method === 'remoteControl/disable') { assert.equal(params.ephemeral, true); remote = { ...remote, status: 'disabled', environmentId: null }; return result(remote) }
    if (method === 'remoteControl/pairing/start') return result({ environmentId: remote.environmentId, pairingCode: 'PHASE3_PAIRING_SECRET', manualPairingCode: 'PHASE3_MANUAL', expiresAt: Math.floor(Date.now() / 1000) + 60 })
    if (method === 'remoteControl/pairing/status') return result({ claimed: true })
    if (method === 'remoteControl/client/list') return result({ data: clients, nextCursor: null })
    if (method === 'remoteControl/client/revoke') { assert.equal(params.environmentId, 'environment-fixture'); clients = []; return result({}) }
    if (['config/batchWrite', 'config/value/write', 'turn/start', 'thread/realtime/start'].includes(method)) return route.fulfill({ status: 409, json: { error: 'Fixture forbids writes to real CLI/config' } })
    return route.continue()
  })
  const url = `${base}/#/thread/${threadId}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator('.conversation-item').filter({ hasText: 'PHASE3_LINK_20260905' }).last().waitFor({ timeout: 30000 })
  const fileLink = page.locator('.conversation-item[data-role="assistant"] a').filter({ hasText: /^README\.md$/ }).last()
  const link = await fileLink.evaluate(element => ({ href: element.getAttribute('href'), title: element.title, text: element.textContent }))
  const linkResult = { hrefOk: link.href === '/codex-local-browse/tmp/codex-webui-phase2-TestChat/README.md', titleOk: link.title === 'README.md', textOk: link.text === 'README.md' }
  assert(Object.values(linkResult).every(Boolean))
  const screenshots = []
  async function capture(name) { await page.waitForTimeout(2300); const path = resolve(output, `${name}-${theme}-${viewport.width}-cjs.png`); await page.screenshot({ path }); screenshots.push(path) }
  await capture('testchat-phase3')
  actualThread = (await (await page.request.post(`${base}/codex-api/rpc`, { data: { method: 'thread/read', params: { threadId, includeTurns: true } } })).json()).result.thread
  fixture = true
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText('PHASE3_ACTIVITY_UI', { exact: true }).waitFor({ timeout: 30000 })
  await page.waitForFunction(() => window.__phase3Sockets?.some(socket => socket.readyState === WebSocket.OPEN))
  await emit('codex-ui/agent-progress', { progress })
  if (await page.locator('.turn-progress-mobile-open').isVisible()) await page.locator('.turn-progress-mobile-open').click()
  else if (await page.locator('.turn-progress-agent-details-toggle').getAttribute('aria-expanded') === 'false') await page.locator('.turn-progress-agent-details-toggle').click()
  const agentLink = page.locator('.turn-progress-agent-link').first()
  await agentLink.waitFor()
  assert.equal(await agentLink.getAttribute('href'), `#/thread/${childId}`)
  if (await page.locator('.turn-progress-close').isVisible()) await page.locator('.turn-progress-close').click()
  await page.getByTestId('native-extensions-open').click()
  const panel = page.getByTestId('native-extensions')
  await panel.locator('[data-feature="plugins"]').waitFor()
  assert.equal(await panel.locator('[data-feature="apps"] button').count(), 0)
  assert.equal(await panel.locator('[data-feature="plugins"] button').count(), 0)
  assert.equal(await panel.locator('[data-feature="memories"] button').count(), 0)
  await panel.locator('[data-plugin="blocked-plugin"]').getByText(/DISABLED_BY_ADMIN/).waitFor()
  await panel.locator('[data-feature="tool_suggest"] button').click()
  await panel.getByTestId('feature-confirm').click()
  await panel.locator('[data-feature="tool_suggest"]').getByText(/CLI 未启用/).waitFor()
  const background = await panel.evaluate(element => getComputedStyle(element).backgroundColor)
  assert.equal(background, theme === 'dark' ? 'rgb(24, 24, 27)' : 'rgb(250, 250, 250)')
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await capture('phase3-features')
  await panel.getByTestId('extension-tab-context').click()
  await panel.getByText(/不能据此认定实际生效/).waitFor()
  await emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, last: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 }, modelContextWindow: 123456 } })
  await panel.getByTestId('native-context-window').filter({ hasText: '123,456' }).waitFor()
  await capture('phase3-context')
  await panel.getByTestId('extension-tab-agents').click()
  await panel.locator(`[data-child-thread="${childId}"]`).waitFor()
  assert.equal(await panel.locator(`[data-child-thread="${childId}"] a`).getAttribute('href'), `#/thread/${childId}`)
  await panel.getByText(/未加载（不代表完成）/).first().waitFor()
  await capture('phase3-agents')
  await panel.getByTestId('extension-tab-remote').click()
  await panel.getByTestId('remote-enable').click()
  assert.equal(requests.filter(row => row.method === 'remoteControl/enable').length, 0)
  await panel.getByTestId('remote-confirm-enable').click()
  await panel.getByTestId('remote-status').filter({ hasText: '已连接' }).waitFor()
  await panel.getByTestId('remote-pair').click()
  await panel.getByTestId('remote-pairing').getByText('PHASE3_MANUAL', { exact: true }).waitFor()
  await panel.getByRole('button', { name: '查询配对结果', exact: true }).click()
  await panel.getByText('PHASE3_MANUAL', { exact: true }).waitFor({ state: 'hidden' })
  await panel.getByText(/PHASE3_DEVICE/).waitFor()
  await panel.getByRole('button', { name: '撤销访问', exact: true }).click()
  await panel.getByTestId('remote-confirm-revoke').click()
  await panel.getByText(/PHASE3_DEVICE/).waitFor({ state: 'hidden' })
  await capture('phase3-remote')
  await panel.getByTestId('remote-disable').click()
  await panel.getByTestId('remote-status').filter({ hasText: '已停用' }).waitFor()
  await panel.getByTestId('extension-tab-realtime').click()
  await panel.getByTestId('realtime-start').waitFor()
  assert.equal(await page.evaluate(() => window.__phase3Media.opened), 0)
  await panel.getByTestId('realtime-start').click()
  await panel.getByText('PHASE3_PROVIDER_REJECTED', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__phase3Media.opened === window.__phase3Media.stopped), true)
  await panel.getByTestId('realtime-start').click()
  await panel.getByTestId('realtime-status').filter({ hasText: 'WebRTC 已连接' }).waitFor()
  await emit('thread/realtime/transcript/delta', { threadId, role: 'assistant', delta: 'PHASE3_TRANSCRIPT' })
  await emit('thread/realtime/transcript/done', { threadId, role: 'assistant', text: 'PHASE3_TRANSCRIPT_FINAL' })
  await panel.locator('.native-realtime-transcript').getByText(/PHASE3_TRANSCRIPT_FINAL/).waitFor()
  await panel.getByLabel('向实时会话补充文本').fill('PHASE3_REALTIME_TEXT')
  await panel.getByRole('button', { name: '发送到实时会话', exact: true }).click()
  await capture('phase3-realtime')
  await panel.getByTestId('native-extensions-close').click()
  await panel.waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.__phase3Media.opened === window.__phase3Media.stopped), true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByTestId('native-extensions-open').click()
  await panel.locator('[data-feature="tool_suggest"]').getByText(/CLI 未启用/).waitFor()
  await panel.getByTestId('extension-tab-agents').click()
  await panel.locator(`[data-child-thread="${childId}"]`).waitFor()
  await panel.getByTestId('extension-tab-realtime').click()
  await panel.getByTestId('realtime-start').waitFor()
  assert.equal(await page.evaluate(() => window.__phase3Media.opened), 0)
  assert.equal(requests.filter(row => ['config/batchWrite', 'config/value/write', 'turn/start', 'thread/realtime/start'].includes(row.method)).length, 0)
  assert.deepEqual(errors, [])
  reports.push({ url, theme, viewport, background, linkResult, nativeAgentLink: true, featureReadbackAndRefresh: true, managedFeatureLocked: true, childHistoryRestored: true, contextEvidenceHonest: true, remoteEphemeralConfirmPairRevoke: true, realtimeTransport: 'WebRTC V1 fixture', microphoneOnlyAfterClick: true, microphoneStoppedOnFailureAndClose: true, noAutoReconnectAfterReload: true, screenshots, pageErrors: errors })
  await context.unrouteAll({ behavior: 'wait' })
  await context.close()
  console.log(`${theme} ${viewport.width}: passed`)
}

;(async () => {
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }, { width: 768, height: 1024 }]) for (const theme of ['light', 'dark']) await verify(browser, theme, viewport)
    writeFileSync(resolve(output, 'phase3-browser-report.json'), JSON.stringify(reports, null, 2))
  } catch (error) {
    for (const context of browser.contexts()) for (const page of context.pages()) { console.error((await page.locator('body').innerText()).slice(-4500)); await page.screenshot({ path: resolve(output, 'phase3-browser-failed.png') }).catch(() => {}) }
    throw error
  } finally { await browser.close() }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
