const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const base='http://127.0.0.1:13511',out=path.resolve('output/playwright/thread-fast')
const a=JSON.parse(fs.readFileSync('output/playwright/chatgpt-preview/thread.json')).id
const b=JSON.parse(fs.readFileSync('output/playwright/message-presentation/thread.json')).threadId
fs.mkdirSync(out,{recursive:true})
async function json(url,method='GET',body){const r=await fetch(base+url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok||value.error)throw Error(value.error?.message||value.error||r.status);return value}
async function rpc(method,params={}){return(await json('/codex-api/rpc','POST',{method,params})).result}
const toggle=p=>p.locator('.thread-composer-attach-menu [role=switch]').filter({hasText:/快速模式|Fast mode/})
async function openPlus(p){if(!await p.locator('.thread-composer-attach-menu').isVisible())await p.locator('.thread-composer-attach-trigger').click();await toggle(p).waitFor()}
async function state(p,fast){await p.waitForFunction(fast=>{const b=[...document.querySelectorAll('.thread-composer-attach-menu [role=switch]')].find(n=>/快速模式|Fast mode/.test(n.textContent));return b&&!b.disabled&&b.getAttribute('aria-checked')===String(fast)},fast);if(fast)await p.locator('.model-reasoning-trigger-fast-icon').waitFor()}
async function select(p,id){await p.evaluate(id=>{location.hash=id?'#/thread/'+id:'#/'},id);await p.waitForTimeout(250);await openPlus(p)}
;(async()=>{
 const prefs=(await json('/codex-api/thread-model-preferences')).data
 const original={a:prefs[a],b:prefs[b]}
 const beforeConfig=(await rpc('config/read',{includeLayers:false})).config.service_tier??null
 for(const id of [a,b]){const t=(await rpc('thread/read',{threadId:id,includeTurns:false})).thread;assert(['idle','notLoaded'].includes(t.status.type))}
 const fallback={model:'gpt-6-astra',reasoningEffort:'low'}
 const browser=await chromium.launch({headless:true}),report={cases:[],patches:[],globalWrites:0,pageErrors:[],turnStarts:0}
 async function patch(id,mode){await json('/codex-api/thread-model-preferences','PATCH',{threadId:id,...fallback,speedMode:mode})}
 async function setup(viewport,theme){const c=await browser.newContext({viewport,colorScheme:theme,isMobile:viewport.width<768,hasTouch:viewport.width<768,serviceWorkers:'block'});await c.addInitScript(theme=>localStorage.setItem('codex-web-local.dark-mode.v1',theme),theme);const p=await c.newPage();p.on('pageerror',e=>report.pageErrors.push(e.message));p.on('request',r=>{if(r.url().endsWith('/thread-model-preferences')&&r.method()==='PATCH')report.patches.push(r.postDataJSON());if(r.url().endsWith('/codex-api/rpc')){const m=r.postDataJSON()?.method;if(m==='config/batchWrite')report.globalWrites++;if(m==='turn/start'||m==='startThreadWithTurn')report.turnStarts++}});await p.goto(`${base}/#/thread/${a}`,{waitUntil:'domcontentloaded'});await p.locator('.conversation-item[data-role=assistant]').first().waitFor();await p.waitForFunction(()=>document.querySelector('.model-reasoning-trigger')?.textContent.includes('Astra'));await openPlus(p);return{c,p}}
 try{
  await patch(a,'standard');await patch(b,'standard')
  const first=await setup({width:1440,height:900},'light');await state(first.p,false)
  await toggle(first.p).click();await state(first.p,true);assert.equal(report.patches.length,1);assert.equal(report.patches[0].threadId,a)
  await select(first.p,b);await state(first.p,false);await select(first.p,a);await state(first.p,true)
  await first.p.reload({waitUntil:'domcontentloaded'});await first.p.locator('.conversation-item[data-role=assistant]').first().waitFor();await openPlus(first.p);await state(first.p,true);await first.c.close()
  for(const viewport of [{width:1440,height:900},{width:375,height:812},{width:768,height:1024}])for(const theme of ['light','dark']){
   const {c,p}=await setup(viewport,theme);await state(p,true)
   await p.reload({waitUntil:'domcontentloaded'});await p.locator('.conversation-item[data-role=assistant]').first().waitFor();await openPlus(p);await state(p,true)
   assert((await toggle(p).innerText()).includes('仅当前会话，刷新后保留'))
   await toggle(p).scrollIntoViewIfNeeded();await p.waitForTimeout(2300)
   const screenshot=path.join(out,`a-fast-${viewport.width}-${theme}.png`);await p.screenshot({path:screenshot})
   await select(p,b);await state(p,false);await p.waitForTimeout(2300)
   const secondScreenshot=path.join(out,`b-standard-${viewport.width}-${theme}.png`);await p.screenshot({path:secondScreenshot})
   await select(p,'');await state(p,false);assert((await toggle(p).innerText()).includes('仅此新会话'))
   await toggle(p).click();await state(p,true);await select(p,b);await state(p,false);await select(p,'');await state(p,false)
   report.cases.push({urlA:`${base}/#/thread/${a}`,urlB:`${base}/#/thread/${b}`,viewport,theme,afterReloadA:'fast',b:'standard',nextNewChat:'standard',screenshots:[screenshot,secondScreenshot]})
   await c.close();console.log('PASS',viewport.width,theme)
  }
  const delayed=await setup({width:375,height:812},'dark');await state(delayed.p,true)
  let finish
  await delayed.p.route('**/thread-model-preferences',async route=>{if(route.request().method()==='PATCH'&&route.request().postDataJSON().threadId===a){await new Promise(r=>{finish=r});await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'THREAD_SPEED_TEST_FAILURE'})})}else await route.continue()})
  await toggle(delayed.p).click();await delayed.p.waitForTimeout(100);assert(finish)
  await select(delayed.p,b);await state(delayed.p,false);await toggle(delayed.p).click();await state(delayed.p,true)
  finish();await delayed.p.waitForTimeout(400);await state(delayed.p,true)
  await select(delayed.p,a);await state(delayed.p,true)
  await delayed.p.unroute('**/thread-model-preferences');await toggle(delayed.p).click();await state(delayed.p,false)
  await delayed.p.reload({waitUntil:'domcontentloaded'});await delayed.p.locator('.conversation-item[data-role=assistant]').first().waitFor();await openPlus(delayed.p);await state(delayed.p,false)
  const after=(await json('/codex-api/thread-model-preferences')).data
  assert.equal(after[a].speedMode,'standard');assert.equal(after[b].speedMode,'fast');await delayed.c.close()
  assert.equal(report.globalWrites,0);assert.equal(report.turnStarts,0);assert.deepEqual(report.pageErrors,[])
  report.concurrentFailureIsolation=true;report.savedModes={a:after[a].speedMode,b:after[b].speedMode}
 }finally{
  await browser.close()
  // Restore only the two test records; do not replace the complete preference file.
  for(const [id,value]of[[a,original.a],[b,original.b]]){await json('/codex-api/thread-model-preferences?threadId='+encodeURIComponent(id),'DELETE');if(value)await json('/codex-api/thread-model-preferences','PUT',{threadId:id,...value})}
  const restored=(await json('/codex-api/thread-model-preferences')).data;assert.deepEqual(restored[a],original.a);assert.deepEqual(restored[b],original.b)
  assert.equal((await rpc('config/read',{includeLayers:false})).config.service_tier??null,beforeConfig)
  report.originalRecordsRestored=true;report.globalConfigUnchanged=true
  fs.writeFileSync(path.join(out,'live-result.json'),JSON.stringify(report,null,2))
 }
 console.log(JSON.stringify({cases:report.cases.length,globalWrites:report.globalWrites,concurrentFailureIsolation:report.concurrentFailureIsolation,restored:report.originalRecordsRestored}))
})().catch(e=>{console.error(e.stack);process.exitCode=1})
