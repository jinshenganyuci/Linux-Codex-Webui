import type { ListItem, MessageBlock, TableAlignment, TaskListItem } from './markdownTypes'

function normalizeMarkdownText(text: string): string {
  return text.replace(/\r\n/gu, '\n')
}

function leadingIndentWidth(line: string): number {
  const leadingWhitespace = line.match(/^\s*/u)?.[0] ?? ''
  return leadingWhitespace.replace(/\t/gu, '    ').length
}

function stripIndentedContent(line: string, baseIndent: number): string {
  if (baseIndent <= 0) return line.trimStart()

  let index = 0
  let width = 0
  while (index < line.length && width < baseIndent) {
    const character = line[index]
    width += character === '\t' ? 4 : 1
    index += 1
  }

  return line.slice(index)
}

function isBlankMarkdownLine(line: string): boolean {
  return line.trim().length === 0
}

function readHeading(line: string): { level: number; value: string } | null {
  const match = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/u)
  if (!match) return null
  return {
    level: match[1].length,
    value: match[2].trim(),
  }
}

function readBlockquoteLine(line: string): string | null {
  const match = line.match(/^\s{0,3}>\s?(.*)$/u)
  if (!match) return null
  return match[1] ?? ''
}

function readUnorderedListItem(line: string): string | null {
  const match = line.match(/^\s*[-*+]\s+(.+)$/u)
  return match?.[1]?.trim() ?? null
}

function readUnorderedListItemMatch(line: string): { indent: number; text: string } | null {
  const match = line.match(/^(\s*)[-*+]\s+(.+)$/u)
  if (!match) return null
  return {
    indent: leadingIndentWidth(match[1] ?? ''),
    text: match[2]?.trim() ?? '',
  }
}

function readTaskListItem(line: string): TaskListItem | null {
  const match = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/u)
  if (!match) return null
  return {
    checked: (match[1] ?? ' ').toLowerCase() === 'x',
    text: match[2]?.trim() ?? '',
  }
}

function readTaskListItemMatch(line: string): { indent: number; item: TaskListItem } | null {
  const match = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/u)
  if (!match) return null
  return {
    indent: leadingIndentWidth(match[1] ?? ''),
    item: {
      checked: (match[2] ?? ' ').toLowerCase() === 'x',
      text: match[3]?.trim() ?? '',
    },
  }
}

function readOrderedListItemData(line: string): { indent: number; text: string; start: number } | null {
  const match = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/u)
  if (!match) return null
  return {
    indent: leadingIndentWidth(match[1] ?? ''),
    start: Number.parseInt(match[2] ?? '1', 10) || 1,
    text: match[3]?.trim() ?? '',
  }
}

function readOrderedListItem(line: string): string | null {
  return readOrderedListItemData(line)?.text ?? null
}

function readOrderedListItemMatch(line: string): { indent: number; text: string; start: number } | null {
  return readOrderedListItemData(line)
}

function splitMarkdownTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null

  let content = trimmed
  if (content.startsWith('|')) content = content.slice(1)
  if (content.endsWith('|')) content = content.slice(0, -1)

  const cells: string[] = []
  let current = ''
  let codeFenceLength = 0

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]

    if (character === '\\' && content[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }

    if (character === '`') {
      let runLength = 1
      while (content[index + runLength] === '`') runLength += 1
      current += content.slice(index, index + runLength)
      if (codeFenceLength === 0) codeFenceLength = runLength
      else if (codeFenceLength === runLength) codeFenceLength = 0
      index += runLength - 1
      continue
    }

    if (character === '|' && codeFenceLength === 0) {
      cells.push(current.trim())
      current = ''
      continue
    }

    current += character
  }

  cells.push(current.trim())
  return cells.some((cell) => cell.length > 0) ? cells : null
}

function readTableAlignmentRow(line: string): TableAlignment[] | null {
  const cells = splitMarkdownTableRow(line)
  if (!cells || cells.length === 0) return null

  const alignments = cells.map((cell) => {
    const trimmed = cell.replace(/\s+/gu, '')
    if (!/^:?-{3,}:?$/u.test(trimmed)) return null
    const startsWithColon = trimmed.startsWith(':')
    const endsWithColon = trimmed.endsWith(':')
    if (startsWithColon && endsWithColon) return 'center'
    if (endsWithColon) return 'right'
    if (startsWithColon) return 'left'
    return null
  })

  return alignments.every((alignment, index) => alignment !== null || /^-+$/u.test(cells[index].replace(/\s+/gu, '')))
    ? alignments
    : null
}

function normalizeTableCells(cells: string[], width: number): string[] {
  if (cells.length === width) return cells
  if (cells.length > width) return cells.slice(0, width)
  return [...cells, ...Array.from({ length: width - cells.length }, () => '')]
}

