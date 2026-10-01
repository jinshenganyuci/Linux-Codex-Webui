import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeDiagnosticsReader, createSystemCliReader, resolveSystemCli } from './runtimeDiagnostics'
import type { RuntimeSnapshot } from '../runtimeDiagnostics'

const snapshot = (generation = 1): RuntimeSnapshot => ({
  webui: { version: 'test', commit: '', dirty: true },
  codex: { version: '0.159.3', startedAt: '', home: '/isolated', command: '/pinned/codex', catalogStatus: 'ready', generation, running: true },
})
const systemCli = { read: vi.fn(async () => ({ status: 'available' as const, version: '0.159.3', command: '/global/codex', checkedAt: '2026-10-01T00:00:00.000Z' })) }
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('system CLI diagnostics', () => {
  it('coalesces version subprocesses and invalidates after executable metadata changes', async () => {
    let identity = 'mtime:1'
    const run = vi.fn(async () => 'codex-cli 0.159.3')
    const reader = createSystemCliReader({ resolve: async () => ({ command: '/global/codex', identity }), run })
    const reports = await Promise.all(Array.from({ length: 20 }, () => reader.read()))
    expect(run).toHaveBeenCalledTimes(1)
    expect(reports[0]).toMatchObject({ version: '0.159.3', command: '/global/codex' })
    await reader.read()
    expect(run).toHaveBeenCalledTimes(1)
    identity = 'mtime:2'
    await reader.read()
    expect(run).toHaveBeenCalledTimes(2)
    await reader.read(true)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('reports missing and invalid version output without inventing a version', async () => {
    const missing = createSystemCliReader({ resolve: async () => null })
    expect(await missing.read()).toMatchObject({ status: 'unavailable', version: null, command: null })
    const invalid = createSystemCliReader({ resolve: async () => ({ command: '/global/codex', identity: 'x' }), run: async () => 'token=SECRET_SENTINEL' })
    const value = await invalid.read()
    expect(value).toMatchObject({ status: 'unavailable', version: null })
    expect(JSON.stringify(value)).not.toContain('SECRET_SENTINEL')
  })

  it.skipIf(process.platform === 'win32')('resolves PATH independently of the pinned runtime and notices symlink target changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'webui-runtime-path-'))
    try {
      vi.stubEnv('CODEXUI_CODEX_COMMAND', '/pinned/runtime/codex')
      const binary = join(directory, 'binary')
      await writeFile(binary, '#!/bin/sh\necho codex-cli 0.159.3\n')
      await chmod(binary, 0o755)
      await symlink(binary, join(directory, 'codex'))
      const first = await resolveSystemCli(directory)
      expect(first?.command).toBe(join(directory, 'codex'))
      await writeFile(binary, '#!/bin/sh\necho codex-cli 0.160.0\n# different size\n')
      expect((await resolveSystemCli(directory))?.identity).not.toBe(first?.identity)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

describe('runtime memory diagnostics', () => {
  it('does no work until read, coalesces concurrent reads, and refreshes by generation', async () => {
    let runtime = snapshot()
    const rpc = vi.fn(async () => ({ v2Ready: false, v2ConsolidatedThreads: 0, secret: 'SECRET_SENTINEL' }))
    const reader = createRuntimeDiagnosticsReader({ runtimeInfo: () => runtime, rpc, systemCli })
    expect(rpc).not.toHaveBeenCalled()
    const values = await Promise.all(Array.from({ length: 30 }, () => reader.read()))
    expect(rpc).toHaveBeenCalledExactlyOnceWith('memory/status', {})
    expect(values[0].memory).toMatchObject({ status: 'available', v2Ready: false, v2ConsolidatedThreads: 0 })
    expect(JSON.stringify(values)).not.toContain('SECRET_SENTINEL')
    expect(values[0].temporaryFeatures.verifiedKeys).toHaveLength(5)
    runtime = snapshot(2)
    await reader.read()
    expect(rpc).toHaveBeenCalledTimes(2)
    await reader.read(true)
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('distinguishes unsupported methods from unknown failures and malformed replies', async () => {
    const unsupported = createRuntimeDiagnosticsReader({ runtimeInfo: snapshot, rpc: async () => { throw new Error('unknown variant `memory/status`') }, systemCli })
    expect((await unsupported.read()).memory).toMatchObject({ status: 'unsupported', v2Ready: null, v2ConsolidatedThreads: null })
    for (const rpc of [async () => { throw new Error('temporarily unavailable') }, async () => ({ v2Ready: true, v2ConsolidatedThreads: -1 })]) {
      const reader = createRuntimeDiagnosticsReader({ runtimeInfo: snapshot, rpc, systemCli })
      expect((await reader.read()).memory).toMatchObject({ status: 'unknown', v2Ready: null, v2ConsolidatedThreads: null })
    }
  })

  it('bounds a hung RPC and does not accumulate new RPCs on repeated refresh', async () => {
    vi.useFakeTimers()
    const rpc = vi.fn(() => new Promise(() => {}))
    const reader = createRuntimeDiagnosticsReader({ runtimeInfo: snapshot, rpc, systemCli, timeoutMs: 100 })
    const request = reader.read()
    await vi.advanceTimersByTimeAsync(100)
    expect((await request).memory.status).toBe('unknown')
    await Promise.all(Array.from({ length: 25 }, () => reader.read(true)))
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('rejects stale replies if the running process changes during a read', async () => {
    let runtime = snapshot()
    let finish!: (value: unknown) => void
    const rpc = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const reader = createRuntimeDiagnosticsReader({ runtimeInfo: () => runtime, rpc, systemCli })
    const request = reader.read()
    await Promise.resolve()
    runtime = snapshot(2)
    finish({ v2Ready: true, v2ConsolidatedThreads: 99 })
    expect((await request).memory).toMatchObject({ status: 'unknown', reason: 'runtime-changed', v2ConsolidatedThreads: null })
  })

  it('does not start a stopped runtime to read optional diagnostics', async () => {
    const rpc = vi.fn()
    const runtime = snapshot()
    runtime.codex.running = false
    runtime.codex.version = null
    const reader = createRuntimeDiagnosticsReader({ runtimeInfo: () => runtime, rpc, systemCli })
    expect((await reader.read()).memory.reason).toBe('runtime-inactive')
    expect(rpc).not.toHaveBeenCalled()
  })
})
