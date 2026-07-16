import { describe, expect, it } from 'vitest'
import { parseMessageBlocks } from './markdownBlocks'
import {
  parseFileReference,
  parseInlineSegments,
  resolveRelativePath,
} from './markdownInline'
import {
  escapeHtml,
  normalizeCodeLanguage,
  renderInlineSegmentsToHtml,
  renderMessageBlockToHtml,
  resolveCodeLanguageAlias,
  type MessageBlockHtmlContext,
} from './markdownHtml'

const cwd = '/workspace/Test Project'
const inlineContext = {
  toLocalThreadUrl(value: string): string | null {
    const match = value.trim().match(/^codex:\/\/threads\/([A-Za-z0-9-]+)$/u)
    return match ? `/#/thread/${match[1]}` : null
  },
}

function toBrowseUrl(pathValue: string): string {
  const resolved = resolveRelativePath(pathValue, cwd)
  const looksAbsolute = resolved.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(resolved)
  if (!looksAbsolute) return '#'
  const normalized = resolved.startsWith('/') ? resolved : `/${resolved}`
  return `/codex-local-browse${encodeURI(normalized)}`
}

function renderInline(text: string): string {
  return renderInlineSegmentsToHtml(
    parseInlineSegments(text, inlineContext),
    { toBrowseUrl },
  )
}

const htmlContext: MessageBlockHtmlContext = {
  renderInlineSegmentsAsHtml: renderInline,
  renderHighlightedCodeAsHtml: (_language, value) => escapeHtml(value),
}

function renderMarkdown(text: string): string {
  return parseMessageBlocks(text)
    .map((block) => renderMessageBlockToHtml(block, htmlContext))
    .join('')
}

describe('markdown inline parsing and HTML rendering', () => {
  it('escapes every HTML-sensitive character before interpolation', () => {
    expect(escapeHtml('<tag data-x="1">Tom & \'Sue\'</tag>')).toBe(
      '&lt;tag data-x=&quot;1&quot;&gt;Tom &amp; &#39;Sue&#39;&lt;/tag&gt;',
    )
  })

  it('keeps exact extension alias lookup separate from fenced-language normalization', () => {
    expect(resolveCodeLanguageAlias('ts')).toBe('typescript')
    expect(resolveCodeLanguageAlias('ts backup')).toBe('ts backup')
    expect(normalizeCodeLanguage('ts backup')).toBe('typescript')
  })

  it.each([
    '**https://anyclaw.store/claim/a7m2z7**',
    '***https://anyclaw.store/claim/a7m2z7***',
  ])('renders a bold-wrapped bare URL without literal markers: %s', (source) => {
    expect(renderInline(source)).toBe(
      '<a class="message-file-link" href="https://anyclaw.store/claim/a7m2z7" target="_blank" rel="noopener noreferrer" title="https://anyclaw.store/claim/a7m2z7">https://anyclaw.store/claim/a7m2z7</a>',
    )
  })

  it.each([
    '**[claim link](https://anyclaw.store/claim/a7m2z7)**',
    '***[claim link](https://anyclaw.store/claim/a7m2z7)***',
  ])('renders a bold-wrapped Markdown link without literal markers: %s', (source) => {
    expect(renderInline(source)).toBe(
      '<a class="message-file-link" href="https://anyclaw.store/claim/a7m2z7" target="_blank" rel="noopener noreferrer" title="https://anyclaw.store/claim/a7m2z7">claim link</a>',
    )
  })

  it('preserves file-link href, title, and backtick-free label text', () => {
    const path = '/home/ubuntu/Documents/New Project (2)/hosting_manager.py'
    const html = renderInline(`Added [\`hosting_manager.py\`](${path})`)

    expect(html).toBe(
      'Added <a class="message-file-link" href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/hosting_manager.py" target="_blank" rel="noopener noreferrer" title="/home/ubuntu/Documents/New Project (2)/hosting_manager.py">hosting_manager.py</a>',
    )
  })

  it('keeps file line parsing separate from cwd path resolution', () => {
    expect(parseFileReference('`src/main.ts:42`')).toEqual({ path: 'src/main.ts', line: 42 })
    expect(resolveRelativePath('src/main.ts', cwd)).toBe('/workspace/Test Project/src/main.ts')
  })
})

