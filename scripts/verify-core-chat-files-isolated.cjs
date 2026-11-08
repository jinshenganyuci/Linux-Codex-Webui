const assert = require('node:assert/strict')
const { execFile, spawn } = require('node:child_process')
const { createWriteStream, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const { chromium } = require('playwright')

const execFileAsync = promisify(execFile)

const repoRoot = path.resolve(__dirname, '..')
const outputDir = path.join(repoRoot, 'output/playwright/core-chat-files-isolated')
const firstPort = 4182
const secondPort = 4183
const providerPort = 4184
const testProjectLabel = 'PR5 Isolated TestChat'
const marker = `PR5_TESTCHAT_${Date.now()}`
const startedProcesses = []
const providerRequests = []

function writeReport(report) {
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2) + '\n')
}

async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (error) => reject(new Error(`Port ${port} is occupied: ${error.message}`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}

function responseTextForMarker(requestMarker) {
  if (requestMarker.startsWith('PR5_LARGE_')) return `${requestMarker}\n${'X'.repeat(120_000)}`
  return `${requestMarker}\n[README.md](README.md)\n[OpenAI Docs](https://developers.openai.com/codex/cli)`
}

async function startMockProvider() {
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, `http://127.0.0.1:${providerPort}`).pathname
    if (pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"ready":true}')
      return
    }
    if (pathname.endsWith('/models')) {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6-luna', object: 'model' }] }))
      return
    }
    if (!pathname.endsWith('/responses')) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{}')
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end('{}')
      return
    }
    const requestMarker = [...JSON.stringify(payload.input ?? []).matchAll(/PR5_[A-Z0-9_]+/gu)].at(-1)?.[0] ?? 'PR5_BACKGROUND'
    const answer = responseTextForMarker(requestMarker)
    const responseIndex = providerRequests.length + 1
    providerRequests.push({ marker: requestMarker, model: payload.model, requestBytes: Buffer.byteLength(body) })
    const item = {
      type: 'message', id: `msg_${responseIndex}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: answer, annotations: [] }],
    }
    const result = {
      id: `resp_${responseIndex}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'completed', model: payload.model, output: [item],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('response.created', { response: { ...result, status: 'in_progress', output: [] } })
    send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: answer })
    send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: answer })
    send('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] })
    send('response.output_item.done', { output_index: 0, item })
    send('response.completed', { response: result })
    response.end()
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(providerPort, '127.0.0.1', resolve))
  return server
}

async function fetchJson(baseUrl, pathname, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`${method} ${pathname}: HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`)
  return payload
}

async function rpc(baseUrl, method, params) {
  return (await fetchJson(baseUrl, '/codex-api/rpc', { method, params })).result
}

async function rpcRaw(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/codex-api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: response.status, payload: await response.json().catch(() => null) }
}

