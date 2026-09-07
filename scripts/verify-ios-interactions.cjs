const { chromium, firefox } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = process.env.UI_PREVIEW_BASE_URL || 'http://127.0.0.1:13511'
const threadId = process.env.UI_PREVIEW_THREAD_ID || JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
const output = path.resolve('output/playwright/ios-preview')
fs.mkdirSync(output, { recursive: true })
const built = process.env.LIVE_PREVIEW !== '1'
async function setup(browser, viewport, theme, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport, colorScheme: theme, serviceWorkers: built ? 'block' : 'allow', reducedMotion, hasTouch: viewport.width < 768, isMobile: viewport.width < 768 })
  await context.addInitScript(theme => localStorage.setItem('codex-web-local.dark-mode.v1', theme), theme)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  if (built) await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const file = url.origin === base ? url.pathname === '/' ? path.resolve('dist/index.html') : url.pathname.startsWith('/assets/') ? path.resolve('dist' + url.pathname) : null : null
    return file && fs.existsSync(file) ? route.fulfill({ path: file }) : route.continue()
  })
  await page.goto(base + '/#/thread/' + threadId)
  await page.locator('.conversation-item[data-role="assistant"]').first().waitFor({ timeout: 30000 })
  return { context, page, errors }
}
async function open(page) {
  await page.locator('.thread-composer-attach-trigger').tap()
  await page.locator('.thread-composer-attach-menu').getByRole('button', { name: /^会话控制 / }).tap()
  await page.locator('.native-controls-dialog').waitFor()
  await page.waitForTimeout(700)
}
async function drag(page, distance, cancel = false) {
  const handle = page.locator('.native-controls-grabber')
  const box = await handle.boundingBox()
  const client = await page.context().newCDPSession(page)
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= 8; i++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance * i / 8 }] })
    await page.waitForTimeout(20)
  }
  const transform = await page.locator('.native-controls-dialog').evaluate(el => getComputedStyle(el).transform)
  await page.waitForTimeout(120) // test distance rather than an accidental synthetic velocity spike
  await client.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
  await client.detach()
  return transform
}
(async () => {
  const browser = await chromium.launch({ headless: process.env.UI_PREVIEW_HEADLESS !== 'false', ignoreDefaultArgs: ['--hide-scrollbars'] })
  const reports = []
  for (const theme of (process.env.UI_PREVIEW_SCROLL_ONLY === '1' ? [] : ['light', 'dark'])) {
    console.log('CHECK', theme)
    const { context, page, errors } = await setup(browser, { width: 375, height: 812 }, theme)
    await open(page)
    assert((await page.locator('.native-controls-dialog').evaluate(el => getComputedStyle(el).backdropFilter)).includes('blur(18px)'), 'built CSS must enable the material blur')
    const initialHeight = (await page.locator('.native-controls-dialog').boundingBox()).height
    await drag(page, -100)
    await page.waitForTimeout(700)
    assert.equal(await page.locator('.native-controls-dialog').getAttribute('data-sheet-expanded'), 'true')
    assert((await page.locator('.native-controls-dialog').boundingBox()).height > initialHeight, 'upward drag should expand')
    await page.locator('.native-controls-grabber').tap()
    await page.waitForTimeout(200)
    assert.equal(await page.locator('.native-controls-dialog').getAttribute('data-sheet-expanded'), 'false')
    const transformDuring = await drag(page, 65, true)
    assert.notEqual(transformDuring, 'matrix(1, 0, 0, 1, 0, 0)', 'drag must follow touch')
    await page.waitForTimeout(700)
    assert(await page.locator('.native-controls-dialog').isVisible(), 'cancel closes panel')
    assert.equal(await page.locator('.native-controls-dialog').evaluate(el => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)', 'cancel does not spring back')
    await page.getByRole('button', { name: '目标', exact: true }).tap()
    await page.getByTestId('native-goal-objective').fill('保留目标草稿，关闭不会提交')
    await page.waitForTimeout(2300)
    await page.screenshot({ path: path.join(output, `goal-touch-${theme}.png`) })
    await drag(page, 150)
    await page.locator('.native-controls-dialog').waitFor({ state: 'hidden' })
    await open(page)
    await page.getByRole('button', { name: '目标', exact: true }).tap()
    assert.equal(await page.getByTestId('native-goal-objective').inputValue(), '保留目标草稿，关闭不会提交')
    // A small visual viewport simulates keyboard space, without claiming a real OS keyboard test.
    await page.setViewportSize({ width: 375, height: 450 })
    await page.waitForTimeout(500)
    const small = await page.locator('.native-controls-dialog').boundingBox()
    assert(small.y >= 0 && small.y + small.height <= 450, 'small viewport clips panel')
    await page.setViewportSize({ width: 375, height: 812 })
    await page.keyboard.press('Escape')
    for (let i = 0; i < 3; i++) {
      await page.locator('.thread-composer-attach-trigger').tap()
      await page.locator('.thread-composer-attach-menu').getByRole('button', { name: /^会话控制 / }).tap()
      await page.waitForTimeout(40)
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.native-controls-overlay').count(), 0, 'rapid opening leaves overlay')
    }
    await page.reload()
    await page.locator('.conversation-item[data-role="assistant"]').first().waitFor()
    await page.locator('.native-controls-trigger').waitFor({state:'attached'})
    await page.locator('.thread-composer-attach-trigger').tap()
    await page.locator('.thread-composer-attach-menu').getByRole('button', { name: /^扩展 / }).tap()
    await page.getByTestId('native-extensions').waitFor()
    await page.waitForTimeout(2300)
    await page.screenshot({ path: path.join(output, `extensions-touch-${theme}.png`) })
    await page.getByTestId('native-extensions-close').tap()
    assert.deepEqual(errors, [])
    reports.push({ theme, initialHeight, smallViewport: small, dragFollowsTouch: true, cancelRestores: true, draftPreserved: true, errors })
    await context.close()
  }
  // Force an overflowing sidebar and chat to inspect the real scrollbar styles and wheel behavior.
  for (const theme of ['light', 'dark']) {
    console.log('CHECK', theme)
    const { context, page, errors } = await setup(browser, { width: 1440, height: 1000 }, theme)
    await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar-scrollable')
      for (let i = 0; i < 50; i++) { const row = document.createElement('div'); row.textContent = `滚动条验收 · 会话 ${i + 1}`; row.style.cssText = 'padding:12px 16px;flex-shrink:0'; sidebar.append(row) }
      const list = document.querySelector('.conversation-list')
      for (let i = 0; i < 60; i++) list.append(list.querySelector('.conversation-item').cloneNode(true))
    })
    await page.waitForTimeout(500)
    const before = await page.locator('.thread-composer-shell').boundingBox()
    const sidebar = page.locator('.sidebar-scrollable')
    const sidebarBox = await sidebar.boundingBox()
    assert(!(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('.desktop-resize-handle') !== null,{x:sidebarBox.x+sidebarBox.width-4,y:sidebarBox.y+35})), 'resize target overlaps scrollbar')
    await sidebar.evaluate(el => { el.scrollTop = 0 })
    await page.mouse.move(sidebarBox.x + sidebarBox.width - 4, sidebarBox.y + 35)
    await page.mouse.down()
    await page.mouse.move(sidebarBox.x + sidebarBox.width - 4, sidebarBox.y + 220, { steps: 12 })
    await page.mouse.up()
    assert(await sidebar.evaluate(el => el.scrollTop > 0), 'native scrollbar thumb cannot be dragged')
    await sidebar.hover()
    await page.mouse.wheel(0, 700)
    await page.waitForTimeout(300)
    assert(await sidebar.evaluate(el => el.scrollTop > 0), 'wheel blocked')
    const styles = await sidebar.evaluate(el => ({
      arrow: getComputedStyle(el, '::-webkit-scrollbar-button').display,
      track: getComputedStyle(el, '::-webkit-scrollbar-track').backgroundColor,
      size: getComputedStyle(el, '::-webkit-scrollbar').width,
      radius: getComputedStyle(el, '::-webkit-scrollbar-thumb').borderRadius,
      outerScrolls: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight,
      parentScrolls: el.parentElement.scrollHeight > el.parentElement.clientHeight,
    }))
    assert.equal(styles.arrow, 'none'); assert.equal(styles.track, 'rgba(0, 0, 0, 0)'); assert.equal(styles.size, '8px'); assert.equal(styles.radius, '999px')
    assert(!styles.outerScrolls && !styles.parentScrolls, 'nested outer scrollbar')
    const chat = page.locator('.conversation-list')
    const bar = await chat.boundingBox()
    await page.mouse.move(bar.x + bar.width / 2, bar.y + 100)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(2300)
    assert.deepEqual(await page.locator('.thread-composer-shell').boundingBox(), before, 'scrollbar shifts composer')
    await page.screenshot({ path: path.join(output, `scrollbars-${theme}.png`) })
    await sidebar.screenshot({ path: path.join(output, `scrollbar-detail-${theme}.png`) })
    const resize = await page.locator('.desktop-resize-handle').boundingBox()
    const oldWidth = await page.locator('.desktop-sidebar').evaluate(el => el.getBoundingClientRect().width)
    await page.mouse.move(resize.x + 5, resize.y + 80)
    await page.mouse.down()
    await page.mouse.move(resize.x + 45, resize.y + 80, {steps:8})
    await page.mouse.up()
    assert((await page.locator('.desktop-sidebar').evaluate(el => el.getBoundingClientRect().width)) > oldWidth + 20, 'sidebar resize regressed')
    assert.deepEqual(errors, [])
    reports.push({ theme, scrollbar: styles, thumbDragged: true, sidebarResizeWorks: true, errors })
    await context.close()
  }
  const reduced = await setup(browser, { width: 375, height: 812 }, 'dark', 'reduce')
  await open(reduced.page)
  assert.equal(await reduced.page.locator('.native-controls-dialog').evaluate(el => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)')
  const mediaClient = await reduced.context.newCDPSession(reduced.page)
  await mediaClient.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-reduced-transparency',value:'reduce'},{name:'prefers-color-scheme',value:'dark'}] })
  const material = await reduced.page.locator('.native-controls-dialog').evaluate(el => ({ blur: getComputedStyle(el).backdropFilter, background: getComputedStyle(el).backgroundColor }))
  assert.equal(material.blur, 'none', 'reduced transparency must remove blur')
  assert(!material.background.startsWith('rgba'), 'reduced transparency must be opaque')
  await mediaClient.detach()
  await reduced.page.keyboard.press('Escape')
  assert.equal(await reduced.page.locator('.native-controls-overlay').count(), 0)
  await reduced.context.close()
  await browser.close()
  fs.writeFileSync(path.join(output, process.env.UI_PREVIEW_SCROLL_ONLY === '1' ? 'scroll-only.json' : 'interactions.json'), JSON.stringify({ cases: reports, reducedMotion: true, realHardwareKeyboard: 'not tested', firefoxInstalled: fs.existsSync(firefox.executablePath()) }, null, 2))
  console.log(process.env.UI_PREVIEW_SCROLL_ONLY === '1' ? 'PASS scrollbar dragging, sidebar resizing and reduced motion' : 'PASS iOS touch, spring cancellation, scrollbars, reduced motion')
})().catch(error => { console.error(error); process.exit(1) })