function readTableBlock(lines: string[], startIndex: number): Extract<MessageBlock, { kind: 'table' }> | null {
  if (startIndex + 1 >= lines.length) return null

  const headerLine = lines[startIndex]
  const separatorLine = lines[startIndex + 1]
  const headers = splitMarkdownTableRow(headerLine)
  const alignments = readTableAlignmentRow(separatorLine)
  if (!headers || !alignments) return null
  if (headers.length !== alignments.length) return null

  const trimmedHeader = headerLine.trim()
  if (!trimmedHeader.startsWith('|') && (trimmedHeader.match(/\|/gu)?.length ?? 0) < 2) return null

  const width = headers.length
  const rows: string[][] = []
  let index = startIndex + 2
  while (index < lines.length) {
    if (isBlankMarkdownLine(lines[index])) break
    const row = splitMarkdownTableRow(lines[index])
    if (!row) break
    rows.push(normalizeTableCells(row, width))
    index += 1
  }

  return {
    kind: 'table',
    headers: normalizeTableCells(headers, width),
    rows,
    alignments,
  }
}

function isParagraphBreakingLine(line: string): boolean {
  return (
    isBlankMarkdownLine(line) ||
    readFenceStart(line) !== null ||
    isThematicBreakLine(line) ||
    readHeading(line) !== null ||
    readBlockquoteLine(line) !== null ||
    readTaskListItem(line) !== null ||
    readUnorderedListItem(line) !== null ||
    readOrderedListItem(line) !== null
  )
}

function readListParagraph(
  lines: string[],
  startIndex: number,
  baseIndent = -1,
): { value: string; nextIndex: number } | null {
  const paragraphLines: string[] = []
  let index = startIndex

  while (index < lines.length) {
    if (isParagraphBreakingLine(lines[index])) break
    if (baseIndent >= 0 && leadingIndentWidth(lines[index]) <= baseIndent) break

    paragraphLines.push(baseIndent >= 0 ? stripIndentedContent(lines[index], baseIndent + 1) : lines[index])
    index += 1
  }

  const value = paragraphLines.join('\n').trim()
  return value ? { value, nextIndex: index } : null
}

function findNextNonBlankLineIndex(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!isBlankMarkdownLine(lines[index])) return index
  }
  return -1
}

function readNestedListBlocks(
  lines: string[],
  startIndex: number,
  parentIndent: number,
  stopAtItem: ((line: string) => { indent: number; text: string } | null) | null = null,
  allowLooseChildLists = false,
): { blocks: MessageBlock[]; nextIndex: number } | null {
  const nestedLines: string[] = []
  let index = startIndex

  while (index < lines.length) {
    const line = lines[index]
    if (isBlankMarkdownLine(line)) {
      const nextNonBlankIndex = findNextNonBlankLineIndex(lines, index + 1)
      if (nextNonBlankIndex === -1) {
        nestedLines.push('')
        index = lines.length
        break
      }
      const nextStopItem = stopAtItem?.(lines[nextNonBlankIndex])
      if (nextStopItem && nextStopItem.indent === parentIndent) break
      if (leadingIndentWidth(lines[nextNonBlankIndex]) <= parentIndent) break
      nestedLines.push('')
      index += 1
      continue
    }

    const stopItem = stopAtItem?.(line)
    if (stopItem && stopItem.indent === parentIndent) break

    const lineIndent = leadingIndentWidth(line)
    const isLooseChildList = allowLooseChildLists && (
      readTaskListItem(line) !== null ||
      readUnorderedListItem(line) !== null
    )
    if (lineIndent <= parentIndent && !isLooseChildList) break

    nestedLines.push(
      lineIndent > parentIndent
        ? stripIndentedContent(line, parentIndent + 1)
        : line.trimStart(),
    )
    index += 1
  }

  while (nestedLines.length > 0 && isBlankMarkdownLine(nestedLines[0])) nestedLines.shift()
  while (nestedLines.length > 0 && isBlankMarkdownLine(nestedLines[nestedLines.length - 1])) nestedLines.pop()

  if (nestedLines.length === 0) return null

  return {
    blocks: parseTextBlocks(nestedLines.join('\n')),
    nextIndex: index,
  }
}

