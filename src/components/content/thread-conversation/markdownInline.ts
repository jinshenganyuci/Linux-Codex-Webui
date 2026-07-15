import type { InlineSegment } from './markdownTypes'

export interface MarkdownInlineContext {
  toLocalThreadUrl: (value: string) => string | null
}

function isFilePath(value: string): boolean {
  if (!value || /[\r\n]/u.test(value)) return false
  if (value.endsWith('/') || value.endsWith('\\')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return false

  const looksLikeUnixAbsolute = value.startsWith('/')
  const looksLikeWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(value)
  const looksLikeRelative = value.startsWith('./') || value.startsWith('../') || value.startsWith('~/')
  if (looksLikeUnixAbsolute || looksLikeWindowsAbsolute || looksLikeRelative) return true

  const looksLikeBareFilename = /^[A-Za-z0-9._@() -]+\.[A-Za-z0-9]{1,12}$/u.test(value)
  if (looksLikeBareFilename) return true

  // Bare relative paths should look like actual path segments, not arbitrary prose containing "/".
  return /^[A-Za-z0-9._@() -]+(?:[\\/][A-Za-z0-9._@() -]+)+$/u.test(value)
}

function getBasename(pathValue: string): string {
  const normalized = pathValue.replace(/\\/gu, '/')
  const name = normalized.split('/').filter(Boolean).pop()
  return name || pathValue
}

export function normalizePathSeparators(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/')
}

function normalizeFileUrlToPath(pathValue: string): string {
  if (!pathValue.startsWith('file://')) return pathValue
  let stripped = pathValue.replace(/^file:\/\//u, '')
  try {
    stripped = decodeURIComponent(stripped)
  } catch {
    // Keep best-effort path if decoding fails.
  }
  if (/^\/[A-Za-z]:\//u.test(stripped)) {
    stripped = stripped.slice(1)
  }
  return stripped
}

function inferHomeFromCwd(cwd: string): string {
  const normalized = normalizePathSeparators(cwd)
  const userMatch = normalized.match(/^\/Users\/([^/]+)/u)
  if (userMatch) return `/Users/${userMatch[1]}`
  const homeMatch = normalized.match(/^\/home\/([^/]+)/u)
  if (homeMatch) return `/home/${homeMatch[1]}`
  return ''
}

export function normalizePathDots(pathValue: string): string {
  const normalized = normalizePathSeparators(pathValue)
  if (!normalized) return normalized

  let root = ''
  let rest = normalized
  const driveMatch = rest.match(/^([A-Za-z]:)(\/.*)?$/u)
  if (driveMatch) {
    root = `${driveMatch[1]}/`
    rest = (driveMatch[2] ?? '').replace(/^\/+/u, '')
  } else if (rest.startsWith('/')) {
    root = '/'
    rest = rest.slice(1)
  }

  const parts = rest.split('/').filter(Boolean)
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(part)
  }

  const joined = stack.join('/')
  if (root) return `${root}${joined}`.replace(/\/+$/u, '') || root
  return joined || normalized
}

export function resolveRelativePath(pathValue: string, cwd: string): string {
  const normalizedPath = normalizePathSeparators(normalizeFileUrlToPath(pathValue.trim()))
  if (!normalizedPath) return ''

  const looksLikeAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//u.test(normalizedPath)
  if (looksLikeAbsolute) return normalizePathDots(normalizedPath)

  if (normalizedPath.startsWith('~/')) {
    const homeBase = inferHomeFromCwd(cwd)
    if (homeBase) {
      return normalizePathDots(`${homeBase}/${normalizedPath.slice(2)}`)
    }
  }

  const base = normalizePathSeparators(cwd.trim())
  if (!base) return normalizePathDots(normalizedPath)
  return normalizePathDots(`${base.replace(/\/+$/u, '')}/${normalizedPath}`)
}

export function parseFileReference(value: string): { path: string; line: number | null } | null {
  if (!value) return null

  let pathValue = value.trim()
  const wrapped = trimLinkWrappers(pathValue)
  pathValue = wrapped.core.trim()
  let line: number | null = null

  const hashLineMatch = pathValue.match(/^(.*)#L(\d+)(?:C\d+)?$/u)
  if (hashLineMatch) {
    pathValue = hashLineMatch[1]
    line = Number(hashLineMatch[2])
  } else {
    const colonLineMatch = pathValue.match(/^(.*):(\d+)(?::\d+)?$/u)
    if (colonLineMatch) {
      pathValue = colonLineMatch[1]
      line = Number(colonLineMatch[2])
    }
  }

  pathValue = normalizeFileUrlToPath(pathValue)
  if (!isFilePath(pathValue)) return null
  return { path: pathValue, line }
}

function trimLinkWrappers(value: string): { core: string; leading: string; trailing: string } {
  let core = value
  let leading = ''
  let trailing = ''

  const wrapperPairs: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>',
    '"': '"',
    '\'': '\'',
    '`': '`',
    '“': '”',
    '‘': '’',
  }

  while (core.length > 0) {
    const opening = core[0]
    const closing = Object.prototype.hasOwnProperty.call(wrapperPairs, opening) ? wrapperPairs[opening] : ''
    if (!closing || !core.endsWith(closing)) break
    leading += opening
    trailing += closing
    core = core.slice(1, -1)
  }

  return { core, leading, trailing }
}

function countAsterisksBefore(value: string, endIndex: number, minIndex: number): number {
  let count = 0
  let index = endIndex - 1
  while (index >= minIndex && value[index] === '*') {
    count += 1
    index -= 1
  }
  return count
}

function countAsterisksAfter(value: string, startIndex: number): number {
  let count = 0
  let index = startIndex
  while (index < value.length && value[index] === '*') {
    count += 1
    index += 1
  }
  return count
}

function readAsteriskLinkWrapper(
  source: string,
  matchStart: number,
  matchEnd: number,
  cursor: number,
  matchedToken: string,
): { segmentStart: number; segmentEnd: number; tokenEndTrim: number } | null {
  const leadingCount = countAsterisksBefore(source, matchStart, cursor)
  if (leadingCount < 2) return null

  const trailingOutsideCount = countAsterisksAfter(source, matchEnd)
  if (trailingOutsideCount >= leadingCount) {
    return {
      segmentStart: matchStart - leadingCount,
      segmentEnd: matchEnd + leadingCount,
      tokenEndTrim: 0,
    }
  }

  const trailingInsideCount = countAsterisksBefore(matchedToken, matchedToken.length, 0)
  if (trailingInsideCount >= leadingCount) {
    return {
      segmentStart: matchStart - leadingCount,
      segmentEnd: matchEnd,
      tokenEndTrim: leadingCount,
    }
  }

  return null
}

function parseMarkdownLinkToken(value: string): { label: string; target: string } | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(')')) return null
  const labelCloseIndex = trimmed.indexOf(']')
  if (labelCloseIndex <= 1) return null
  if (trimmed[labelCloseIndex + 1] !== '(') return null
  const labelRaw = trimmed.slice(1, labelCloseIndex).trim()
  const targetRaw = trimmed.slice(labelCloseIndex + 2, -1).trim()
  if (labelRaw.includes('\n') || targetRaw.includes('\n')) return null
  const label = trimLinkWrappers(labelRaw).core.trim() || labelRaw
  const target = trimLinkWrappers(targetRaw).core.trim()
  if (!target) return null
  return { label, target }
}

