/* Real model acceptance on isolated 13511 only. Creates one owned conversation.
 * No interception: verifies native update_plan -> bridge -> visible card -> disk.
 * PLAN_NATIVE_KEEP=1 retains the owned test conversation for restart acceptance.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { chromium } = require('playwright')
const WebSocket = require('ws')

const base = process.env.PROFILE_BASE_URL || 'http://127.0.0.1:13511'
assert.equal(new URL(base).port, '13511')
const out = path.resolve('output/playwright/plan-progress/native')
const marker = `PLAN_PROGRESS_NATIVE_${Date.now()}`
const cwd = `/tmp/codex-webui-plan-progress-${process.pid}`
const report = { base, marker, cases: [], events: [], screenshots: [], errors: [] }
fs.mkdirSync(out, { recursive: true })
let ownedThreadId, browser, socket, configPath, configHash
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
async function api(endpoint, body, method) {
  const response = await fetch(base + endpoint, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  })
  const result = await response.json()
  assert(response.ok && !result.error, `${endpoint}: ${JSON.stringify(result.error || response.status)}`)
  return result
}
const rpc = async (method, params = {}) => (await api('/codex-api/rpc', { method, params })).result
async function until(fn, label, timeout = 120000) {
  const began = Date.now()
  while (Date.now() - began < timeout) { if (await fn()) return; await pause(100) }
  throw new Error(`Timed out: ${label}`)
}
async function screenshot(page, name) {
  await pause(2300)
  const file = path.join(out, `${name}.png`)
  await page.screenshot({ path: file })
  report.screenshots.push({ url: page.url(), viewport: page.viewportSize(), file })
}
async function runTurn(text, label) {
  const began = Date.now()
  const result = await rpc('turn/start', {
    threadId: ownedThreadId,
    effort: 'low',
    input: [{ type: 'text', text }],
  })
  const turnId = result.turn.id
  await until(() => report.events.some(row => row.method === 'turn/completed' && row.turnId === turnId), `${label} completed`)
  const terminal = report.events.findLast(row => row.method === 'codex-ui/plan-updated' && row.turnId === turnId)
  assert(terminal, `${label}: no real authoritative plan event`)
  assert.equal(terminal.kind, 'checklist')
  report.cases.push({ label, turnId, elapsedMs: Date.now() - began, terminal })
  return { turnId, terminal }
}
;(async () => {
  const runtime = (await api('/codex-api/runtime-info')).data
  assert(runtime.codex.home.includes('/acceptance/'), 'Refuse a production CODEX_HOME')
  assert.equal(runtime.codex.busy, false, 'Acceptance service must be idle')
  configPath = path.join(runtime.codex.home, 'config.toml')
  configHash = digest(configPath)
  report.runtime = { version: runtime.codex.version, commit: runtime.webui.commit, startedAt: runtime.codex.startedAt }
  fs.mkdirSync(cwd, { recursive: true })
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'This is an isolated UI acceptance task. Do not modify files or spawn agents. Use the requested plan tool and finish the requested tiny arithmetic test.\n')
  socket = new WebSocket(base.replace(/^http/, 'ws') + '/codex-api/ws')
  socket.on('message', data => {
    let frame; try { frame = JSON.parse(String(data)) } catch { return }
    const p = frame.params || {}, s = p.snapshot
    if (frame.method === 'ready') report.handshakeVersion = p.planSnapshotsVersion
    const id = s?.threadId || p.threadId || p.turn?.threadId
    if (!ownedThreadId || id !== ownedThreadId) return
    if (['codex-ui/plan-updated', 'turn/plan/updated', 'turn/completed'].includes(frame.method)) {
      report.events.push({ method: frame.method, at: new Date().toISOString(), turnId: s?.turnId || p.turnId || p.turn?.id, kind: s?.kind, lifecycle: s?.lifecycle, revision: s?.revision, steps: s?.steps || p.plan, status: p.turn?.status })
      save()
    }
  })
  await until(() => socket.readyState === WebSocket.OPEN && report.handshakeVersion === 1, 'versioned plan handshake', 10000)
  const started = await rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only' })
  ownedThreadId = started.thread.id
  report.threadId = ownedThreadId
  report.model = started.model
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, colorScheme: 'dark', serviceWorkers: 'block' })
  await context.addInitScript(() => localStorage.setItem('codex-web-local.dark-mode.v1', 'dark'))
  const page = await context.newPage()
  page.on('pageerror', error => report.errors.push(error.message))
  await page.goto(`${base}/#/thread/${ownedThreadId}`, { waitUntil: 'domcontentloaded' })
  await page.locator('.thread-composer-input').waitFor({ timeout: 15000 })

  const partial = await runTurn(`UI acceptance ${marker}. Do not edit files or use subagents. You MUST call the available update_plan tool (discover its exact name if needed). Create exactly three checklist steps: 核对输入, 计算结果, 验证结果. For this first test turn only mark 核对输入 completed and leave the other two pending. Do not finish them or mark them completed. Then answer exactly ${marker}_PARTIAL. This intentionally tests a normally ended turn with an unfinished checklist.`, 'partial')
  assert.equal(partial.terminal.lifecycle, 'incomplete')
  assert.equal(partial.terminal.steps.filter(step => step.status === 'completed').length, 1)
  await page.locator('.plan-card').first().waitFor({ timeout: 15000 })
  await screenshot(page, 'partial-mobile-dark')
  const partialText = await page.locator('.plan-card').allTextContents()
  assert(partialText.some(text => text.includes('1/3')))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.plan-card').first().waitFor({ timeout: 15000 })
  assert((await page.locator('.plan-card').allTextContents()).some(text => text.includes('1/3')))
  report.partialAfterRefresh = true

  const complete = await runTurn(`UI acceptance ${marker}. Make a NEW checklist in this turn with exactly 核对输入, 计算结果, 验证结果. Use update_plan to show 核对输入 completed and 计算结果 in_progress, then calculate 2+3. Use update_plan again to mark the first two completed and 验证结果 in_progress. Verify the result is 5, then use update_plan to mark all three completed. Do not edit files, use subagents, or ask questions. Finally answer ${marker}_COMPLETE 5.`, 'complete')
  assert.equal(complete.terminal.lifecycle, 'completed')
  assert.equal(complete.terminal.steps.length, 3)
  assert(complete.terminal.steps.every(step => step.status === 'completed'))
  const steps = report.events.filter(row => row.method === 'codex-ui/plan-updated' && row.turnId === complete.turnId)
  assert(steps.some(row => row.lifecycle === 'live' && row.steps.some(step => step.status === 'inProgress')), 'No real intermediate current step')
  const summaries = (await api(`/codex-api/plan-summary-history?threadId=${ownedThreadId}`)).data[ownedThreadId]
  await until(async () => {
    const rows = (await api(`/codex-api/plan-summary-history?threadId=${ownedThreadId}`)).data[ownedThreadId] || []
    return rows.some(row => row.turnId === complete.turnId && row.lifecycle === 'completed')
  }, 'terminal persisted', 10000)
  report.persistedSummaryCount = summaries?.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await until(async () => (await page.locator('.plan-card').allTextContents()).some(text => text.includes('3/3')), 'complete after refresh', 15000)
  await screenshot(page, 'complete-mobile-dark')
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' })
  const reopened = await fresh.newPage()
  await reopened.goto(`${base}/#/thread/${ownedThreadId}`, { waitUntil: 'domcontentloaded' })
  await until(async () => (await reopened.locator('.plan-card').allTextContents()).some(text => text.includes('3/3')), 'fresh browser restore', 15000)
  await screenshot(reopened, 'fresh-desktop-light')
  assert.equal(await reopened.locator('.plan-card').count(), 2, 'One checklist per own turn, no duplicate history cards')
  assert.deepEqual(report.errors, [])
  report.freshBrowserRestore = true
  report.passed = true
})().catch(error => { report.failure = error.stack; process.exitCode = 1 }).finally(async () => {
  if (browser) await browser.close()
  socket?.close()
  if (configPath) { report.configUnchanged = digest(configPath) === configHash; if (!report.configUnchanged) process.exitCode = 1 }
  if (ownedThreadId && process.env.PLAN_NATIVE_KEEP !== '1') {
    try { await rpc('thread/delete', { threadId: ownedThreadId }); report.cleanup = 'owned conversation deleted' }
    catch (error) { report.cleanup = error.message; process.exitCode = 1 }
  } else if (ownedThreadId) report.cleanup = 'retained only for follow-up restart verification'
  fs.rmSync(cwd, { force: true, recursive: true })
  save()
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, threadId: ownedThreadId, configUnchanged: report.configUnchanged, cleanup: report.cleanup, failure: report.failure }))
})
