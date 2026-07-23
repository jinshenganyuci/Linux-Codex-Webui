const { chromium } = require('playwright')
const { mkdirSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')

const baseUrl = process.env.PROFILE_BASE_URL || 'http://localhost:5173'
const route = process.env.PROFILE_ROUTE || '/'
const waitMs = Number.parseInt(process.env.PROFILE_WAIT_MS || '7000', 10)
const threadLoadTimeoutMs = Number.parseInt(process.env.PROFILE_THREAD_LOAD_TIMEOUT_MS || '15000', 10)
const headless = process.env.PROFILE_HEADLESS !== 'false'
const cacheRevisitEnabled = process.env.PROFILE_CACHE_REVISIT === 'true'
const cacheRevisitWaitMs = Number.parseInt(process.env.PROFILE_CACHE_REVISIT_WAIT_MS || '1500', 10)
const outputDir = resolve(process.cwd(), 'output/playwright')
const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
const THREAD_LOADING_TEXT = 'Loading threads...'
const REAL_CHAT_MESSAGE_SELECTOR = [
  '.conversation-list > .conversation-item[data-role="user"]',
  '.conversation-list > .conversation-item[data-role="assistant"]',
].join(', ')
const HISTORY_PAGE_METHODS = new Set(['thread/turns/list', 'thread/items/list'])

function routeSlug() {
  const raw = route.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')
  return raw || 'home'
}

const artifactPrefix = `browser-runtime-profile-${routeSlug()}-${runStamp}`

function round(value) {
  return Math.round(value * 10) / 10
}

function resolvedPositiveNumber(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

function summarize(rows) {
  const durations = rows.map((row) => row.ms).filter((value) => Number.isFinite(value))
  const totalBytes = rows.reduce((sum, row) => sum + row.responseBytes, 0)
  return {
    count: rows.length,
    minMs: round(durations.length ? Math.min(...durations) : 0),
    avgMs: round(durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0),
    p95Ms: round(percentile(durations, 95)),
    maxMs: round(durations.length ? Math.max(...durations) : 0),
    totalKB: round(totalBytes / 1024),
  }
}

function buildWarnings(duplicateCounts, apiSummary, apiRows) {
  const warnings = []
  const providerModels = apiSummary.find((row) => row.key === '/codex-api/provider-models')
  const totalApiKB = round(apiRows.reduce((sum, row) => sum + row.responseBytes, 0) / 1024)

  if (duplicateCounts.threadListFirstPage > 1) warnings.push(`threadListFirstPage=${duplicateCounts.threadListFirstPage}`)
  if (duplicateCounts.threadResume > 1) warnings.push(`threadResume=${duplicateCounts.threadResume}`)
  if (duplicateCounts.threadReadWithTurns > 1) warnings.push(`threadReadWithTurns=${duplicateCounts.threadReadWithTurns}`)
  if (duplicateCounts.threadReadDuplicateKeys > 0) warnings.push(`threadReadDuplicateKeys=${duplicateCounts.threadReadDuplicateKeys}`)
  if (duplicateCounts.historyPageDuplicateKeys > 0) warnings.push(`historyPageDuplicateKeys=${duplicateCounts.historyPageDuplicateKeys}`)
  if (duplicateCounts.skillsList > 1) warnings.push(`skillsList=${duplicateCounts.skillsList}`)
  if (duplicateCounts.rateLimitsRead > 1) warnings.push(`rateLimitsRead=${duplicateCounts.rateLimitsRead}`)
  if (providerModels && providerModels.maxMs > 1000) warnings.push(`providerModels=${providerModels.maxMs}ms`)
  if (totalApiKB > 750) warnings.push(`totalApiKB=${totalApiKB}`)

  return { warnings, totalApiKB }
}

function requestKey(row) {
  if (row.rpc === 'thread/list') {
    return row.cursor ? 'thread/list:cursor' : 'thread/list:first-page'
  }
  if (row.rpc === 'thread/read') {
    return `thread/read:${row.threadId || 'unknown'}:${row.includeTurns === true ? 'turns' : 'summary'}`
  }
  if (HISTORY_PAGE_METHODS.has(row.rpc)) {
    return `${row.rpc}:${row.threadId || 'unknown'}:${row.turnId || 'all-turns'}:${row.cursor || 'first-page'}`
  }
  return row.rpc || row.path
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function readResumeRequest(params) {
  const record = asRecord(params)
  const initialTurnsPage = asRecord(record?.initialTurnsPage)
  return {
    excludeTurns: typeof record?.excludeTurns === 'boolean' ? record.excludeTurns : null,
    initialTurnsPage: {
      requested: initialTurnsPage !== null,
      limit: typeof initialTurnsPage?.limit === 'number' ? initialTurnsPage.limit : null,
      sortDirection: typeof initialTurnsPage?.sortDirection === 'string' ? initialTurnsPage.sortDirection : null,
      itemsView: typeof initialTurnsPage?.itemsView === 'string' ? initialTurnsPage.itemsView : null,
    },
  }
}

function readRpcResponseMetadata(rpc, payload) {
  const envelope = asRecord(payload)
  const result = asRecord(envelope?.result)
  const thread = asRecord(result?.thread)
  const initialTurnsPage = asRecord(result?.initialTurnsPage)
  const historyMode = thread?.historyMode === 'legacy' || thread?.historyMode === 'paginated'
    ? thread.historyMode
    : null
  const metadata = {
    responseHistoryMode: historyMode,
  }

  if (rpc === 'thread/resume') {
    const initialPageTurns = Array.isArray(initialTurnsPage?.data) ? initialTurnsPage.data : null
    const legacyTurns = Array.isArray(thread?.turns) ? thread.turns : null
    metadata.resumeResponse = {
      historyMode,
      firstPageTurnCount: initialPageTurns?.length ?? legacyTurns?.length ?? null,
      firstPageSource: initialPageTurns ? 'initialTurnsPage' : legacyTurns ? 'thread.turns' : null,
      turnsBackwardsCursor: typeof result?.turnsBackwardsCursor === 'string' ? result.turnsBackwardsCursor : null,
      itemsBackwardsCursor: typeof result?.itemsBackwardsCursor === 'string' ? result.itemsBackwardsCursor : null,
    }
  } else if (HISTORY_PAGE_METHODS.has(rpc)) {
    metadata.responsePageEntryCount = Array.isArray(result?.data) ? result.data.length : null
    metadata.responseNextCursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null
    metadata.responseBackwardsCursor = typeof result?.backwardsCursor === 'string' ? result.backwardsCursor : null
  }

  return metadata
}

function historyPageDuplicateDetails(apiRows) {
  const grouped = new Map()
  for (const row of apiRows.filter((candidate) => HISTORY_PAGE_METHODS.has(candidate.rpc))) {
    const key = `${row.rpc}|${row.threadId || ''}|${row.turnId || ''}|${row.cursor || ''}`
    const current = grouped.get(key) || {
      key,
      method: row.rpc,
      threadId: row.threadId || null,
      turnId: row.turnId || null,
      cursor: row.cursor || null,
      count: 0,
    }
    current.count += 1
    grouped.set(key, current)
  }
  return Array.from(grouped.values()).filter((entry) => entry.count > 1)
}

function inferModeFromRows(rows) {
  const explicitModes = new Set(
    rows
      .map((row) => row.responseHistoryMode)
      .filter((value) => value === 'legacy' || value === 'paginated'),
  )
  const hasNativePagination = rows.some((row) => HISTORY_PAGE_METHODS.has(row.rpc))
  const hasPaginatedBootstrap = rows.some((row) => row.resumeRequest?.initialTurnsPage?.requested === true)
  const hasLegacyHistoryRead = rows.some((row) => row.rpc === 'thread/read' && row.includeTurns === true)
  const evidence = []

  for (const mode of explicitModes) evidence.push(`response.thread.historyMode=${mode}`)
  if (hasNativePagination) evidence.push('native-history-page-request')
  if (hasPaginatedBootstrap) evidence.push('thread/resume initialTurnsPage requested')
  if (hasLegacyHistoryRead) evidence.push('thread/read includeTurns=true')

  const inferredModes = new Set(explicitModes)
  if (hasNativePagination || hasPaginatedBootstrap) inferredModes.add('paginated')
  if (hasLegacyHistoryRead) inferredModes.add('legacy')
  const inferred = inferredModes.size > 1
    ? 'mixed'
    : inferredModes.size === 1 ? Array.from(inferredModes)[0] : 'unknown'

  return { inferred, evidence }
}

function readTargetThreadId(targetUrl) {
  const parsed = new URL(targetUrl)
  const match = `${parsed.hash || parsed.pathname}`.match(/(?:#)?\/thread\/([^/?#]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function buildHistoryModeReport(apiRows, targetThreadId = null) {
  const relevantRows = apiRows.filter((row) => (
    row.rpc === 'thread/resume'
    || row.rpc === 'thread/read'
    || HISTORY_PAGE_METHODS.has(row.rpc)
  ))
  const byThreadRows = new Map()
  for (const row of relevantRows) {
    const threadId = row.threadId || 'unknown'
    const rows = byThreadRows.get(threadId) || []
    rows.push(row)
    byThreadRows.set(threadId, rows)
  }

  return {
    ...inferModeFromRows(relevantRows),
    targetThreadId,
    target: targetThreadId
      ? inferModeFromRows(relevantRows.filter((row) => row.threadId === targetThreadId))
      : null,
    byThread: Array.from(byThreadRows.entries()).map(([threadId, rows]) => ({
      threadId,
      ...inferModeFromRows(rows),
    })),
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function hasThreadLoadingText(value) {
  return typeof value === 'string' && value.includes(THREAD_LOADING_TEXT)
}

function toTargetUrl() {
  if (/^https?:\/\//.test(route)) return route
  if (route.startsWith('#')) return `${baseUrl}/${route}`
  if (route.startsWith('/')) return `${baseUrl}${route}`
  return `${baseUrl}/${route}`
}

async function collectPerformance(page) {
  return page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0]
    const paints = performance.getEntriesByType('paint').map((entry) => ({
      name: entry.name,
      startTime: entry.startTime,
    }))
    const resources = performance.getEntriesByType('resource')
      .filter((entry) => entry.name.includes('/codex-api') || entry.name.includes('/assets/'))
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        duration: entry.duration,
        transferSize: entry.transferSize,
        decodedBodySize: entry.decodedBodySize,
      }))
    const runtimeProfile = window.__browserRuntimeProfile
    const longTasksSupported = runtimeProfile?.longTasksSupported === true
    const longTaskDurations = longTasksSupported
      ? runtimeProfile.longTasks.map((entry) => entry.duration).filter((value) => Number.isFinite(value))
      : []

    return {
      navigation: navigation ? {
        responseEnd: navigation.responseEnd,
        domContentLoaded: navigation.domContentLoadedEventEnd,
        loadEventEnd: navigation.loadEventEnd,
      } : null,
      paints,
      resources,
      memory: performance.memory ? {
        usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize,
        jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
      } : null,
      firstRealMessageMs: Number.isFinite(runtimeProfile?.firstRealMessageMs)
        ? runtimeProfile.firstRealMessageMs
        : null,
      firstRealMessageSelector: runtimeProfile?.realChatMessageSelector || null,
      longTaskCount: longTasksSupported ? longTaskDurations.length : null,
      maxLongTaskMs: longTasksSupported && longTaskDurations.length > 0
        ? Math.max(...longTaskDurations)
        : longTasksSupported ? 0 : null,
      longTasksSupported,
    }
  })
}

async function runCacheRevisit(page, targetUrl, cacheRevisitApiRows, setProfilePhase) {
  if (!cacheRevisitEnabled) return { enabled: false }

  const parsedTarget = new URL(targetUrl)
  if (!parsedTarget.hash.startsWith('#/thread/')) {
    return {
      enabled: true,
      supported: false,
      reason: 'PROFILE_ROUTE is not a hash-based thread route',
    }
  }

  await page.evaluate(() => {
    window.location.hash = '#/'
  })
  await page.locator(REAL_CHAT_MESSAGE_SELECTOR).first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})

  setProfilePhase('cache-revisit')
  const startedAt = performance.now()
  await page.evaluate((targetHash) => {
    window.location.hash = targetHash
  }, parsedTarget.hash)

  let firstRealMessageMs = null
  try {
    await page.locator(REAL_CHAT_MESSAGE_SELECTOR).first().waitFor({
      state: 'attached',
      timeout: resolvedPositiveNumber(threadLoadTimeoutMs, 15000),
    })
    firstRealMessageMs = round(performance.now() - startedAt)
  } catch {
    firstRealMessageMs = null
  }

  await page.waitForTimeout(resolvedPositiveNumber(cacheRevisitWaitMs, 1500))
  setProfilePhase('initial')

  const historyRows = cacheRevisitApiRows.filter((row) => (
    row.rpc === 'thread/resume'
    || (row.rpc === 'thread/read' && row.includeTurns === true)
    || HISTORY_PAGE_METHODS.has(row.rpc)
  ))

  return {
    enabled: true,
    supported: true,
    firstRealMessageMs,
    apiRequestCount: cacheRevisitApiRows.length,
    historyApiRequestCount: historyRows.length,
    cacheHitInferred: firstRealMessageMs !== null && historyRows.length === 0,
    totalApiKB: round(cacheRevisitApiRows.reduce((sum, row) => sum + row.responseBytes, 0) / 1024),
    historyMode: buildHistoryModeReport(cacheRevisitApiRows, readTargetThreadId(targetUrl)),
    apiRows: cacheRevisitApiRows,
  }
}

