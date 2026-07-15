import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export type AppServerJsonlTransportEvent =
  | { type: 'line'; generation: number; line: string }
  | { type: 'exit'; generation: number }

export type AppServerJsonlTransportStartOptions = {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export type AppServerJsonlTransportSpawner = (
  command: string,
  args: string[],
  options: {
    stdio: ['pipe', 'pipe', 'pipe']
    env?: NodeJS.ProcessEnv
  },
) => ChildProcessWithoutNullStreams

export type AppServerJsonlTransportLike = {
  readonly running: boolean
  readonly activeGeneration: number
  start(options: AppServerJsonlTransportStartOptions): number
  writeJson(payload: Record<string, unknown>, generation?: number): void
  stop(): number
}

export type AppServerJsonlTransportFactory = (
  emit: (event: AppServerJsonlTransportEvent) => void,
) => AppServerJsonlTransportLike

const defaultSpawner: AppServerJsonlTransportSpawner = (command, args, options) => {
  return spawn(command, args, options)
}

export class AppServerJsonlTransport implements AppServerJsonlTransportLike {
  private process: ChildProcessWithoutNullStreams | null = null
  private processGeneration = 0
  private activeProcessGeneration = 0

  constructor(
    private readonly emit: (event: AppServerJsonlTransportEvent) => void,
    private readonly spawnProcess: AppServerJsonlTransportSpawner = defaultSpawner,
  ) {}

  get running(): boolean {
    return this.process !== null
  }

  get activeGeneration(): number {
    return this.activeProcessGeneration
  }

  start(options: AppServerJsonlTransportStartOptions): number {
    if (this.process) return this.activeProcessGeneration

    const proc = this.spawnProcess(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env ? { env: options.env } : {}),
    })
    const generation = ++this.processGeneration
    let readBuffer = ''
    this.process = proc
    this.activeProcessGeneration = generation

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (this.process !== proc || this.activeProcessGeneration !== generation) return
      readBuffer += chunk

      let lineEnd = readBuffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = readBuffer.slice(0, lineEnd).trim()
        readBuffer = readBuffer.slice(lineEnd + 1)

        if (line.length > 0) {
          this.emit({ type: 'line', generation, line })
        }

        lineEnd = readBuffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', () => {
      // Keep stderr drained and silent; JSON-RPC errors arrive on stdout.
    })

    proc.on('exit', () => {
      if (this.process !== proc || this.activeProcessGeneration !== generation) return
      try {
        this.emit({ type: 'exit', generation })
      } finally {
        if (this.process === proc && this.activeProcessGeneration === generation) {
          this.process = null
          this.activeProcessGeneration = 0
        }
      }
    })

    return generation
  }

  writeJson(payload: Record<string, unknown>, generation = this.activeProcessGeneration): void {
    if (!this.process || generation === 0 || generation !== this.activeProcessGeneration) {
      throw new Error('codex app-server is not running')
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  stop(): number {
    if (!this.process) return 0

    const proc = this.process
    const generation = this.activeProcessGeneration
    this.process = null
    this.activeProcessGeneration = 0

    try {
      proc.stdin.end()
    } catch {
      // ignore close errors on shutdown
    }

    try {
      proc.kill('SIGTERM')
    } catch {
      // ignore kill errors on shutdown
    }

    const forceKillTimer = setTimeout(() => {
      if (!proc.killed) {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore kill errors on shutdown
        }
      }
    }, 1500)
    forceKillTimer.unref()

    return generation
  }
}
