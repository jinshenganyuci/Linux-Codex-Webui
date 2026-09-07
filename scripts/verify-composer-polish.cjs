const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const base = process.env.UI_PREVIEW_BASE_URL || 'http://127.0.0.1:13511'
const out = path.resolve('output/playwright/composer-polish')
const smallOnly = process.env.UI_POLISH_SMALL_ONLY === '1'
const live = process.env.LIVE_PREVIEW === '1'
const threadId = JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
fs.mkdirSync(out, { recursive: true })
const within = (r, v) => assert(r && r.x >= 0 && r.y >= 0 && r.x + r.width <= v.width + 1 && r.y + r.height <= v.height + 1, JSON.stringify(r))
async function setup(browser, viewport, theme) {
  const context = await browser.newContext({ viewport, colorScheme: theme, hasTouch: viewport.width < 768, isMobile: viewport.width < 768, serviceWorkers: live ? 'allow' : 'block' })
  await context.addInitScript(theme => localStorage.setItem('codex-web-local.dark-mode.v1', theme), theme)
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  if (!live) await page.route('**/*', route => {
    const url = new URL(route.request().url())
    const file = url.origin === base ? url.pathname === '/' ? path.resolve('dist/index.html') : url.pathname.startsWith('/assets/') ? path.resolve('dist' + url.pathname) : null : null
    return file && fs.existsSync(file) ? route.fulfill({ path: file }) : route.continue()
  })
  return { context, page, errors }
}
;(async () => {
  const browser = await chromium.launch({ headless: true })
  const reports = [], animationReports = []
  const original = (await (await fetch(base + '/codex-api/thread-model-preferences')).json()).data[threadId]
  try {
    for (const viewport of [{width:375,height:812},{width:376,height:694},{width:360,height:568},{width:768,height:1024},{width:1440,height:900}]) {
      for (const theme of ['light', 'dark']) {
        if (smallOnly && viewport.width !== 375) continue
        const { context, page, errors } = await setup(browser, viewport, theme)
        await page.goto(base + '/#/')
        await page.locator('.new-thread-suggestions').waitFor()
        await page.waitForTimeout(2300)
        if (viewport.width === 360) await page.addStyleTag({ content: '.thread-composer-attach-menu button, .thread-composer-attach-menu .search-dropdown-value { font-size:18px !important; }' })
        await page.locator('.thread-composer-attach-trigger').click()
        const menu = page.locator('.thread-composer-attach-menu')
        await menu.waitFor(); await page.waitForTimeout(2300)
        const geometry = await page.evaluate(() => {
          const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom } }
          const label = document.querySelector('.thread-composer-skill-menu-control .search-dropdown-value')
          return { menu:rect('.thread-composer-attach-menu'), shell:rect('.thread-composer-shell'), skills:rect('.thread-composer-skill-menu-control'), permission:document.querySelector('.thread-composer-mobile-permission') ? rect('.thread-composer-mobile-permission') : null, text:label.textContent, textFits:label.scrollWidth <= label.clientWidth + 1, bodyOverflow:document.documentElement.scrollWidth > innerWidth }
        })
        within(geometry.menu, viewport)
        assert(!geometry.bodyOverflow && geometry.textFits && geometry.text.includes('技能'), 'skill label is clipped')
        assert(geometry.skills.width >= geometry.menu.width - 20, 'skill row still has toolbar width')
        if (viewport.width < 768) {
          assert(Math.abs(geometry.menu.x - (viewport.width - geometry.menu.width) / 2) <= 1, 'menu is not centered')
          assert(geometry.menu.x >= 16 && viewport.width - geometry.menu.x - geometry.menu.width >= 15, 'menu touches screen edge')
          assert(geometry.menu.bottom <= geometry.shell.y - 7, 'menu overlaps the composer')
          assert(geometry.permission.bottom <= geometry.skills.y + 1, 'top controls share or overlap a row')
          assert(geometry.skills.height >= 44 && geometry.permission.height >= 44, 'top row is squeezed vertically')
        }
        await page.screenshot({ path:path.join(out,`add-${viewport.width}-${theme}.png`) })
        await menu.locator('.thread-composer-menu-label').click()
        assert(await menu.isVisible(), 'inside click dismisses menu')
        await menu.locator('.thread-composer-skill-menu-control button').click()
        const search = page.locator('.search-dropdown-menu-wrap input')
        await search.waitFor(); await search.fill('menu-layout-check')
        assert(await menu.isVisible(), 'teleported skill picker unmounted')
        await search.press('Escape'); await search.waitFor({state:'hidden'})
        assert(await menu.isVisible(), 'child Escape closes the parent')
        await menu.getByRole('switch', { name:/先问再规划/ }).scrollIntoViewIfNeeded()
        assert.deepEqual(await page.locator('.thread-composer-shell').boundingBox(), {x:geometry.shell.x,y:geometry.shell.y,width:geometry.shell.width,height:geometry.shell.height}, 'scroll moves composer')
        await page.mouse.click(2, 2); assert.equal(await menu.count(), 0)
        const bolt = page.locator('.model-reasoning-trigger-fast-icon')
        await bolt.waitFor()
        assert.equal(await bolt.evaluate(el => getComputedStyle(el).color), 'rgb(249, 115, 22)', 'fast bolt is not orange')
        await page.locator('.thread-composer-attach-trigger').click()
        await page.keyboard.press('Escape'); assert.equal(await menu.count(), 0)
        await page.reload(); await page.locator('.new-thread-suggestions').waitFor(); await page.waitForTimeout(700)
        await page.locator('.thread-composer-attach-trigger').click(); await menu.waitFor()
        within(await menu.boundingBox(), viewport)
        if (viewport.width === 375) {
          await page.setViewportSize({width:375,height:320}); await page.waitForTimeout(300)
          within(await menu.boundingBox(), {width:375,height:320})
          await menu.getByRole('switch', {name:/先问再规划/}).scrollIntoViewIfNeeded()
          within(await menu.getByRole('switch', {name:/先问再规划/}).boundingBox(), {width:375,height:320})
          await page.setViewportSize(viewport); await page.waitForTimeout(300)
          within(await menu.boundingBox(), viewport)
          await page.mouse.click(2, 2)
          await page.locator('.thread-composer-input').fill('第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行')
          await page.locator('.thread-composer-expand').click()
          await page.locator('.thread-composer-attach-trigger').click()
          const skill = menu.locator('.thread-composer-skill-menu-control button')
          await skill.click()
          const fullSearch = page.locator('.search-dropdown-menu-wrap input')
          await fullSearch.waitFor()
          assert(await fullSearch.evaluate(el => {const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}), 'child picker is below fullscreen composer')
          await fullSearch.press('Escape'); await page.keyboard.press('Escape')
          await page.locator('.thread-composer-expand').click()
          await page.locator('.thread-composer-input').fill('')
        }
        assert.deepEqual(errors, [])
        reports.push({ viewport, theme, url:page.url(), geometry, errors })
        await context.close(); console.log('PASS menu', viewport.width, theme)
      }
    }
    for (const theme of (smallOnly ? [] : ['light', 'dark'])) {
      const viewport = {width:375,height:812}
      const { context, page, errors } = await setup(browser, viewport, theme)
      const writes = []
      page.on('request', r => { if (r.url().endsWith('/thread-model-preferences') && r.method() === 'PUT') writes.push(r.postDataJSON()) })
      await page.goto(base + '/#/thread/' + threadId)
      await page.locator('.conversation-item[data-role="assistant"]').first().waitFor(); await page.waitForTimeout(2300)
      await page.locator('.thread-composer-attach-trigger').click()
      const menu = page.locator('.thread-composer-attach-menu')
      await menu.waitFor(); within(await menu.boundingBox(), viewport)
      await menu.getByRole('button', { name:/^会话控制 / }).click(); await page.locator('.native-controls-dialog').waitFor()
      await page.keyboard.press('Escape')
      await page.locator('.model-reasoning-trigger').click()
      const slider = page.getByRole('slider'); await slider.focus(); await page.keyboard.press('End')
      await page.locator('.reasoning-slider.is-ultra').waitFor(); await page.waitForTimeout(800)
      const particles = page.locator('.reasoning-slider-particle'); assert.equal(await particles.count(), 12)
      await slider.evaluate(el => el.blur())
      const snapshot = () => particles.evaluateAll(items => items.map(el => { const s = getComputedStyle(el); return {transform:s.transform,opacity:s.opacity,playState:s.animationPlayState,name:s.animationName} }))
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable')
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(x => [x.name,x.value]))
      const beforeMetrics = await metrics(), before = await snapshot(), saved = writes.length
      await page.waitForTimeout(1200)
      const after = await snapshot(), afterMetrics = await metrics()
      assert(before.some((p,i) => p.transform !== after[i].transform && p.opacity !== after[i].opacity), 'particles do not move and shimmer')
      assert.equal(writes.length, saved, 'decorative animation writes preferences')
      assert(after.every(p => p.name.includes('ultra-particle-drift')))
      await page.screenshot({path:path.join(out,`ultra-${theme}.png`)})
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange')) })
      assert((await snapshot()).every(p => p.playState === 'paused'), 'hidden page still animates')
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
      await page.emulateMedia({reducedMotion:'reduce'})
      const reduced = await snapshot(); await page.waitForTimeout(600)
      assert.deepEqual(await snapshot(), reduced)
      assert(reduced.every(p => p.name === 'none'), 'reduced motion still animates')
      await page.emulateMedia({reducedMotion:'no-preference'})
      await slider.focus(); await page.keyboard.press('Home')
      assert.equal(await particles.count(), 0, 'particles remain below Ultra')
      await page.keyboard.press('Escape'); assert.equal(await slider.count(), 0)
      assert.deepEqual(errors, [])
      animationReports.push({theme,url:page.url(),particles:12,before,after,layoutCount:afterMetrics.LayoutCount-beforeMetrics.LayoutCount,styleRecalcCount:afterMetrics.RecalcStyleCount-beforeMetrics.RecalcStyleCount,reducedMotion:true,hiddenPaused:true,extraWrites:writes.length-saved-1,errors})
      await context.close(); console.log('PASS particles', theme)
    }
  } finally {
    if (original) await fetch(base+'/codex-api/thread-model-preferences',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({threadId,...original})})
    await browser.close()
  }
  fs.writeFileSync(path.join(out,smallOnly?'small-viewport-result.json':live?'live-result.json':'result.json'),JSON.stringify({menus:reports,animations:animationReports},null,2))
  console.log('PASS',reports.length,'menus,',animationReports.length,'animation cases')
})().catch(error => { console.error(error); process.exit(1) })