function readListItems(
  lines: string[],
  startIndex: number,
  readItem: (line: string) => { indent: number; text: string } | null,
  allowLooseChildLists = false,
): { items: ListItem[]; nextIndex: number } | null {
  const items: ListItem[] = []
  let index = startIndex
  const firstItem = readItem(lines[startIndex])
  if (!firstItem) return null
  const baseIndent = firstItem.indent

  while (index < lines.length) {
    const itemValue = readItem(lines[index])
    if (itemValue === null || itemValue.indent !== baseIndent) break

    const paragraphs = [itemValue.text]
    const children: MessageBlock[] = []
    index += 1

    while (index < lines.length) {
      if (isBlankMarkdownLine(lines[index])) {
        const nextNonBlankIndex = findNextNonBlankLineIndex(lines, index + 1)
        if (nextNonBlankIndex === -1) {
          index = lines.length
          break
        }
        const nextSameLevelItem = readItem(lines[nextNonBlankIndex])
        if (nextSameLevelItem && nextSameLevelItem.indent === baseIndent) {
          index = nextNonBlankIndex
          break
        }
        if (leadingIndentWidth(lines[nextNonBlankIndex]) <= baseIndent) {
          index = nextNonBlankIndex
          break
        }
        index += 1
        continue
      }

      const nextSameLevelItem = readItem(lines[index])
      if (nextSameLevelItem && nextSameLevelItem.indent === baseIndent) break

      const hasIndentedChildren = leadingIndentWidth(lines[index]) > baseIndent
      const hasLooseChildList = allowLooseChildLists && (
        readTaskListItem(lines[index]) !== null ||
        readUnorderedListItem(lines[index]) !== null
      )
      if (hasIndentedChildren || hasLooseChildList) {
        const nestedBlocks = readNestedListBlocks(lines, index, baseIndent, readItem, allowLooseChildLists)
        if (nestedBlocks) {
          children.push(...nestedBlocks.blocks)
          index = nestedBlocks.nextIndex
          continue
        }
      }

      if (leadingIndentWidth(lines[index]) <= baseIndent) break

      const continuation = readListParagraph(lines, index, baseIndent)
      if (!continuation) break
      paragraphs.push(continuation.value)
      index = continuation.nextIndex
    }

    items.push(children.length > 0 ? { paragraphs, children } : { paragraphs })
  }

  return items.length > 0 ? { items, nextIndex: index } : null
}

function isThematicBreakLine(line: string): boolean {
  return /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line.trim())
}

