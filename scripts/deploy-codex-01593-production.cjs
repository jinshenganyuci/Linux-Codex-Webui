// Authorized 2026-10-01 Codex 0.159.3 production upgrade only. Run --deploy from a separate systemd
// unit: the initiating conversation itself is owned by the service we restart.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { createReadStream } = require('node:fs')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const path = require('node:path')
const execute = promisify(execFile)
const source = '/root/.local/share/linux-codex-webui/worktrees/codex-01593-ui-20261001'
const directory = '/root/.local/share/linux-codex-webui/deployments/13510-codex-01593-20261001'
const release = '/root/.local/share/linux-codex-webui/releases/codex-01593-13510-20261001'
const unit = 'codex-webui-13510.service'
const workerUnit = 'codex-webui-deploy-codex-01593-20261001.service'
const dropIn = '/etc/systemd/system/codex-webui-13510.service.d/zzzzzzzz-codex-01593-20261001.conf'
const home = '/root/.codex'
const formalCwd = '/root/Codex-Webui'
const passwordSource = path.join(formalCwd, 'output/codex-webui-13510-runner.mjs')
const targetCommit = '51df3759b14051d1983ce10ec47bd527ca176d81'
const targetFrontend = targetCommit
const acceptedRelease = '/root/.local/share/linux-codex-webui/releases/codex-01593-ui-20261001-51df375'
const oldRelease = '/root/.local/share/linux-codex-webui/releases/plan-progress-13510-20260930'
const expectedOldCommit = '47e2280cd7323f255dd3dd6fd3f114e841490ad7'
const oldCommand = '/root/.local/share/linux-codex-webui/runtimes/codex-0.154.0/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
const command = oldCommand.replace('codex-0.154.0/', 'codex-0.159.3/')
const testThread = '01a0f5c7-3e0b-75d1-97f1-06a633aa7657'
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const run = async (program, args, timeout = 30000, options = {}) => (await execute(program, args, { timeout, maxBuffer: 1024 * 1024, ...options })).stdout.trim()
const pid = service => run('/usr/bin/systemctl', ['show', service, '-p', 'MainPID', '--value'])
const exists = filename => fs.access(filename).then(() => true, () => false)

