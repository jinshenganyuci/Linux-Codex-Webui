import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { normalizeModelCapability } from '../modelCapabilities.js'
import type { UiModelCapability } from '../types/codex.js'
import { getSpawnInvocation } from '../utils/commandInvocation.js'

const execute = promisify(execFile)

export function codexVersionFromUserAgent(value: string): string | null {
  return value.trim().match(/^[^\s/]+[ /](\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\s|$)/)?.[1] ?? null
}

export function normalizeBundledCapabilities(payload: unknown): UiModelCapability[] {
  const models = payload !== null && typeof payload === 'object' && 'models' in payload ? payload.models : null
  if (!Array.isArray(models)) return []
  return models.flatMap((row) => {
    const model = normalizeModelCapability(row, 'bundled')
    return model ? [model] : []
  })
}

type CatalogExecutor = (command: string, args: string[]) => Promise<string>

export class RuntimeCatalog {
  private request: Promise<UiModelCapability[]> | null = null
  private identity = ''
  status: 'unloaded' | 'ready' | 'unavailable' | 'version-mismatch' = 'unloaded'

  constructor(private readonly run: CatalogExecutor = async (command, args) => {
    const invocation = getSpawnInvocation(command, args)
    const result = await execute(invocation.command, invocation.args, { timeout: 8_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    return result.stdout
  }) {}

  read(command: string, version: string | null): Promise<UiModelCapability[]> {
    const identity = JSON.stringify([command, version])
    if (this.request && this.identity === identity) return this.request
    this.identity = identity
    this.status = 'unloaded'
    this.request = (async () => {
      if (!command || !version) return []
      const installedVersion = codexVersionFromUserAgent(await this.run(command, ['--version']))
      if (installedVersion !== version) {
        if (this.identity === identity) this.status = 'version-mismatch'
        return []
      }
      const models = normalizeBundledCapabilities(JSON.parse(await this.run(command, ['debug', 'models', '--bundled'])))
      if (this.identity === identity) this.status = models.length > 0 ? 'ready' : 'unavailable'
      return models
    })().catch(() => {
      if (this.identity === identity) this.status = 'unavailable'
      return []
    })
    return this.request
  }
}
