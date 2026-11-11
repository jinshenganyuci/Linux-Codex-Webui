const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const baseUrl = process.env.FILE_SEARCH_BASE_URL || 'http://127.0.0.1:4173'
const projectLabel = process.env.FILE_SEARCH_TEST_PROJECT_LABEL
const outputDir = path.resolve('output/playwright')

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
  const searchRequests = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    if (request.url().includes('/codex-api/composer-file-search')) searchRequests.push(request.url())
  })

  try {
    const url = `${baseUrl}/#/`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.locator('.new-thread-folder-dropdown').waitFor({ timeout: 20_000 })
    await page.waitForTimeout(2500)
    await page.locator('.new-thread-folder-dropdown').click()
    await page.locator('.composer-dropdown-option', { hasText: projectLabel }).click()
    await page.locator('.thread-composer-attach-trigger').click()
    await page.locator('.thread-composer-attach-item').filter({ hasText: '搜索文件和聊天' }).first().click()

    const menu = page.locator('.thread-composer-attach-menu')
    const searchInput = page.locator('.thread-composer-attach-search-input')
    assert.equal(await menu.count(), 1)
    await searchInput.fill('package.json')
    const result = page.locator('.thread-composer-attach-search-result').filter({ hasText: 'package.json' }).first()
    await result.waitFor({ timeout: 15_000 })
    assert.equal(searchRequests.length, 1)
    await page.waitForTimeout(2500)
    const searchScreenshot = path.join(outputDir, `tui-file-search-results-${theme}-${viewport.width}.png`)
    await page.screenshot({ path: searchScreenshot, fullPage: true })

    await result.click()
    await page.locator('.thread-composer-file-chip', { hasText: 'package.json' }).waitFor()
    assert.equal(await menu.count(), 0)

    await page.locator('.thread-composer-attach-trigger').click()
    await page.locator('.thread-composer-attach-item').filter({ hasText: '搜索文件和聊天' }).first().click()
    await searchInput.press('Escape')
    assert.equal(await menu.count(), 1)
    assert.equal(await searchInput.count(), 0)
    await page.mouse.click(10, 80)
    assert.equal(await menu.count(), 0)

    await page.waitForTimeout(2500)
    const chipScreenshot = path.join(outputDir, `tui-file-search-chip-${theme}-${viewport.width}.png`)
    await page.screenshot({ path: chipScreenshot, fullPage: true })

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    assert.equal(overflow, false)
    assert.deepEqual(pageErrors, [])
    return { url, viewport, theme, fileSearchRequests: searchRequests.length, searchScreenshot, chipScreenshot, overflow }
  } finally {
    await context.close()
  }
}

async function main() {
  if (!projectLabel) throw new Error('Set FILE_SEARCH_TEST_PROJECT_LABEL to an isolated test project label')
  mkdirSync(outputDir, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  })
  try {
    const results = []
    for (const entry of [
      { viewport: { width: 1440, height: 900 }, theme: 'light' },
      { viewport: { width: 375, height: 812 }, theme: 'dark' },
    ]) {
      results.push(await verifyCase(browser, entry.viewport, entry.theme))
    }
    const reportPath = path.join(outputDir, 'tui-file-search-report.json')
    writeFileSync(reportPath, JSON.stringify(results, null, 2))
    process.stdout.write(`PASS ${results.length} file-search layouts; ${reportPath}\n`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
