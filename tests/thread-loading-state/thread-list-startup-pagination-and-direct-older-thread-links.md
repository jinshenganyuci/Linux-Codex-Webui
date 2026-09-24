### Thread list startup pagination and direct older-thread links

#### 2026-09-24：无浏览器缓存的实时索引查询

**问题与实现：** 原生 `thread/list` 默认会扫描 JSONL 历史来修复元数据。同一份正式规模的隔离副本中，连续查询各读取约 555 MB，耗时 6.05 秒和 5.41 秒。WebUI 现在对普通列表请求传入 Codex 原生的 `useStateDbOnly: true`，读取实时维护的状态索引；不增加浏览器列表缓存，不替换分页游标，不自己实现一套数据库。显式 `false` 仍允许维护操作修复元数据。

**前置条件：** 使用独立 13511 与隔离 CODEX_HOME，准备足够数量的真实历史副本；本轮为 755 个活动、78 个归档会话文件，活动历史约 3.6 GB。保留正式配置、会话和服务；不可把正式目录直接作为测试写入目标。核对实际 CLI：本轮 0.154.0；0.153.4 的本机协议 schema 也明确包含该参数。

**操作：**
1. 构建后启动 13511，用全新的浏览器上下文访问首页，确认初始 Cookie、localStorage 为空；禁用 HTTP 缓存和 Service Worker。
2. 运行 `STARTUP_BASELINE=1 STARTUP_THREAD_ID=<同一个旧会话> node scripts/verify-fresh-startup.cjs`。脚本只在浏览器请求中显式传入 `useStateDbOnly: false`，重放旧查询；服务端、数据和前端保持相同。
3. 运行 `STARTUP_THREAD_ID=<同一个旧会话> node scripts/verify-fresh-startup.cjs`，检查首页明暗主题、旧对话直接链接、375×812 手机深色模式。手机先确认历史已显示，再打开真实侧栏核对列表。
4. 运行 `STARTUP_SEND=1 STARTUP_CASE=home-light node scripts/verify-fresh-startup.cjs`，发送唯一测试标记；确认真实助手回复，再用新的空浏览器直接打开创建的会话。
5. 对独立测试会话执行重命名、归档、恢复和删除，逐次查询索引列表，确认状态立即变化；检查两页 ID 无重复、游标保持原生格式。对外部导入场景分别比较原扫描与索引结果，避免把既有导入依赖问题误报为本次回归。

**预期：** 无缓存首页与旧对话均可快速使用；普通查询不会反复读取数百 MB 的历史。数据保持真实可更新，不能以静态列表、返回空数据、隐藏加载文案或忽略错误作为通过条件。分别记录输入框可输入、可发送、侧栏出现、历史出现以及模型回复耗时，不能把模型生成时间算作页面启动时间。一次真实对话会触发状态刷新，须区分启动首屏请求与对话过程中的请求。

**本轮证据：** `output/playwright/startup-investigation/native-baseline.json`、`native-index-only.json`、`native-index-parity.json`；浏览器请求与截图在 `output/playwright/fresh-startup/`。原生索引查询首次约 170 ms，后续 10.71/15.06 ms；与原扫描查询的活动 85 条、归档 52 条可见会话 ID、顺序、标题和历史模式一致。少量时间字段在副本的索引与历史文件间存在差异，未影响排序；没有声称所有字段逐字节相同。

**浏览器实测：** 同服务、同数据、同前端，全部新上下文且禁用缓存。最终桌面明/暗首页列表由 7.11/11.72 秒降至 0.80/0.81 秒；同一旧对话桌面由 13.27 秒降至 1.03 秒，375×812 深色手机由 11.45 秒降至 0.85 秒。新对话可发送约 0.78 秒，点击后 3.67 秒收到真实标记回复；另一个空浏览器约 0.99 秒打开新对话历史。此为本机 13511 样本，不代表外网传输或模型生成延迟的保证。首页首屏查询一次；旧对话恢复后会有第二次状态刷新，未把这个既有刷新行为宣称为已消除。新消息过程中的事件刷新另计。

**功能复核：** 索引能立即反映重命名、归档、恢复和删除；原生两页 50/36 条无重复。本机没有 `sqlite3` 命令，原有 ZIP 导入注册失败；同一导入数据在原扫描和索引查询下均不可见，因此没有把该项记为通过，也未将导入修复混入本次性能修改。临时增加的导入修复调用已移除，最终产品改动仅涉及列表读取模式。