function applyDelimitedMarkersAcrossTextSegments(
  segments: InlineSegment[],
  options: {
    marker: string
    kind: Extract<InlineSegment['kind'], 'bold' | 'italic' | 'strikethrough'>
    isValidContent?: (value: string) => boolean
  },
): InlineSegment[] {
  const output: InlineSegment[] = []
  let isOpen = false
  let buffer = ''

  const pushText = (value: string): void => {
    if (!value) return
    output.push({ kind: 'text', value })
  }

  for (const segment of segments) {
    if (segment.kind !== 'text') {
      if (isOpen) {
        pushText(`${options.marker}${buffer}`)
        isOpen = false
        buffer = ''
      }
      output.push(segment)
      continue
    }

    let remaining = segment.value
    while (remaining.length > 0) {
      const markerIndex = remaining.indexOf(options.marker)
      if (markerIndex < 0) {
        if (isOpen) buffer += remaining
        else pushText(remaining)
        break
      }

      const before = remaining.slice(0, markerIndex)
      if (isOpen) buffer += before
      else pushText(before)

      remaining = remaining.slice(markerIndex + options.marker.length)
      if (isOpen) {
        const content = buffer
        if (
          content.length > 0 &&
          (options.isValidContent ? options.isValidContent(content) : true)
        ) {
          output.push({ kind: options.kind, value: content })
        } else {
          pushText(`${options.marker}${content}${options.marker}`)
        }
        buffer = ''
        isOpen = false
      } else {
        isOpen = true
      }
    }
  }

  if (isOpen) {
    pushText(`${options.marker}${buffer}`)
  }

  return output
}

