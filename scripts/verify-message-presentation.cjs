const { chromium } = require('playwright')
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const base='http://127.0.0.1:13511',out=path.resolve('output/playwright/message-presentation')
const fixture=JSON.parse(fs.readFileSync(path.join(out,'thread.json'))), live=process.env.LIVE_PREVIEW==='1'
const color=theme=>theme==='dark'?'rgb(108, 182, 255)':'rgb(9, 105, 218)'
const expectedLinks=[['查看项目文档','https://example.com/project?source=chat&view=code','https://example.com/project?source=chat&view=code'],['打开资源页面','https://example.com/download','https://example.com/download'],['验收说明','/codex-local-browse'+fixture.localFile,fixture.localFile]]
async function rpc(method,params={}) {const r=await(await fetch(base+'/codex-api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})})).json();if(r.error)throw Error(r.error.message);return r.result}
;(async()=>{
 const thread=(await rpc('thread/read',{threadId:fixture.threadId,includeTurns:true})).thread
 assert.equal(thread.status.type,'idle','Wait for the real TestChat reply before UI verification')
 const reply=thread.turns.flatMap(t=>t.items).filter(i=>i.type==='agentMessage'&&i.text?.includes(fixture.marker+'_END')).at(-1)
 assert(reply,'TestChat must contain the real completed assistant reply')
 const expectedCode=[...reply.text.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm)].map(m=>m[1].replace(/\n$/,''))
 assert(expectedCode.length>=5)
 const browser=await chromium.launch({headless:true}),results=[]
 try {
  for(const viewport of [{width:1440,height:1000},{width:375,height:812},{width:768,height:1024}])for(const theme of ['light','dark']) {
   const context=await browser.newContext({viewport,colorScheme:theme,hasTouch:viewport.width<768,isMobile:viewport.width<768,permissions:['clipboard-read','clipboard-write'],serviceWorkers:live?'allow':'block'})
   await context.addInitScript(theme=>localStorage.setItem('codex-web-local.dark-mode.v1',theme),theme)
   // Opening the external link verifies navigation without contacting an external website.
   await context.route('https://example.com/**',r=>r.fulfill({contentType:'text/html',body:'<title>Navigation verified</title>External link target verified'}))
   if(!live)await context.route(base+'/**',r=>{const u=new URL(r.request().url()),f=u.pathname==='/'?path.resolve('dist/index.html'):u.pathname.startsWith('/assets/')?path.resolve('dist'+u.pathname):null;return f&&fs.existsSync(f)?r.fulfill({path:f}):r.continue()})
   const page=await context.newPage(),errors=[],api=[],requests=[]
   page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{requests.push(r.url());if(r.url().endsWith('/codex-api/rpc'))api.push(r.postDataJSON()?.method)})
   await page.goto(`${base}/#/thread/${fixture.threadId}`,{waitUntil:'domcontentloaded'})
   const row=page.locator('.conversation-item[data-role="assistant"]').filter({hasText:fixture.marker+'_END'}).last()
   await row.waitFor();await row.locator('.message-code-block .hljs-attr').first().waitFor()
   const links=[]
   for(const [text,href,title] of expectedLinks) {
    const link=row.getByRole('link',{name:text,exact:true});assert.equal(await link.count(),1)
    const actual=await link.evaluate(el=>({href:el.getAttribute('href'),title:el.getAttribute('title'),text:el.textContent.trim(),color:getComputedStyle(el).color,target:el.target,rel:el.rel}))
    const result={hrefOk:actual.href===href,titleOk:actual.title===title,textOk:actual.text===text,colorOk:actual.color===color(theme),targetOk:actual.target==='_blank',relOk:actual.rel==='noopener noreferrer'}
    assert(Object.values(result).every(Boolean),JSON.stringify({actual,result}));links.push(result)
   }
   const local=row.getByRole('link',{name:'验收说明',exact:true})
   const [localPage]=await Promise.all([context.waitForEvent('page'),local.click()]);await localPage.waitForLoadState('domcontentloaded');assert((await localPage.locator('body').innerText()).includes('Message presentation fixture'));await localPage.close()
   const [externalPage]=await Promise.all([context.waitForEvent('page'),row.getByRole('link',{name:'查看项目文档',exact:true}).click()]);await externalPage.waitForLoadState('domcontentloaded');assert.equal(new URL(externalPage.url()).pathname,'/project');await externalPage.close()
   const blocks=row.locator('.message-code-block');assert.equal(await blocks.count(),5)
   const languages=await blocks.locator('.message-code-language').allTextContents();assert.deepEqual(languages,['YAML','Bash','JSON','unknownlang','代码'])
   const yaml=blocks.nth(0),code=yaml.locator('code'),original=await code.textContent()
   assert(original.includes('readable-'.repeat(25)))
   assert(await yaml.locator('pre').evaluate(n=>n.scrollWidth>n.clientWidth),'Long line must scroll inside code')
   assert(await yaml.locator('pre').evaluate(n=>getComputedStyle(n).whiteSpace)==='pre')
   const copyResults=[],beforeControls=api.length
   for(let i=0;i<5;i++) {
    const block=blocks.nth(i),copy=block.locator('[data-message-code-copy]'),text=await block.locator('code').textContent()
    // Copy preserves the exact fenced source, including leading spaces.
    const expected=expectedCode[i]
    assert.equal(text,expected)
    if(viewport.width<768)await copy.tap();else await copy.click()
    await page.waitForFunction(el=>el.dataset.copied==='true',await copy.elementHandle())
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),text)
    const box=await copy.boundingBox();if(viewport.width<768)assert(box.width>=44&&box.height>=44)
    copyResults.push({language:languages[i],sourceExact:true,clipboardExact:true})
   }
   const wrap=yaml.locator('[data-message-code-wrap]')
   if(viewport.width<768)await wrap.tap();else {await wrap.focus();await page.keyboard.press('Enter')}
   assert.equal(await wrap.getAttribute('aria-pressed'),'true')
   assert.equal(await yaml.locator('pre').evaluate(n=>getComputedStyle(n).whiteSpace),'pre-wrap')
   assert(await yaml.locator('pre').evaluate(n=>n.scrollWidth<=n.clientWidth+1))
   assert.equal(await code.textContent(),original)
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Page must not overflow horizontally')
   assert.equal(await blocks.nth(3).locator('code span').count(),0,'Unknown-language HTML remains literal text')
   const inline=await row.locator('.message-inline-code').first().evaluate(n=>({background:getComputedStyle(n).backgroundColor,font:getComputedStyle(n).fontFamily}))
   assert(!['transparent','rgba(0, 0, 0, 0)'].includes(inline.background))
   const themeStyles=await yaml.evaluate(n=>({background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color,headerBackground:getComputedStyle(n.querySelector('.message-code-header')).backgroundColor,radius:getComputedStyle(n).borderRadius}))
   assert.equal(themeStyles.background,theme==='dark'?'rgb(32, 34, 40)':'rgb(245, 245, 245)')
   await yaml.scrollIntoViewIfNeeded();await page.waitForTimeout(2300)
   const codeScreenshot=path.join(out,`code-${viewport.width}-${theme}.png`);await page.screenshot({path:codeScreenshot})
   await wrap.click();assert.equal(await wrap.getAttribute('aria-pressed'),'false')
   // Each block controls its own wrapping without changing the other blocks.
   const nestedWrap=blocks.nth(2).locator('[data-message-code-wrap]');await nestedWrap.click();assert.equal(await nestedWrap.getAttribute('aria-pressed'),'true')
   assert.equal(api.slice(beforeControls).filter(m=>/^(turn\/|thread\/settings|config\/batchWrite)/.test(m)).length,0)
   await row.getByRole('link',{name:'查看项目文档',exact:true}).scrollIntoViewIfNeeded();await page.waitForTimeout(2300)
   const linkScreenshot=path.join(out,`links-${viewport.width}-${theme}.png`);await page.screenshot({path:linkScreenshot})
   if(viewport.width===375&&theme==='light')await page.screenshot({path:path.resolve('output/playwright/testchat-message-presentation-cjs.png')})
   await page.reload({waitUntil:'domcontentloaded'});await row.waitFor();assert.equal(await row.getByRole('link',{name:'打开资源页面',exact:true}).evaluate(n=>getComputedStyle(n).color),color(theme))
   assert.deepEqual(errors,[])
   const highlightLoads=requests.filter(u=>/common-[^/]+\.js/.test(u)).length
   results.push({url:page.url(),viewport,theme,links,copyResults,languages,themeStyles,inline,wrapExact:true,afterRefreshBlue:true,highlightLoads,errors,screenshots:[linkScreenshot,codeScreenshot]})
   await context.close();console.log('PASS',viewport.width,theme)
  }
 } finally {await browser.close()}
 fs.writeFileSync(path.join(out,live?'live-result.json':'build-result.json'),JSON.stringify(results,null,2));console.log('PASS',results.length,'TestChat cases')
})().catch(e=>{console.error(e.stack);process.exitCode=1})