async function hash(filename, bytes) {
  const digest = createHash('sha256')
  if (bytes !== 0) for await (const chunk of createReadStream(filename, bytes === undefined ? {} : { start: 0, end: bytes - 1 })) digest.update(chunk)
  return digest.digest('hex')
}
async function save(name, value) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const destination = path.join(directory, name)
  await fs.writeFile(`${destination}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await fs.rename(`${destination}.tmp`, destination)
}
async function record(phase, details = {}) {
  const value = { phase, targetCommit, targetFrontend, port: 13510, checkedAt: new Date().toISOString(), sessionBackupCreated: false, ...details }
  await save('status.json', value)
  console.log(JSON.stringify(value))
}
async function request(endpoint, body, port = 13510) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    signal: AbortSignal.timeout(15000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  assert(response.ok, `${endpoint}: HTTP ${response.status}`)
  const result = await response.json()
  assert(!result.error, `${endpoint}: RPC failed`)
  return result
}
const rpc = async (method, params = {}) => (await request('/codex-api/rpc', { method, params })).result
function idle(state) { return state.busy === false && state.activeThreadIds.length === 0 && state.pendingCount === 0 && state.queuedCount === 0 }

async function idleState() {
  const runtime = (await request('/codex-api/runtime-info')).data
  assert.equal(runtime.codex.home, home)
  const pending = (await request('/codex-api/server-requests/pending')).data
  const queue = (await request('/codex-api/thread-queue-state')).data
  assert(Array.isArray(pending) && queue && typeof queue === 'object' && !Array.isArray(queue))
  const state = {
    busy: runtime.codex.busy, activeThreadIds: runtime.codex.activeThreadIds,
    pendingCount: pending.length + runtime.codex.pendingRequestCount,
    queuedCount: Object.values(queue).reduce((count, items) => { assert(Array.isArray(items)); return count + items.length }, 0),
  }
  // Do not enumerate native queues on each poll while a turn is active.
  if (!idle(state)) return state
  const loaded = new Set()
  let cursor = null
  const seen = new Set()
  do {
    const response = await rpc('thread/loaded/list', { limit: 100, cursor })
    assert(Array.isArray(response.data), 'Unknown loaded-thread response')
    for (const id of response.data) { assert.equal(typeof id, 'string'); loaded.add(id) }
    cursor = response.nextCursor || null
    assert(!cursor || !seen.has(cursor), 'Repeated loaded-thread cursor')
    if (cursor) seen.add(cursor)
    assert(seen.size < 100, 'Loaded-thread inventory exceeded safety limit')
  } while (cursor)
  const ownerPath = path.join(home, 'webui-native-queue-owners.json')
  if (await exists(ownerPath)) {
    const owners = JSON.parse(await fs.readFile(ownerPath, 'utf8'))['linux-codex-webui-native-queue-threads'] ?? []
    assert(Array.isArray(owners) && owners.length <= 4096 && owners.every(id => typeof id === 'string'))
    for (const id of owners) loaded.add(id)
  }
  for (const threadId of loaded) {
    const response = await rpc('thread/queue/list', { threadId, limit: 1 })
    assert(Array.isArray(response.data), 'Unknown native queue response')
    state.queuedCount += response.data.length
    if (state.queuedCount) break
  }
  // Queue inspection is sequential; a turn may have started while we read it.
  const latest = (await request('/codex-api/runtime-info')).data.codex
  state.busy = latest.busy
  state.activeThreadIds = latest.activeThreadIds
  state.pendingCount += latest.pendingRequestCount
  return state
}

async function filesUnder(root) {
  const result = []
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile()) result.push(filename)
    }
  }
  if (await exists(root)) await visit(root)
  return result.sort()
}
async function manifest(root) {
  const result = {}
  for (const filename of await filesUnder(root)) result[path.relative(root, filename)] = await hash(filename)
  return result
}
async function verifyHttpFiles(files) {
  for (const [relative, expected] of Object.entries(files)) {
    const response = await fetch(`http://127.0.0.1:13510/${relative}`, { signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200)
    assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), expected, `Frontend mismatch: ${relative}`)
  }
}
const planFiles = ['linux-codex-webui-plan-summary-history.json', 'linux-codex-webui-active-plans.json']
async function preservePlanFiles(label, immutable = false, roots = { directory, home }) {
  const copied = []
  const destination = path.join(roots.directory, label)
  const completed = path.join(destination, 'copy-manifest.json')
  if (immutable && await exists(completed)) {
    const preserved = JSON.parse(await fs.readFile(completed, 'utf8'))
    for (const [name, expected] of Object.entries(preserved.hashes)) assert.equal(await hash(path.join(destination, name)), expected, 'Saved rollback plan state changed')
    return preserved
  }
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  for (const name of planFiles) if (await exists(path.join(roots.home, name))) {
    await fs.writeFile(path.join(destination, name), await fs.readFile(path.join(roots.home, name)), { mode: 0o600 })
    copied.push(name)
  }
  // These small compatibility copies are never restored over live chat data.
  const hashes = {}
  for (const name of copied) hashes[name] = await hash(path.join(destination, name))
  const preserved = { directory: destination, files: copied, hashes }
  await fs.writeFile(`${completed}.tmp`, JSON.stringify(preserved), { mode: 0o600 })
  await fs.rename(`${completed}.tmp`, completed)
  return preserved
}
async function verifyPlanHistoryPreserved(snapshot) {
  const name = planFiles[0]
  if (!snapshot.planState.files.includes(name)) return { preservedPlanSummaries: 0 }
  const previous = JSON.parse(await fs.readFile(path.join(snapshot.planState.directory, name), 'utf8')).threads ?? {}
  const current = JSON.parse(await fs.readFile(path.join(home, name), 'utf8')).threads ?? {}
  let count = 0
  for (const [id, rows] of Object.entries(previous)) for (const row of rows) {
    const match = (current[id] ?? []).find(candidate => candidate.id === row.id && candidate.turnId === row.turnId)
    assert(match, 'A preexisting plan summary is missing')
    assert.deepEqual({ text: match.text, steps: match.steps, explanation: match.explanation }, { text: row.text, steps: row.steps, explanation: row.explanation }, 'Preexisting plan content changed')
    count++
  }
  return { preservedPlanSummaries: count }
}
async function atomicDropIn(contents) {
  await fs.writeFile(`${dropIn}.tmp`, contents, { mode: 0o644 })
  await fs.rename(`${dropIn}.tmp`, dropIn)
}
async function threadIds() {
  const ids = new Set()
  for (const archived of [false, true]) {
    let cursor = null
    const seen = new Set()
    do {
      const response = await rpc('thread/list', { archived, modelProviders: [], sourceKinds: [], limit: 200, sortKey: 'updated_at', cursor, useStateDbOnly: true })
      assert(Array.isArray(response.data))
      for (const thread of response.data) ids.add(thread.id)
      cursor = response.nextCursor || null
      assert(!cursor || !seen.has(cursor), 'Repeated history cursor')
      if (cursor) seen.add(cursor)
      assert(seen.size < 100, 'Thread inventory exceeded safety limit')
    } while (cursor)
  }
  return [...ids].sort()
}
async function protectedFiles() {
  const files = [path.join(home, 'config.toml'), path.join(home, 'auth.json'), passwordSource,
    path.join(home, 'linux-codex-webui-thread-model-preferences.json'),
    path.join(home, 'linux-codex-webui-thread-collaboration-preferences.json'),
    path.join(home, 'linux-codex-webui-new-chat-defaults.json'),
    path.join(home, 'linux-codex-webui-sidebar-preferences.json')]
  const config = await fs.readFile(files[0], 'utf8')
  const catalog = config.match(/^model_catalog_json\s*=\s*("(?:[^"\\]|\\.)*")/m)
  if (catalog) files.push(path.resolve(home, JSON.parse(catalog[1])))
  const result = {}
  for (const filename of files) result[filename] = await exists(filename) ? await hash(filename) : null
  return result
}
async function activeLoginTokens() {
  const filename = path.join(home, 'webui-auth-sessions.json')
  if (!(await exists(filename))) return []
  const entries = JSON.parse(await fs.readFile(filename, 'utf8')).tokens
  assert(Array.isArray(entries), 'Unknown persisted login-session format')
  return entries.filter(entry => typeof entry.value === 'string' && entry.expiresAt > Date.now())
    .map(entry => ({ digest: createHash('sha256').update(entry.value).digest('hex'), expiresAt: entry.expiresAt }))
}
async function sessionSnapshot() {
  const result = {}
  for (const root of ['sessions', 'archived_sessions']) {
    for (const filename of await filesUnder(path.join(home, root))) {
      if (!filename.endsWith('.jsonl')) continue
      const stat = await fs.stat(filename)
      result[path.relative(home, filename)] = { size: stat.size, sha256: await hash(filename, stat.size) }
    }
  }
  return result
}
async function verifySessions(snapshot) {
  let appended = 0
  for (const [relative, before] of Object.entries(snapshot)) {
    const filename = path.join(home, relative)
    const current = await fs.stat(filename)
    assert(current.size >= before.size, 'A preexisting session was truncated')
    assert.equal(await hash(filename, before.size), before.sha256, 'Preexisting session bytes changed')
    if (current.size > before.size) appended++
  }
  return { preservedFiles: Object.keys(snapshot).length, concurrentlyAppendedFiles: appended }
}

