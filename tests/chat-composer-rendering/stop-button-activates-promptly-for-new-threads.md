### Stop button activates promptly for new threads

#### Feature/Change Name
The composer stop control switches from the temporary saving spinner to a real stop button as soon as the active turn id is available for a newly created thread.

#### Prerequisites/Setup
1. Isolated acceptance server running at `http://127.0.0.1:13511`
2. Home route available with a writable project/folder selected
3. Codex can start a normal assistant turn

#### Steps
1. Open `http://127.0.0.1:13511/#/`
2. Send a short prompt from the new-thread composer
3. Immediately watch the right-side composer control after routing into the new thread
4. Before the full response finishes, verify the temporary saving spinner transitions into the stop icon/button
5. Click `Stop` while the turn is still running

#### Expected Results
- A new thread may briefly show the saving spinner while the turn starts
- The control becomes an actual stop button as soon as the active turn id is known, without waiting for thread-list persistence
- Clicking stop interrupts the running turn

#### Rollback/Cleanup
- Archive or delete the test thread if it was created only for this check

---

### 2026-09-07：手机停止按钮为正圆

前置条件：独立 13511 和 `output/playwright/chatgpt-preview/thread.json` 中的已完成 TestChat。使用 Playwright 回放该线程的运行状态以展示停止按钮，避免实际发送/中断任务；前端资源可从当前 dist 注入。

```bash
BASELINE=1 node scripts/verify-round-stop-button.cjs
pnpm run build:frontend
node scripts/verify-round-stop-button.cjs
LIVE_PREVIEW=1 SMOKE=1 node scripts/verify-round-stop-button.cjs
```

操作：分别在 1440×900、375×812、768×1024 明暗主题查看真实输入框，测量停止按钮实际宽高、圆角和内部图标中心；临时将页面按钮设置为禁用，再测一次形状，最后恢复。截图前等待 2.3 秒。确认底栏不横向溢出，且不调用 turn/interrupt 或其他写入接口。

预期与结果：旧手机规则为 40×44，修复后为 44×44；桌面和平板为 36×36。六组全部通过，按钮 flex-shrink 为 0，正常和禁用状态宽高一致，圆角至少为半径，图标中心误差小于 1px。停止事件处理未改；本次只验证外观，不执行实际停止。前端类型检查和构建通过。CSS 原始体积 +38 字节、gzip +14，无新增运行时逻辑。

URL：`http://127.0.0.1:13511/#/thread/01a0797c-faa5-70a0-b29e-b4c92c0bb03c`。报告为 `output/playwright/composer-round-stop/browser.json`；截图绝对路径为 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/composer-round-stop/after-{1440,375,768}-{light,dark}.png`，裁取真实输入框以便对比形状。

![手机浅色正圆停止按钮](/root/codex工作目录/Linux-Codex-Webui/output/playwright/composer-round-stop/after-375-light.png)

![手机深色正圆停止按钮](/root/codex工作目录/Linux-Codex-Webui/output/playwright/composer-round-stop/after-375-dark.png)

清理：关闭回放浏览器即可，原线程和配置不变。仅静态发布 13511，保留服务进程，不备份。回退从目标提交重建并发布前端，13510 不参与本次修改。
