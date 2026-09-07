const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.UI_PREVIEW_BASE_URL || 'http://127.0.0.1:13511', out = path.resolve(process.env.UI_PREVIEW_OUTPUT_DIR || 'output/playwright/chatgpt-preview');
const id = process.env.UI_PREVIEW_THREAD_ID || JSON.parse(fs.readFileSync(path.join(out, 'thread.json'))).id;
(async () => {
    const actual = (await (await fetch(base + '/codex-api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'thread/read', params: { threadId: id, includeTurns: true } }) })).json()).result.thread;
    const browser = await chromium.launch({ headless: true });
    const reports = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }])
        for (const theme of ['light', 'dark']) {
            const context = await browser.newContext({ viewport, colorScheme: theme });
            await context.addInitScript(theme => localStorage.setItem('codex-web-local.dark-mode.v1', theme), theme);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            const queue = [{ id: 'ui-preview-queue', clientUserMessageId: 'ui-preview-client', input: [{ type: 'text', text: '继续检查手机与电脑的显示效果' }, { type: 'image', url: 'https://example.invalid/attachment.png' }] }];
            let editPayload;
            const turn = { id: 'ui-preview-turn', status: 'completed', items: [{ id: 'preview-user', type: 'userMessage', content: [{ type: 'text', text: '请检查布局、运行状态与长命令的对齐。' }] }, { id: 'preview-agent', type: 'agentMessage', text: '已统一聊天内容的左右边界。下面是运行记录，展开可以查看详情。' }, { id: 'preview-wait', type: 'sleep', durationMs: 1000, status: 'completed' }, { id: 'preview-command', type: 'commandExecution', command: 'node scripts/verify-interface.cjs --desktop --mobile --theme=light,dark --check=alignment,menu,draft-persistence', aggregatedOutput: '布局一致，检查完成。', status: 'completed', exitCode: 0 }, { id: 'preview-agent2', type: 'agentMessage', text: '手机和电脑采用相同的视觉样式，设置面板可以点击外部收起。' }] };
            await page.route('**/*', async (route) => {
                const req = route.request(), u = new URL(req.url());
                const file = u.origin === base ? (u.pathname === '/' ? path.resolve('dist/index.html') : u.pathname.startsWith('/assets/') ? path.resolve('dist' + u.pathname) : null) : null;
                if (file && fs.existsSync(file))
                    return route.fulfill({ path: file });
                if (u.pathname === '/codex-api/native-queue-mode')
                    return route.fulfill({ json: { data: { mode: 'native', settings: { model: 'gpt-6-astra', effort: 'low', serviceTier: null } } } });
                if (u.pathname === '/codex-api/rpc') {
                    const { method, params } = req.postDataJSON();
                    const result = v => route.fulfill({ json: { result: v } });
                    if (method === 'thread/read' || method === 'thread/resume')
                        return result({ thread: { ...actual, historyMode: 'legacy', status: { type: 'idle' }, turns: [turn] }, initialTurnsPage: { data: [{ ...turn, itemsView: 'full' }], nextCursor: null }, model: 'gpt-6-astra', reasoningEffort: 'low', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' });
                    if (method === 'thread/turns/list')
                        return result({ data: [turn], nextCursor: null });
                    if (method === 'thread/items/list')
                        return result({ data: turn.items.map(item => ({ turnId: turn.id, item })), nextCursor: null });
                    if (method === 'thread/queue/list')
                        return result({ data: queue, nextCursor: null });
                    if (method === 'thread/queue/update') {
                        editPayload = params;
                        queue[0].input = params.input;
                        return result({});
                    }
                    if (method === 'thread/queue/start' || method === 'turn/start')
                        throw Error('unexpected write');
                }
                return route.continue();
            });
            await page.goto(base + '/#/thread/' + id);
            await page.locator('.runtime-item').waitFor({ timeout: 15000 }).catch(async (e) => { console.log((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(out, 'runtime-error.png') }); throw e; });
            await page.locator('.native-queue').waitFor();
            await page.waitForTimeout(2500);
            const bounds = await page.evaluate(() => Object.fromEntries(['.thread-composer-shell', '.runtime-item', '.message-row[data-role="assistant"]', '.cmd-row', '.native-queue'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, { x: r.x, width: r.width }]; })));
            const composer = bounds['.thread-composer-shell'];
            for (const [s, r] of Object.entries(bounds)) {
                assert(Math.abs(r.x - composer.x) < 1, `${s} left`);
                assert(Math.abs(r.width - composer.width) < 1, `${s} width`);
            }
            await page.locator('.runtime-item summary').click();
            assert(await page.locator('.runtime-item pre').isVisible());
            await page.locator('.runtime-item summary').click();
            await page.waitForTimeout(2300);
            await page.screenshot({ path: path.join(out, `runtime-${viewport.width}-${theme}.png`) });
            await page.locator('.native-queue').getByRole('button', { name: '编辑', exact: true }).click();
            await page.locator('.native-queue textarea').fill('修改后的排队消息');
            await page.locator('.native-queue').getByRole('button', { name: '保存编辑', exact: true }).click();
            await page.waitForTimeout(400);
            assert(editPayload);
            assert(editPayload.input.some(x => x.type === 'image'), 'editing lost attachment');
            assert(editPayload.input.some(x => x.type === 'text' && x.text === '修改后的排队消息'));
            assert.equal(editPayload.queuedSubmissionId, 'ui-preview-queue');
            assert.deepEqual(errors, []);
            reports.push({ viewport, theme, bounds, attachmentPreserved: true, errors });
            await context.close();
        }
    await browser.close();
    fs.writeFileSync(path.join(out, 'runtime-result.json'), JSON.stringify(reports, null, 2));
    console.log('PASS runtime/queue 4');
})().catch(e => { console.error(e); process.exit(1); });
