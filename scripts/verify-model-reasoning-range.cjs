const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.env.REASONING_BASE_URL || 'http://127.0.0.1:4173'
const expectedModel = process.env.REASONING_EXPECTED_MODEL || 'gpt-6.1-sol'
const outputDir = path.resolve('output/playwright/model-reasoning-range')

async function readRpc(method, params = {}) {
  const response = await fetch(`${baseUrl}/codex-api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  assert.equal(response.ok, true, `${method}: HTTP ${response.status}`)
  return (await response.json()).result
}

async function verifyCase(browser, viewport, theme, expectedEfforts, unknownCatalog = false, language = 'en') {
  const context = await browser.newContext({
    viewport,
    colorScheme: theme,
    hasTouch: viewport.width < 768,
    isMobile: viewport.width < 768,
    serviceWorkers: 'block',
  })
  await context.addInitScript(({ selectedTheme, selectedLanguage }) => {
    localStorage.setItem('codex-web-local.dark-mode.v1', selectedTheme)
    localStorage.setItem('codex-web-local.ui-language.v1', selectedLanguage)
  }, { selectedTheme: theme, selectedLanguage: language })
  const page = await context.newPage()
  const pageErrors = []
  const modelListRequests = []
  const providerModelRequests = []
  const writes = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === '/codex-api/provider-models') providerModelRequests.push(request.url())
    if (url.pathname === '/codex-api/rpc') {
      try {
        const body = request.postDataJSON()
        if (body.method === 'model/list') modelListRequests.push(request.url())
        if (['config/value/write', 'turn/start', 'thread/start'].includes(body.method)) writes.push(body.method)
      } catch {}
    } else if (['/codex-api/thread/start-turn', '/codex-api/new-chat-defaults', '/codex-api/thread-model-preferences'].includes(url.pathname)
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`)
    }
  })
  if (unknownCatalog) {
    await page.route('**/codex-api/rpc', async (route) => {
      const body = route.request().postDataJSON()
      if (body?.method === 'model/list') {
        await route.fulfill({ json: { result: { data: [], nextCursor: null } } })
      } else {
        await route.continue()
      }
    })
    await page.route('**/codex-api/preferences/new-chat-defaults', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { data: { version: 1, revision: 0, providers: { custom: { reasoningEffort: 'ultra' } } } } })
      } else {
        await route.continue()
      }
    })
  }

  try {
    const url = `${baseUrl}/#/`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const trigger = page.locator('.model-reasoning-trigger').first()
    await trigger.waitFor({ timeout: 20_000 })
    await page.waitForTimeout(1_500)
    const initialLabel = await trigger.getAttribute('aria-label')
    assert.match(initialLabel, /Ultra/u)
    await trigger.click()
    const slider = page.locator('.reasoning-slider[role="slider"]').first()
    let options = []
    if (unknownCatalog) {
      await page.locator('.model-reasoning-empty').waitFor({ timeout: 10_000 })
      assert.equal(await slider.count(), 0)
      assert.equal(await page.locator('.model-reasoning-advanced button').count(), 0)
      await page.locator('.sidebar-settings-button').click()
      const savedDefault = page.locator('.sidebar-settings-new-chat-dropdown').nth(1).locator('.composer-dropdown-trigger')
      await savedDefault.scrollIntoViewIfNeeded()
      assert.match(await savedDefault.textContent(), /Ultra/u)
    } else {
      await slider.waitFor({ timeout: 10_000 })
      options = await slider.evaluate((element) => element.__vueParentComponent?.props?.options?.map((option) => option.value) ?? [])
      assert.deepEqual(options, expectedEfforts)
      assert.equal(await slider.getAttribute('aria-valuemax'), String(expectedEfforts.length - 1))
      assert.equal(await slider.locator('.reasoning-slider-tick').count(), expectedEfforts.length)
      const advanced = page.locator('.model-reasoning-advanced button')
      assert.deepEqual(await advanced.allTextContents(), ['Max', 'Ultra'])
      await advanced.first().click()
      assert.match(await trigger.getAttribute('aria-label'), /Max/u)
      await advanced.last().click()
      assert.match(await trigger.getAttribute('aria-label'), /Ultra/u)
    }
    await page.waitForTimeout(2_500)
    const screenshot = path.join(outputDir, `model-reasoning-${unknownCatalog ? 'unknown-' : ''}${language}-${theme}-${viewport.width}.png`)
    await page.screenshot({ path: screenshot, fullPage: false })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('html').evaluate((element) => element.classList.contains('dark')), theme === 'dark')
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(writes, [])
    assert.equal(modelListRequests.length, 1)
    assert.equal(providerModelRequests.length, 1)
    return { url, viewport, theme, language, unknownCatalog, initialLabel, options, modelListRequests: 1, providerModelRequests: 1, writes: 0, screenshot }
  } finally {
    await context.close()
  }
}

async function main() {
  mkdirSync(outputDir, { recursive: true })
  const config = await readRpc('config/read')
  assert.equal(config.config?.model, expectedModel)
  assert.equal(config.config?.model_reasoning_effort, 'ultra')
  const modelList = await readRpc('model/list')
  const selectedModel = modelList.data?.find((model) => model.id === expectedModel)
  assert.ok(selectedModel, `model/list does not contain ${expectedModel}`)
  const expectedEfforts = selectedModel.supportedReasoningEfforts.map((option) => option.reasoningEffort)
  assert.deepEqual(expectedEfforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.REASONING_BROWSER_PATH || '/usr/bin/google-chrome-stable',
  })
  try {
    const results = []
    for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 375, height: 812 }]) {
      for (const theme of ['light', 'dark']) results.push(await verifyCase(browser, viewport, theme, expectedEfforts))
    }
    results.push(await verifyCase(browser, { width: 1440, height: 900 }, 'light', expectedEfforts, true))
    results.push(await verifyCase(browser, { width: 1440, height: 900 }, 'light', expectedEfforts, false, 'zh-CN'))
    results.push(await verifyCase(browser, { width: 375, height: 812 }, 'dark', expectedEfforts, false, 'zh-CN'))
    const reportPath = path.join(outputDir, 'report.json')
    writeFileSync(reportPath, JSON.stringify({ model: expectedModel, expectedEfforts, results }, null, 2))
    process.stdout.write(`PASS ${results.length} model reasoning cases; ${reportPath}\n`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