function readFenceStart(line: string): { marker: string; language: string } | null {
  const match = line.match(/^\s{0,3}(```+|~~~+)\s*([^\s`~][^`]*)?\s*$/u)
  if (!match) return null
  return {
    marker: match[1],
    language: (match[2] ?? '').trim(),
  }
}

function parseTextBlocks(text: string): MessageBlock[] {
  const normalizedText = normalizeMarkdownText(text)
  const lines = normalizedText.split('\n')
  const blocks: MessageBlock[] = []
  let index = 0

  while (index < lines.length) {
    if (isBlankMarkdownLine(lines[index])) {
      index += 1
      continue
    }

    const fence = readFenceStart(lines[index])
    if (fence) {
      index += 1
      const codeLines: string[] = []
      while (index < lines.length) {
        if (lines[index].trim() === fence.marker) {
          index += 1
          break
        }
        codeLines.push(lines[index])
        index += 1
      }
      blocks.push({
        kind: 'codeBlock',
        language: fence.language,
        value: codeLines.join('\n'),
      })
      continue
    }

    if (isThematicBreakLine(lines[index])) {
      blocks.push({ kind: 'thematicBreak' })
      index += 1
      continue
    }

    const heading = readHeading(lines[index])
    if (heading) {
      blocks.push({ kind: 'heading', level: heading.level, value: heading.value })
      index += 1
      continue
    }

    const quoteLine = readBlockquoteLine(lines[index])
    if (quoteLine !== null) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const nextQuoteLine = readBlockquoteLine(lines[index])
        if (nextQuoteLine === null) break
        quoteLines.push(nextQuoteLine)
        index += 1
      }
      blocks.push({ kind: 'blockquote', value: quoteLines.join('\n').trim() })
      continue
    }

    const table = readTableBlock(lines, index)
    if (table) {
      blocks.push(table)
      index += 2 + table.rows.length
      continue
    }

    const taskItem = readTaskListItem(lines[index])
    if (taskItem !== null) {
      const items: TaskListItem[] = []
      const baseIndent = readTaskListItemMatch(lines[index])?.indent ?? 0
      while (index < lines.length) {
        const nextItem = readTaskListItemMatch(lines[index])
        if (nextItem === null || nextItem.indent !== baseIndent) break
        items.push(nextItem.item)
        index += 1
      }
      if (items.length > 0) {
        blocks.push({ kind: 'taskList', items })
        continue
      }
    }

    const unorderedItem = readUnorderedListItem(lines[index])
    if (unorderedItem !== null) {
      const parsedList = readListItems(lines, index, readUnorderedListItemMatch)
      if (parsedList) {
        blocks.push({ kind: 'unorderedList', items: parsedList.items })
        index = parsedList.nextIndex
        continue
      }
      if (unorderedItem.length > 0) {
        blocks.push({ kind: 'unorderedList', items: [{ paragraphs: [unorderedItem] }] })
        index += 1
        continue
      }
    }

    const orderedItem = readOrderedListItem(lines[index])
    if (orderedItem !== null) {
      const orderedItemMatch = readOrderedListItemMatch(lines[index])
      const parsedList = readListItems(lines, index, readOrderedListItemMatch, true)
      if (parsedList) {
        blocks.push({
          kind: 'orderedList',
          items: parsedList.items,
          start: orderedItemMatch?.start ?? 1,
        })
        index = parsedList.nextIndex
        continue
      }
      if (orderedItem.length > 0) {
        blocks.push({
          kind: 'orderedList',
          items: [{ paragraphs: [orderedItem] }],
          start: orderedItemMatch?.start ?? 1,
        })
        index += 1
        continue
      }
    }

    const paragraphLines: string[] = []
    while (index < lines.length) {
      if (isBlankMarkdownLine(lines[index])) break
      if (
        readFenceStart(lines[index]) ||
        isThematicBreakLine(lines[index]) ||
        readHeading(lines[index]) ||
        readTableBlock(lines, index) ||
        readBlockquoteLine(lines[index]) !== null ||
        readTaskListItem(lines[index]) !== null ||
        readUnorderedListItem(lines[index]) !== null ||
        readOrderedListItem(lines[index]) !== null
      ) break
      paragraphLines.push(lines[index])
      index += 1
    }

    const value = paragraphLines.join('\n').trim()
    if (value) {
      blocks.push({ kind: 'paragraph', value })
    }
  }

  return blocks
}

function toRenderableImageUrl(value: string): string {
  const normalized = value.trim()
  if (!normalized) return ''
  if (
    normalized.startsWith('data:') ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('/codex-local-image?')
  ) {
    return normalized
  }

  if (normalized.startsWith('file://')) {
    return `/codex-local-image?path=${encodeURIComponent(normalized)}`
  }

  const looksLikeUnixAbsolute = normalized.startsWith('/')
  const looksLikeWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(normalized)
  if (looksLikeUnixAbsolute || looksLikeWindowsAbsolute) {
    return `/codex-local-image?path=${encodeURIComponent(normalized)}`
  }

  return normalized
}

function parseNonCodeMessageBlocks(text: string): MessageBlock[] {
  if (!text.includes('![') || !text.includes('](')) {
    return parseTextBlocks(text)
  }

  const blocks: MessageBlock[] = []
  const imagePattern = /!\[([^\]]*)\]\(([^)\n]+)\)/gu
  let cursor = 0

  for (const match of text.matchAll(imagePattern)) {
    const [fullMatch, altRaw, urlRaw] = match
    if (typeof match.index !== 'number') continue

    const start = match.index
    const end = start + fullMatch.length
    const imageUrl = toRenderableImageUrl(urlRaw.trim())
    if (!imageUrl) continue

    if (start > cursor) {
      blocks.push(...parseTextBlocks(text.slice(cursor, start)))
    }

    blocks.push({ kind: 'image', url: imageUrl, alt: altRaw.trim(), markdown: fullMatch })
    cursor = end
  }

  if (cursor < text.length) {
    blocks.push(...parseTextBlocks(text.slice(cursor)))
  }

  return blocks
}

export function parseMessageBlocks(text: string): MessageBlock[] {
  const normalizedText = normalizeMarkdownText(text)
  const lines = normalizedText.split('\n')
  const blocks: MessageBlock[] = []
  let index = 0
  let chunkStart = 0

  const flushChunk = (endExclusive: number): void => {
    if (endExclusive <= chunkStart) return
    const chunk = lines.slice(chunkStart, endExclusive).join('\n')
    blocks.push(...parseNonCodeMessageBlocks(chunk))
  }

  while (index < lines.length) {
    const fence = readFenceStart(lines[index])
    if (!fence) {
      index += 1
      continue
    }

    flushChunk(index)

    index += 1
    const codeLines: string[] = []
    while (index < lines.length) {
      if (lines[index].trim() === fence.marker) {
        index += 1
        break
      }
      codeLines.push(lines[index])
      index += 1
    }

    blocks.push({
      kind: 'codeBlock',
      language: fence.language,
      value: codeLines.join('\n'),
    })
    chunkStart = index
  }

  flushChunk(lines.length)
  return blocks.length > 0 ? blocks : [{ kind: 'paragraph', value: text }]
}
