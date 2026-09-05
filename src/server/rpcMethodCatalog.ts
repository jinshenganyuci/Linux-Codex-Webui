import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resolveCodexCommand } from '../commandResolution'
import { getSpawnInvocation } from '../utils/commandInvocation'

const execute = promisify(execFile)

function extractMethods(payload: unknown): string[] {
  const root = payload as { oneOf?: Array<{ properties?: { method?: { enum?: unknown[] } } }> }
  return [...new Set((root.oneOf ?? []).flatMap(entry => entry.properties?.method?.enum ?? []).filter((value): value is string => typeof value === 'string'))].sort()
}

async function generateSchemas(command: string, directory: string): Promise<void> {
  const args = ['app-server', 'generate-json-schema', '--experimental', '--out', directory]
  const invocation = getSpawnInvocation(command, args)
  try {
    await execute(invocation.command, invocation.args, { timeout: 20000, maxBuffer: 65536 })
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '')
    if (!/unexpected argument ['"]--experimental['"]/.test(stderr)) throw error
    const legacy = getSpawnInvocation(command, args.filter(argument => argument !== '--experimental'))
    await execute(legacy.command, legacy.args, { timeout: 20000, maxBuffer: 65536 })
  }
}

async function commandIdentity(): Promise<{ command: string; key: string }> {
  const command = resolveCodexCommand()
  if (!command) throw new Error('Codex CLI is not available.')
  const metadata = await stat(command).catch(() => null)
  return { command, key: `${command}:${metadata?.size ?? ''}:${metadata?.mtimeMs ?? ''}` }
}

export class MethodCatalog {
  private cachedKey = ''
  private pending: Promise<{ methods: string[]; notifications: string[] }> | null = null

  constructor(
    private readonly generate = generateSchemas,
    private readonly identify = commandIdentity,
  ) {}

  private async load(): Promise<{ methods: string[]; notifications: string[] }> {
    const identity = await this.identify()
    if (this.pending && this.cachedKey === identity.key) return this.pending
    this.cachedKey = identity.key
    const pending = (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'linux-codex-webui-schema-'))
      try {
        await this.generate(identity.command, directory)
        const [requests, notifications] = await Promise.all(['ClientRequest.json', 'ServerNotification.json'].map(filename => readFile(join(directory, filename), 'utf8')))
        return { methods: extractMethods(JSON.parse(requests)), notifications: extractMethods(JSON.parse(notifications)) }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })()
    this.pending = pending
    try {
      return await pending
    } catch (error) {
      if (this.pending === pending) this.pending = null
      throw error
    }
  }

  async listMethods(): Promise<string[]> { return [...(await this.load()).methods] }
  async listNotificationMethods(): Promise<string[]> { return [...(await this.load()).notifications] }
}
