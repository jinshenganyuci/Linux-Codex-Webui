import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('project gateway facade contract', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the legacy codexGateway exports wired to the extracted module', async () => {
    const facade = await import('./codexGateway')
    const project = await import('./projectGateway')

    expect(facade.getWorkspaceRootsState).toBe(project.getWorkspaceRootsState)
    expect(facade.downloadProjectZip).toBe(project.downloadProjectZip)
    expect(facade.importProjectZip).toBe(project.importProjectZip)
    expect(facade.searchComposerFiles).toBe(project.searchComposerFiles)
  })

  it('deduplicates workspace-root reads and returns defensive cache copies', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return jsonResponse({
        data: {
          order: ['/workspace'],
          labels: { '/workspace': 'Workspace' },
          active: ['/workspace'],
          projectOrder: ['/workspace/project'],
          remoteProjects: [{ id: 'remote-1', hostId: 'host-1', remotePath: '/remote', label: 'Remote' }],
        },
      })
    }))
    const { getWorkspaceRootsState } = await import('./projectGateway')

    const [first, second] = await Promise.all([
      getWorkspaceRootsState(),
      getWorkspaceRootsState(),
    ])
    first.order.push('/mutated')
    first.remoteProjects?.[0] && (first.remoteProjects[0].label = 'Mutated')
    const third = await getWorkspaceRootsState()

    expect(requests).toEqual(['/codex-api/workspace-roots-state'])
    expect(second.order).toEqual(['/workspace'])
    expect(third.order).toEqual(['/workspace'])
    expect(third.remoteProjects?.[0]?.label).toBe('Remote')
  })

  it('preserves project-root request payloads and invalidates the roots cache', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    let rootsReadCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (url === '/codex-api/project-root') {
        return jsonResponse({ data: { path: '/workspace/new-project' } })
      }
      rootsReadCount += 1
      return jsonResponse({ data: { order: [`/workspace/${String(rootsReadCount)}`] } })
    }))
    const { getWorkspaceRootsState, openProjectRoot } = await import('./projectGateway')

    await expect(getWorkspaceRootsState()).resolves.toMatchObject({ order: ['/workspace/1'] })
    await expect(openProjectRoot('/workspace/new-project', {
      createIfMissing: true,
      label: 'New project',
    })).resolves.toBe('/workspace/new-project')
    await expect(getWorkspaceRootsState()).resolves.toMatchObject({ order: ['/workspace/2'] })

    expect(requests[1]).toEqual({
      url: '/codex-api/project-root',
      method: 'POST',
      body: {
        path: '/workspace/new-project',
        createIfMissing: true,
        label: 'New project',
      },
    })
  })

  it('streams project ZIP downloads with the same URL, filename and progress events', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          'Content-Type': 'application/zip',
          'Content-Length': '4',
          'Content-Disposition': "attachment; filename*=UTF-8''my%20project.zip",
        },
      })
    }))
    const { downloadProjectZip } = await import('./projectGateway')
    const progress: Array<{ loaded: number; total: number | null }> = []

    const result = await downloadProjectZip('/workspace/my project', (event) => progress.push(event))

    expect(requests).toEqual(['/codex-api/project-zip?cwd=%2Fworkspace%2Fmy+project'])
    expect(result.fileName).toBe('my project.zip')
    expect(result.blob.size).toBe(4)
    expect(progress[0]).toEqual({ loaded: 0, total: 4 })
    expect(progress.at(-1)).toEqual({ loaded: 4, total: 4 })
  })

  it('keeps project import and composer search request contracts unchanged', async () => {
    const requests: Array<{ url: string; method: string; body: unknown; contentType: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null,
        contentType: new Headers(init?.headers).get('Content-Type'),
      })
      if (url.startsWith('/codex-api/project-import')) {
        return jsonResponse({ data: { path: '/workspace/imported', importedSessions: 3 } })
      }
      return jsonResponse({ data: [{ path: 'src/App.vue' }, { path: '' }, null] })
    }))
    const { importProjectZip, searchComposerFiles } = await import('./projectGateway')
    const archive = new Blob(['zip'])

    await expect(importProjectZip(archive, '/workspace')).resolves.toEqual({
      path: '/workspace/imported',
      importedSessions: 3,
    })
    await expect(searchComposerFiles('/workspace', ' app ', 7)).resolves.toEqual([
      { path: 'src/App.vue' },
    ])

    expect(requests[0]).toMatchObject({
      url: '/codex-api/project-import?parent=%2Fworkspace',
      method: 'POST',
      body: archive,
      contentType: 'application/zip',
    })
    expect(requests[1]).toEqual({
      url: '/codex-api/composer-file-search',
      method: 'POST',
      body: { cwd: '/workspace', query: 'app', limit: 7 },
      contentType: 'application/json',
    })
  })

  it('preserves the legacy message-before-error failure text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      message: 'project root message',
      error: 'project root error',
    }, 400)))
    const { openProjectRoot } = await import('./projectGateway')

    await expect(openProjectRoot('/missing')).rejects.toThrow('project root message')
  })
})