async function nativeChildren(parent, executable) {
  if (parent === '0') return []
  const children = (await fs.readFile(`/proc/${parent}/task/${parent}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  const found = []
  for (const child of children) if (await fs.realpath(`/proc/${child}/exe`).catch(() => '') === executable) found.push(child)
  return found
}
async function stopAndWaitNative(snapshot, rollingBack = false) {
  assert.equal(await run('/usr/bin/systemctl', ['show', unit, '-p', 'KillMode', '--value']), 'process')
  assert.equal(await run('/usr/bin/systemctl', ['show', unit, '-p', 'TimeoutStopUSec', '--value']), 'infinity')
  const parent = await pid(unit)
  const captured = new Map((snapshot.stoppingNative ?? []).map(row => [row.pid, row]))
  for (const executable of [oldCommand, command]) for (const child of await nativeChildren(parent, executable)) captured.set(child, { pid: child, executable })
  snapshot.stoppingNative = [...captured.values()]
  await save('preflight.json', snapshot)
  await run('/usr/bin/systemctl', ['stop', unit], 0)
  // Persisted PID/executable pairs also cover recovery with an orphan child.
  // A zombie has no /proc/<pid>/exe. Never send a second or forced signal.
  for (const child of snapshot.stoppingNative) {
    while (await fs.realpath(`/proc/${child.pid}/exe`).catch(() => '') === child.executable) {
      await record(rollingBack ? 'waiting-native-exit-before-rollback' : 'waiting-native-exit', { nativePid: child.pid })
      await sleep(1000)
    }
  }
}
async function backupNativeDatabases() {
  const destination = path.join(directory, 'native-database-before-upgrade')
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  const completed = path.join(destination, 'manifest.json')
  if (await exists(completed)) {
    const saved = JSON.parse(await fs.readFile(completed, 'utf8'))
    for (const row of saved.databases) assert.equal(await hash(path.join(destination, row.name)), row.sha256, 'Native database backup changed')
    return saved
  }
  // SQLite backup API gives a consistent copy even if an external CLI shares
  // CODEX_HOME. Diagnostic logs are not user history and are left in place.
  const script = `import sqlite3, pathlib, json, os
home=pathlib.Path(${JSON.stringify(home)})
destination=pathlib.Path(${JSON.stringify(destination)})
rows=[]
for src in sorted(home.glob('*.sqlite')):
 if src.name.startswith('logs_'): continue
 dest=destination/src.name
 partial=destination/(src.name+'.partial')
 partial.unlink(missing_ok=True)
 with sqlite3.connect(src.as_uri()+'?mode=ro', uri=True, timeout=30) as source:
  with sqlite3.connect(partial) as target:
   source.backup(target)
   assert target.execute('PRAGMA quick_check').fetchone()[0]=='ok'
 os.chmod(partial,0o600)
 partial.replace(dest)
 rows.append({'name':src.name,'size':dest.stat().st_size})
print(json.dumps(rows))`
  const rows = JSON.parse(await run('/usr/bin/python3', ['-c', script], 180000))
  for (const row of rows) row.sha256 = await hash(path.join(destination, row.name))
  const saved = { directory: destination, method: 'sqlite-backup-api', restoredAutomatically: false, databases: rows, checkedAt: new Date().toISOString() }
  await fs.writeFile(completed, JSON.stringify(saved, null, 2), { mode: 0o600 })
  return saved
}

async function prepare() {
  assert(!(await exists(dropIn)), 'The target drop-in already exists; inspect instead of overwriting it')
  assert(!/^\s*sqlite_home\s*=/m.test(await fs.readFile(path.join(home, 'config.toml'), 'utf8')), 'External sqlite_home requires a separately verified backup target')
  const current = (await request('/codex-api/runtime-info')).data
  const accepted = (await request('/codex-api/runtime-info', undefined, 13511)).data
  assert.equal(current.webui.commit, expectedOldCommit)
  assert.equal(current.codex.home, home)
  assert.equal(current.codex.version, '0.154.0')
  assert.equal(current.codex.command, oldCommand)
  const nativeConfig = (await rpc('config/read', { includeLayers: false })).config
  assert(nativeConfig && typeof nativeConfig === 'object', 'Resolved native config is unavailable')
  assert(!nativeConfig.sqlite_home || path.resolve(home, nativeConfig.sqlite_home) === home, 'Resolved sqlite_home is outside the verified backup root')
  assert.equal(accepted.webui.commit, targetCommit)
  assert.equal(accepted.webui.dirty, false)
  assert.equal(accepted.codex.version, '0.159.3')
  assert.equal(accepted.codex.command, command)
  assert.equal(await run(command, ['--version']), 'codex-cli 0.159.3')
  assert((await fs.readFile(path.join(release, 'dist-cli/index.js'), 'utf8')).includes(targetCommit))
  const frontend = await manifest(path.join(source, 'dist'))
  const backend = await manifest(path.join(source, 'dist-cli'))
  assert.deepEqual(await manifest(path.join(release, 'dist')), frontend)
  assert.deepEqual(await manifest(path.join(release, 'dist-cli')), backend)
  const snapshot = {
    oldNativePids: await nativeChildren(await pid(unit), oldCommand),
    oldPid: await pid(unit), testPid: await pid('codex-webui-13511.service'),
    oldCommit: current.webui.commit, targetCommit, frontend, backend,
    runnerHash: await hash(path.join(release, 'runner-13510.mjs')),
    unitFingerprint: await run('/usr/bin/systemctl', ['show', unit, '-p', 'ExecStart', '-p', 'WorkingDirectory', '-p', 'Environment']),
    testEntryHash: await hash(path.join(acceptedRelease, 'dist-cli/index.js')),
    verifierHash: await hash(path.join(directory, 'verify-codex-01593-production.cjs')),
    deployScriptHash: await hash(path.join(directory, 'deploy-codex-01593-production.cjs')),
    bootId: (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    oldFrontend: await manifest(path.join(oldRelease, 'dist')),
    oldBackend: await manifest(path.join(oldRelease, 'dist-cli')),
    previewFrontend: await manifest(path.join(acceptedRelease, 'dist')),
  }
  for (const [relative, digest] of Object.entries(frontend)) assert.equal(await hash(path.join(acceptedRelease, 'dist', relative)), digest)
  assert.deepEqual(await manifest(path.join(acceptedRelease, 'dist-cli')), backend)
  // Store only a digest of unit settings, never arbitrary environment contents.
  snapshot.unitFingerprint = createHash('sha256').update(snapshot.unitFingerprint).digest('hex')
  await save('preflight.json', snapshot)
  await record('prepared', { oldPid: snapshot.oldPid, frontendFiles: Object.keys(frontend).length, state: await idleState() })
}

async function verify(snapshot) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const runtime = (await request('/codex-api/runtime-info')).data
      if (runtime.webui.commit === targetCommit && runtime.codex.version === '0.159.3' && runtime.codex.running) break
    } catch {}
    assert(attempt < 119, 'New runtime did not become ready')
    await sleep(500)
  }
  const runtime = (await request('/codex-api/runtime-info')).data
  assert.equal(runtime.webui.commit, targetCommit)
  assert.equal(runtime.webui.dirty, false)
  assert.equal(runtime.codex.home, home)
  assert.equal(runtime.codex.command, command)
  assert.equal(runtime.codex.version, '0.159.3')
  const currentPid = await pid(unit)
  if (snapshot.bootId === (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()) assert.notEqual(currentPid, snapshot.oldPid)
  assert.notEqual(currentPid, '0')
  const children = (await fs.readFile(`/proc/${currentPid}/task/${currentPid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  let cliPid = ''
  for (const child of children) if (await fs.realpath(`/proc/${child}/exe`).catch(() => '') === command) cliPid = child
  assert(cliPid, 'CLI is not owned by the new production service')
  assert.equal(await run(`/proc/${cliPid}/exe`, ['--version']), 'codex-cli 0.159.3')
  assert((await fs.readFile(`/proc/${cliPid}/environ`, 'utf8')).split('\0').includes(`CODEX_HOME=${home}`))
  await verifyHttpFiles(snapshot.frontend)
  assert(Array.isArray((await rpc('model/list', { limit: 100 })).data))
  const afterIds = new Set(await threadIds())
  assert(snapshot.threadIds.every(id => afterIds.has(id)), 'A previously visible conversation is missing')
  assert.deepEqual(await protectedFiles(), snapshot.protectedFiles)
  const currentTokens = new Set((await activeLoginTokens()).map(entry => entry.digest))
  assert(snapshot.authTokens.filter(entry => entry.expiresAt > Date.now()).every(entry => currentTokens.has(entry.digest)), 'An unexpired login session was lost')
  await record('verifying-browser', { pid: currentPid, cliPid, sessionFilesToVerify: Object.keys(snapshot.sessions).length, preservedThreadCount: snapshot.threadIds.length })
  const password = (await fs.readFile(passwordSource, 'utf8')).match(/'--password'\s*,\s*'([^']+)'/)?.[1]
  assert(password, 'Existing password configuration unavailable')
  await run('/usr/bin/node', [path.join(directory, 'verify-codex-01593-production.cjs')], 180000, {
    cwd: source,
    env: { ...process.env, VERIFY_PRODUCTION_STARTUP: '1', PROFILE_BASE_URL: 'http://127.0.0.2:13510', WEBUI_TEST_PASSWORD: password,
      STARTUP_THREAD_ID: testThread, STARTUP_PRODUCTION_OUTPUT_DIR: path.join(directory, 'browser') },
  })
  const browser = JSON.parse(await fs.readFile(path.join(directory, 'browser/report.json'), 'utf8'))
  assert.equal(browser.passed, true, 'Production browser verification did not pass')
  // Verify the real bridge negotiation separately from synthetic UI frames.
  const WebSocket = require(path.join(source, 'node_modules/ws'))
  await new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:13510/codex-api/ws')
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Plan ready handshake timed out')) }, 15000)
    socket.on('error', error => { clearTimeout(timer); reject(error) })
    socket.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame.method !== 'ready') return
      clearTimeout(timer); socket.close()
      try { assert.equal(frame.params.planSnapshotsVersion, 1); resolve() } catch (error) { reject(error) }
    })
  })
  const tokensAfterLogin = new Set((await activeLoginTokens()).map(entry => entry.digest))
  assert(snapshot.authTokens.filter(entry => entry.expiresAt > Date.now()).every(entry => tokensAfterLogin.has(entry.digest)), 'Login verification removed an existing session')
  assert.deepEqual(await protectedFiles(), snapshot.protectedFiles)
  const preserved = await verifySessions(snapshot.sessions)
  if (snapshot.bootId === (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()) assert.equal(await pid('codex-webui-13511.service'), snapshot.testPid, '13511 was restarted')
  assert.equal(await hash(path.join(acceptedRelease, 'dist-cli/index.js')), snapshot.testEntryHash)
  assert.deepEqual(await manifest(path.join(acceptedRelease, 'dist')), snapshot.previewFrontend)
  const plans = await verifyPlanHistoryPreserved(snapshot)
  const index = (await request('/codex-api/thread-index/status')).data
  assert(!['error', 'unsupported'].includes(index.state), 'Index maintenance could not run')
  await fs.writeFile(path.join(release, 'DEPLOYED_COMMIT'), targetCommit + '\n')
  await fs.writeFile(path.join(release, 'FRONTEND_COMMIT'), targetFrontend + '\n')
  await record('complete', { webui: runtime.webui, pid: currentPid, cliPid, codexHome: home, cliVersion: runtime.codex.version,
    ...preserved, ...plans, preservedInteractiveThreadCount: snapshot.threadIds.length, configUnchanged: true, modelPreferencesUnchanged: true,
    loginSessionsPreserved: true, test13511Unchanged: true, verifiedHttpFiles: Object.keys(snapshot.frontend).length,
    browserReport: path.join(directory, 'browser/report.json'), browserPassed: browser.passed === true,
    realPlanProtocolVersion: 1, databaseBackup: snapshot.databaseBackup,
    indexStatus: index, persistentDropIn: dropIn })
}

