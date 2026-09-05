const assert = require('node:assert/strict')
const { readFileSync, writeFileSync } = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const { resolve } = require('node:path')

const base = process.env.PHASE2_BASE_URL || 'http://127.0.0.1:4173'
const threadId = process.env.PHASE2_THREAD_ID || JSON.parse(readFileSync('output/playwright/phase2-runtime-bootstrap.json', 'utf8')).threadId
const output = resolve('output/playwright/phase2-native-report.json')
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const digest = filename => createHash('sha256').update(readFileSync(filename)).digest('hex')
const createdQueueIds = []
let ownTurnId = ''

async function api(endpoint, method = 'GET', body) {
  const response = await fetch(base + endpoint, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000) })
  const value = await response.json()
  if (!response.ok || value.error) throw new Error(`${endpoint}: HTTP ${response.status}: ${String(value.error?.message || value.error || 'request failed')}`)
  return value
}
const rpc = async (method, params = {}) => (await api('/codex-api/rpc', 'POST', { method, params })).result
const queue = async () => (await rpc('thread/queue/list', { threadId, limit: 100 })).data
const mode = value => api('/codex-api/native-queue-mode', 'PUT', { threadId, mode: value })

async function waitTurn(turnId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const thread = (await rpc('thread/read', { threadId, includeTurns: true })).thread
    const turn = thread.turns.find(item => item.id === turnId)
    if (turn?.status === 'completed') return turn
    if (turn?.status === 'failed') throw new Error('The isolated model turn failed')
    await pause(700)
  }
  throw new Error('Isolated model turn timed out')
}

