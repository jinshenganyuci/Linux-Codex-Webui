import { afterEach, describe, expect, it, vi } from 'vitest'
import { listNativeChildren, setRuntimeFeature } from './nativeExtensionsGateway'

afterEach(() => vi.unstubAllGlobals())
describe('native extension gateway', () => {
  it('uses ancestor filters for active and archived child threads without resuming any', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body)); requests.push(body)
      return new Response(JSON.stringify({ result: { data: body.params.archived ? [] : [{ id: 'child', parentThreadId: 'root', agentNickname: 'Worker', preview: 'task', status: { type: 'notLoaded' } }], nextCursor: null } }))
    }))
    const result = await listNativeChildren('root')
    expect(requests).toHaveLength(2)
    expect(requests.every(request => request.method === 'thread/list' && request.params.ancestorThreadId === 'root')).toBe(true)
    expect(result.data[0]).toMatchObject({ id: 'child', status: 'notLoaded' })
  })

  it('does not treat an ignored runtime switch as success or write to config', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
      if (input.endsWith('native-extension-info')) return new Response(JSON.stringify({ data: { cliVersion: '0.153.4', requirementsKnown: true, featureRequirements: {}, features: [{ name: 'tool_suggest', enabled: true }] } }))
      requests.push(JSON.parse(String(options?.body)).method)
      return new Response(JSON.stringify({ result: { enablement: {} } }))
    }))
    await expect(setRuntimeFeature('tool_suggest', false)).rejects.toThrow('未确认')
    expect(requests).toEqual(['experimentalFeature/enablement/set'])
    await expect(setRuntimeFeature('context_management', true)).rejects.toThrow('不会写入配置')
    await expect(setRuntimeFeature('plugins', false)).rejects.toThrow('不会写入配置')
    await expect(setRuntimeFeature('apps', false)).rejects.toThrow('不会写入配置')
    expect(requests).toHaveLength(1)
  })

  it('does not guess supported runtime switches for a different CLI version', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { cliVersion: '0.154.0', requirementsKnown: true, featureRequirements: {} } })))
    vi.stubGlobal('fetch', fetch)
    await expect(setRuntimeFeature('tool_suggest', false)).rejects.toThrow('版本')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