function applyInlineMarkdownMarkers(segments: InlineSegment[]): InlineSegment[] {
  const nonWhitespaceWrapped = (value: string): boolean => (
    value.trim().length > 0 &&
    !/^\s/u.test(value) &&
    !/\s$/u.test(value)
  )

  let next = applyDelimitedMarkersAcrossTextSegments(segments, {
    marker: '**',
    kind: 'bold',
    isValidContent: nonWhitespaceWrapped,
  })

  next = applyDelimitedMarkersAcrossTextSegments(next, {
    marker: '~~',
    kind: 'strikethrough',
    isValidContent: nonWhitespaceWrapped,
  })

  next = applyDelimitedMarkersAcrossTextSegments(next, {
    marker: '*',
    kind: 'italic',
    isValidContent: nonWhitespaceWrapped,
  })

  return next
}

function splitPlainTextByLinks(
  text: string,
  context: MarkdownInlineContext,
  options: { applyMarkdownMarkers?: boolean } = {},
): InlineSegment[] {
  const segments: InlineSegment[] = []
  const pattern = /codex:\/\/threads\/[A-Za-z0-9-]+|https?:\/\/[^\s<>"'`，。；：！？、()[\]{}「」『』《》]+|file:\/\/[^\n<>"'`，。；：！？、[\]{}「」『』《》]+|["'](?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^\n"']+["']|`(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^`\n]+`/gu
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    if (typeof match.index !== 'number') continue
    const start = match.index
    const end = start + match[0].length
    let token = match[0]
    let trailingPunctuation = ''
    while (/[.,;:!?，。；：！？、]$/u.test(token)) {
      trailingPunctuation = token.slice(-1) + trailingPunctuation
      token = token.slice(0, -1)
    }

    const asteriskWrapper = readAsteriskLinkWrapper(text, start, end, cursor, token)
    const segmentStart = asteriskWrapper?.segmentStart ?? start
    const segmentEnd = asteriskWrapper?.segmentEnd ?? end

    if (segmentStart > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, segmentStart) })
    }

    if (asteriskWrapper?.tokenEndTrim) {
      token = token.slice(0, -asteriskWrapper.tokenEndTrim)
    }
    const wrapped = trimLinkWrappers(token)
    token = wrapped.core
    const leading = wrapped.leading
    const trailing = wrapped.trailing + trailingPunctuation

    if (leading) {
      segments.push({ kind: 'text', value: leading })
    }

    const localThreadUrl = context.toLocalThreadUrl(token)

    if (localThreadUrl) {
      segments.push({ kind: 'url', value: localThreadUrl, href: localThreadUrl })
      if (trailing) {
        segments.push({ kind: 'text', value: trailing })
      }
    } else if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      segments.push({ kind: 'bold', value: token.slice(2, -2) })
      if (trailing) {
        segments.push({ kind: 'text', value: trailing })
      }
    } else if (/^https?:\/\//u.test(token)) {
      segments.push({ kind: 'url', value: token, href: token })
      if (trailing) {
        segments.push({ kind: 'text', value: trailing })
      }
    } else {
      const ref = parseFileReference(token)
      if (ref) {
        segments.push({
          kind: 'file',
          value: token,
          path: ref.path,
          displayPath: token,
          downloadName: getBasename(ref.path),
        })
        if (trailing) {
          segments.push({ kind: 'text', value: trailing })
        }
      } else {
        segments.push({ kind: 'text', value: match[0] })
      }
    }

    cursor = segmentEnd
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', value: text.slice(cursor) })
  }

  return options.applyMarkdownMarkers === false ? segments : applyInlineMarkdownMarkers(segments)
}

