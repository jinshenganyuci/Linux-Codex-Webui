export type CapabilityStatus = 'available' | 'unsupported' | 'unknown'

export type RuntimeSnapshot = {
  webui: { version: string; commit: string; dirty: boolean }
  codex: {
    version: string | null; startedAt: string; home: string; command: string
    catalogStatus: string; generation: number; running: boolean
  }
}

export type SystemCliStatus = {
  status: 'available' | 'unavailable'
  version: string | null
  command: string | null
  checkedAt: string
}

export type MemoryStatus = {
  status: CapabilityStatus
  reason: 'confirmed' | 'runtime-inactive' | 'unsupported' | 'unavailable' | 'runtime-changed'
  v2Ready: boolean | null
  v2ConsolidatedThreads: number | null
  checkedAt: string
}

export type RuntimeDiagnostics = RuntimeSnapshot & {
  systemCli: SystemCliStatus
  explicitRuntime: boolean
  memory: MemoryStatus
  temporaryFeatures: { status: CapabilityStatus; verifiedKeys: readonly string[] }
}
