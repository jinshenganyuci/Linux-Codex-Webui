// Exercise the real deployment entrypoints inside a VM. No production path,
// network endpoint, child process or deployment mode is executed by this suite.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const vm = require('node:vm')

const scripts = [
  'deploy-startup-production.cjs',
  'deploy-plan-production.cjs',
  'deploy-codex-01593-production.cjs',
]
const allowedBuiltins = new Set([
  'node:assert/strict', 'node:crypto', 'node:os', 'node:path', 'node:util',
])

function harness(filename, args) {
  const io = []
  const stdout = []
  const stderr = []
  const denied = operation => {
    io.push(operation)
    return new Error(`Deployment I/O is forbidden in this test: ${operation}`)
  }
  const fsPromises = new Proxy({}, {
    get: (_, method) => (..._args) => Promise.reject(denied(`fs.promises.${String(method)}`)),
  })
  const fsSync = new Proxy({}, {
    get: (_, method) => (..._args) => { throw denied(`fs.${String(method)}`) },
  })
  const childProcess = new Proxy({}, {
    get: (_, method) => (...args) => {
      const error = denied(`child_process.${String(method)}`)
      const callback = args.at(-1)
      if (typeof callback === 'function') { callback(error); return }
      throw error
    },
  })
  const fakeProcess = {
    argv: ['node', filename, ...args],
    env: {},
    pid: 12345,
    exitCode: undefined,
    stdout: { write: value => { stdout.push(String(value)); return true } },
    stderr: { write: value => { stderr.push(String(value)); return true } },
    exit: () => { throw denied('process.exit') },
  }
  const context = vm.createContext({
    require: name => {
      if (name === 'node:fs/promises') return fsPromises
      if (name === 'node:fs') return fsSync
      if (name === 'node:child_process') return childProcess
      assert(allowedBuiltins.has(name), `Unexpected dependency: ${name}`)
      return require(name)
    },
    process: fakeProcess,
    console: {
      log: (...values) => stdout.push(values.map(String).join(' ')),
      error: (...values) => stderr.push(values.map(String).join(' ')),
      warn: (...values) => stderr.push(values.map(String).join(' ')),
    },
    fetch: () => Promise.reject(denied('fetch')),
    setTimeout: () => { throw denied('setTimeout') },
    clearTimeout: () => { throw denied('clearTimeout') },
    Buffer,
    URL,
    AbortSignal,
  })
  const source = readFileSync(path.join(__dirname, filename), 'utf8')
  const evaluate = code => new vm.Script(code, { filename }).runInContext(context, { timeout: 1000 })
  return { context, io, stdout, stderr, process: fakeProcess, evaluate, start: () => evaluate(source) }
}

async function load(filename, args) {
  const isolated = harness(filename, args)
  const completion = isolated.start()
  assert.equal(typeof completion?.then, 'function', 'The script must expose its runCli() completion to the VM')
  await completion
  return isolated
}

for (const filename of scripts) {
  test(`${filename}: help and empty invocation perform no deployment I/O`, async t => {
    for (const args of [[], ['--help'], ['-h']]) {
      await t.test(args.join(' ') || '(no arguments)', async () => {
        const isolated = await load(filename, args)
        assert.equal(isolated.process.exitCode ?? 0, 0)
        assert.match(isolated.stdout.join('\n'), /Usage:/i)
        assert.deepEqual(isolated.stderr, [])
        assert.deepEqual(isolated.io, [], 'Help must not read or overwrite a deployment receipt, contact a service or run a command')
      })
    }
  })

  test(`${filename}: invalid arguments fail without deployment I/O`, async t => {
    const modes = ['--prepare', '--deploy', '--self-test']
    const invalid = [
      ['--unknown'], ['deploy'], ['--deploy=1'], ['--'],
      ['--help', '--unknown'], ['--help', '-h'],
      ...modes.flatMap(first => modes.map(second => [first, second])),
      ...modes.flatMap(mode => [[mode, '--unknown'], ['--unknown', mode], [mode, '--help'], ['--help', mode]]),
    ]
    for (const args of invalid) {
      await t.test(args.join(' '), async () => {
        const isolated = await load(filename, args)
        assert.equal(isolated.process.exitCode, 1)
        assert(isolated.stderr.join('\n').trim(), 'Invalid CLI input must report a diagnostic')
        assert.deepEqual(isolated.stdout, [], 'Invalid input must not enter deployment status logging')
        assert.deepEqual(isolated.io, [], 'Argument errors must not reach the deployment failure handler or its status files')
      })
    }
  })

  test(`${filename}: each explicit mode dispatches once after pure parsing`, async t => {
    for (const mode of ['prepare', 'deploy', 'self-test']) {
      await t.test(`--${mode}`, async () => {
        const isolated = await load(filename, ['--help'])
        isolated.context.args = [`--${mode}`]
        assert.equal(isolated.evaluate('parseDeploymentMode(args)'), mode)
        const dispatched = []
        isolated.context.observeMode = value => { dispatched.push(value) }
        // Replace only the operation body. Parsing and runCli are the real code;
        // this verifies dispatch without executing prepare/deploy/self-test.
        isolated.evaluate('main = async mode => observeMode(mode)')
        isolated.process.argv = ['node', filename, `--${mode}`]
        isolated.stdout.length = 0
        await isolated.evaluate('runCli()')
        assert.deepEqual(dispatched, [mode])
        assert.equal(isolated.process.exitCode ?? 0, 0)
        assert.deepEqual(isolated.stderr, [])
        assert.deepEqual(isolated.io, [])
      })
    }
  })
}

test('Codex promotion failure preserves upgraded data and exits unsuccessfully', async () => {
  const isolated = await load('deploy-codex-01593-production.cjs', ['--help'])
  const records = []
  let rollbackCalls = 0
  isolated.context.failVerification = () => { throw new Error('INJECTED_VERIFY_FAILURE') }
  isolated.context.captureRecord = (phase, details) => { records.push({ phase, details }) }
  isolated.context.rejectRollback = () => { rollbackCalls += 1; throw new Error('Rollback must not run after the target may have started') }
  isolated.evaluate(`
    verify = async () => failVerification()
    record = async (phase, details) => captureRecord(phase, details)
    serviceState = async () => 'ActiveState=failed'
    rollback = async () => rejectRollback()
  `)
  await isolated.evaluate("switchAndVerify({ mayHaveStartedTarget: true, databaseBackup: 'ISOLATED_BACKUP_MARKER' }, 'verify')")
  assert.equal(isolated.process.exitCode, 1, 'The systemd worker must not report a successful promotion after verification fails')
  assert.equal(records.length, 1)
  assert.equal(records[0].phase, 'failed-preserving-upgraded-data')
  assert.equal(records[0].details.error, 'INJECTED_VERIFY_FAILURE')
  assert.equal(records[0].details.databaseBackup, 'ISOLATED_BACKUP_MARKER')
  assert.equal(records[0].details.automaticDatabaseRestore, false)
  assert.equal(records[0].details.service, 'ActiveState=failed')
  assert.equal(rollbackCalls, 0)
  assert.deepEqual(isolated.io, [], 'The injected failure test must never touch real deployment state')
})