const targetDropIn = `[Service]\nWorkingDirectory=${formalCwd}\nKillMode=process\nTimeoutStopSec=infinity\nExecStart=\nExecStart=/usr/bin/node ${release}/runner-13510.mjs\nEnvironment=CODEX_HOME=${home}\nEnvironment=CODEXUI_CODEX_COMMAND=${command}\n`
function resumeMode(phase, installed, commit) {
  if (['rolling-back', 'waiting-for-idle-before-rollback', 'waiting-native-exit-before-rollback'].includes(phase)) return 'rollback'
  if (['switching', 'verifying-browser', 'waiting-for-idle-before-switch', 'waiting-native-exit'].includes(phase)) {
    if (installed && commit === targetCommit) return 'verify'
    if (commit === expectedOldCommit || !commit) return 'switch'
    throw new Error('Unexpected runtime after an interrupted deployment')
  }
  assert(!installed, 'Unexpected installed deployment override')
  return 'prepare'
}
async function rollback(snapshot, error) {
  assert(!snapshot.mayHaveStartedTarget, 'Database migration may have started: automatic downgrade is forbidden')
  await record('rolling-back', { error: error.message })
  for (;;) {
    try { if (idle(await idleState())) break } catch { if (await pid(unit) === '0') break }
    await record('waiting-for-idle-before-rollback', { error: error.message })
    await sleep(2000)
  }
  // Only a pre-target failure may restore the old executable. Preserve its
  // latest plan state as evidence; databases are never restored automatically.
  await stopAndWaitNative(snapshot, true)
  const rollbackPlanState = await preservePlanFiles('plan-state-before-rollback', true)
  await atomicDropIn('[Service]\nKillMode=process\nTimeoutStopSec=infinity\n')
  await run('/usr/bin/systemctl', ['daemon-reload'])
  await run('/usr/bin/systemctl', ['start', unit], 0)
  for (let i = 0; i < 120; i++) {
    try {
      const old = (await request('/codex-api/runtime-info')).data
      if (old.webui.commit === snapshot.oldCommit && old.codex.version === '0.154.0' && old.codex.command === oldCommand && old.codex.running) {
        assert.deepEqual(await manifest(path.join(oldRelease, 'dist-cli')), snapshot.oldBackend)
        await verifyHttpFiles(snapshot.oldFrontend)
        const preserved = await verifySessions(snapshot.sessions)
        await fs.unlink(dropIn)
        await run('/usr/bin/systemctl', ['daemon-reload'])
        await record('rolled-back', { error: error.message, oldCommit: snapshot.oldCommit, rollbackPlanState, ...preserved })
        return
      }
    } catch {}
    await sleep(500)
  }
  throw new Error(`Deployment failed and rollback readiness failed: ${error.message}`)
}
async function switchAndVerify(snapshot, mode) {
  try {
    if (mode !== 'verify') {
      // Includes recovery after worker/host interruption. Never restart a busy
      // surviving process just because the previous receipt says "switching".
      while (await pid(unit) !== '0' && !idle(await idleState())) {
        await record('waiting-for-idle-before-switch')
        await sleep(2000)
      }
      await record('switching', { preservedSessionFiles: Object.keys(snapshot.sessions).length, preservedInteractiveThreadCount: snapshot.threadIds.length })
      await stopAndWaitNative(snapshot)
      snapshot.databaseBackup = await backupNativeDatabases()
      await save('preflight.json', snapshot)
      // Persist before installing the override: a reboot can start the target
      // even if this worker never reaches its own systemctl start call.
      snapshot.mayHaveStartedTarget = true
      await save('preflight.json', snapshot)
      await atomicDropIn(targetDropIn)
      await run('/usr/bin/systemctl', ['daemon-reload'])
      assert.equal(await run('/usr/bin/systemctl', ['show', unit, '-p', 'KillMode', '--value']), 'process')
      assert.equal(await run('/usr/bin/systemctl', ['show', unit, '-p', 'TimeoutStopUSec', '--value']), 'infinity')
      await run('/usr/bin/systemctl', ['start', unit], 0)
    }
    await verify(snapshot)
  } catch (error) {
    if (snapshot.mayHaveStartedTarget || await exists(dropIn) && await fs.readFile(dropIn, 'utf8') === targetDropIn) {
      await record('failed-preserving-upgraded-data', { error: error.message, databaseBackup: snapshot.databaseBackup, service: await serviceState(), automaticDatabaseRestore: false })
      return
    }
    await rollback(snapshot, error)
  }
}
async function deploy() {
  assert(!(await fs.readFile('/proc/self/cgroup', 'utf8')).includes('/codex-webui-13510.service'), 'Run deployment outside production cgroup')
  const previous = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'))
  if (['complete', 'rolled-back', 'failed', 'failed-preserving-upgraded-data'].includes(previous.phase)) return
  const snapshot = JSON.parse(await fs.readFile(path.join(directory, 'preflight.json'), 'utf8'))
  assert.deepEqual(await manifest(path.join(release, 'dist')), snapshot.frontend)
  assert.deepEqual(await manifest(path.join(release, 'dist-cli')), snapshot.backend)
  assert.equal(await hash(path.join(release, 'runner-13510.mjs')), snapshot.runnerHash)
  assert.equal(await hash(path.join(directory, 'verify-codex-01593-production.cjs')), snapshot.verifierHash)
  assert.equal(await hash(path.join(directory, 'deploy-codex-01593-production.cjs')), snapshot.deployScriptHash)
  const installed = await exists(dropIn)
  let currentCommit = ''
  try { currentCommit = (await request('/codex-api/runtime-info')).data.webui.commit } catch {}
  const mode = resumeMode(previous.phase, installed, currentCommit)
  if (installed) {
    const contents = await fs.readFile(dropIn, 'utf8')
    assert(contents === targetDropIn || mode === 'rollback' && contents === '[Service]\nKillMode=process\nTimeoutStopSec=infinity\n', 'Unexpected override contents')
  }
  if (mode === 'rollback') return rollback(snapshot, new Error('Resuming interrupted rollback'))
  if (mode === 'switch' || mode === 'verify') {
    assert(snapshot.sessions && snapshot.planState, 'Interrupted switch is missing its preservation snapshot')
    return switchAndVerify(snapshot, mode)
  }
  assert.equal(currentCommit, snapshot.oldCommit)
  const settings = await run('/usr/bin/systemctl', ['show', unit, '-p', 'ExecStart', '-p', 'WorkingDirectory', '-p', 'Environment'])
  assert.equal(createHash('sha256').update(settings).digest('hex'), snapshot.unitFingerprint)
  const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (snapshot.bootId !== bootId) {
    // A reboot with the same old unit is safe to prepare again. An unrelated
    // same-boot service restart is not silently accepted.
    snapshot.bootId = bootId
    snapshot.oldPid = await pid(unit)
    snapshot.oldNativePids = await nativeChildren(snapshot.oldPid, oldCommand)
    snapshot.testPid = await pid('codex-webui-13511.service')
    await save('preflight.json', snapshot)
  }
  let samples = 0, attempt = 0
  while (true) {
    assert.equal(await pid(unit), snapshot.oldPid, 'Production restarted elsewhere; inspect before continuing')
    const state = await idleState()
    samples = idle(state) ? samples + 1 : 0
    if (attempt++ % 5 === 0) await record('waiting-for-idle', { state, consecutiveIdleSamples: samples })
    if (samples >= 3) {
      snapshot.threadIds = await threadIds()
      assert(snapshot.threadIds.includes(testThread), 'Verification history is not present')
      snapshot.protectedFiles = await protectedFiles()
      snapshot.sessions = await sessionSnapshot()
      snapshot.authTokens = await activeLoginTokens()
      snapshot.planState = await preservePlanFiles('plan-state-before-upgrade')
      if (idle(await idleState())) break
      samples = 0
    }
    await sleep(2000)
  }
  assert(!(await exists(dropIn)), 'Another deployment installed the target override')
  const latestSettings = await run('/usr/bin/systemctl', ['show', unit, '-p', 'ExecStart', '-p', 'WorkingDirectory', '-p', 'Environment'])
  assert.equal(createHash('sha256').update(latestSettings).digest('hex'), snapshot.unitFingerprint)
  await save('preflight.json', snapshot)
  await switchAndVerify(snapshot, 'switch')
}
async function main() {
  if (process.argv.includes('--self-test')) {
    const clean = { busy: false, activeThreadIds: [], pendingCount: 0, queuedCount: 0 }
    assert(idle(clean))
    for (const patch of [{ busy: true }, { activeThreadIds: ['active'] }, { pendingCount: 1 }, { queuedCount: 1 }]) assert(!idle({ ...clean, ...patch }))
    assert.equal(resumeMode('prepared', false, expectedOldCommit), 'prepare')
    assert.equal(resumeMode('switching', true, targetCommit), 'verify')
    assert.equal(resumeMode('switching', false, expectedOldCommit), 'switch')
    assert.equal(resumeMode('verifying-browser', true, targetCommit), 'verify')
    assert.equal(resumeMode('waiting-native-exit', false, ''), 'switch')
    assert.equal(resumeMode('rolling-back', true, targetCommit), 'rollback')
    assert.throws(() => resumeMode('prepared', true, expectedOldCommit))
    assert.throws(() => resumeMode('switching', true, 'unrelated'))
    const temporary = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'plan-deploy-self-test-'))
    try {
      const roots = { directory: path.join(temporary, 'receipt'), home: path.join(temporary, 'home') }
      await fs.mkdir(roots.home)
      const original = path.join(roots.home, planFiles[0])
      await fs.writeFile(original, '{"newPlanIdentity":"checklist+proposal"}')
      const first = await preservePlanFiles('rollback', true, roots)
      await fs.writeFile(original, '{"oldVersion":"merged-by-turn"}')
      const second = await preservePlanFiles('rollback', true, roots)
      assert.deepEqual(second, first)
      assert.equal(await fs.readFile(path.join(second.directory, planFiles[0]), 'utf8'), '{"newPlanIdentity":"checklist+proposal"}')
    } finally { await fs.rm(temporary, { recursive: true, force: true }) }
    console.log('Idle, interrupted deployment and immutable rollback-copy guards passed; no API requests or service changes')
    return
  }
  if (process.argv.includes('--prepare')) return prepare()
  assert(process.argv.includes('--deploy'), 'Choose --prepare or --deploy explicitly')
  try { await deploy() } finally { await run('/usr/bin/systemctl', ['disable', workerUnit]).catch(() => {}) }
}
async function serviceState() {
  return await run('/usr/bin/systemctl', ['show', unit, '-p', 'MainPID', '-p', 'ActiveState', '-p', 'SubState'])
}
main().catch(async error => {
  if (process.argv.includes('--self-test')) { console.error(error.message); process.exitCode = 1; return }
  const saved = await fs.readFile(path.join(directory, 'preflight.json'), 'utf8').then(JSON.parse).catch(() => ({}))
  const installed = await fs.readFile(dropIn, 'utf8').catch(() => '')
  const preserving = saved.mayHaveStartedTarget || installed === targetDropIn
  await record(preserving ? 'failed-preserving-upgraded-data' : 'failed', { error: error.message, service: await serviceState(), automaticDatabaseRestore: false, databaseBackup: saved.databaseBackup })
  process.exitCode = 1
})
