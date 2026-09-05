import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MethodCatalog } from './rpcMethodCatalog'

const schema = (methods: string[]) => JSON.stringify({ oneOf: methods.map(method => ({ properties: { method: { enum: [method] } } })) })

describe('RPC schema catalog', () => {
  it('shares generation across concurrent method and notification requests and removes temporary output', async () => {
    let output = ''
    const generate = vi.fn(async (_command: string, directory: string) => {
      output = directory
      await writeFile(join(directory, 'ClientRequest.json'), schema(['turn/steer', 'thread/queue/add']))
      await writeFile(join(directory, 'ServerNotification.json'), schema(['thread/queue/changed']))
    })
    const catalog = new MethodCatalog(generate, async () => ({ command: 'codex', key: 'fixed' }))
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2 ? catalog.listMethods() : catalog.listNotificationMethods()))
    expect(generate).toHaveBeenCalledTimes(1)
    expect(results[1]).toEqual(['thread/queue/add', 'turn/steer'])
    expect(results[0]).toEqual(['thread/queue/changed'])
    await expect(access(output)).rejects.toThrow()
    await catalog.listMethods()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('invalidates for a different runtime and retries a failed generation', async () => {
    let key = 'old'
    let fail = true
    const generate = vi.fn(async (_command: string, directory: string) => {
      if (fail) { fail = false; throw new Error('temporary failure') }
      await writeFile(join(directory, 'ClientRequest.json'), schema([key]))
      await writeFile(join(directory, 'ServerNotification.json'), schema([]))
    })
    const catalog = new MethodCatalog(generate, async () => ({ command: 'codex', key }))
    await expect(catalog.listMethods()).rejects.toThrow('temporary failure')
    expect(await catalog.listMethods()).toEqual(['old'])
    key = 'new'
    expect(await catalog.listMethods()).toEqual(['new'])
    expect(generate).toHaveBeenCalledTimes(3)
  })
})
