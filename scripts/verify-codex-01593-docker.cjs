#!/usr/bin/env node
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:net')
const { tmpdir } = require('node:os')
const { resolve } = require('node:path')

const PORT = Number.parseInt(process.env.CODEX_DOCKER_TEST_PORT || '13511', 10)
const BASE_URL = `http://127.0.0.1:${PORT}`
const VERSION = process.env.CODEX_DOCKER_TEST_VERSION || '0.159.3'
const PREFIX = process.env.CODEX_DOCKER_TEST_PREFIX || 'codex-01593-docker'
const image = process.env.CODEX_01593_DOCKER_IMAGE || 'linux-codex-webui-codex-01593:local'
const output = resolve(__dirname, '../output/playwright')
const nativeHistory = process.env.CODEX_01593_NATIVE_HISTORY !== '0'
const viewport = { width: 1280, height: 900 }
const report = {
  cliVersion: VERSION, image, baseUrl: BASE_URL, viewport,
  authCoverage: 'Local mock provider returns invalid/expired credential HTTP 401; this does not simulate ChatGPT OAuth token refresh.',
  legacyWorkflowDifference: 'This repository removed automatic Zen fallback. No-auth/malformed-auth cases check existing startup behavior; alpha/beta mock providers replace external Zen/OpenRouter services.',
  cases: [],
}
let root
let activeContainer
let browser
const wait = duration => new Promise(resolveWait => setTimeout(resolveWait, duration))
const docker = (...args) => execFileSync('docker', args, {
  encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim()

// This function is serialized into a temporary, read-only bind mount. No repo fixture changes.
function mockProviderMain() {
  const { createServer: createHttpServer } = require('node:http')
  const { appendFileSync } = require('node:fs')
  let responseIndex = 0
  createHttpServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1:8099').pathname
    const provider = pathname.split('/').filter(Boolean)[0] || 'health'
    response.setHeader('Content-Type', 'application/json')
    if (pathname === '/health') { response.end('{"ready":true}'); return }
    if (pathname.endsWith('/models')) {
      response.end(JSON.stringify({ object: 'list', data: [{ id: provider === 'beta' ? 'gpt-5.6-luna' : 'gpt-6-astra', object: 'model' }] }))
      return
    }
    if (!pathname.endsWith('/responses')) { response.statusCode = 404; response.end('{}'); return }
    let body = ''
    for await (const chunk of request) body += chunk
    let payload
    try { payload = JSON.parse(body) } catch { response.statusCode = 400; response.end('{}'); return }
    const inputText = JSON.stringify(payload.input || [])
    // Capture only test identifiers and routing metadata, never bearer tokens or arbitrary prompts.
    const markers = [...new Set(inputText.match(/CODEX_01593_[A-Z0-9_]+/g) || [])]
    appendFileSync('/tmp/codex-01593-provider.jsonl', JSON.stringify({
      provider, model: payload.model, serviceTier: payload.service_tier ?? null, markers,
    }) + '\n')
    if (provider === 'invalid' || provider === 'expired') {
      response.statusCode = 401
      response.end(JSON.stringify({ error: {
        message: provider === 'invalid' ? 'CODEX_01593_INVALID_AUTH: simulated invalid credential' : 'CODEX_01593_EXPIRED_AUTH: simulated expired credential',
        type: 'invalid_request_error', code: provider === 'invalid' ? 'invalid_api_key' : 'expired_api_key',
      } }))
      return
    }
    const index = ++responseIndex
    const marker = markers.at(-1) || 'CODEX_01593_BACKGROUND'
    const text = `${provider.toUpperCase()}_ACK ${marker}`
    const item = { type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }
    const result = { id: `resp_${index}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: payload.model, output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('response.created', { response: { ...result, status: 'in_progress', output: [] } })
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text })
    send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text })
    send('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
    send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: result })
    response.end()
  }).listen(8099, '127.0.0.1')
}

async function assertPortFree() {
  await new Promise((resolveCheck, reject) => {
    const server = createServer()
    server.once('error', error => reject(new Error(`${BASE_URL} is unavailable (${error.code}). Stop the authorized test service separately; this script never kills listeners.`)))
    server.listen(PORT, '127.0.0.1', () => server.close(resolveCheck))
  })
}

async function fetchJson(path, body, method = body === undefined ? 'GET' : 'POST', timeoutMs = 30000) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const payload = await response.json()
  assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${JSON.stringify(payload).slice(0, 1800)}`)
  return payload
}

async function rpc(method, params = {}, timeoutMs = 30000) {
  const payload = await fetchJson('/codex-api/rpc', { method, params }, 'POST', timeoutMs)
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`)
  return payload.result
}

function providerConfig(name) {
  return `\n[model_providers.${name}]\nname = "01593 mock ${name}"\nbase_url = "http://127.0.0.1:8099/${name}/v1"\nwire_api = "responses"\nrequires_openai_auth = ${['invalid', 'expired'].includes(name)}\nexperimental_bearer_token = "codex-01593-fake-only"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`
}

const baseConfig = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\n'
const analyticsConfig = '\n[analytics]\nenabled = false\n'

function saveReport() {
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(output, `${PREFIX}-report.json`), JSON.stringify(report, null, 2) + '\n')
}

async function startCase(name, config, auth) {
  await assertPortFree()
  const home = resolve(root, name)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(resolve(home, 'config.toml'), config + analyticsConfig, { mode: 0o600 })
  if (auth !== undefined) writeFileSync(resolve(home, 'auth.json'), auth, { mode: 0o600 })
  const containerName = `codex-webui-01593-${process.pid}-${name}-${root.split('-').at(-1).toLowerCase()}`
  const containerId = docker('run', '-d', '--name', containerName,
    '--label', `codex-webui-01593-owner=${process.pid}`,
    '-p', `127.0.0.1:${PORT}:${PORT}`,
    '-e', 'CODEX_HOME=/codex-home', '-e', `PORT=${PORT}`,
    '-v', `${home}:/codex-home`, '-v', `${resolve(root, 'provider.cjs')}:/mock/provider.cjs:ro`,
    '--workdir', '/project', image,
    'sh', '-c', `node /mock/provider.cjs & exec linux-codex-webui --port ${PORT} --no-password --no-open --no-tunnel --no-login`)
  activeContainer = containerId
  let lastError
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    try {
      const runtime = (await fetchJson('/codex-api/runtime-info', undefined, 'GET', 5000)).data
      assert.equal(runtime.codex.version, VERSION, 'Image must contain the requested Codex CLI')
      assert.equal(runtime.codex.home, '/codex-home')
      return runtime
    } catch (error) { lastError = error; await wait(500) }
  }
  throw new Error(`${name} did not become ready: ${lastError?.message}`)
}

function captureProviderRequests() {
  const raw = docker('exec', activeContainer, 'node', '-e', "const fs=require('node:fs');const p='/tmp/codex-01593-provider.jsonl';process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,'utf8'):'')")
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function runCase(name, config, auth, verify) {
  const row = { name, url: BASE_URL, port: PORT, startedAt: new Date().toISOString(), status: 'running' }
  report.cases.push(row)
  saveReport()
  const startedAt = performance.now()
  try {
    const runtime = await startCase(name, config, auth)
    row.runtime = { version: runtime.codex.version, home: runtime.codex.home }
    Object.assign(row, await verify())
    row.providerRequests = captureProviderRequests()
    row.status = 'passed'
    console.log(`${name}: passed`)
  } catch (error) {
    row.status = 'failed'
    row.error = error.message
    throw error
  } finally {
    row.durationMs = Math.round(performance.now() - startedAt)
    if (activeContainer) {
      try {
        const log = docker('logs', '--tail', '180', activeContainer)
        row.logPath = resolve(output, `${PREFIX}-${name}.log`)
        writeFileSync(row.logPath, log)
      } catch {}
      // Only containers created under this exact unique name are removed; no listener is killed.
      docker('rm', '-f', activeContainer)
      activeContainer = undefined
    }
    saveReport()
  }
}

async function recordUi(name, { threadId, marker, errorMarker = false, theme = 'light', reload = false } = {}) {
  const context = await browser.newContext({ viewport })
  await context.addInitScript(themeValue => {
    localStorage.setItem('codex-web-local.dark-mode.v1', themeValue)
    localStorage.setItem('codex-web-local.ui-language.v1', 'en')
  }, theme)
  const page = await context.newPage()
  const pageErrors = []
  const apiCounts = {}
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/codex-api/')) return
    let key = `${request.method()} ${url.pathname}`
    if (url.pathname === '/codex-api/rpc') {
      try { key += ` ${request.postDataJSON()?.method || ''}` } catch {}
    }
    apiCounts[key] = (apiCounts[key] || 0) + 1
  })
  const url = `${BASE_URL}/${threadId ? `#/thread/${threadId}` : ''}`
  let screenshot
  const startedAt = performance.now()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('.thread-composer-input').waitFor({ timeout: 45000 })
    assert.equal(await page.getByText('OpenCode Zen', { exact: true }).count(), 0)
    const markerRows = marker ? page.locator('.conversation-item').filter({ hasText: marker }) : null
    if (markerRows) await markerRows.first().waitFor({ timeout: 45000 })
    if (reload) {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('.thread-composer-input').waitFor({ timeout: 45000 })
      if (markerRows) await markerRows.first().waitFor({ timeout: 45000 })
    }
    await page.waitForTimeout(2300)
    const isDark = await page.locator('html').evaluate(element => element.classList.contains('dark'))
    assert.equal(isDark, theme === 'dark', `Requested ${theme} theme must actually apply`)
    assert.deepEqual(pageErrors, [], 'UI must boot without uncaught errors')
    let duplicateOverlayCount = null
    if (errorMarker) {
      assert.equal(await markerRows.count(), 1, 'Persisted auth failure must render exactly one conversation row')
      duplicateOverlayCount = await page.locator('.turn-progress-card').filter({ hasText: marker }).count()
      assert.equal(duplicateOverlayCount, 0, 'Persisted auth failure must not retain a duplicate live overlay')
    }
    screenshot = resolve(output, `${PREFIX}-${name}-${theme}.png`)
    await page.screenshot({ path: screenshot, fullPage: false })
    return { url, viewport, theme, screenshot, afterRefresh: reload, duplicateOverlayCount, apiCounts, readyAndCaptureMs: Math.round(performance.now() - startedAt) }
  } catch (error) {
    await page.screenshot({ path: resolve(output, `${PREFIX}-${name}-${theme}-failed.png`) }).catch(() => {})
    throw error
  } finally { await context.close() }
}

async function registerProject() {
  await fetchJson('/codex-api/workspace-roots-state', { order: ['/project'], active: ['/project'], labels: { '/project': '01593 isolated mock' } }, 'PUT')
}

async function readTurns(threadId, historyMode = 'paginated') {
  if (historyMode === 'legacy') return (await rpc('thread/read', { threadId, includeTurns: true }, 10000)).thread.turns
  return (await rpc('thread/turns/list', { threadId, limit: 20, sortDirection: 'asc', itemsView: 'full' }, 10000)).data
}

async function waitTurn(threadId, turnId, historyMode) {
  const deadline = Date.now() + 60000
  let lastReadError
  while (Date.now() < deadline) {
    try {
      const turn = (await readTurns(threadId, historyMode)).find(candidate => candidate.id === turnId)
      if (turn && ['failed', 'completed', 'interrupted'].includes(turn.status)) return turn
    } catch (error) {
      if (!/not materialized|no rollout found|not found|list_turns is not supported yet/i.test(error.message)) throw error
      lastReadError = error.message
    }
    await wait(250)
  }
  throw new Error(`Turn ${turnId} did not finish within 60s${lastReadError ? `; last transient history error: ${lastReadError}` : ''}`)
}

async function startThread(model) {
  const result = await rpc('thread/start', { model, cwd: '/project', approvalPolicy: 'never', sandbox: 'read-only' })
  return result.thread
}

async function sendTurn(thread, marker, model) {
  const started = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: marker }], model, effort: 'low' })
  return waitTurn(thread.id, started.turn.id, thread.historyMode)
}

async function verifyRejectedCredential(name) {
  const marker = `CODEX_01593_${name.toUpperCase()}_AUTH`
  await registerProject()
  const thread = await startThread('gpt-6-astra')
  const failed = await sendTurn(thread, `CODEX_01593_TEST_${name.toUpperCase()}_CREDENTIAL`, 'gpt-6-astra')
  assert.equal(failed.status, 'failed')
  assert.ok(JSON.stringify(failed.error).includes(marker), 'CLI must persist the mock provider rejection')
  const ui = []
  for (const theme of ['light', 'dark']) ui.push(await recordUi(`${name}-auth`, { threadId: thread.id, marker, errorMarker: true, theme, reload: true }))
  const turns = await readTurns(thread.id, thread.historyMode)
  assert.equal(turns.length, 1, 'Auth rejection must not create replacement turns')
  return { threadId: thread.id, historyMode: thread.historyMode, turnStatus: failed.status, simulatedProviderHttpStatus: 401, errorPersistedAfterReload: true, duplicateOverlayCount: 0, ui }
}

async function verifyNativeHistory(thread) {
  const first = await sendTurn(thread, 'CODEX_01593_HISTORY_FIRST', 'gpt-5.6-luna')
  const second = await sendTurn(thread, 'CODEX_01593_HISTORY_SECOND', 'gpt-5.6-luna')
  assert.equal(first.status, 'completed')
  assert.equal(second.status, 'completed')
  const fork = await rpc('thread/fork', { threadId: thread.id, lastTurnId: first.id, excludeTurns: true })
  const forkTurns = await readTurns(fork.thread.id, fork.thread.historyMode)
  assert.deepEqual(forkTurns.map(turn => turn.id), [first.id])
  await rpc('thread/revert', { threadId: thread.id, beforeTurnId: second.id })
  const revertedTurns = await readTurns(thread.id, thread.historyMode)
  assert.deepEqual(revertedTurns.map(turn => turn.id), [first.id])
  const ui = await recordUi('native-fork', { threadId: fork.thread.id, marker: 'BETA_ACK CODEX_01593_HISTORY_FIRST', reload: true })
  return { threadId: thread.id, forkedThreadId: fork.thread.id, firstTurnId: first.id, removedTurnId: second.id, forkTurnCount: forkTurns.length, revertedTurnCount: revertedTurns.length, ui }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log(`CODEX_01593_DOCKER_IMAGE=<prebuilt-image> CODEX_DOCKER_TEST_PORT=${PORT} CODEX_DOCKER_TEST_VERSION=${VERSION} node scripts/verify-codex-01593-docker.cjs\nOnly ${BASE_URL}; it must be idle before running. No image build, service stop, or other port is performed.\nCODEX_01593_NATIVE_HISTORY=0 disables the extra real-CLI two-turn fork/revert test.\nReports: ${output}/${PREFIX}-report.json`)
    return
  }
  assert.equal(process.argv.length, 2, 'Only --help is accepted; use environment variables for port and version overrides')
  await assertPortFree()
  report.imageId = docker('image', 'inspect', image, '--format', '{{.Id}}')
  root = mkdtempSync(resolve(tmpdir(), 'codexui-01593-docker-'))
  mkdirSync(output, { recursive: true })
  writeFileSync(resolve(root, 'provider.cjs'), `(${mockProviderMain.toString()})()\n`)
  // Parse the generated provider without executing it or opening its listener.
  new (require('node:vm').Script)(readFileSync(resolve(root, 'provider.cjs'), 'utf8'))
  const { chromium } = require('playwright')
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.CODEX_ACCEPTANCE_BROWSER_PATH ? { executablePath: process.env.CODEX_ACCEPTANCE_BROWSER_PATH } : {}) })
    for (const [name, auth] of [['no-auth', undefined], ['malformed-auth', '{invalid-json']]) {
      await runCase(name, baseConfig, auth, async () => {
        let configRead = 'ok'
        try { await rpc('config/read', { includeLayers: false }) } catch (error) { configRead = error.message }
        return { configRead, noLegacyFallback: true, ui: [await recordUi(name)] }
      })
    }
    for (const name of ['invalid', 'expired']) {
      await runCase(`${name}-auth`, `${baseConfig}model_provider = "${name}"\n${providerConfig(name)}`,
        JSON.stringify({ OPENAI_API_KEY: `sk-codex-01593-${name}-fake-only` }), () => verifyRejectedCredential(name))
    }
    await runCase('provider-switch', `${baseConfig}model_provider = "alpha"\n${providerConfig('alpha')}${providerConfig('beta')}`, undefined, async () => {
      await registerProject()
      const before = await fetchJson('/codex-api/provider-models')
      assert.deepEqual(before.data, ['gpt-6-astra'])
      const alpha = await startThread('gpt-6-astra')
      assert.equal((await sendTurn(alpha, 'CODEX_01593_ALPHA_ROUTE', 'gpt-6-astra')).status, 'completed')
      const ui = [await recordUi('provider-alpha', { threadId: alpha.id, marker: 'ALPHA_ACK CODEX_01593_ALPHA_ROUTE' })]
      await rpc('config/batchWrite', { edits: [
        { keyPath: 'model_provider', value: 'beta', mergeStrategy: 'upsert' },
        { keyPath: 'model', value: 'gpt-5.6-luna', mergeStrategy: 'upsert' },
      ], reloadUserConfig: true })
      const after = await fetchJson('/codex-api/provider-models')
      assert.deepEqual(after.data, ['gpt-5.6-luna'])
      const beta = await startThread('gpt-5.6-luna')
      assert.equal((await sendTurn(beta, 'CODEX_01593_BETA_ROUTE', 'gpt-5.6-luna')).status, 'completed')
      ui.push(await recordUi('provider-beta', { threadId: beta.id, marker: 'BETA_ACK CODEX_01593_BETA_ROUTE', theme: 'dark', reload: true }))
      const captured = captureProviderRequests()
      for (const [provider, marker, model] of [['alpha', 'CODEX_01593_ALPHA_ROUTE', 'gpt-6-astra'], ['beta', 'CODEX_01593_BETA_ROUTE', 'gpt-5.6-luna']]) {
        const rows = captured.filter(row => row.markers.includes(marker))
        assert.ok(rows.length > 0, `Mock must receive ${provider} user turn`)
        assert.ok(rows.every(row => row.provider === provider && row.model === model), `Incorrect provider routing for ${marker}`)
      }
      return { beforeModels: before.data, afterModels: after.data, ui, ...(nativeHistory ? { nativeHistory: await verifyNativeHistory(await startThread('gpt-5.6-luna')) } : {}) }
    })
    report.status = 'passed'
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser?.close()
    browser = undefined
    if (activeContainer) { docker('rm', '-f', activeContainer); activeContainer = undefined }
    try {
      rmSync(root, { recursive: true, force: true })
      root = undefined
    } catch (error) {
      report.retainedTempRoot = root
      report.cleanupWarning = error.message
    }
    saveReport()
  }
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    if (activeContainer) { try { docker('rm', '-f', activeContainer) } catch {} }
    if (root) {
      try { rmSync(root, { recursive: true, force: true }) }
      catch (error) { report.retainedTempRoot = root; report.cleanupWarning = error.message }
    }
    report.status = 'interrupted'
    saveReport()
    process.exit(code)
  })
}

main().catch(error => {
  report.status = 'failed'
  report.error = error.message
  saveReport()
  console.error(error.stack)
  process.exitCode = 1
})
