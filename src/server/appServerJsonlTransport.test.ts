import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AppServerJsonlTransport,
  type AppServerJsonlTransportEvent,
  type AppServerJsonlTransportSpawner,
} from './appServerJsonlTransport'

function createFakeProcess(markKilledOnSignal = true): {
  child: ChildProcessWithoutNullStreams
  stdout: EventEmitter
  stderr: EventEmitter
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  stdoutSetEncoding: ReturnType<typeof vi.fn>
  stderrSetEncoding: ReturnType<typeof vi.fn>
} {
  const stdoutSetEncoding = vi.fn()
  const stderrSetEncoding = vi.fn()
  const stdout = Object.assign(new EventEmitter(), { setEncoding: stdoutSetEncoding })
  const stderr = Object.assign(new EventEmitter(), { setEncoding: stderrSetEncoding })
  const write = vi.fn()
  const end = vi.fn()
  const childEvents = new EventEmitter()
  const child = Object.assign(childEvents, {
    stdin: { write, end },
    stdout,
    stderr,
    killed: false,
  }) as unknown as ChildProcessWithoutNullStreams
  const kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (markKilledOnSignal) {
      ;(child as unknown as { killed: boolean }).killed = true
    }
    return signal !== undefined
  })
  child.kill = kill
  return {
    child,
    stdout,
    stderr,
    write,
    end,
    kill,
    stdoutSetEncoding,
    stderrSetEncoding,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AppServerJsonlTransport', () => {
  it('frames trimmed non-empty JSONL lines across stdout chunks without flushing a trailing fragment', () => {
    const fake = createFakeProcess()
    const spawnProcess = vi.fn<AppServerJsonlTransportSpawner>(() => fake.child)
    const events: AppServerJsonlTransportEvent[] = []
    const transport = new AppServerJsonlTransport((event) => events.push(event), spawnProcess)

    expect(transport.start({
      command: '/usr/bin/codex',
      args: ['app-server', '--flag'],
      env: { CODEX_HOME: '/tmp/codex-home' },
    })).toBe(1)
    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/codex', ['app-server', '--flag'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { CODEX_HOME: '/tmp/codex-home' },
    })
    expect(fake.stdoutSetEncoding).toHaveBeenCalledWith('utf8')
    expect(fake.stderrSetEncoding).toHaveBeenCalledWith('utf8')

    fake.stdout.emit('data', '  {"id":1}\n\n {"method":')
    fake.stdout.emit('data', '"turn/started"}  \n trailing-fragment')
    fake.stderr.emit('data', 'diagnostic that stays silent')

    expect(events).toEqual([
      { type: 'line', generation: 1, line: '{"id":1}' },
      { type: 'line', generation: 1, line: '{"method":"turn/started"}' },
    ])

    fake.child.emit('exit', 0, null)
    expect(events).toEqual([
      { type: 'line', generation: 1, line: '{"id":1}' },
      { type: 'line', generation: 1, line: '{"method":"turn/started"}' },
      { type: 'exit', generation: 1 },
    ])
  })

  it('writes one exact JSON line and rejects writes for stale or stopped generations', () => {
    const fake = createFakeProcess()
    const transport = new AppServerJsonlTransport(() => {}, () => fake.child)
    const generation = transport.start({ command: 'codex', args: ['app-server'] })

    transport.writeJson({ jsonrpc: '2.0', id: 7, params: { text: '你好' } }, generation)

    expect(fake.write).toHaveBeenCalledWith('{"jsonrpc":"2.0","id":7,"params":{"text":"你好"}}\n')
    expect(() => transport.writeJson({ id: 8 }, generation + 1)).toThrow('codex app-server is not running')

    expect(transport.stop()).toBe(generation)
    expect(() => transport.writeJson({ id: 9 }, generation)).toThrow('codex app-server is not running')
  })

  it('increments generations and ignores data and exit events from a detached child', () => {
    const first = createFakeProcess()
    const second = createFakeProcess()
    const children = [first.child, second.child]
    const events: AppServerJsonlTransportEvent[] = []
    const transport = new AppServerJsonlTransport(
      (event) => events.push(event),
      () => children.shift() ?? second.child,
    )

    expect(transport.start({ command: 'codex', args: ['app-server'] })).toBe(1)
    expect(transport.start({ command: 'ignored', args: [] })).toBe(1)
    expect(transport.stop()).toBe(1)
    expect(transport.start({ command: 'codex', args: ['app-server'] })).toBe(2)

    first.stdout.emit('data', '{"source":"old"}\n')
    first.child.emit('exit', 1, null)
    second.stdout.emit('data', '{"source":"current"}\n')

    expect(transport.running).toBe(true)
    expect(transport.activeGeneration).toBe(2)
    expect(events).toEqual([
      { type: 'line', generation: 2, line: '{"source":"current"}' },
    ])

    second.child.emit('exit', 1, null)
    second.child.emit('exit', 1, null)

    expect(transport.running).toBe(false)
    expect(transport.activeGeneration).toBe(0)
    expect(events).toEqual([
      { type: 'line', generation: 2, line: '{"source":"current"}' },
      { type: 'exit', generation: 2 },
    ])
  })

  it('ends stdin, sends SIGTERM, and preserves the delayed SIGKILL fallback on explicit stop', async () => {
    vi.useFakeTimers()
    const fake = createFakeProcess(false)
    const events: AppServerJsonlTransportEvent[] = []
    const transport = new AppServerJsonlTransport((event) => events.push(event), () => fake.child)
    transport.start({ command: 'codex', args: ['app-server'] })

    expect(transport.stop()).toBe(1)
    expect(fake.end).toHaveBeenCalledTimes(1)
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM')

    fake.child.emit('exit', 0, 'SIGTERM')
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(1499)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(transport.stop()).toBe(0)
  })
})