async function startWebUi(port, codexHome) {
  const baseUrl = `http://127.0.0.1:${port}`
  const log = createWriteStream(path.join(outputDir, `webui-${port}.log`))
  const child = spawn(process.execPath, [
    'node_modules/.bin/vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEXUI_CODEX_COMMAND: '/usr/bin/codex',
      CODEXUI_SANDBOX_MODE: 'read-only',
      CODEXUI_APPROVAL_POLICY: 'never',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  startedProcesses.push(child)
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  let lastError = ''
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`WebUI ${port} exited early; see ${log.path}`)
    try {
      const runtime = (await fetchJson(baseUrl, '/codex-api/runtime-info')).data
      assert.equal(runtime.codex.home, codexHome)
      return { baseUrl, runtime }
    } catch (error) {
      lastError = error.message
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw new Error(`WebUI ${port} did not become ready: ${lastError}`)
}

async function stopWebUi(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
  }
}

async function waitForTurn(baseUrl, threadId, turnId) {
  const deadline = Date.now() + 45_000
  let lastStatus = ''
  while (Date.now() < deadline) {
    const page = await rpc(baseUrl, 'thread/turns/list', {
      threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
    })
    const turn = page.data?.find((entry) => entry.id === turnId)
    lastStatus = turn?.status ?? ''
    if (lastStatus === 'completed') return
    if (lastStatus === 'failed' || lastStatus === 'interrupted') {
      throw new Error(`Turn ${turnId} ended ${lastStatus}: ${JSON.stringify(turn.error).slice(0, 300)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Turn ${turnId} did not complete: ${lastStatus}`)
}

async function seedLargeHistory(baseUrl, threadId) {
  const startedAt = performance.now()
  let lastMarker = ''
  for (let index = 1; index <= 12; index += 1) {
    lastMarker = `PR5_LARGE_${String(index).padStart(2, '0')}_${Date.now()}`
    const started = await rpc(baseUrl, 'turn/start', {
      threadId,
      input: [{ type: 'text', text: lastMarker }],
      model: 'gpt-5.6-luna',
      effort: 'low',
    })
    await waitForTurn(baseUrl, threadId, started.turn.id)
  }
  const read = await rpcRaw(baseUrl, 'thread/read', { threadId, includeTurns: true })
  assert.equal(read.status, 200)
  const turns = read.payload?.result?.thread?.turns ?? []
  assert.ok(turns.length >= 10)
  return {
    requestedTurns: 12,
    returnedTurns: turns.length,
    responseBytes: Buffer.byteLength(JSON.stringify(read.payload)),
    lastMarker,
    seedMs: Math.round(performance.now() - startedAt),
  }
}

async function verifyTestChat(browser, baseUrl, projectPath) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    localStorage.setItem('codex-web-local.dark-mode.v1', 'light')
    localStorage.setItem('codex-web-local.ui-language.v1', 'en')
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' })
    await page.locator('.new-thread-folder-dropdown').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(2_000)
    await page.locator('.new-thread-folder-dropdown').click()
    await page.locator('.composer-dropdown-option', { hasText: testProjectLabel }).click()
    const prompt = `${marker} Reply with a local README.md link and an OpenAI Docs link.`
    await page.locator('.thread-composer-input').fill(prompt)
    await page.locator('.thread-composer-submit').click()
    await page.waitForURL(/#\/thread\//u, { timeout: 60_000 })
    const threadId = new URL(page.url()).hash.slice('#/thread/'.length)
    const assistantRow = page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: marker }).first()
    await assistantRow.waitFor({ timeout: 60_000 })
    const localLink = assistantRow.locator('a').filter({ hasText: 'README.md' }).first()
    const webLink = assistantRow.locator('a').filter({ hasText: 'OpenAI Docs' }).first()
    const local = {
      href: await localLink.getAttribute('href'),
      title: await localLink.getAttribute('title'),
      text: (await localLink.textContent())?.trim() ?? '',
    }
    const web = {
      href: await webLink.getAttribute('href'),
      title: await webLink.getAttribute('title'),
      text: (await webLink.textContent())?.trim() ?? '',
    }
    const assertions = {
      hrefOk: local.href?.startsWith(`/codex-local-browse${projectPath}/`) === true && local.href.endsWith('/README.md'),
      titleOk: local.title === 'README.md',
      textOk: local.text === 'README.md',
      webHrefOk: web.href === 'https://developers.openai.com/codex/cli',
      webTextOk: web.text === 'OpenAI Docs',
    }
    for (const [name, value] of Object.entries(assertions)) assert.equal(value, true, `${name}: ${JSON.stringify({ local, web })}`)
    assert.deepEqual(pageErrors, [])
    await page.waitForTimeout(2_500)
    const screenshot = path.join(outputDir, 'testchat-core-chat-files-light-1440-cjs.png')
    await page.screenshot({ path: screenshot, fullPage: true })
    return { url: page.url(), threadId, marker, prompt, local, web, assertions, screenshot, viewport: { width: 1440, height: 900 }, theme: 'light' }
  } finally {
    await context.close()
  }
}

