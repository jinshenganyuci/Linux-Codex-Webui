const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.env.PROMPT_HISTORY_BASE_URL || 'http://127.0.0.1:4173'
const outputDir = path.resolve('output/playwright')
const historyKey = 'codex-web-local.prompt-history.v1'
const fixtures = ['Inspect PROJECT_ALPHA.md', 'Review PROJECT_BETA.md']

async function verifyCase(browser, viewport, theme) {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: viewport.width < 768,
    isMobile: viewport.width < 768,
    serviceWorkers: 'block',
  })
  await context.addInitScript((value) => localStorage.setItem('codex-web-local.dark-mode.v1', value), theme)
  const page = await context.newPage()
  const pageErrors = []
  const sendRequests = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    if (/\/codex-api\/(?:thread\/start-turn|rpc)/u.test(request.url()) && /"method":"turn\/(?:start|steer)"/u.test(request.postData() || '')) {
      sendRequests.push(request.url())
    }
  })

  try {
    await page.goto(`${baseUrl}/#/`, { waitUntil: 'domcontentloaded' })
    const input = page.locator('.thread-composer-input').first()
    await input.waitFor({ timeout: 20_000 })
    await page.evaluate(({ key, entries }) => localStorage.setItem(key, JSON.stringify(entries)), { key: historyKey, entries: fixtures })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await input.waitFor({ timeout: 20_000 })

    await input.fill('unsent draft')
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), fixtures[1])
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), fixtures[0])
    await input.press('ArrowDown')
    assert.equal(await input.inputValue(), fixtures[1])
    await input.press('ArrowDown')
    assert.equal(await input.inputValue(), 'unsent draft')

    await input.press('Control+r')
    const dialog = page.locator('.thread-composer-prompt-history')
    await dialog.waitFor()
    const searchInput = dialog.locator('input')
    await searchInput.fill('project_beta')
    assert.equal(await dialog.locator('.thread-composer-prompt-history-row').count(), 1)
    await searchInput.press('Enter')
    assert.equal(await input.inputValue(), fixtures[1])
    assert.equal(await dialog.count(), 0)

    await input.press('Control+r')
    await dialog.waitFor()
    await dialog.locator('input').fill('PROJECT_ALPHA')
    await dialog.locator('.thread-composer-prompt-history-row').click()
    assert.equal(await input.inputValue(), fixtures[0])
    assert.equal(await dialog.count(), 0)

    await input.fill('first line\nsecond line')
    await input.evaluate((element) => element.setSelectionRange(element.value.length, element.value.length))
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), 'first line\nsecond line')
    await input.evaluate((element) => element.setSelectionRange(2, 2))
    await input.press('ArrowUp')
    assert.equal(await input.inputValue(), fixtures[1])

    await input.press('Control+r')
    await dialog.waitFor()
    await dialog.locator('input').fill('PROJECT_ALPHA')
    assert.equal(await dialog.locator('.thread-composer-prompt-history-row').count(), 1)
    await dialog.locator('input').press('Escape')
    assert.equal(await dialog.count(), 0)
    assert.equal(await input.inputValue(), fixtures[1])

    await input.press('Control+r')
    await dialog.waitFor()
    await dialog.locator('input').fill('project')
    await page.waitForTimeout(2500)
    const screenshotPath = path.join(outputDir, `tui-prompt-history-${theme}-${viewport.width}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    const appearance = await dialog.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      foreground: getComputedStyle(element.querySelector('.thread-composer-prompt-history-row')).color,
      pageDark: document.documentElement.classList.contains('dark'),
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }))
    assert.equal(appearance.pageDark, theme === 'dark')
    assert.equal(appearance.overflow, false)
    assert.equal(sendRequests.length, 0)
    assert.deepEqual(pageErrors, [])
    return { url: `${baseUrl}/#/`, viewport, theme, screenshotPath, appearance, sendRequests: 0 }
  } finally {
    await context.close()
  }
}

async function verifyCopyShortcut(browser) {
  const threadId = '019dbd35-0000-7000-8000-000000000001'
  const responseText = 'COPY_LAST_RESPONSE_MARKER_20261108'
  const thread = {
    id: threadId,
    preview: 'Copy shortcut fixture',
    historyMode: 'legacy',
    modelProvider: 'openai',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    path: null,
    cwd: '/tmp/codex-webui-prompt-history-fixture',
    cliVersion: 'test',
    source: 'appServer',
    gitInfo: null,
    turns: [{
      id: 'fixture-turn',
      status: 'completed',
      error: null,
      items: [
        { type: 'userMessage', id: 'fixture-user', content: [{ type: 'text', text: 'Copy the last answer', text_elements: [] }] },
        { type: 'agentMessage', id: 'fixture-answer', text: responseText, phase: 'final_answer' },
      ],
    }],
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    serviceWorkers: 'block',
  })
  const page = await context.newPage()
  const pageErrors = []
  const sendRequests = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    if (request.url().endsWith('/codex-api/thread/start-turn')) sendRequests.push(request.url())
  })
  await page.route('**/codex-api/rpc', async (route) => {
    const body = route.request().postDataJSON()
    if (body?.method === 'thread/list') {
      await route.fulfill({ json: { result: { data: [thread], nextCursor: null } } })
      return
    }
    if (body?.method === 'thread/read' && body.params?.threadId === threadId) {
      await route.fulfill({ json: { result: { thread } } })
      return
    }
    await route.continue()
  })

  try {
    const url = `${baseUrl}/#/thread/${threadId}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('.conversation-item[data-role="assistant"]', { hasText: responseText }).waitFor({ timeout: 20_000 })
    const input = page.locator('.thread-composer-input').first()
    await input.focus()
    await input.press('Control+o')
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), responseText)
    assert.equal(sendRequests.length, 0)
    assert.deepEqual(pageErrors, [])
    await page.waitForTimeout(2500)
    const screenshotPath = path.join(outputDir, 'tui-copy-last-response-light-1440.png')
    await page.screenshot({ path: screenshotPath, fullPage: true })
    return { url, viewport: { width: 1440, height: 900 }, clipboardText: responseText, screenshotPath, sendRequests: 0 }
  } finally {
    await context.close()
  }
}

async function main() {
  mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  })
  try {
    const results = []
    for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
      for (const theme of ['light', 'dark']) results.push(await verifyCase(browser, viewport, theme))
    }
    assert.notEqual(results[0].appearance.background, results[1].appearance.background)
    const copyResult = await verifyCopyShortcut(browser)
    const reportPath = path.join(outputDir, 'tui-prompt-history-report.json')
    writeFileSync(reportPath, JSON.stringify({ history: results, copy: copyResult }, null, 2))
    process.stdout.write(`PASS ${results.length} prompt-history layouts and copy shortcut; ${reportPath}\n`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