async function main() {
  mkdirSync(outputDir, { recursive: true })

  const targetUrl = toTargetUrl()
  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(({ realChatMessageSelector }) => {
    const runtimeProfile = {
      firstRealMessageMs: null,
      longTasks: [],
      longTasksSupported: false,
      realChatMessageSelector,
    }
    window.__browserRuntimeProfile = runtimeProfile

    let messageObserver = null
    const markFirstRealMessage = () => {
      if (runtimeProfile.firstRealMessageMs !== null) return
      if (document.querySelector(realChatMessageSelector)) {
        runtimeProfile.firstRealMessageMs = performance.now()
        messageObserver?.disconnect()
      }
    }

    messageObserver = new MutationObserver(markFirstRealMessage)
    messageObserver.observe(document, { childList: true, subtree: true })
    markFirstRealMessage()

    try {
      const supportsLongTasks = typeof PerformanceObserver !== 'undefined'
        && Array.from(PerformanceObserver.supportedEntryTypes || []).includes('longtask')
      if (supportsLongTasks) {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            runtimeProfile.longTasks.push({
              startTime: entry.startTime,
              duration: entry.duration,
            })
          }
        })
        observer.observe({ type: 'longtask', buffered: true })
        runtimeProfile.longTasksSupported = true
      }
    } catch {
      runtimeProfile.longTasksSupported = false
      runtimeProfile.longTasks = []
    }
  }, { realChatMessageSelector: REAL_CHAT_MESSAGE_SELECTOR })
  const page = await context.newPage()
  const apiRows = []
  const cacheRevisitApiRows = []
  let profilePhase = 'initial'

  page.on('request', (request) => {
    const url = request.url()
    if (!url.includes('/codex-api')) return

    const body = request.postData()
    const parsedBody = body ? parseJson(body) : null
    const params = asRecord(parsedBody?.params)
    const rpc = parsedBody && typeof parsedBody.method === 'string' ? parsedBody.method : ''
    request.__profile = {
      startedAt: performance.now(),
      phase: profilePhase,
      rpc,
      cursor: typeof params?.cursor === 'string'
        ? params.cursor
        : '',
      threadId: typeof params?.threadId === 'string'
        ? params.threadId
        : '',
      turnId: typeof params?.turnId === 'string'
        ? params.turnId
        : '',
      sortDirection: typeof params?.sortDirection === 'string'
        ? params.sortDirection
        : '',
      includeTurns: params?.includeTurns === true,
      resumeRequest: rpc === 'thread/resume' ? readResumeRequest(params) : null,
      requestBytes: body ? Buffer.byteLength(body, 'utf8') : 0,
    }
  })

  page.on('response', async (response) => {
    const request = response.request()
    const profile = request.__profile
    if (!profile) return

    let responseBytes = 0
    let responsePayload = null
    try {
      const responseBody = await response.body()
      responseBytes = responseBody.byteLength
      if (profile.rpc === 'thread/resume' || profile.rpc === 'thread/read' || HISTORY_PAGE_METHODS.has(profile.rpc)) {
        responsePayload = parseJson(responseBody.toString('utf8'))
      }
    } catch {
      responseBytes = 0
    }

    const row = {
      method: request.method(),
      path: new URL(response.url()).pathname,
      rpc: profile.rpc,
      cursor: profile.cursor,
      threadId: profile.threadId,
      turnId: profile.turnId,
      sortDirection: profile.sortDirection,
      includeTurns: profile.includeTurns,
      status: response.status(),
      ms: round(performance.now() - profile.startedAt),
      requestBytes: profile.requestBytes,
      responseBytes,
      responseKB: round(responseBytes / 1024),
      ...(profile.resumeRequest ? { resumeRequest: profile.resumeRequest } : {}),
      ...readRpcResponseMetadata(profile.rpc, responsePayload),
    }
    const destination = profile.phase === 'cache-revisit' ? cacheRevisitApiRows : apiRows
    destination.push(row)
  })

  const tracePath = resolve(outputDir, `${artifactPrefix}-trace.zip`)
  await context.tracing.start({ screenshots: true, snapshots: true })

  const startedAt = performance.now()
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(resolvedPositiveNumber(waitMs, 7000))
  let threadLoadingTimedOut = false
  const resolvedThreadLoadTimeoutMs = Number.isFinite(threadLoadTimeoutMs) && threadLoadTimeoutMs >= 0
    ? threadLoadTimeoutMs
    : 15000
  try {
    await page.waitForFunction(
      (loadingText) => !document.body.innerText.includes(loadingText),
      THREAD_LOADING_TEXT,
      { timeout: resolvedThreadLoadTimeoutMs },
    )
  } catch {
    threadLoadingTimedOut = true
  }
  const totalMs = round(performance.now() - startedAt)

  const finalUrl = page.url()
  const title = await page.title()
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')
  const appShellPresent = await page.locator('.desktop-layout').count() > 0
  const stillLoadingThreads = threadLoadingTimedOut || hasThreadLoadingText(bodyText)
  const performanceData = await collectPerformance(page)
  performanceData.firstRealMessageMs = Number.isFinite(performanceData.firstRealMessageMs)
    ? round(performanceData.firstRealMessageMs)
    : null
  performanceData.maxLongTaskMs = Number.isFinite(performanceData.maxLongTaskMs)
    ? round(performanceData.maxLongTaskMs)
    : null
  const cacheRevisit = await runCacheRevisit(
    page,
    targetUrl,
    cacheRevisitApiRows,
    (phase) => { profilePhase = phase },
  )
  const screenshotPath = resolve(outputDir, `${artifactPrefix}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await context.tracing.stop({ path: tracePath })
  await browser.close()

  const grouped = new Map()
  for (const row of apiRows) {
    const key = requestKey(row)
    const rows = grouped.get(key) || []
    rows.push(row)
    grouped.set(key, rows)
  }

  const apiSummary = Array.from(grouped.entries())
    .map(([key, rows]) => ({ key, ...summarize(rows) }))
    .sort((a, b) => b.avgMs - a.avgMs)

  const duplicateHistoryPages = historyPageDuplicateDetails(apiRows)
  const duplicateCounts = {
    threadList: apiRows.filter((row) => row.rpc === 'thread/list').length,
    threadListFirstPage: apiRows.filter((row) => row.rpc === 'thread/list' && !row.cursor).length,
    threadListCursor: apiRows.filter((row) => row.rpc === 'thread/list' && row.cursor).length,
    threadResume: apiRows.filter((row) => row.rpc === 'thread/resume').length,
    threadRead: apiRows.filter((row) => row.rpc === 'thread/read').length,
    threadReadWithTurns: apiRows.filter((row) => row.rpc === 'thread/read' && row.includeTurns === true).length,
    threadReadDuplicateKeys: Array.from(
      apiRows
        .filter((row) => row.rpc === 'thread/read')
        .reduce((counts, row) => {
          const key = requestKey(row)
          counts.set(key, (counts.get(key) || 0) + 1)
          return counts
        }, new Map())
        .values(),
    ).filter((count) => count > 1).length,
    threadTurnsList: apiRows.filter((row) => row.rpc === 'thread/turns/list').length,
    threadTurnsListFirstPage: apiRows.filter((row) => row.rpc === 'thread/turns/list' && !row.cursor).length,
    threadTurnsListCursor: apiRows.filter((row) => row.rpc === 'thread/turns/list' && row.cursor).length,
    threadItemsList: apiRows.filter((row) => row.rpc === 'thread/items/list').length,
    threadItemsListFirstPage: apiRows.filter((row) => row.rpc === 'thread/items/list' && !row.cursor).length,
    threadItemsListCursor: apiRows.filter((row) => row.rpc === 'thread/items/list' && row.cursor).length,
    historyPageDuplicateKeys: duplicateHistoryPages.length,
    skillsList: apiRows.filter((row) => row.rpc === 'skills/list').length,
    rateLimitsRead: apiRows.filter((row) => row.rpc === 'account/rateLimits/read').length,
    providerModels: apiRows.filter((row) => row.path === '/codex-api/provider-models').length,
  }
  const diagnostics = buildWarnings(duplicateCounts, apiSummary, apiRows)
  const historyMode = buildHistoryModeReport(apiRows, readTargetThreadId(targetUrl))
  const threadResumeCalls = apiRows
    .filter((row) => row.rpc === 'thread/resume')
    .map((row) => ({
      threadId: row.threadId || null,
      status: row.status,
      ms: row.ms,
      request: row.resumeRequest ?? null,
      response: row.resumeResponse ?? null,
    }))

  const report = {
    targetUrl,
    finalUrl,
    title,
    totalMs,
    screenshotPath,
    tracePath,
    duplicateCounts,
    duplicateHistoryPageRequests: duplicateHistoryPages,
    warnings: diagnostics.warnings,
    totalApiKB: diagnostics.totalApiKB,
    pageState: {
      threadLoadingText: THREAD_LOADING_TEXT,
      threadLoadTimeoutMs: resolvedThreadLoadTimeoutMs,
      stillLoadingThreads,
      appShellPresent,
      zeroApiTraffic: apiRows.length === 0,
      firstRealMessageMs: performanceData.firstRealMessageMs,
      firstRealMessageSelector: REAL_CHAT_MESSAGE_SELECTOR,
    },
    historyMode,
    threadResumeCalls,
    cacheRevisit,
    measurementScope: {
      browserRpcRequests: true,
      appServerInternalItemQueries: false,
      appServerInternalItemQueryNote: 'Browser RPC counts cannot detect per-turn app-server item hydration or internal N+1 queries.',
    },
    bodyTextHead: bodyText.slice(0, 1000),
    performance: performanceData,
    apiSummary,
    slowestApiRows: [...apiRows].sort((a, b) => b.ms - a.ms).slice(0, 20),
    apiRows,
  }

  const reportPath = resolve(outputDir, `${artifactPrefix}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  console.log(JSON.stringify({
    reportPath,
    screenshotPath,
    tracePath,
    targetUrl,
    finalUrl,
    title,
    totalMs,
    duplicateCounts,
    duplicateHistoryPageRequests: duplicateHistoryPages,
    warnings: diagnostics.warnings,
    pageState: report.pageState,
    historyMode,
    threadResumeCalls,
    cacheRevisit,
    performance: {
      firstRealMessageMs: performanceData.firstRealMessageMs,
      firstRealMessageSelector: performanceData.firstRealMessageSelector,
      longTaskCount: performanceData.longTaskCount,
      maxLongTaskMs: performanceData.maxLongTaskMs,
      longTasksSupported: performanceData.longTasksSupported,
    },
    totalApiKB: diagnostics.totalApiKB,
    topApiSummary: apiSummary.slice(0, 12),
    slowestApiRows: report.slowestApiRows.slice(0, 10),
  }, null, 2))

  if (stillLoadingThreads || !appShellPresent || apiRows.length === 0) {
    const reasons = []
    if (stillLoadingThreads) reasons.push(`page still contains "${THREAD_LOADING_TEXT}" after ${resolvedThreadLoadTimeoutMs}ms`)
    if (!appShellPresent) reasons.push('app shell .desktop-layout is missing')
    if (apiRows.length === 0) reasons.push('zero /codex-api responses were captured')
    console.error(`Profile failed: ${reasons.join('; ')}. Report: ${reportPath}`)
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
