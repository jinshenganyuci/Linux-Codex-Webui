// One authorized frontend promotion. Run under the existing 13510 deploy flock.
// No-argument/help paths are read-only and never touch deployment receipts.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const WebSocket = require('ws')
const TARGET = 'feb33192fe3edd96f73775d42d59121a039fd495'
const BACKEND = '51df3759b14051d1983ce10ec47bd527ca176d81'
const root = '/root/.local/share/linux-codex-webui'
const accepted = `${root}/releases/mobile-duplicate-reply-20261004-feb3319/dist`
const formalRelease = `${root}/releases/codex-01593-13510-20261001`
const destination = `${formalRelease}/dist`
const directory = `${root}/deployments/13510-mobile-duplicate-20261004`
const source = `${root}/worktrees/mobile-duplicate-reply-20261004`
const home = '/root/.codex'
const exists = file => fs.access(file).then(() => true, () => false)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = async file => digest(await fs.readFile(file))
const command = (program, args) => execFileSync(program, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim()
const servicePid = port => command('systemctl', ['show', `codex-webui-${port}.service`, '-p', 'MainPID', '--value'])
async function atomicWrite(file, bytes) {
  const temporary = `${file}.mobile-promotion-${process.pid}`
  await fs.writeFile(temporary, bytes, { flag: 'wx' })
  await fs.rename(temporary, file)
}
async function save(value) {
  await atomicWrite(path.join(directory, 'status.json'), JSON.stringify(value, null, 2))
}
async function runtime(port) {
  const response = await fetch(`http://127.0.0.1:${port}/codex-api/runtime-info`, { signal: AbortSignal.timeout(10000) })
  assert(response.ok)
  return (await response.json()).data
}
async function filesUnder(root) {
  const rows = []
  if (!(await exists(root))) return rows
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) rows.push(...await filesUnder(file))
    else if (entry.isFile()) rows.push(file)
  }
  return rows.sort()
}
async function manifest(root) {
  const rows = {}
  for (const file of await filesUnder(root)) rows[path.relative(root, file)] = await hash(file)
  return rows
}
async function protectedState() {
  const result = {}
  const files = [
    path.join(home, 'config.toml'), path.join(home, 'auth.json'),
    path.join(home, 'webui-auth-sessions.json'),
    path.join(home, 'linux-codex-webui-thread-model-preferences.json'),
    path.join(home, 'linux-codex-webui-thread-collaboration-preferences.json'),
    path.join(home, 'linux-codex-webui-new-chat-defaults.json'),
    path.join(formalRelease, 'dist-cli/index.js'),
    '/root/Codex-Webui/output/codex-webui-13510-runner.mjs',
  ]
  const config = await fs.readFile(files[0], 'utf8')
  const catalog = config.match(/^model_catalog_json\s*=\s*("(?:[^"\\]|\\.)*")/m)
  if (catalog) files.push(path.resolve(home, JSON.parse(catalog[1])))
  for (const file of files) result[file] = await exists(file) ? await hash(file) : null
  return result
}
async function nativeIdentity(parent, executable) {
  const children = (await fs.readFile(`/proc/${parent}/task/${parent}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean)
  for (const child of children) {
    if (await fs.realpath(`/proc/${child}/exe`).catch(() => '') === executable) {
      assert((await fs.readFile(`/proc/${child}/environ`, 'utf8')).split('\0').includes(`CODEX_HOME=${home}`))
      return { pid: child, executable, version: command(`/proc/${child}/exe`, ['--version']) }
    }
  }
  throw new Error('Production native child ownership is not confirmed')
}
async function verifyHttp(manifest) {
  for (const [relative, expected] of Object.entries(manifest)) {
    const response = await fetch(`http://127.0.0.1:13510/${relative}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200)
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), expected, `HTTP bytes differ: ${relative}`)
  }
}
async function deploy() {
  assert(!(await exists(directory)), 'Deployment directory exists; inspect its receipt instead of overwriting')
  assert.equal(command('git', ['-C', source, 'diff', BACKEND, TARGET, '--', 'src/server', 'src/cli', 'package.json', 'pnpm-lock.yaml']), '', 'This deployment requires no backend or runtime changes')
  const current = await runtime(13510), preview = await runtime(13511)
  assert.equal(current.webui.commit, BACKEND)
  assert.equal(current.codex.version, '0.159.3')
  assert.equal(current.codex.home, home)
  assert.equal(preview.webui.commit, TARGET)
  assert.equal(preview.webui.dirty, false)
  const oldFiles = await manifest(destination), newFiles = await manifest(accepted)
  for (const [file, expected] of Object.entries(newFiles)) {
    if (file === 'index.html') continue
    if (oldFiles[file]) assert.equal(oldFiles[file], expected, `Unexpected same-name resource change: ${file}`)
    else assert(file.startsWith('assets/'), 'Only versioned assets may be added')
  }
  const oldIndex = await fs.readFile(path.join(destination, 'index.html'))
  const initial = await fetch('http://127.0.0.1:13510/index.html', { cache: 'no-store' })
  assert.equal(digest(Buffer.from(await initial.arrayBuffer())), digest(oldIndex))
  const oldEtag = initial.headers.get('etag')
  assert(oldEtag)
  const pids = { formal: servicePid(13510), preview: servicePid(13511) }
  const native = await nativeIdentity(pids.formal, current.codex.command)
  const protectedFiles = await protectedState()
  const sessions = {}
  for (const folder of ['sessions', 'archived_sessions']) for (const file of await filesUnder(path.join(home, folder))) {
    if (file.endsWith('.jsonl')) sessions[file] = (await fs.stat(file)).size
  }
  const frontendMarker = path.join(formalRelease, 'FRONTEND_COMMIT')
  const previousMarker = await fs.readFile(frontendMarker).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  await fs.mkdir(directory, { mode: 0o700 })
  await fs.writeFile(path.join(directory, 'index-before.html'), oldIndex, { flag: 'wx', mode: 0o600 })
  const evidence = { targetFrontend: TARGET, backendCommit: BACKEND, pids, native, protectedFiles, sessions, oldFiles, newFiles, oldEtag, previousMarker: previousMarker?.toString() ?? null }
  await fs.writeFile(path.join(directory, 'before.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  let switched = false, unexpectedClose = false
  const socket = new WebSocket('ws://127.0.0.1:13510/codex-api/ws')
  socket.on('close', () => { unexpectedClose = true })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('WebSocket handshake timed out')) }, 10000)
      socket.once('error', error => { clearTimeout(timer); reject(error) })
      socket.on('message', bytes => { const frame = JSON.parse(String(bytes)); if (frame.method === 'ready') { clearTimeout(timer); resolve() } })
    })
    let added = 0
    for (const [file, expected] of Object.entries(newFiles)) {
      if (file === 'index.html' || oldFiles[file]) continue
      await fs.mkdir(path.dirname(path.join(destination, file)), { recursive: true })
      const bytes = await fs.readFile(path.join(accepted, file))
      assert.equal(digest(bytes), expected)
      await atomicWrite(path.join(destination, file), bytes)
      added++
    }
    // Verify every dependency over HTTP before exposing the new entry document.
    await verifyHttp(Object.fromEntries(Object.entries(newFiles).filter(([file]) => file !== 'index.html')))
    assert.equal(await hash(path.join(destination, 'index.html')), digest(oldIndex), 'Another publisher changed the entry')
    const newIndex = await fs.readFile(path.join(accepted, 'index.html'))
    assert.equal(digest(newIndex), newFiles['index.html'])
    await atomicWrite(path.join(destination, 'index.html'), newIndex)
    switched = true
    await verifyHttp(newFiles)
    await verifyHttp(Object.fromEntries(Object.entries(oldFiles).filter(([file]) => file !== 'index.html')))
    const changed = await fetch('http://127.0.0.1:13510/index.html', { cache: 'no-cache', headers: { 'If-None-Match': oldEtag } })
    assert.equal(changed.status, 200)
    assert.equal(digest(Buffer.from(await changed.arrayBuffer())), newFiles['index.html'])
    const newEtag = changed.headers.get('etag')
    const unchanged = await fetch('http://127.0.0.1:13510/index.html', { cache: 'no-cache', headers: { 'If-None-Match': newEtag } })
    assert.equal(unchanged.status, 304)
    assert.equal(servicePid(13510), pids.formal)
    assert.equal(servicePid(13511), pids.preview)
    assert.deepEqual(await nativeIdentity(pids.formal, current.codex.command), native)
    assert.deepEqual(await protectedState(), protectedFiles)
    for (const [file, size] of Object.entries(sessions)) assert((await fs.stat(file)).size >= size, 'A session was removed or truncated')
    assert.equal(socket.readyState, WebSocket.OPEN)
    assert.equal(unexpectedClose, false)
    await atomicWrite(frontendMarker, TARGET + '\n')
    await save({ phase: 'published-awaiting-browser', checkedAt: new Date().toISOString(), targetFrontend: TARGET, backendCommit: BACKEND, cliVersion: current.codex.version, pids, native, addedAssets: added, verifiedFrontendFiles: Object.keys(newFiles).length, retainedOldResources: Object.keys(oldFiles).length - 1, protectedFilesUnchanged: true, preservedSessionPaths: Object.keys(sessions).length, websocketPreserved: true, cacheChecks: { oldEtag, newEtag, changedStatus: 200, unchangedStatus: 304 }, restartPerformed: false })
    console.log(`Published frontend ${TARGET.slice(0, 7)}; backend and native processes preserved; browser verification pending`)
  } catch (error) {
    if (switched) await atomicWrite(path.join(destination, 'index.html'), oldIndex)
    if (previousMarker) await atomicWrite(frontendMarker, previousMarker)
    else if (await exists(frontendMarker)) await fs.unlink(frontendMarker)
    await save({ phase: 'failed-entry-restored', error: error.message, checkedAt: new Date().toISOString(), targetFrontend: TARGET, restartPerformed: false })
    throw error
  } finally { socket.close() }
}
const args = process.argv.slice(2)
if (args.length === 0 || args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('Usage: flock -n <13510-deploy.lock> node scripts/deploy-mobile-duplicate-frontend.cjs --deploy')
} else if (args.length === 1 && args[0] === '--deploy') {
  deploy().catch(error => { console.error(error.message); process.exitCode = 1 })
} else {
  console.error('Unknown arguments; use --help. No deployment was performed.')
  process.exitCode = 1
}