function splitTextByFileUrls(
  text: string,
  context: MarkdownInlineContext,
  options: { applyMarkdownMarkers?: boolean } = {},
): InlineSegment[] {
  const segments: InlineSegment[] = []
  let cursor = 0
  let scanFrom = 0

  const findNextMarkdownLink = (
    source: string,
    fromIndex: number,
  ): { start: number; end: number; token: string } | null => {
    let linkStart = source.indexOf('[', fromIndex)
    while (linkStart >= 0) {
      const labelEnd = source.indexOf(']', linkStart + 1)
      if (labelEnd < 0) return null
      if (source[labelEnd + 1] !== '(') {
        linkStart = source.indexOf('[', linkStart + 1)
        continue
      }

      let depth = 1
      let index = labelEnd + 2
      let hasNewLine = false
      while (index < source.length) {
        const char = source[index]
        if (char === '\n') {
          hasNewLine = true
          break
        }
        if (char === '(') depth += 1
        if (char === ')') {
          depth -= 1
          if (depth === 0) {
            const token = source.slice(linkStart, index + 1)
            if (parseMarkdownLinkToken(token)) {
              return { start: linkStart, end: index + 1, token }
            }
            break
          }
        }
        index += 1
      }

      if (hasNewLine) {
        linkStart = source.indexOf('[', linkStart + 1)
        continue
      }
      linkStart = source.indexOf('[', linkStart + 1)
    }
    return null
  }

  while (scanFrom < text.length) {
    const match = findNextMarkdownLink(text, scanFrom)
    if (!match) break
    const { start, end, token } = match
    const asteriskWrapper = readAsteriskLinkWrapper(text, start, end, cursor, token)
    const segmentStart = asteriskWrapper?.segmentStart ?? start
    const segmentEnd = asteriskWrapper?.segmentEnd ?? end

    if (segmentStart > cursor) {
      segments.push(...splitPlainTextByLinks(text.slice(cursor, segmentStart), context, options))
    }

    const markdownToken = parseMarkdownLinkToken(token)
    if (!markdownToken) {
      segments.push(...splitPlainTextByLinks(text.slice(segmentStart, segmentEnd), context, options))
      cursor = segmentEnd
      scanFrom = segmentEnd
      continue
    }
    const label = markdownToken.label
    const target = markdownToken.target
    const localThreadUrl = context.toLocalThreadUrl(target)

    if (localThreadUrl) {
      segments.push({ kind: 'url', value: label || localThreadUrl, href: localThreadUrl })
    } else if (/^https?:\/\//u.test(target)) {
      segments.push({ kind: 'url', value: label || target, href: target })
    } else {
      const ref = parseFileReference(target)
      if (ref) {
        segments.push({
          kind: 'file',
          value: target,
          path: ref.path,
          displayPath: label || target,
          downloadName: getBasename(ref.path),
        })
      } else {
        segments.push({ kind: 'text', value: token })
      }
    }

    cursor = segmentEnd
    scanFrom = segmentEnd
  }

  if (cursor < text.length) {
    segments.push(...splitPlainTextByLinks(text.slice(cursor), context, options))
  }

  return segments
}