**验证命令：** `pnpm run test:unit`：70 文件、682 项通过；`pnpm run build`：前端类型检查与前后端构建通过。CJS 公共 CLI 验证：`node -e "process.argv=['node','dist-cli/index.js','--help']; import('./dist-cli/index.js')"`，退出码 0，输出 CLI 帮助。

**认证与截图：** `http://127.0.0.2:13511/#/` 不满足本地 Host 免登录条件，用初始 Cookie 为空的新上下文完成真实密码登录，1440×900 深色模式通过；自动登录步骤约 0.60 秒，登录后列表约 0.50 秒。密码仅通过测试进程环境传入，不写入脚本、报告或截图。桌面浅色 `http://127.0.0.1:13511/#/` 的截图为 `/root/.local/share/linux-codex-webui/worktrees/perf-startup-20260924/output/playwright/fresh-startup/after-home-light.png`；认证深色截图为同目录 `after-home-dark-127.0.0.2.png`。手机 URL 与具体旧会话 ID、375×812 视口、断言和绝对截图路径见 `after.json`；两种主题均检查实际根节点主题，页面错误为零。

![无缓存首页浅色验收](../../output/playwright/fresh-startup/after-home-light.png)

![无 Cookie 重新认证后的深色首页](../../output/playwright/fresh-startup/after-home-dark-127.0.0.2.png)

**清理或回滚：** 删除本轮独立测试会话和导入项目；保留真实历史原件。13511 的测试覆盖配置放在 `/run/systemd/system/codex-webui-13511.service.d/zzzzzz-startup-acceptance.conf`，恢复原验收实例时仅移除此文件、执行 `systemctl daemon-reload` 并重启 13511。正式 13510 不在此步骤中重启或发布。若撤回代码，回退索引参数即可，无浏览器缓存格式迁移。

#### Feature/Change Name
Thread loading uses a smaller initial list page, hydrates later pages in the background, and direct thread URLs are not rejected just because the thread is outside the first page.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`).
2. Browser developer tools Network panel open with `Preserve log` enabled; clear the log immediately before the test.
3. More than 150 existing threads, including a known valid thread outside the first 50 and a second known thread outside the first 150.
4. Record both older thread ids and titles before starting. Ensure no turn is actively running for the initial pagination check.

#### Steps
1. Open the app home route and filter Network requests by RPC payload method `thread/list`.
2. Inspect the first `thread/list` request body. Verify `archived` is `false`, `limit` is `50`, and `cursor` is `null`.
3. Wait 9 seconds without using a force-refresh action. Verify the startup window contains exactly one request for `(cursor: null, limit: 50)` and no duplicate first-page request is in flight.
4. After the first-page response completes, wait through two complete 10-second pagination intervals plus each response time, or continue until a page returns `nextCursor: null`. Inspect each later `thread/list` request in order: each uses `limit: 100`, and its `cursor` exactly equals the non-null `nextCursor` returned by the preceding page.
5. Group the recorded requests by `(cursor, limit)` and verify every pair occurs once, no two background `thread/list` requests overlap, and pagination stops when the response returns `nextCursor: null`.
6. Verify the sidebar gains the known thread titles as their pages complete, contains each thread only once, and preserves descending recency order across merged pages.
7. Open a fresh browser page/context so no in-memory thread list is retained, clear its Network log, and navigate directly to `/#/thread/<older-thread-id>` for a valid thread outside the first 50 without first visiting Home.
8. Verify the route remains on that id, its messages load through a thread detail request, and it is not redirected to Home merely because the first page did not contain it.
9. In a separate run, start a disposable turn and reload while it is active. After the first-page response supplies a non-null `nextCursor`, wait more than 10 seconds and verify no background cursor request is issued during the active turn. Stop or complete the turn, then verify the retained next cursor is requested exactly once.

#### Expected Results
- The first `thread/list` request uses `limit: 50`, and concurrent/repeated non-forced startup consumers coalesce or reuse the recent result instead of issuing duplicate first-page requests.
- Later pages load serially in the background with `limit: 100`, using each returned `nextCursor` exactly once until `null`.
- The sidebar gains older threads as pages complete without duplicate rows and remains sorted by recency.
- Background pagination pauses while a turn is active and resumes once with the retained cursor after the active work ends.
- A direct older-thread URL stays on the requested route and loads messages instead of redirecting Home.

#### Rollback/Cleanup
- Stop or complete any disposable active turn used for the pause/resume check.
- Delete only test threads created to exceed the page boundaries; otherwise no persistent state is changed.

---
