import { open, opendir, link, unlink, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type ThreadIndexStatus = {
  state: 'idle' | 'checking' | 'repairing' | 'paused' | 'ready' | 'partial' | 'error' | 'unsupported'
  lastCheckedAt: string | null
  scannedFiles: number
  indexedThreads: number
  missingThreads: number
  repairedThreads: number
  hiddenThreads: number
  failedThreads: number
  truncated: boolean
  error: string | null
}
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_END = new RegExp(`(${UUID})\\.jsonl$`, 'i')
const LEGACY_IMPORT = new RegExp(`^\\d{6}-(${UUID})\\.jsonl$`, 'i')
const HEADER_CHUNK_BYTES = 16 * 1024
const HEADER_MAX_BYTES = 1024 * 1024
const MAX_FILES = 20_000
const MAX_ENTRIES = 60_000
const MAX_PAGES = 100

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Read only the session header; never read conversation bodies to discover IDs. */
export async function readRolloutHeader(path: string): Promise<{ id: string; timestamp: string } | null> {
  const handle = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let bytes = 0
    let ended = false
    while (bytes < HEADER_MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(HEADER_CHUNK_BYTES, HEADER_MAX_BYTES - bytes))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes)
      if (!bytesRead) { ended = true; break }
      const newline = buffer.subarray(0, bytesRead).indexOf(10)
      chunks.push(buffer.subarray(0, newline >= 0 ? newline : bytesRead))
      bytes += bytesRead
      if (newline >= 0 || bytesRead < buffer.length) { ended = true; break }
    }
    if (!ended) return null
    const row = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    const payload = record(row.payload)
    return row.type === 'session_meta' && typeof payload.id === 'string' && new RegExp(`^${UUID}$`, 'i').test(payload.id)
      ? { id: payload.id, timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : String(row.timestamp ?? '') }
      : null
  } finally {
    await handle.close()
  }
}

type Dependencies = {
  home: () => string
  rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>
  supportsFastList: () => Promise<boolean>
  isBusy: () => boolean
  hasActiveTurns?: () => boolean
  onRecovered: () => void
  intervalMs?: number
  pauseMs?: number
}

/** Maintenance is shared per bridge, never awaited by list/read/send HTTP routes. */
export class ThreadIndexRecovery {
  private status: ThreadIndexStatus = {
    state: 'idle', lastCheckedAt: null, scannedFiles: 0, indexedThreads: 0,
    missingThreads: 0, repairedThreads: 0, hiddenThreads: 0, failedThreads: 0, truncated: false, error: null,
  }
  private pending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private resolvePause: (() => void) | null = null
  private disposed = false
  private rerunRequested = false
  private recheckHidden = false
  private readonly hiddenRollouts = new Map<string, { id: string; fingerprint: string }>()

  constructor(private readonly deps: Dependencies) {}

  getStatus(): ThreadIndexStatus { return { ...this.status } }

  start(): void {
    if (this.disposed || this.timer || this.pending) return
    this.schedule(1500)
  }