async function verifyTestChatMobile(browser, baseUrl, threadId, projectPath) {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 }, colorScheme: 'dark', hasTouch: true, isMobile: true, serviceWorkers: 'block',
  })
  await context.addInitScript(() => {
    localStorage.setItem('codex-web-local.dark-mode.v1', 'dark')
    localStorage.setItem('codex-web-local.ui-language.v1', 'en')
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    const url = `${baseUrl}/#/thread/${threadId}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const assistantRow = page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: marker }).first()
    await assistantRow.waitFor({ timeout: 30_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await assistantRow.waitFor({ timeout: 30_000 })
    const localLink = assistantRow.locator('a').filter({ hasText: 'README.md' }).first()
    const assertions = {
      hrefOk: (await localLink.getAttribute('href')) === `/codex-local-browse${projectPath}/README.md`,
      titleOk: (await localLink.getAttribute('title')) === 'README.md',
      textOk: (await localLink.textContent())?.trim() === 'README.md',
      darkTheme: await page.locator('html').evaluate((element) => element.classList.contains('dark')),
      noOverflow: await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    }
    for (const [name, value] of Object.entries(assertions)) assert.equal(value, true, name)
    assert.deepEqual(pageErrors, [])
    await page.waitForTimeout(2_500)
    const screenshot = path.join(outputDir, 'testchat-core-chat-files-dark-375-cjs.png')
    await page.screenshot({ path: screenshot, fullPage: false })
    return { url, viewport: { width: 375, height: 812 }, theme: 'dark', afterRefresh: true, assertions, screenshot }
  } finally {
    await context.close()
  }
}

async function verifyStructuredChatMention(browser, baseUrl, threadId) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    localStorage.setItem('codex-web-local.dark-mode.v1', 'light')
    localStorage.setItem('codex-web-local.ui-language.v1', 'en')
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    const url = `${baseUrl}/#/thread/${threadId}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: marker }).first().waitFor({ timeout: 30_000 })
    await page.locator('.thread-composer-attach-trigger').click()
    await page.locator('.thread-composer-attach-item').filter({ hasText: 'Search files and chats' }).first().click()
    const searchInput = page.locator('.thread-composer-attach-search-input')
    await searchInput.fill(marker)
    const chatResult = page.locator('.thread-composer-attach-search-result').filter({ has: page.locator('.thread-composer-attach-search-chat-icon') }).first()
    await chatResult.waitFor({ timeout: 15_000 })
    await chatResult.click()
    await page.locator('.thread-composer-chat-chip').waitFor()
    const mentionMarker = `PR5_MENTION_${Date.now()}`
    await page.locator('.thread-composer-input').fill(mentionMarker)
    await page.locator('.thread-composer-submit').click()
    await page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: mentionMarker }).first().waitFor({ timeout: 45_000 })
    const userRow = page.locator('.conversation-item[data-role="user"]').filter({ hasText: mentionMarker }).first()
    const mentionChip = userRow.locator('.message-chat-chip').first()
    await mentionChip.waitFor({ timeout: 15_000 })
    const chip = {
      href: await mentionChip.getAttribute('href'),
      title: await mentionChip.getAttribute('title'),
      text: (await mentionChip.textContent())?.trim() ?? '',
    }
    const expectedPath = `thread://${threadId}?hostId=local`
    assert.equal(chip.href, `${baseUrl}/#/thread/${threadId}`)
    assert.equal(chip.title, expectedPath)
    assert.ok(chip.text.includes(marker))
    const read = await rpc(baseUrl, 'thread/read', { threadId, includeTurns: true })
    const userItems = (read.thread?.turns ?? []).flatMap((turn) => turn.items ?? []).filter((item) => item.type === 'userMessage')
    const mentionItem = userItems.find((item) => JSON.stringify(item.content).includes(mentionMarker))
    assert.ok(mentionItem)
    assert.ok(mentionItem.content?.some((entry) => entry.type === 'mention' && entry.path === expectedPath))
    assert.deepEqual(pageErrors, [])
    await page.waitForTimeout(2_500)
    const screenshot = path.join(outputDir, 'testchat-structured-mention-light-1440-cjs.png')
    await page.screenshot({ path: screenshot, fullPage: false })
    return { url, viewport: { width: 1440, height: 900 }, mentionMarker, mentionPath: expectedPath, chip, persistedMention: true, screenshot }
  } finally {
    await context.close()
  }
}

