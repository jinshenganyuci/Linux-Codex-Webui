const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const base = process.env.UI_PREVIEW_BASE_URL || 'http://127.0.0.1:13511'
const out = path.resolve(process.env.UI_PREVIEW_OUTPUT_DIR || 'output/playwright/composer-reference')
const threadId = process.env.UI_PREVIEW_THREAD_ID || JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
const live = process.env.LIVE_PREVIEW === '1'
fs.mkdirSync(out,{recursive:true})
const within = (r,v) => assert(r && r.x>=-1 && r.y>=-1 && r.x+r.width<=v.width+1 && r.y+r.height<=v.height+1,JSON.stringify(r))
;(async()=>{
 const browser=await chromium.launch({headless:true}),results=[]
 const original=(await (await fetch(base+'/codex-api/thread-model-preferences')).json()).data[threadId]
 assert(original,'requires existing acceptance thread model preferences')
 try {
  for(const viewport of [{width:1440,height:900},{width:375,height:812},{width:768,height:1024},{width:376,height:640}]) for(const theme of ['light','dark']) {
   const context=await browser.newContext({viewport,colorScheme:theme,isMobile:viewport.width<768,hasTouch:viewport.width<768,serviceWorkers:live?'allow':'block',reducedMotion:viewport.height===640?'reduce':'no-preference'})
   await context.addInitScript(({theme,threadId})=>{
    localStorage.setItem('codex-web-local.dark-mode.v1',theme)
    localStorage.setItem('codex-web-local.thread-token-usage.v1',JSON.stringify({[threadId]:{last:{totalTokens:24000},total:{totalTokens:35000},modelContextWindow:258000}}))
   },{theme,threadId})
   const page=await context.newPage(),errors=[],writes=[],api=[]
   page.on('pageerror',e=>errors.push(e.message))
   page.on('request',r=>{if(r.url().includes('/codex-api/'))api.push({path:new URL(r.url()).pathname,method:r.method()});if(r.url().endsWith('/thread-model-preferences')&&r.method()==='PUT')writes.push(r.postDataJSON())})
   if(!live)await page.route('**/*',route=>{const u=new URL(route.request().url()),f=u.origin===base?(u.pathname==='/'?path.resolve('dist/index.html'):u.pathname.startsWith('/assets/')?path.resolve('dist'+u.pathname):null):null;return f&&fs.existsSync(f)?route.fulfill({path:f}):route.continue()})
   await page.goto(base+'/#/thread/'+threadId)
   await page.locator('.conversation-item[data-role="assistant"]').first().waitFor()
   const input=page.locator('.thread-composer-input'),trigger=page.locator('.model-reasoning-trigger'),slider=page.getByRole('slider')
   await input.fill('输入框聚焦时没有蓝色光圈')
   const shadow=await page.locator('.thread-composer-shell').evaluate(el=>getComputedStyle(el).boxShadow)
   assert(!shadow.includes('122, 255')&&!shadow.includes('59, 130, 246')&&!shadow.includes('0px 0px 0px 3px'),shadow)
   await input.fill('')
   await trigger.click();await slider.waitFor()
   // Use the actual model picker so capabilities and persistence flow through the app.
   await page.getByRole('button',{name:'选择模型与速度',exact:true}).click()
   await page.locator('.model-reasoning-option').filter({hasText:/^6 Astra/}).click()
   await page.getByRole('button',{name:'返回思考强度'}).click()
   await slider.focus();await page.keyboard.press('Home');await page.waitForTimeout(500)
   let box=await slider.boundingBox(),thumb=await slider.locator('.reasoning-slider-thumb').boundingBox()
   const startX=box.x+thumb.width/2, endX=box.x+box.width-thumb.width/2,y=box.y+box.height/2
   const before=writes.length
   const drag=await context.newCDPSession(page)
   if(viewport.width<768){await drag.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y}]});await drag.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:(startX+endX)/2,y}]})}else{await page.mouse.move(startX,y);await page.mouse.down();await page.mouse.move((startX+endX)/2,y,{steps:8})}
   await page.waitForTimeout(80)
   assert.equal(writes.length,before,'drag writes before release')
   const moving=await slider.locator('.reasoning-slider-thumb').boundingBox();assert(moving.x>box.x+box.width*.2,'thumb does not track pointer')
   if(viewport.width<768){await drag.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:endX,y}]});await drag.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})}else{await page.mouse.move(endX,y,{steps:8});await page.mouse.up()}
   await drag.detach();await page.waitForTimeout(650)
   assert.equal(writes.length,before+1,'one drag should write once')
   assert.equal(writes.at(-1).reasoningEffort,'ultra')
   assert.equal(writes.at(-1).model,'gpt-6-astra','late startup read overwrote the chosen model')
   assert(await slider.evaluate(el=>el.classList.contains('is-ultra')))
   await slider.evaluate(el=>el.blur())
   await page.waitForTimeout(2200)
   const shot=path.join(out,`slider-${viewport.width}-${theme}.png`)
   await page.screenshot({path:shot})
   if(theme==='light' && [1440,375].includes(viewport.width)){const shell=await page.locator('.thread-composer-shell').boundingBox(),layer=await page.locator('.model-reasoning-layer').boundingBox();const x=Math.max(0,Math.min(shell.x,layer.x)-12),y=Math.max(0,Math.min(shell.y,layer.y)-12);await page.screenshot({path:path.join(out,viewport.width===1440?'composer-desktop-light.png':'composer-phone-light.png'),clip:{x,y,width:Math.min(viewport.width-x,Math.max(shell.x+shell.width,layer.x+layer.width)-x+12),height:viewport.height-y}})}
   within(await page.locator('.model-reasoning-layer').boundingBox(),viewport)
   // Pointer cancellation must keep the already saved effort.
   const cancelWrites=writes.length
   const cdp=await context.newCDPSession(page)
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:startX,y,radiusX:1,radiusY:1}]})
   await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]})
   await cdp.detach()
   await page.waitForTimeout(350)
   assert.equal(writes.length,cancelWrites)
   await page.keyboard.press('Escape');assert.equal(await slider.count(),0,'Escape closes')
   await page.reload();await trigger.waitFor();await page.waitForTimeout(600)
   try { await page.waitForFunction(()=>document.querySelector('.model-reasoning-trigger')?.textContent.includes('Ultra'),null,{timeout:10000}) } catch(e) { await page.screenshot({path:path.join(out,'failed-refresh.png')}); console.log('REFRESH',JSON.stringify({text:await trigger.innerText(),writes,stored:(await (await fetch(base+'/codex-api/thread-model-preferences')).json()).data[threadId]})); throw e }
   await trigger.click();await slider.focus();await page.keyboard.press('ArrowLeft');await page.waitForTimeout(350)
   assert.equal(writes.at(-1).reasoningEffort,'max','keyboard should select previous supported effort')
   await page.getByRole('button',{name:'恢复模型默认强度'}).click();await page.waitForTimeout(350)
   assert((await slider.getAttribute('aria-valuetext'))!=='Ultra','reset did not change effort')
   await page.getByRole('button',{name:'选择模型与速度',exact:true}).click()
   await page.waitForTimeout(2300);within(await page.locator('.model-reasoning-layer').boundingBox(),viewport)
   await page.screenshot({path:path.join(out,`models-${viewport.width}-${theme}.png`)})
   await page.locator('.model-config-speed-trigger').click();await page.locator('.model-config-speed-options').waitFor()
   assert.equal(await page.locator('.model-config-speed-options button').count(),2)
   await page.keyboard.press('Escape')
   await page.locator('.model-reasoning-option').filter({hasText:/^5.6 Terra/}).click()
   await page.getByRole('button',{name:'返回思考强度'}).click()
   assert((await trigger.innerText()).includes('5.6 Terra'))
   await page.mouse.click(2,70);assert.equal(await slider.count(),0,'outside click closes')
   // Compact context indicator remains clickable with details.
   const ring=page.locator('.thread-composer-context-button');await ring.click();await page.locator('.thread-composer-context.is-open').waitFor()
   assert((await page.locator('.thread-composer-context-popover').innerText()).includes('24k'))
   await page.keyboard.press('Escape')
   await page.locator('.thread-composer-attach-trigger').click()
   await page.locator('.thread-composer-skill-menu-control .search-dropdown-trigger').click()
   await page.locator('.search-dropdown-menu-wrap').waitFor()
   await page.mouse.click(2,70)
   if(viewport.width>=768){await page.locator('.thread-composer-permission-control .composer-dropdown-trigger').click()}else{
    await page.locator('.thread-composer-attach-trigger').click();await page.locator('.thread-composer-mobile-permission .composer-dropdown-trigger').click()
   }
   await page.locator('.composer-permission-heading').waitFor();await page.waitForTimeout(600)
   assert((await page.locator('.composer-dropdown-menu:has(.composer-permission-heading) .composer-dropdown-option').count())>0)
   await page.waitForTimeout(2200);within(await page.locator('.composer-dropdown-menu:has(.composer-permission-heading)').boundingBox(),viewport);await page.screenshot({path:path.join(out,`permissions-${viewport.width}-${theme}.png`)})
   await page.mouse.click(2,70)
   await page.locator('.thread-composer-attach-trigger').click()
   await page.locator('.thread-composer-attach-menu').getByRole('button',{name:/^会话控制 /}).click()
   await page.locator('.native-controls-dialog').waitFor();await page.waitForTimeout(1200);within(await page.locator('.native-controls-dialog').boundingBox(),viewport)
   await page.keyboard.press('Escape')
   assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'horizontal overflow')
   assert.deepEqual(errors,[])
   results.push({url:page.url(),viewport,theme,contextUsageFixture:true,shadow,writes,apiRequests:api.length,errors,screenshot:shot})
   await context.close();console.log('PASS',viewport.width,theme)
  }
 } finally {
  await fetch(base+'/codex-api/thread-model-preferences',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({threadId,...original})})
  await browser.close()
 }
 fs.writeFileSync(path.join(out,live?'live-result.json':'result.json'),JSON.stringify(results,null,2))
 console.log('PASS',results.length,'reference composer cases')
})().catch(e=>{console.error(e);process.exit(1)})