describe('markdown block parsing and HTML rendering', () => {
  it('preserves table cells, code pipes, alignment, and inline markup', () => {
    const source = [
      '| Left | Center | Right |',
      '| :--- | :---: | ---: |',
      '| a | `b|c` | **d** |',
    ].join('\n')

    expect(parseMessageBlocks(source)).toEqual([{
      kind: 'table',
      headers: ['Left', 'Center', 'Right'],
      rows: [['a', '`b|c`', '**d**']],
      alignments: ['left', 'center', 'right'],
    }])
    expect(renderMarkdown(source)).toBe(
      '<div class="message-table-wrap"><table class="message-table"><thead><tr>' +
      '<th class="message-table-head-cell" style="text-align:left">Left</th>' +
      '<th class="message-table-head-cell" style="text-align:center">Center</th>' +
      '<th class="message-table-head-cell" style="text-align:right">Right</th>' +
      '</tr></thead><tbody><tr class="message-table-body-row">' +
      '<td class="message-table-cell" style="text-align:left">a</td>' +
      '<td class="message-table-cell" style="text-align:center"><code class="message-inline-code">b|c</code></td>' +
      '<td class="message-table-cell" style="text-align:right"><strong class="message-bold-text">d</strong></td>' +
      '</tr></tbody></table></div>',
    )
  })

  it('preserves ordered-list start, continuation, and nested-list structure', () => {
    const source = [
      '3. first',
      '   continuation',
      '   - nested',
      '4. second',
    ].join('\n')

    expect(parseMessageBlocks(source)).toEqual([{
      kind: 'orderedList',
      start: 3,
      items: [
        {
          paragraphs: ['first'],
          children: [
            { kind: 'paragraph', value: 'continuation' },
            { kind: 'unorderedList', items: [{ paragraphs: ['nested'] }] },
          ],
        },
        { paragraphs: ['second'] },
      ],
    }])

    const html = renderMarkdown(source)
    expect(html).toContain('<ol class="message-list message-list-ordered" start="3">')
    expect(html).toContain('<p class="message-text">continuation</p>')
    expect(html).toContain('<ul class="message-list message-list-unordered">')
  })

  it('keeps fenced-code language/value boundaries and escapes fallback HTML', () => {
    const source = [
      '```ts title',
      'const value = `<tag>`',
      '```',
      '',
      'after',
    ].join('\n')

    expect(parseMessageBlocks(source)).toEqual([
      { kind: 'codeBlock', language: 'ts title', value: 'const value = `<tag>`' },
      { kind: 'paragraph', value: 'after' },
    ])
    expect(normalizeCodeLanguage('ts title')).toBe('typescript')
    expect(renderMarkdown(source)).toBe(
      '<div class="message-code-block"><div class="message-code-header">' +
      '<span class="message-code-language" title="ts title">ts title</span>' +
      '<button type="button" class="message-code-copy-button" data-message-code-copy="true" data-copy-label="Copy" data-copied-label="Copied" aria-label="Copy" title="Copy">' +
      '<svg class="message-code-copy-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2zm-4 4a2 2 0 0 1-2 2V8m4 8h10" />' +
      '</svg><span class="message-code-copy-label">Copy</span></button></div>' +
      '<pre class="message-code-pre"><code class="hljs">const value = `&lt;tag&gt;`</code></pre></div>' +
      '<p class="message-text">after</p>',
    )
  })

  it('adds independent copy actions for YAML and shell fences without changing their source', () => {
    const source = [
      '```yaml',
      'services:',
      '  app:',
      '    image: example/app:latest',
      '```',
      '',
      '```bash',
      'docker compose up -d',
      '```',
    ].join('\n')

    expect(parseMessageBlocks(source)).toEqual([
      {
        kind: 'codeBlock',
        language: 'yaml',
        value: 'services:\n  app:\n    image: example/app:latest',
      },
      { kind: 'codeBlock', language: 'bash', value: 'docker compose up -d' },
    ])

    const html = renderMarkdown(source)
    expect(html.match(/data-message-code-copy="true"/gu)).toHaveLength(2)
    expect(html).toContain('<code class="hljs">services:\n  app:\n    image: example/app:latest</code>')
    expect(html).toContain('<code class="hljs">docker compose up -d</code>')
  })

  it('calls inline and highlight renderers in source order', () => {
    const calls: string[] = []
    const context: MessageBlockHtmlContext = {
      renderInlineSegmentsAsHtml(value) {
        calls.push(`inline:${value}`)
        return value
      },
      renderHighlightedCodeAsHtml(language, value) {
        calls.push(`code:${language}:${value}`)
        return value
      },
    }
    const blocks = parseMessageBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```js\nx()\n```')

    blocks.map((block) => renderMessageBlockToHtml(block, context)).join('')

    expect(calls).toEqual(['inline:A', 'inline:B', 'inline:1', 'inline:2', 'code:js:x()'])
  })
})