async function verifyActiveWriterReadOnly(browser, baseUrl, threadId, expectedMarker) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    localStorage.setItem('codex-web-local.dark-mode.v1', 'dark')
    localStorage.setItem('codex-web-local.ui-language.v1', 'en')
  })
  const page = await context.newPage()
  const pageErrors = []
  const rpcMethods = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    if (!request.url().endsWith('/codex-api/rpc')) return
    try {
      const body = request.postDataJSON()
      rpcMethods.push({ method: body.method, includeTurns: body.params?.includeTurns ?? null })
    } catch {}
  })
  try {
    const url = `${baseUrl}/#/thread/${threadId}`
    const startedAt = performance.now()
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const assistantRow = page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: expectedMarker }).first()
    await assistantRow.waitFor({ timeout: 45_000 })
    const loadedMs = Math.round(performance.now() - startedAt)
    const initialResumeCount = rpcMethods.filter((request) => request.method === 'thread/resume').length
    const fullReadCount = rpcMethods.filter((request) => request.method === 'thread/read' && request.includeTurns === true).length
    assert.ok(initialResumeCount >= 1, 'The second client must encounter the paginated resume path')
    assert.ok(fullReadCount >= 1, 'The second client must fall back to full read-only history')
    assert.equal(await page.locator('.visible-error-card').count(), 0)

    await page.evaluate(() => { window.location.hash = '#/' })
    await page.locator('.new-thread-folder-dropdown').waitFor({ timeout: 15_000 })
    await page.evaluate((id) => { window.location.hash = `#/thread/${id}` }, threadId)
    await assistantRow.waitFor({ timeout: 15_000 })
    await page.waitForTimeout(1_000)
    const repeatedResumeCount = rpcMethods.filter((request) => request.method === 'thread/resume').length
    assert.equal(repeatedResumeCount, initialResumeCount, 'Same-page revisit must not retry thread/resume')

    await page.waitForTimeout(2_500)
    const screenshot = path.join(outputDir, 'testchat-active-writer-read-only-dark-1280-cjs.png')
    await page.screenshot({ path: screenshot, fullPage: false })

    const providerRequestCountBeforeSend = providerRequests.length
    const sendMarker = `PR5_LOCKED_SEND_${Date.now()}`
    const input = page.locator('.thread-composer-input')
    await input.fill(sendMarker)
    await page.locator('.thread-composer-submit').click()
    await page.getByText(/already has an active writer/iu).first().waitFor({ timeout: 20_000 })
    assert.equal(await input.inputValue(), sendMarker)
    assert.equal(providerRequests.length, providerRequestCountBeforeSend)
    assert.equal(await assistantRow.count(), 1)
    const sendAttemptResumeCount = rpcMethods.filter((request) => request.method === 'thread/resume').length
    assert.ok(sendAttemptResumeCount > repeatedResumeCount)

    assert.deepEqual(pageErrors, [])
    return { url, viewport: { width: 1280, height: 900 }, theme: 'dark', loadedMs, initialResumeCount, repeatedResumeCount, sendAttemptResumeCount, sendFailureVisible: true, draftRetained: true, fullReadCount, rpcMethods, screenshot }
  } catch (error) {
    await page.screenshot({ path: path.join(outputDir, 'testchat-active-writer-read-only-failed.png') }).catch(() => undefined)
    throw new Error(`${error.message}; rpcMethods=${JSON.stringify(rpcMethods)}; pageErrors=${JSON.stringify(pageErrors)}`)
  } finally {
    await context.close()
  }
}