export function parseInlineSegments(text: string, context: MarkdownInlineContext): InlineSegment[] {
  const hasInlineCodeMarker = text.includes('`')
  const linkFirstSegments = splitTextByFileUrls(text, context, {
    applyMarkdownMarkers: !hasInlineCodeMarker,
  })
  if (!hasInlineCodeMarker) return linkFirstSegments
  if (!linkFirstSegments.some((segment) => segment.kind === 'text' && segment.value.includes('`'))) {
    return applyInlineMarkdownMarkers(linkFirstSegments)
  }

  const parseCodeAwareTextSegments = (value: string): InlineSegment[] => {
    if (!value.includes('`')) return splitPlainTextByLinks(value, context)

    const segments: InlineSegment[] = []
    let cursor = 0
    let textStart = 0

    while (cursor < value.length) {
      if (value[cursor] !== '`') {
        cursor += 1
        continue
      }

      let openLength = 1
      while (cursor + openLength < value.length && value[cursor + openLength] === '`') {
        openLength += 1
      }
      const delimiter = '`'.repeat(openLength)

      let searchFrom = cursor + openLength
      let closingStart = -1
      while (searchFrom < value.length) {
        const candidate = value.indexOf(delimiter, searchFrom)
        if (candidate < 0) break

        const hasBacktickBefore = candidate > 0 && value[candidate - 1] === '`'
        const hasBacktickAfter =
          candidate + openLength < value.length && value[candidate + openLength] === '`'
        const hasNewLineInside = value.slice(cursor + openLength, candidate).includes('\n')

        if (!hasBacktickBefore && !hasBacktickAfter && !hasNewLineInside) {
          closingStart = candidate
          break
        }
        searchFrom = candidate + 1
      }

      if (closingStart < 0) {
        cursor += openLength
        continue
      }

      if (cursor > textStart) {
        segments.push(...splitPlainTextByLinks(value.slice(textStart, cursor), context))
      }

      const token = value.slice(cursor + openLength, closingStart)
      if (token.length > 0) {
        const markdownLink = parseMarkdownLinkToken(token)
        if (markdownLink) {
          const localThreadUrl = context.toLocalThreadUrl(markdownLink.target)
          if (localThreadUrl) {
            segments.push({
              kind: 'url',
              value: markdownLink.label || localThreadUrl,
              href: localThreadUrl,
            })
          } else if (/^https?:\/\//u.test(markdownLink.target)) {
            segments.push({
              kind: 'url',
              value: markdownLink.label || markdownLink.target,
              href: markdownLink.target,
            })
          } else {
            const markdownFileReference = parseFileReference(markdownLink.target)
            if (markdownFileReference) {
              segments.push({
                kind: 'file',
                value: markdownLink.target,
                path: markdownFileReference.path,
                displayPath: markdownLink.label || markdownLink.target,
                downloadName: getBasename(markdownFileReference.path),
              })
            } else {
              segments.push({ kind: 'code', value: token })
            }
          }
        } else {
          const localThreadUrl = context.toLocalThreadUrl(token)
          if (localThreadUrl) {
            segments.push({
              kind: 'url',
              value: localThreadUrl,
              href: localThreadUrl,
            })
          } else if (/^https?:\/\/[^\s]+$/u.test(token)) {
            segments.push({
              kind: 'url',
              value: token,
              href: token,
            })
          } else {
            const fileReference = parseFileReference(token)
            if (fileReference) {
              const displayPath = fileReference.line
                ? `${fileReference.path}:${String(fileReference.line)}`
                : fileReference.path
              segments.push({
                kind: 'file',
                value: token,
                path: fileReference.path,
                displayPath,
                downloadName: getBasename(fileReference.path),
              })
            } else {
              segments.push({ kind: 'code', value: token })
            }
          }
        }
      } else {
        segments.push({ kind: 'text', value: `${delimiter}${delimiter}` })
      }

      cursor = closingStart + openLength
      textStart = cursor
    }

    if (textStart < value.length) {
      segments.push(...splitPlainTextByLinks(value.slice(textStart), context))
    }

    return segments
  }

  return linkFirstSegments.flatMap((segment) => (
    segment.kind === 'text'
      ? parseCodeAwareTextSegments(segment.value)
      : [segment]
  ))
}
