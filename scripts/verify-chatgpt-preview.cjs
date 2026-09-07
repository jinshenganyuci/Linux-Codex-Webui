const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { existsSync, writeFileSync, readFileSync } = require('node:fs');
const path = require('node:path');
const base = process.env.UI_PREVIEW_BASE_URL || 'http://127.0.0.1:13511';
const threadId = process.env.UI_PREVIEW_THREAD_ID || JSON.parse(readFileSync('output/playwright/chatgpt-preview/thread.json')).id;
const out = path.resolve(process.env.UI_PREVIEW_OUTPUT_DIR || 'output/playwright/chatgpt-preview');
const useBuilt = process.env.LIVE_PREVIEW !== '1';
const reports = [];
function within(box, v, label) { assert(box, label); assert(box.x >= -1 && box.y >= -1 && box.x + box.width <= v.width + 1 && box.y + box.height <= v.height + 1, `${label}: ${JSON.stringify(box)}`); }
(async () => {
    const browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }, { width: 768, height: 1024 }])
        for (const theme of ['light', 'dark']) {
            const label = `${viewport.width}-${theme}`;
            console.log('CHECK', label);
            const context = await browser.newContext({ viewport, colorScheme: theme });
            await context.addInitScript(theme => { localStorage.setItem('codex-web-local.dark-mode.v1', theme); localStorage.setItem('codex-web-local.sidebar-width.v1', '300'); }, theme);
            const page = await context.newPage();
            page.setDefaultTimeout(20000);
            const errors = [];
            const calls = [];
            const responses = [];
            page.on('pageerror', e => errors.push(e.message));
            page.on('request', r => { if (r.url().endsWith('/rpc')) {
                try {
                    calls.push(r.postDataJSON());
                }
                catch { }
            } });
            page.on('response', async (r) => { if (r.url().includes('/codex-api/')) {
                try {
                    const b = await r.body();
                    responses.push({ url: new URL(r.url()).pathname, bytes: b.length, status: r.status() });
                }
                catch { }
            } });
            if (useBuilt)
                await page.route('**/*', route => { const u = new URL(route.request().url()); const file = u.origin === base ? (u.pathname === '/' ? path.resolve('dist/index.html') : u.pathname.startsWith('/assets/') ? path.resolve('dist' + u.pathname) : null) : null; if (file && existsSync(file))
                    return route.fulfill({ path: file }); return route.continue(); });
            await page.goto(base + '/#/thread/' + threadId, { waitUntil: 'domcontentloaded' });
            await page.locator('.conversation-item[data-role="assistant"]').first().waitFor();
            await page.locator('.native-controls-trigger').waitFor({ state: 'attached' });
            await page.waitForTimeout(2500);
            const openControls = async () => { if (viewport.width >= 768)
                await page.locator('.native-controls-trigger').click();
            else {
                await page.locator('.thread-composer-attach-trigger').click();
                await page.locator('.thread-composer-attach-menu').getByRole('button', { name: /^会话控制 / }).click();
            } };
            const initialCalls = calls.slice();
            const geometry = await page.evaluate(() => { const b = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }; return { composer: b('.thread-composer-shell'), message: b('.message-row[data-role="assistant"]'), list: b('.conversation-list'), main: b('.desktop-main'), overflow: document.documentElement.scrollWidth > innerWidth, background: getComputedStyle(document.querySelector('.thread-composer-shell')).backgroundColor }; });
            assert(!geometry.overflow, 'page horizontal overflow');
            assert(Math.abs(geometry.composer.x - geometry.message.x) <= 1, `left alignment ${JSON.stringify(geometry)}`);
            assert(Math.abs(geometry.composer.width - geometry.message.width) <= 1, 'right alignment');
            const l = geometry.composer.x - geometry.main.x;
            const r = geometry.main.x + geometry.main.width - geometry.composer.x - geometry.composer.width;
            assert(Math.abs(l - r) <= 1, 'symmetric margins');
            within(geometry.composer, viewport, 'composer');
            await page.screenshot({ path: path.join(out, `chat-${label}.png`) });
            await openControls();
            await page.locator('.native-controls-dialog').waitFor();
            await page.waitForTimeout(2300);
            within(await page.locator('.native-controls-dialog').boundingBox(), viewport, 'native dialog');
            assert.deepEqual(await page.locator('.thread-composer-shell').boundingBox(), geometry.composer, 'opening moves composer');
            await page.screenshot({ path: path.join(out, `controls-${label}.png`) });
            await page.getByRole('button', { name: '目标', exact: true }).click();
            const objective = page.getByTestId('native-goal-objective');
            await objective.fill('保留这份目标草稿，不执行也不保存');
            await page.locator('.native-controls-heading h2').click();
            assert(await objective.isVisible(), 'inside click closes');
            await page.locator('.native-controls-overlay').click({ position: { x: 2, y: 2 } });
            await page.locator('.native-controls-dialog').waitFor({ state: 'hidden' });
            assert.equal(await page.locator('.native-controls-dialog').count(), 0, 'outside dismiss');
            await openControls();
            await page.getByRole('button', { name: '目标', exact: true }).click();
            assert.equal(await objective.inputValue(), '保留这份目标草稿，不执行也不保存', 'draft lost');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.native-controls-dialog').count(), 0, 'Esc dismiss');
            assert(await page.locator(viewport.width >= 768 ? '.native-controls-trigger' : '.thread-composer-attach-trigger').evaluate(el => el === document.activeElement), 'focus restore');
            await page.locator('.thread-composer-attach-trigger').click();
            await page.locator('.thread-composer-attach-menu').waitFor();
            within(await page.locator('.thread-composer-attach-menu').boundingBox(), viewport, 'add menu');
            await page.screenshot({ path: path.join(out, `add-${label}.png`) });
            await page.locator('.thread-composer-attach-menu').getByRole('button', { name: /^目标 / }).click();
            assert(await objective.isVisible(), 'plus goal entry');
            await page.keyboard.press('Escape');
            // Real permission list is read only. Its teleported popup must not dismiss the parent.
            if (viewport.width >= 768)
                await page.locator('.thread-composer-permission-control').click();
            else {
                await openControls();
                await page.getByRole('button', { name: '运行与权限', exact: true }).click();
            }
            await page.getByTestId('native-permission-picker').locator('button').click();
            const search = page.locator('.composer-dropdown-menu-wrap input');
            await search.last().fill('read');
            assert(await page.locator('.native-controls-dialog').isVisible(), 'teleported submenu closes dialog');
            await page.keyboard.press('Escape');
            assert(await page.locator('.native-controls-dialog').isVisible(), 'first Esc should close submenu only');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.composer-dropdown-menu-wrap').count(), 0, 'second Esc closes cleared submenu');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('.native-controls-dialog').count(), 0);
            if (viewport.width >= 768) {
                await page.locator('.model-reasoning-trigger').click();
                await page.locator('.model-reasoning-layer').waitFor();
                await page.waitForTimeout(2300);
                within(await page.locator('.model-reasoning-layer').boundingBox(), viewport, 'model');
                await page.screenshot({ path: path.join(out, `model-${label}.png`) });
                await page.mouse.click(geometry.message.x, 150);
            }
            else {
                await page.locator('.thread-composer-mobile-settings-trigger').click();
                await page.locator('.thread-composer-mobile-settings-sheet').waitFor();
                await page.waitForTimeout(2300);
                within(await page.locator('.thread-composer-mobile-settings-sheet').boundingBox(), viewport, 'mobile settings');
                await page.screenshot({ path: path.join(out, `model-${label}.png`) });
                await page.locator('.thread-composer-mobile-settings-close').click();
            }
            await page.goto(base + '/#/', { waitUntil: 'domcontentloaded' });
            await page.locator('.new-thread-suggestions').waitFor();
            await page.waitForTimeout(2300);
            await page.screenshot({ path: path.join(out, `home-${label}.png`) });
            await page.locator('.new-thread-suggestions button').first().click();
            assert((await page.locator('.thread-composer-input').inputValue()).includes('目录结构'), 'suggestion does not fill draft');
            assert.equal(calls.filter(x => x.method === 'turn/start').length, 0, 'UI interactions unexpectedly send');
            assert.deepEqual(errors, [], 'page errors');
            reports.push({ label, url: base + '/#/thread/' + threadId, geometry, initialRpc: initialCalls.map(c => c.method), apiRequests: responses.length, apiKB: Math.round(responses.reduce((n, r) => n + r.bytes, 0) / 1024), errors });
            await context.close();
        }
    await browser.close();
    writeFileSync(path.join(out, useBuilt ? 'verify-result.json' : 'live-result.json'), JSON.stringify(reports, null, 2));
    console.log('PASS', reports.length);
})().catch(e => { console.error(e); process.exit(1); });
