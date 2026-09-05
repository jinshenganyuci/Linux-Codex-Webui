const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const { resolve } = require('node:path')

const base = process.env.PHASE3_BASE_URL || 'http://127.0.0.1:4173'
const threadId = process.env.PHASE3_THREAD_ID || JSON.parse(readFileSync('output/playwright/phase3-runtime-bootstrap.json', 'utf8')).threadId
const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex')
async function api(path, body) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(45000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const value = await response.json()
  if (!response.ok || value.error) throw new Error(`${response.status}: ${value.error?.message || value.error || 'request failed'}`)
  return value
}
const rpc = async (method, params = {}) => (await api('/codex-api/rpc', { method, params })).result
const info = async () => (await api('/codex-api/native-extension-info')).data

async function main() {
  const original = await info()
  const runtime = (await api('/codex-api/runtime-info')).data
  assert(runtime.codex.home.includes('/acceptance/'), 'Only an isolated acceptance HOME is allowed')
  assert.equal(runtime.codex.version, '0.153.4')
  assert.equal(runtime.codex.busy, false)
  assert.equal(original.descendantThreads, true)
  assert.equal(original.requirementsKnown, true)
  assert(!/bearer_token|api_key|email|access_token/i.test(JSON.stringify(original)))
  const configPath = resolve(runtime.codex.home, 'config.toml')
  const configHash = digest(configPath)
  const report = { base, threadId, cliVersion: runtime.codex.version, checkedAt: new Date().toISOString(), provider: original.provider, accountType: original.accountType, warnings: original.warnings, featureCount: original.features.length }
  const methods = (await api('/codex-api/meta/methods')).data
  const required = ['thread/realtime/start', 'thread/realtime/stop', 'thread/realtime/appendText', 'thread/realtime/listVoices', 'remoteControl/status/read', 'remoteControl/enable', 'remoteControl/disable', 'remoteControl/pairing/start', 'remoteControl/pairing/status', 'remoteControl/client/list', 'remoteControl/client/revoke', 'plugin/installed', 'experimentalFeature/enablement/set']
  assert(required.every(method => methods.includes(method)), 'Native Schema must advertise every UI action')
  report.schemaMethods = required
  const startedAt = performance.now()
  const reads = await Promise.all(Array.from({ length: 20 }, info))
  report.concurrentCapabilityReads = { count: reads.length, milliseconds: Math.round(performance.now() - startedAt), responseBytes: Buffer.byteLength(JSON.stringify(original)) }
  assert(reads.every(value => JSON.stringify(value) === JSON.stringify(original)))
  const installed = await rpc('plugin/installed', { cwds: ['/tmp/codex-webui-phase2-TestChat'] })
  assert(Array.isArray(installed.marketplaces))
  report.installedPluginCount = installed.marketplaces.reduce((total, marketplace) => total + marketplace.plugins.length, 0)
  const remote = await rpc('remoteControl/status/read')
  assert.equal(remote.status, 'disabled', 'Acceptance must not have an existing remote session')
  report.remoteStatus = remote.status
  const voiceInfo = await rpc('thread/realtime/listVoices')
  assert(Array.isArray(voiceInfo.voices.v1))
  report.realtimeVoices = { v1Count: voiceInfo.voices.v1.length, defaultV1: voiceInfo.voices.defaultV1 }
  report.children = []
  for (const archived of [false, true]) {
    const result = await rpc('thread/list', { ancestorThreadId: threadId, archived, sourceKinds: [], modelProviders: [], limit: 50 })
    assert(Array.isArray(result.data))
    assert(!result.data.some(thread => thread.id === threadId))
    report.children.push({ archived, count: result.data.length, paginated: Boolean(result.nextCursor) })
  }
  const selected = original.features.find(feature => feature.name === 'tool_suggest')
  assert(selected && !Object.prototype.hasOwnProperty.call(original.featureRequirements, 'tool_suggest'))
  try {
    const changed = await rpc('experimentalFeature/enablement/set', { enablement: { tool_suggest: !selected.enabled } })
    assert.equal(changed.enablement.tool_suggest, !selected.enabled)
    assert.equal((await info()).features.find(feature => feature.name === 'tool_suggest').enabled, !selected.enabled)
    report.runtimeFeatureReadback = true
  } finally {
    await rpc('experimentalFeature/enablement/set', { enablement: { tool_suggest: selected.enabled } })
    assert.equal((await info()).features.find(feature => feature.name === 'tool_suggest').enabled, selected.enabled)
    assert.equal(digest(configPath), configHash)
  }
  report.runtimeFeatureRestored = true
  assert.equal(original.features.find(feature => feature.name === 'realtime_conversation')?.enabled, false, 'Only test the disabled realtime gate; never enable audio implicitly')
  const ownerId = randomUUID()
  const realtimePath = `/codex-api/realtime-session?threadId=${encodeURIComponent(threadId)}&ownerId=${ownerId}`
  assert.equal((await api(realtimePath)).data.active, false)
  await rpc('thread/resume', { threadId, omitTurns: true })
  const scoped = (await api(`/codex-api/native-extension-info?threadId=${encodeURIComponent(threadId)}`)).data
  assert.equal(scoped.threadId, threadId)
  assert.equal(scoped.features.find(feature => feature.name === 'realtime_conversation')?.enabled, false)
  report.currentThreadEvidence = { threadId: scoped.threadId, provider: scoped.provider }
  try {
    await api('/codex-api/realtime-session', { action: 'start', threadId, ownerId, options: { version: 'v1', outputModality: 'audio', transport: { type: 'webrtc', sdp: 'v=0\r\nPHASE3_INVALID_OFFER' } } })
    throw new Error('Disabled realtime start unexpectedly succeeded')
  } catch (error) {
    assert.match(error.message, /realtime_conversation.*disabled|realtime.*not enabled|realtime.*disabled|does not support realtime conversation/i)
    report.realtimeDisabledRejection = error.message
  } finally {
    await api('/codex-api/realtime-session', { action: 'stop', threadId, ownerId })
  }
  assert.equal((await api(realtimePath)).data.active, false)
  assert.equal((await rpc('remoteControl/status/read')).status, 'disabled')
  assert.equal(digest(configPath), configHash)
  report.configUnchanged = true
  report.realAudioAndPairingTested = false
  report.noAgentsSpawned = true
  writeFileSync(resolve('output/playwright/phase3-native-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