  private schedule(delay: number): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.check() }, delay)
    this.timer.unref()
  }

  /** Existing runs are joined; mutations can request one additional pass. */
  check(afterMutation = false, recheckHidden = false): Promise<void> {
    if (recheckHidden) this.recheckHidden = true
    if (this.disposed) return Promise.resolve()
    if (this.pending) {
      if (afterMutation || recheckHidden) this.rerunRequested = true
      return this.pending
    }
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    const pending = this.run().catch(error => {
      if (!this.disposed) this.status = { ...this.status, state: 'error', error: error instanceof Error ? error.message : String(error) }
    }).finally(() => {
      if (this.pending === pending) this.pending = null
      const delay = this.rerunRequested ? 500 : this.deps.intervalMs ?? 5 * 60_000
      this.rerunRequested = false
      this.schedule(delay)
    })
    this.pending = pending
    return pending
  }

  private async pause(delay: number): Promise<void> {
    await new Promise<void>(resolve => {
      this.resolvePause = resolve
      this.pauseTimer = setTimeout(resolve, delay)
      this.pauseTimer.unref()
    })
    this.pauseTimer = null
    this.resolvePause = null
  }

  private async yieldToChat(beforeRepair = false): Promise<boolean> {
    // Running model turns do not lock historical metadata. Pace each repair so
    // foreground RPCs can run between them, but do not wait minutes for a turn.
    if (beforeRepair && !this.disposed && this.deps.hasActiveTurns?.()) await this.pause(250)
    while (!this.disposed && this.deps.isBusy()) {
      this.status.state = 'paused'
      await this.pause(this.deps.pauseMs ?? 1000)
    }
    return !this.disposed
  }

  private async indexedIds(): Promise<Set<string> | null> {
    const ids = new Set<string>()
    for (const archived of [false, true]) {
      let cursor: string | null = null
      const cursors = new Set<string>()
      for (let page = 0; page < MAX_PAGES; page++) {
        if (!(await this.yieldToChat())) return null
        this.status.state = 'checking'
        const response = record(await this.deps.rpc('thread/list', {
          archived, limit: 200, sortKey: 'updated_at', modelProviders: [], sourceKinds: SOURCE_KINDS,
          useStateDbOnly: true, cursor,
        }))
        for (const row of Array.isArray(response.data) ? response.data : []) {
          const id = record(row).id
          if (typeof id === 'string') ids.add(id)
        }
        cursor = typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : null
        if (!cursor) break
        if (cursors.has(cursor) || page === MAX_PAGES - 1) {
          this.status.truncated = true
          this.status.error = '会话索引超过本轮检查上限，未自动修复；请缩小历史规模后重试。'
          return null
        }
        cursors.add(cursor)
      }
    }
    return ids
  }

  private async *files(): AsyncGenerator<string> {
    const queue = [{ path: join(this.deps.home(), 'sessions'), depth: 0 }, { path: join(this.deps.home(), 'archived_sessions'), depth: 0 }]
    let entries = 0
    for (let offset = 0; offset < queue.length && !this.disposed; offset++) {
      const entry = queue[offset]!
      let directory
      try { directory = await opendir(entry.path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for await (const child of directory) {
        if (this.disposed) return
        if (++entries > MAX_ENTRIES || this.status.scannedFiles >= MAX_FILES) {
          this.status.truncated = true
          this.status.error = '历史目录超过本轮检查上限；部分文件未检查。'
          return
        }
        if (child.isDirectory()) {
          if (entry.depth < 12) queue.push({ path: join(entry.path, child.name), depth: entry.depth + 1 })
          else this.status.truncated = true
        } else if (child.isFile() && child.name.endsWith('.jsonl')) {
          this.status.scannedFiles++
          yield join(entry.path, child.name)
        }
      }
    }
  }

  private async run(): Promise<void> {
    if (this.recheckHidden) { this.hiddenRollouts.clear(); this.recheckHidden = false }
    this.status = { ...this.status, state: 'checking', scannedFiles: 0, indexedThreads: 0, missingThreads: 0, repairedThreads: 0, hiddenThreads: 0, failedThreads: 0, truncated: false, error: null }
    if (!(await this.deps.supportsFastList())) {
      this.status.state = 'unsupported'
      this.status.error = '当前 Codex 不支持索引快速读取；保留原生兼容查询，请升级 Codex。'
      return
    }
    const indexed = await this.indexedIds()
    if (this.disposed) return
    if (!indexed) { this.status.state = 'partial'; return }
    this.status.indexedThreads = indexed.size
    const attempted = new Set<string>()
    const inspected = new Set<string>()
    const seenPaths = new Set<string>()
    for await (let path of this.files()) {
      if (!(await this.yieldToChat())) return
      seenPaths.add(path)
      const filenameId = UUID_END.exec(basename(path))?.[1]
      // Known index rows remain authoritative: no timestamp/title/SQL rewrite.
      if (filenameId && indexed.has(filenameId)) { this.hiddenRollouts.delete(path); continue }
      try {
        const info = await stat(path)
        const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
        const hidden = this.hiddenRollouts.get(path)
        if (hidden?.fingerprint === fingerprint) {
          if (!inspected.has(hidden.id)) this.status.hiddenThreads++
          inspected.add(hidden.id)
          continue
        }
        this.hiddenRollouts.delete(path)
        const header = await readRolloutHeader(path)
        if (!header) { this.status.failedThreads++; continue }
        if (indexed.has(header.id) || inspected.has(header.id)) continue
        inspected.add(header.id)
        attempted.add(header.id)
        this.status.missingThreads++
        // Older WebUI ZIP imports used filenames native Codex cannot discover.
        // Rename only our recognizable, unindexed import layout, byte-for-byte.
        if (basename(dirname(path)) === 'imported' && LEGACY_IMPORT.test(basename(path))) {
          const time = new Date(header.timestamp)
          if (Number.isNaN(time.getTime())) throw new Error('导入历史缺少有效会话时间')
          const target = join(dirname(path), `rollout-${time.toISOString().slice(0, 19).replace(/:/g, '-')}-${header.id}.jsonl`)
          await link(path, target)
          await unlink(path)
          path = target
        }
        if (!(await this.yieldToChat(true))) return
        this.status.state = 'repairing'
        const summary = record(record(await this.deps.rpc('thread/read', { threadId: header.id, includeTurns: false })).thread)
        // thread/list intentionally omits sessions with neither preview nor
        // name, even when they are valid indexed threads. A successful read
        // with an explicit empty preview proves this is a hidden empty record,
        // not a failed recovery. Remember unchanged files to avoid rereading
        // hundreds of dormant agent sessions on every maintenance pass.
        if (summary.id === header.id && summary.preview === '' && !summary.name && summary.path === path) {
          this.hiddenRollouts.set(path, { id: header.id, fingerprint })
          attempted.delete(header.id)
          this.status.missingThreads--
          this.status.hiddenThreads++
        }
        // Verification below proves indexing, rather than treating a successful
        // read as proof that a compatible CLI actually persisted the row.
      } catch (error) {
        this.status.failedThreads++
        this.status.error = error instanceof Error ? error.message : String(error)
      }
    }
    if (this.disposed) return
    for (const path of this.hiddenRollouts.keys()) if (!seenPaths.has(path)) this.hiddenRollouts.delete(path)
    if (attempted.size) {
      const verified = await this.indexedIds()
      if (this.disposed) return
      if (verified) {
        this.status.repairedThreads = [...attempted].filter(id => verified.has(id)).length
        this.status.failedThreads = Math.max(this.status.failedThreads, attempted.size - this.status.repairedThreads)
        this.status.indexedThreads = verified.size
      }
      if (this.status.repairedThreads) this.deps.onRecovered()
    }
    this.status.lastCheckedAt = new Date().toISOString()
    this.status.state = this.status.failedThreads || this.status.truncated ? 'partial' : 'ready'
    if (this.status.failedThreads && !this.status.error) this.status.error = '部分历史文件无法补入索引，请检查文件格式后重试。'
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.pauseTimer) clearTimeout(this.pauseTimer)
    this.resolvePause?.()
    this.timer = null
    this.pauseTimer = null
  }
}