async function profileReadOnlyThread(baseUrl, threadId) {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/profile-browser-runtime.cjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PROFILE_BASE_URL: baseUrl,
      PROFILE_ROUTE: `#/thread/${threadId}`,
      PROFILE_WAIT_MS: '3000',
      PROFILE_CACHE_REVISIT: 'true',
      PROFILE_BROWSER_EXECUTABLE_PATH: process.env.CODEX_ACCEPTANCE_BROWSER_PATH || '/usr/bin/google-chrome-stable',
      PROFILE_SCREENSHOT_FULL_PAGE: 'false',
    },
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  const profile = JSON.parse(stdout)
  assert.equal(profile.pageState.appShellPresent, true)
  assert.equal(profile.pageState.stillLoadingThreads, false)
  assert.equal(profile.pageState.zeroApiTraffic, false)
  assert.equal(profile.duplicateCounts.threadResume, 1)
  assert.equal(profile.duplicateCounts.threadReadWithTurns, 1)
  assert.equal(profile.duplicateCounts.threadReadDuplicateKeys, 0)
  assert.equal(profile.cacheRevisit.historyApiRequestCount, 0)
  assert.ok(profile.totalApiKB > 1_000)
  assert.deepEqual(profile.warnings.filter((warning) => (
    warning !== 'skillsList=2' && !warning.startsWith('totalApiKB=')
  )), [])
  return profile
}

