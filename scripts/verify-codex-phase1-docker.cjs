const { execFileSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const root = mkdtempSync(resolve(require('node:os').tmpdir(), 'codexui-phase1-docker-'))
const output = resolve('output/playwright')
const image = process.env.PHASE1_DOCKER_IMAGE || 'linux-codex-webui-phase1:20260905'
const reportPrefix = process.env.CODEX_ACCEPTANCE_REPORT_PREFIX || 'phase1'
assert.match(reportPrefix, /^[a-z0-9-]+$/)
const containers = []
const reports = []
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const wait = duration => new Promise(resolve => setTimeout(resolve, duration))
async function fetchJson(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(30000), ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const payload = await response.json()
  assert.equal(response.ok, true, `${port} ${path}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}
async function rpc(port, method, params = {}) {
  const payload = await fetchJson(port, '/codex-api/rpc', { method, params })
  if (payload.error) throw new Error(`${method}: ${JSON.stringify(payload.error)}`)
  return payload.result
}
async function readReadyThread(port, threadId) {
  for (let attempt = 0; ; attempt++) {
    try { return await rpc(port, 'thread/read', { threadId, includeTurns: true }) }
    catch (error) {
      if (attempt >= 39 || !/list_turns is not supported yet|no rollout found|not materialized/i.test(error.message)) throw error
      await wait(250)
    }
  }
}
const provider = name => `\n[model_providers.${name}]\nname = "Phase1 ${name}"\nbase_url = "http://127.0.0.1:8099/${name}/v1"\nwire_api = "responses"\nrequires_openai_auth = ${name === 'invalid'}\nexperimental_bearer_token = "phase1-fake-only"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`
async function start(name, port, config, auth) {
  const home = resolve(root, name)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(resolve(home, 'config.toml'), config, { mode: 0o600 })
  if (auth !== undefined) writeFileSync(resolve(home, 'auth.json'), auth, { mode: 0o600 })
  const container = `codex-webui-phase1-${process.pid}-${name}`
  containers.push(container)
  docker('run', '-d', '--name', container, '-p', `127.0.0.1:${port}:4190`, '-v', `${home}:/codex-home`, '-v', `${resolve(__dirname, 'fixtures/codex-phase1-provider.cjs')}:/mock/provider.cjs:ro`, image)
  docker('exec', '-d', container, 'node', '/mock/provider.cjs')
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { await fetchJson(port, '/codex-api/runtime-info'); return } catch { await wait(500) }
  }
  throw new Error(`${container} failed readiness`)
}
async function checkUi(browser, name, port) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.thread-composer-input').waitFor({ timeout: 30000 })
  assert.equal(await page.getByText('OpenCode Zen', { exact: true }).count(), 0)
  assert.deepEqual(errors, [])
  await page.waitForTimeout(2300)
  const screenshot = resolve(output, `${reportPrefix}-docker-${name}.png`)
  await page.screenshot({ path: screenshot })
  await page.close()
  return screenshot
}
;(async () => {
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  try {
    const baseConfig = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "low"\n'
    for (const [name, port, auth] of [['no-auth', 4191, undefined], ['malformed-auth', 4192, '{invalid-json']]) {
      await start(name, port, baseConfig, auth)
      let configRead = 'ok'
      try { await rpc(port, 'config/read', { includeLayers: false }) } catch (error) { configRead = error.message }
      const screenshot = await checkUi(browser, name, port)
      const runtime = (await fetchJson(port, '/codex-api/runtime-info')).data
      assert.equal(runtime.codex.version, '0.153.4')
      reports.push({ name, port, configRead, cli: runtime.codex.version, home: runtime.codex.home, screenshot, noLegacyFallback: true })
      console.log(`${name}: passed`)
    }
    await start('invalid-auth', 4193, `${baseConfig}model_provider = "invalid"\n${provider('invalid')}`, JSON.stringify({ OPENAI_API_KEY: 'sk-phase1-invalid' }))
    const started = await rpc(4193, 'thread/start', { model: 'gpt-6-astra', cwd: '/project', approvalPolicy: 'never', sandbox: 'read-only' })
    const threadId = started.thread.id
    await fetch(`http://127.0.0.1:4193/codex-api/workspace-roots-state`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order: ['/project'], active: ['/project'], labels: { '/project': 'TestChat' } }), signal: AbortSignal.timeout(5000) })
    await rpc(4193, 'turn/start', { threadId, input: [{ type: 'text', text: 'PHASE1_DOCKER_INVALID_AUTH' }], model: 'gpt-6-astra', effort: 'low' })
    let thread
    for (let attempt = 0; attempt < 50; attempt += 1) {
      thread = (await readReadyThread(4193, threadId)).thread
      if (thread.turns.some(turn => turn.status === 'failed')) break
      await wait(500)
    }
    const failedTurn = thread.turns.find(turn => turn.status === 'failed')
    assert.ok(failedTurn, 'Invalid auth must create a failed turn')
    assert.ok(JSON.stringify(failedTurn).includes('PHASE1_INVALID_AUTH'))
    const screenshots = []
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
      await page.addInitScript(theme => localStorage.setItem('codex-web-local.dark-mode.v1', theme), theme)
      await page.goto(`http://127.0.0.1:4193/#/thread/${threadId}`, { waitUntil: 'domcontentloaded' })
      await page.locator('.conversation-item').filter({ hasText: 'PHASE1_INVALID_AUTH' }).waitFor({ timeout: 30000 })
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('.conversation-item').filter({ hasText: 'PHASE1_INVALID_AUTH' }).waitFor({ timeout: 30000 })
      assert.equal(await page.locator('.conversation-item').filter({ hasText: 'PHASE1_INVALID_AUTH' }).count(), 1)
      assert.equal(await page.locator('.turn-progress-card').filter({ hasText: 'PHASE1_INVALID_AUTH' }).count(), 0)
      await page.waitForTimeout(2300)
      const screenshot = resolve(output, `${reportPrefix}-docker-invalid-auth-${theme}.png`)
      await page.screenshot({ path: screenshot })
      screenshots.push(screenshot)
      await page.close()
    }
    const finalThread = (await readReadyThread(4193, threadId)).thread
    assert.equal(finalThread.turns.length, 1)
    reports.push({ name: 'invalid-auth', port: 4193, threadId, status: failedTurn.status, afterRefresh: true, duplicateOverlayCount: 0, noRetryOrModelFallback: true, screenshots })
    console.log('invalid-auth: passed')
    await start('provider-switch', 4194, `${baseConfig}model_provider = "alpha"\n${provider('alpha')}${provider('beta')}`)
    const before = await fetchJson(4194, '/codex-api/provider-models')
    assert.deepEqual(before.data, ['gpt-6-astra'])
    await rpc(4194, 'config/batchWrite', { edits: [{ keyPath: 'model_provider', value: 'beta', mergeStrategy: 'upsert' }, { keyPath: 'model', value: 'gpt-5.6-luna', mergeStrategy: 'upsert' }], reloadUserConfig: true })
    const after = await fetchJson(4194, '/codex-api/provider-models')
    assert.deepEqual(after.data, ['gpt-5.6-luna'])
    reports.push({ name: 'provider-switch', port: 4194, before: before.data, after: after.data, screenshot: await checkUi(browser, 'provider-switch', 4194) })
    console.log('provider-switch: passed')
    if (process.env.VERIFY_THREAD_FAST === '1') {
      await rpc(4194, 'config/batchWrite', { edits: [{ keyPath: 'service_tier', value: 'priority', mergeStrategy: 'upsert' }, { keyPath: 'features.fast_mode', value: true, mergeStrategy: 'upsert' }], reloadUserConfig: true })
      const speeds = []
      for (const serviceTier of ['priority', null]) {
        const t = (await rpc(4194, 'thread/start', { model: 'gpt-5.6-luna', cwd: '/project', serviceTier })).thread
        await rpc(4194, 'turn/start', { threadId: t.id, model: 'gpt-5.6-luna', effort: 'low', serviceTier, input: [{ type: 'text', text: serviceTier ? 'THREAD_SPEED_FIXTURE_FAST' : 'THREAD_SPEED_FIXTURE_STANDARD' }] })
        let done = false
        for (let i = 0; i < 40; i++) { const t2 = (await readReadyThread(4194, t.id)).thread; if (t2.turns.some(turn => turn.status === 'failed')) { done = true; break } await wait(250) }
        assert(done)
        speeds.push({ threadId: t.id, serviceTier })
      }
      const captured = docker('exec', containers.at(-1), 'cat', '/tmp/codex-provider-tiers.jsonl').split('\n').filter(Boolean).map(line => JSON.parse(line))
      // Title generation or authentication can add requests; validate the user turns by their unique markers.
      for (const [marker, tier] of [['THREAD_SPEED_FIXTURE_FAST', 'priority'], ['THREAD_SPEED_FIXTURE_STANDARD', null]]) {
        const requests = captured.filter(row => row.marker === marker)
        assert(requests.length > 0)
        assert(requests.every(row => row.serviceTier === tier), 'Standard must override legacy global priority: ' + JSON.stringify(requests))
      }
      const prefs = (await fetchJson(4194, '/codex-api/thread-model-preferences')).data
      assert.equal(prefs[speeds[0].threadId].speedMode, 'fast'); assert.equal(prefs[speeds[1].threadId].speedMode, 'standard')
      reports.push({ name: 'per-thread-speed', port: 4194, legacyGlobalTier: 'priority', captured, speeds, preferencesIndependent: true })
      console.log('per-thread-speed: passed')
    }

    writeFileSync(resolve(output, `${reportPrefix}-docker-report.json`), JSON.stringify(reports, null, 2))
    console.log(JSON.stringify(reports, null, 2))
  } catch (error) {
    for (const container of containers) console.error(container, docker('logs', '--tail', '30', container))
    throw error
  } finally {
    await browser.close()
    for (const container of containers) docker('rm', '-f', container)
    rmSync(root, { recursive: true, force: true })
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1 })
