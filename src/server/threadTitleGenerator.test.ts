import { describe, expect, it, vi } from 'vitest'
import {
  buildThreadTitlePrompt,
  normalizeGeneratedThreadTitle,
  ThreadTitleGenerator,
  type ThreadTitleGenerationRequest,
} from './threadTitleGenerator'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('thread title generator', () => {
  it('creates a constrained prompt and sanitizes the model final message', () => {
    const prompt = buildThreadTitlePrompt('分析 https://github.com/jinshenganyuci/Linux-Codex-Webui 这个项目')

    expect(prompt).toContain('不要以 URL、文件路径、命令或“帮我”开头')
    expect(prompt).toContain(JSON.stringify('分析 https://github.com/jinshenganyuci/Linux-Codex-Webui 这个项目'))
    expect(normalizeGeneratedThreadTitle('标题：分析 Linux-Codex-Webui 项目\n这是解释')).toBe('分析 Linux-Codex-Webui 项目')
    expect(normalizeGeneratedThreadTitle('# 标题：修复手机菜单')).toBe('修复手机菜单')
    expect(normalizeGeneratedThreadTitle('https://github.com/jinshenganyuci/Linux-Codex-Webui')).toBe('')
  })

  it('uses the requested model, deduplicates a thread, and serializes title jobs', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const runner = vi.fn((request: ThreadTitleGenerationRequest) => (
      request.threadId === 'thread-one' ? first.promise : second.promise
    ))
    const generator = new ThreadTitleGenerator(runner, 1, 8)
    const firstRequest: ThreadTitleGenerationRequest = {
      threadId: 'thread-one',
      prompt: '分析仓库结构',
      model: 'gpt-5.6-terra',
    }

    const firstTitle = generator.generate(firstRequest)
    const duplicateTitle = generator.generate(firstRequest)
    const secondTitle = generator.generate({
      threadId: 'thread-two',
      prompt: '修复手机菜单',
      model: 'gpt-5.6-sol',
    })

    expect(duplicateTitle).toBe(firstTitle)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-terra', threadId: 'thread-one' }),
      expect.any(AbortSignal),
    )

    first.resolve('标题：分析仓库结构')
    await expect(firstTitle).resolves.toBe('分析仓库结构')
    await expect(duplicateTitle).resolves.toBe('分析仓库结构')
    await vi.waitFor(() => {
      expect(runner).toHaveBeenCalledTimes(2)
    })
    expect(runner).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'gpt-5.6-sol', threadId: 'thread-two' }),
      expect.any(AbortSignal),
    )

    second.resolve('修复手机菜单')
    await expect(secondTitle).resolves.toBe('修复手机菜单')
  })
})