async function verifyWriteRecovery(browser, baseUrl, threadId, previousMarker) {
  let resumeAttempts = 0
  let lastResume = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    resumeAttempts += 1
    lastResume = await rpcRaw(baseUrl, 'thread/resume', { threadId })
    if (lastResume.status === 200) break
    if (!/already has an active writer/iu.test(JSON.stringify(lastResume.payload))) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert.equal(lastResume?.status, 200, `Writer did not release: ${JSON.stringify(lastResume).slice(0, 400)}`)

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' })
  await context.addInitScript(() => {
    localStorage.setItem('codex-web-local.dark-mode.v1', 'light')
    localStorage.setItem('codex-web-local.ui-language.v1', 'en')
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  try {
    const url = `${baseUrl}/#/thread/${threadId}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: previousMarker }).first().waitFor({ timeout: 30_000 })
    const providerRequestCountBeforeSend = providerRequests.length
    const sendMarker = `PR5_AFTER_RELEASE_${Date.now()}`
    await page.locator('.thread-composer-input').fill(sendMarker)
    await page.locator('.thread-composer-submit').click()
    const completedReply = page.locator('.conversation-item[data-role="assistant"]').filter({ hasText: sendMarker }).first()
    await completedReply.waitFor({ timeout: 45_000 })
    assert.ok(providerRequests.length > providerRequestCountBeforeSend)
    assert.deepEqual(pageErrors, [])
    await page.waitForTimeout(2_500)
    const screenshot = path.join(outputDir, 'testchat-after-writer-release-light-1280-cjs.png')
    await page.screenshot({ path: screenshot, fullPage: false })
    return { url, viewport: { width: 1280, height: 900 }, theme: 'light', resumeAttempts, sendMarker, providerRequestCountBeforeSend, providerRequestCountAfterSend: providerRequests.length, screenshot }
  } finally {
    await context.close()
  }
}

async function main() {
  for (const port of [firstPort, secondPort, providerPort]) await assertPortFree(port)
  mkdirSync(outputDir, { recursive: true })
  const codexHome = mkdtempSync(path.join(tmpdir(), 'codex-pr5-isolated-'))
  const projectPath = path.join(codexHome, 'TestChat')
  mkdirSync(projectPath, { recursive: true })
  writeFileSync(path.join(projectPath, 'README.md'), `# Isolated TestChat\n${marker}\n`)
  writeFileSync(path.join(codexHome, 'config.toml'), [
    'model = "gpt-5.6-luna"',
    'model_provider = "pr5mock"',
    'model_reasoning_effort = "low"',
    '[model_providers.pr5mock]',
    'name = "PR5 isolated mock"',
    `base_url = "http://127.0.0.1:${providerPort}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'experimental_bearer_token = "pr5-test-only"',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'), { mode: 0o600 })
  const report = {
    status: 'running', marker, codexHome, projectPath,
    ports: { first: firstPort, second: secondPort, provider: providerPort },
    provider: 'local deterministic Responses SSE mock; no real model or credentials',
  }
  writeReport(report)
  let provider
  let browser
  try {
    const cliVersion = await execFileAsync('/usr/bin/codex', ['--version'], {
      env: { ...process.env, CODEX_HOME: codexHome }, timeout: 10_000,
    })
    report.cliBinaryVersion = cliVersion.stdout.trim()
    assert.match(report.cliBinaryVersion, /^codex-cli /u)
    provider = await startMockProvider()
    const first = await startWebUi(firstPort, codexHome)
    report.firstRuntime = { version: first.runtime.codex.version, home: first.runtime.codex.home }
    await fetchJson(first.baseUrl, '/codex-api/workspace-roots-state', {
      order: [projectPath], active: [projectPath], labels: { [projectPath]: testProjectLabel },
    }, 'PUT')
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CODEX_ACCEPTANCE_BROWSER_PATH || '/usr/bin/google-chrome-stable',
    })
    report.testChat = await verifyTestChat(browser, first.baseUrl, projectPath)
    report.testChatMobile = await verifyTestChatMobile(browser, first.baseUrl, report.testChat.threadId, projectPath)
    report.structuredMention = await verifyStructuredChatMention(browser, first.baseUrl, report.testChat.threadId)
    const threadSnapshot = await rpc(first.baseUrl, 'thread/read', { threadId: report.testChat.threadId, includeTurns: false })
    report.threadHistoryMode = threadSnapshot.thread?.historyMode ?? null
    assert.equal(report.threadHistoryMode, 'paginated')
    report.largeHistory = await seedLargeHistory(first.baseUrl, report.testChat.threadId)
    await rpc(first.baseUrl, 'thread/resume', { threadId: report.testChat.threadId })
    const second = await startWebUi(secondPort, codexHome)
    report.secondRuntime = { version: second.runtime.codex.version, home: second.runtime.codex.home }
    const writerConflict = await rpcRaw(second.baseUrl, 'thread/resume', { threadId: report.testChat.threadId })
    report.writerConflict = { status: writerConflict.status, message: JSON.stringify(writerConflict.payload).slice(0, 500) }
    assert.ok(writerConflict.status >= 400)
    assert.match(report.writerConflict.message, /already has an active writer/iu)
    report.readOnlyBrowser = await verifyActiveWriterReadOnly(browser, second.baseUrl, report.testChat.threadId, report.largeHistory.lastMarker)
    report.profile = await profileReadOnlyThread(second.baseUrl, report.testChat.threadId)
    await stopWebUi(startedProcesses[0])
    report.afterRelease = await verifyWriteRecovery(browser, second.baseUrl, report.testChat.threadId, report.largeHistory.lastMarker)
    report.providerRequests = providerRequests
    report.status = 'passed'
    writeReport(report)
    process.stdout.write(`PASS isolated TestChat: ${report.testChat.threadId}; ${path.join(outputDir, 'report.json')}\n`)
  } catch (error) {
    report.status = 'failed'
    report.error = error.stack || error.message
    report.providerRequests = providerRequests
    writeReport(report)
    throw error
  } finally {
    if (browser) await browser.close()
    for (const child of startedProcesses.reverse()) await stopWebUi(child)
    if (provider) await new Promise((resolve) => provider.close(resolve))
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
