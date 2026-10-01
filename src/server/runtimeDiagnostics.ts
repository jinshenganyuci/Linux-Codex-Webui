import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { getVerifiedRuntimeFeatureKeys } from '../nativeExtensions.js'
import type { MemoryStatus, RuntimeDiagnostics, RuntimeSnapshot, SystemCliStatus } from '../runtimeDiagnostics.js'
import { codexVersionFromUserAgent } from './runtimeCatalog.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'

const execute = promisify(execFile)
const CACHE_MS = 30_000
const TIMEOUT_MS = 2500
export type SystemCliExecutable = { command: string; identity: string }

// Intentionally do not use the WebUI's CODEXUI_CODEX_COMMAND override here.
// Resolve exactly the executable named codex on the server process's PATH.
export async function resolveSystemCli(pathValue = process.env.PATH ?? ''): Promise<SystemCliExecutable | null> {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex']
  for (const directory of [...new Set(pathValue.split(delimiter))].slice(0, 64)) {
    if (!directory || !isAbsolute(directory)) continue
    for (const name of names) {
      const command = join(directory, name)
      try {
        await access(command, constants.X_OK)
        const target = await realpath(command)
        const info = await stat(target)
        if (!info.isFile()) continue
        return { command, identity: `${command}:${target}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` }
      } catch { /* Continue through PATH without reading any configuration. */ }
    }
  }
  return null
}

export function createSystemCliReader(options: {
  resolve?: () => Promise<SystemCliExecutable | null>
  run?: (command: string) => Promise<string>
  now?: () => number
} = {}) {
  const resolve = options.resolve ?? resolveSystemCli
  const now = options.now ?? Date.now
  const run = options.run ?? (async (command: string) => {
    const invocation = getSpawnInvocation(command, ['--version'])
    return (await execute(invocation.command, invocation.args, { timeout: TIMEOUT_MS, maxBuffer: 4096, windowsHide: true })).stdout
  })
  let cached: { identity: string; expiresAt: number; value: SystemCliStatus } | null = null
  let pending: Promise<SystemCliStatus> | null = null
  const read = (refresh = false): Promise<SystemCliStatus> => {
    if (pending) return pending
    pending = (async () => {
      const executable = await resolve().catch(() => null)
      const identity = executable?.identity ?? 'missing'
      if (!refresh && cached?.identity === identity && now() < cached.expiresAt) return cached.value
      let version: string | null = null
      if (executable) {
        try { version = codexVersionFromUserAgent(await run(executable.command)) } catch { /* A bounded version probe may fail. */ }
      }
      const value: SystemCliStatus = { status: version ? 'available' : 'unavailable', version, command: executable?.command ?? null, checkedAt: new Date(now()).toISOString() }
      cached = { identity, expiresAt: now() + CACHE_MS, value }
      return value
    })().finally(() => { pending = null })
    return pending
  }
  return { read }
}

function isUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /unknown variant|method not found|unknown method|not supported|unsupported method|not implemented/i.test(message)
}

export function createRuntimeDiagnosticsReader(options: {
  runtimeInfo: () => RuntimeSnapshot
  rpc: (method: string, params: unknown) => Promise<unknown>
  systemCli?: { read: (refresh?: boolean) => Promise<SystemCliStatus> }
  explicitRuntime?: () => boolean
  now?: () => number
  timeoutMs?: number
}) {
  const now = options.now ?? Date.now
  const systemCli = options.systemCli ?? createSystemCliReader({ now })
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  let memoryCache: { generation: number; expiresAt: number; value: MemoryStatus } | null = null
  // Retain the pending raw RPC after a response deadline. Repeated refreshes
  // cannot pile up RPCs if this app-server never resolves memory/status.
  let memoryPending: { generation: number; response: Promise<MemoryStatus> } | null = null
  const unknownMemory = (reason: MemoryStatus['reason']): MemoryStatus => ({ status: 'unknown', reason, v2Ready: null, v2ConsolidatedThreads: null, checkedAt: new Date(now()).toISOString() })

  const readMemory = async (runtime: RuntimeSnapshot, refresh: boolean): Promise<MemoryStatus> => {
    const { generation, running, version } = runtime.codex
    if (!running || !version || !generation) return unknownMemory('runtime-inactive')
    if (memoryPending?.generation === generation) return memoryPending.response
    if (!refresh && memoryCache?.generation === generation && now() < memoryCache.expiresAt) return memoryCache.value
    const entry = { generation, response: Promise.resolve(unknownMemory('unavailable')) }
    let timer: ReturnType<typeof setTimeout> | undefined
    const raw = Promise.resolve().then(() => options.rpc('memory/status', {})).then((value): MemoryStatus => {
      const row = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
      if (typeof row.v2Ready !== 'boolean' || typeof row.v2ConsolidatedThreads !== 'number' || !Number.isSafeInteger(row.v2ConsolidatedThreads) || row.v2ConsolidatedThreads < 0) return unknownMemory('unavailable')
      return { status: 'available', reason: 'confirmed', v2Ready: row.v2Ready, v2ConsolidatedThreads: row.v2ConsolidatedThreads, checkedAt: new Date(now()).toISOString() }
    }, (error): MemoryStatus => isUnsupported(error)
      ? { ...unknownMemory('unsupported'), status: 'unsupported' }
      : unknownMemory('unavailable'))
    entry.response = Promise.race([
      raw,
      new Promise<MemoryStatus>(resolve => { timer = setTimeout(() => resolve(unknownMemory('unavailable')), timeoutMs) }),
    ]).then(value => {
      if (options.runtimeInfo().codex.generation !== generation) return unknownMemory('runtime-changed')
      memoryCache = { generation, expiresAt: now() + CACHE_MS, value }
      return value
    }).finally(() => { if (timer) clearTimeout(timer) })
    memoryPending = entry
    void raw.finally(() => { if (memoryPending === entry) memoryPending = null })
    return entry.response
  }

  return {
    async read(refresh = false): Promise<RuntimeDiagnostics> {
      const runtime = options.runtimeInfo()
      const [system, memory] = await Promise.all([systemCli.read(refresh), readMemory(runtime, refresh)])
      const current = options.runtimeInfo()
      const sameGeneration = current.codex.generation === runtime.codex.generation && current.codex.running
      const verifiedKeys = current.codex.running ? getVerifiedRuntimeFeatureKeys(current.codex.version) : []
      return {
        ...current, systemCli: system,
        explicitRuntime: options.explicitRuntime?.() ?? Boolean(process.env.CODEXUI_CODEX_COMMAND?.trim()),
        memory: sameGeneration ? memory : unknownMemory(current.codex.running ? 'runtime-changed' : 'runtime-inactive'),
        temporaryFeatures: { status: verifiedKeys.length ? 'available' : 'unknown', verifiedKeys },
      }
    },
  }
}