async function main() {
  await rpc('experimentalFeature/list', { limit: 1 })
  const runtime = (await api('/codex-api/runtime-info')).data
  assert(runtime.codex.home.includes('/acceptance/'), 'Only an isolated acceptance HOME is allowed')
  assert.equal(runtime.codex.version, '0.153.4')
  assert.equal(runtime.codex.busy, false, 'Acceptance runtime must be idle')
  await rpc('thread/resume', { threadId, omitTurns: true })
  const configPath = resolve(runtime.codex.home, 'config.toml')
  const configHash = digest(configPath)
  const originalMode = (await api(`/codex-api/native-queue-mode?threadId=${encodeURIComponent(threadId)}`)).data.mode
  assert.equal((await queue()).length, 0, 'Existing queued input must not be touched')
  const existingGoal = (await rpc('thread/goal/get', { threadId })).goal
  assert.equal(existingGoal, null, 'Existing goals must not be overwritten')
  const report = { base, threadId, cliVersion: runtime.codex.version, webuiCommit: runtime.webui.commit, checkedAt: new Date().toISOString() }
  try {
    const created = (await rpc('thread/goal/set', { threadId, objective: 'PHASE2_GOAL_API_20260905', tokenBudget: 1234, status: 'paused' })).goal
    assert.equal(created.status, 'paused')
    const updated = (await rpc('thread/goal/set', { threadId, tokenBudget: 2345 })).goal
    assert.equal(updated.tokensUsed, created.tokensUsed)
    assert.equal(updated.createdAt, created.createdAt)
    assert.equal((await rpc('thread/goal/get', { threadId })).goal.tokenBudget, 2345)
    await rpc('thread/goal/clear', { threadId })
    assert.equal((await rpc('thread/goal/get', { threadId })).goal, null)
    report.goalCrud = true
    await rpc('thread/settings/update', { threadId, model: 'gpt-6-astra', effort: 'low', serviceTier: null })
    const profiles = (await rpc('permissionProfile/list', { limit: 100 })).data
    assert(profiles.some(profile => profile.id === ':read-only' && profile.allowed))
    await rpc('thread/settings/update', { threadId, permissions: ':read-only' })
    let settings = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      settings = (await api(`/codex-api/native-queue-mode?threadId=${encodeURIComponent(threadId)}`)).data.settings
      if (settings?.permissionProfile === ':read-only' && settings?.effort === 'low') break
      await pause(100)
    }
    assert.equal(settings.permissionProfile, ':read-only')
    assert.equal(settings.model, 'gpt-6-astra')
    assert.equal(settings.effort, 'low')
    report.threadSettingsAndPermissionProfile = settings
    await mode('native')
    const started = await rpc('turn/start', { threadId, model: 'gpt-6-astra', effort: 'low', input: [{ type: 'text', text: '这是隔离的只读验收。请执行一次 shell 命令 sleep 8; cat README.md，不能修改文件或请求额外权限。命令完成后只回复 PHASE2_ACTIVE_20260905 和 README 中的验收标记，不做其他任务。' }] })
    ownTurnId = started.turn.id
    const settingsResult = await rpc('turn/settings/update', { threadId, turnId: ownTurnId, effort: 'low' })
    assert.equal(settingsResult.status, 'applied')
    const steered = await rpc('turn/steer', { threadId, expectedTurnId: ownTurnId, input: [{ type: 'text', text: '补充：最终回复必须再带上 PHASE2_STEER_20260905。保持同一个回合和只读限制。' }] })
    assert.equal(steered.turnId, ownTurnId)
    report.steerTurnId = steered.turnId
    report.turnSettingsStatus = settingsResult.status
    const first = (await rpc('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: '只回复 PHASE2_QUEUE_ORIGINAL_20260905，不使用工具。' }] })).queuedSubmission
    createdQueueIds.push(first.id)
    const second = (await rpc('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: '只回复 PHASE2_QUEUE_DELETE_20260905，不使用工具。' }] })).queuedSubmission
    createdQueueIds.push(second.id)
    await rpc('thread/queue/update', { threadId, queuedSubmissionId: first.id, input: [{ type: 'text', text: '只回复 PHASE2_QUEUE_EDITED_20260905，不使用任何工具。' }] })
    await rpc('thread/queue/reorder', { threadId, queuedSubmissionIds: [second.id, first.id] })
    assert.deepEqual((await queue()).map(item => item.id), [second.id, first.id])
    await rpc('thread/queue/delete', { threadId, queuedSubmissionId: second.id })
    assert.deepEqual((await queue()).map(item => item.id), [first.id])
    const completed = await waitTurn(ownTurnId)
    const finalText = completed.items.filter(item => item.type === 'agentMessage').map(item => item.text || '').join('\n')
    assert(finalText.includes('PHASE2_STEER_20260905'), 'The insertion did not reach the actual model response')
    report.steerReachedModel = true
    await pause(1800)
    const remaining = await queue()
    report.cliAutomaticallyDrainedQueue = remaining.length === 0
    if (remaining.some(item => item.id === first.id)) {
      const queued = await rpc('thread/queue/start', { threadId, queuedSubmissionId: first.id })
      ownTurnId = queued.turn.id
      const result = await waitTurn(ownTurnId)
      assert(result.items.some(item => item.type === 'agentMessage' && item.text?.includes('PHASE2_QUEUE_EDITED_20260905')))
      report.explicitQueueStart = true
    } else {
      const turns = (await rpc('thread/read', { threadId, includeTurns: true })).thread.turns
      const latest = turns.at(-1)
      const delivered = latest.status === 'completed' ? latest : await waitTurn(latest.id)
      assert(delivered.items.some(item => item.type === 'agentMessage' && item.text?.includes('PHASE2_QUEUE_EDITED_20260905')))
    }
    assert.equal((await queue()).length, 0)
    const manual = (await rpc('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: '只回复 PHASE2_QUEUE_MANUAL_20260905，不使用工具。' }] })).queuedSubmission
    createdQueueIds.push(manual.id)
    try {
      const manualStart = await rpc('thread/queue/start', { threadId, queuedSubmissionId: manual.id })
      ownTurnId = manualStart.turn.id
      report.explicitQueueStart = true
    } catch (error) {
      if (!String(error.message).includes('queued submission not found') && !String(error.message).includes('当前会话仍在运行')) throw error
      const latest = (await rpc('thread/read', { threadId, includeTurns: true })).thread.turns.at(-1)
      ownTurnId = latest.id
      report.explicitQueueStart = false
      report.explicitStartRacedAutomaticDelivery = true
    }
    const manualResult = await waitTurn(ownTurnId)
    assert(manualResult.items.some(item => item.type === 'agentMessage' && item.text?.includes('PHASE2_QUEUE_MANUAL_20260905')))
    assert.equal((await queue()).length, 0)
    report.queueCrudOrderAndDelivery = true
    assert.equal(digest(configPath), configHash)
    report.globalConfigUnchanged = true
    report.readOnlyTestProject = '/tmp/codex-webui-phase2-TestChat'
    writeFileSync(output, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    const currentQueue = await queue().catch(() => [])
    for (const item of currentQueue) if (createdQueueIds.includes(item.id)) await rpc('thread/queue/delete', { threadId, queuedSubmissionId: item.id }).catch(() => {})
    const currentGoal = await rpc('thread/goal/get', { threadId }).catch(() => null)
    if (currentGoal?.goal?.objective === 'PHASE2_GOAL_API_20260905') await rpc('thread/goal/clear', { threadId }).catch(() => {})
    await mode(originalMode).catch(() => {})
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
