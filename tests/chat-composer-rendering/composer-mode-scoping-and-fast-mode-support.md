### Composer mode scoping and Fast mode support

#### Feature/Change Name
Plan mode is scoped to the current chat, persists through the WebUI backend across browsers, and Fast mode is saved globally for all chats in the current WebUI service while following the live Codex model catalog. A one-turn Ask-first option can request structured clarification without changing the thread's saved mode.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two existing threads are available
3. Model list includes `gpt-5.4` or a `gpt-5.4-*` variant and `gpt-5.5` or a `gpt-5.5-*` variant
4. Light theme and dark theme both available from the appearance switcher
5. A second browser profile or private window for cross-browser mode verification

#### Steps
1. In light theme, open thread A, open the composer add menu, and enable Plan mode.
2. Open thread B and confirm Plan mode is off by default.
3. Return to thread A and confirm Plan mode remains on for that thread.
4. Open Start new thread, enable Plan mode, send a first message, and confirm the created thread starts in Plan mode.
5. Return to Start new thread again and confirm Plan mode is off for the next new chat.
6. Refresh thread A and confirm its Plan mode indicator remains on.
7. Open thread A in the second browser profile and confirm the Plan mode indicator is also on there; disable it, refresh the first browser, and confirm the first browser now shows Default mode.
8. Open the composer add menu, enable **Ask first, then plan**, and confirm a removable **Ask first** chip appears while the persistent Plan mode setting remains unchanged.
9. Send a deliberately ambiguous request. Inspect `turn/start` and confirm it uses `collaborationMode.mode = "plan"`, contains one-turn `developer_instructions`, and leaves the visible user message unchanged. Answer the resulting structured questions.
10. Send another ordinary message and confirm the one-turn instructions are absent and the thread still uses its previously saved Default/Plan mode.
11. While a turn is active, enable **Ask first, then plan** and send another prompt; confirm it is queued and retains the one-turn instructions when the backend starts it.
12. Select a model whose current `model/list` entry exposes a Fast service tier, and confirm the Fast mode switch is visible.
13. Select a model whose catalog entry has no Fast service tier and confirm the switch is hidden when Standard mode is active.
14. Confirm a supported model uses its live catalog Fast tier for a new turn (`priority` for Codex 0.153.4 Astra, or `fast` for catalogs that advertise that value).
15. With stale `service_tier = "fast"` configuration on an unsupported model, confirm the switch remains visible only so Fast can be turned off and the model trigger does not show a bolt.
16. Switch to dark theme and repeat the relevant steps at desktop, `375x812`, and `768x1024` viewports.

#### Expected Results
- Enabling Plan mode in one existing thread does not enable it in other existing threads.
- A new-chat Plan mode selection applies to the created chat but does not persist as the default for later new chats.
- Existing-thread mode is stored under `CODEX_HOME`, so refreshes and other browsers use the same authoritative selection; old `localStorage` Plan entries migrate only when no backend state exists.
- **Ask first, then plan** applies to exactly one turn, uses the native collaboration-mode `developer_instructions` field, queues instead of steering an active turn, and never silently changes the thread's saved mode.
- The one-turn instruction asks only for material clarification; a fully specified request may proceed directly to a plan rather than inventing a redundant question.
- Fast mode availability comes from the live `model/list` service-tier metadata instead of model-name matching.
- Native Codex providers can use Fast when their live model catalog exposes a Fast tier for the selected model.
- A stale Fast configuration can always be disabled without falsely showing Fast as effective.
- Composer controls and menus remain readable in light and dark themes.

#### Rollback/Cleanup
- Turn Plan mode off in any test threads if desired.
- Disable any unsent **Ask first** chip; sent one-turn state clears automatically.

---


### 全局快速模式：唯一入口与刷新持久化（2026-09-07）

#### 前置条件
- 使用隔离验收服务 `http://127.0.0.1:13511`，至少一个已完成的 TestChat；不得用正式 13510 做例行测试。
- 准备支持 Fast 的实际模型（例如验收服务中的 Astra），记录原有开关状态，并准备另一浏览器配置或隐身窗口。
- 桌面 1440×900、手机 375×812、平板 768×1024，明暗主题分别检查。

#### 操作与预期
1. 等待已有聊天的实际回复渲染，打开「＋」，开启快速模式。一次点击只发送一次 `config/batchWrite`，服务端持久化 `features.fast_mode = true` 和模型目录提供的 `service_tier`；原生会话设置可用时也必须保存。
2. 刷新页面，再次打开「＋」应保持开启；转到另一聊天或新聊天入口，再打开同一服务的全新浏览器，也应读取开启状态。它不是单个聊天或单个浏览器的偏好。已打开的其他浏览器刷新后读取最新值，不承诺无需刷新即时同步。
3. 点击模型/思考强度入口，再点击模型名称进入配置列表。只提供模型选择、能力说明和完成按钮，不再出现速度选择。Esc 返回强度，再次 Esc 关闭；橙色闪电仍表示当前模型可用且已开启 Fast。
4. 从「＋」关闭 Fast，刷新当前页面和另一浏览器，均应关闭。原生设置不应偷偷覆盖全局偏好；不支持 Fast 的模型仍不得传入不支持的服务等级，已有活动回合和已排队快照不被追溯改写。
5. 延迟旧配置读取，并在返回前开关 Fast；旧读取不得恢复过期状态。写入期间重复点击不重复提交。模拟写入失败，显示错误并回到先前已保存的开关状态，实际配置保持原值。
6. 在上述六组明暗视口检查真实「＋」菜单和模型列表，手机菜单保持居中，无横向溢出，设置文字和开关可达；刷新后截图必须仍能看到 Fast 开启。

#### 自动命令与清理
```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts src/composables/desktop/nativeThreadController.test.ts src/api/codexGateway.test.ts src/components/content/sheetMotion.test.ts src/runtimeItems.test.ts
pnpm run build
node scripts/verify-global-fast-mode.cjs
LIVE_PREVIEW=1 node scripts/verify-global-fast-mode.cjs
```

浏览器脚本直接使用 Playwright，以便设置主题 localStorage、拦截尚未发布的构建资源和模拟配置写入失败。先等实际助手消息完成渲染；长期事件流不以 `networkidle` 判断就绪。默认从当前 dist 加载，`LIVE_PREVIEW=1` 读取已部署 13511 静态资源，两种方式均访问真实配置接口。结果位于 `output/playwright/global-fast/`，逐项记录实际 URL、视口、截图路径、配置请求和刷新结果。脚本不发送真实模型消息，finally 恢复原先的两个 Fast 配置字段，不复制完整配置、权限或凭据。


#### 本次验证结果与性能
- `pnpm run build` 通过；上述 5 个测试文件共 207 项通过。新增回归在修复前 5 项失败、修复后通过，覆盖原生聊天全局保存、跨聊天/新状态实例、写入前及写入期间的迟到读取、失败回退和防重复。
- 构建资源模式六组检查通过。刷新后 Fast 保留，其他全新浏览器读取同值；关闭也跨刷新保留，注入失败时回退，三次成功开关各仅一个 `config/batchWrite`，一项预期失败，无真实 `turn/start`。测试恢复原有两个 Fast 字段。
- 主 JS 从 716403→715235 字节（gzip 222906→222719），CSS 536007→534692（gzip 60409→60230）；原大 chunk 提示保留。没有新增依赖、启动请求、轮询、历史扫描或请求扇出，写入仍是单个小型批次；竞态保护只比较一个版本号，模型目录加载与原缓存失效边界不变。未测供应商实际加速、实机软键盘和低端 GPU。
- CJS 公共 CLI 验证命令及结果：
```bash
node -e "const {execFileSync}=require('node:child_process'); const assert=require('node:assert/strict'); assert.match(execFileSync(process.execPath,['dist-cli/index.js','--help'],{encoding:'utf8'}),/Usage: linux-codex-webui/); console.log('PASS CLI help from CJS');"
# PASS CLI help from CJS
```
- 按配置改动要求执行打包回归，复用已含 Codex 0.153.4 的 `linux-codex-webui-chat-fixes:20260906` 镜像，新包安装到 `/opt/global-fast`，`CODEX_HOME=/codex-home`，命令为 `linux-codex-webui --port ${PORT:-4190} --no-password --no-open --no-tunnel --no-login`。精确构建命令与结果：
```bash
pnpm pack --pack-destination /tmp
docker build -t linux-codex-webui-global-fast:20260907 /tmp/codex-global-fast-docker
PHASE1_DOCKER_IMAGE=linux-codex-webui-global-fast:20260907 CODEX_ACCEPTANCE_REPORT_PREFIX=global-fast node scripts/verify-codex-phase1-docker.cjs
```
- 四项容器检查通过：4191 无认证、4192 损坏认证保持 Codex-only；4193 假认证和本地 mock 返回错误，刷新后保留一次失败回合、重复浮层为 0；4194 本地模拟 alpha/Astra 切换 beta/Luna 后模型目录更新。沿用当前仓库的 Codex-only 回归，不恢复已移除的 Zen/OpenRouter 自动兜底。报告 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast-docker-report.json`，截图为同目录 `global-fast-docker-no-auth.png`、`global-fast-docker-malformed-auth.png`、`global-fast-docker-invalid-auth-light.png`、`global-fast-docker-invalid-auth-dark.png`、`global-fast-docker-provider-switch.png`。四个容器及临时配置目录在 finally 清理。

13511 真实验收聊天，375×812 深色，刷新后的唯一快速开关：

![刷新后保留全局快速模式](/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast/plus-375-dark.png)

同一地址，375×812 浅色，模型配置没有速度菜单：

![模型配置仅保留模型选择](/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast/models-375-light.png)

隔离 4193，1280×900 深色，认证错误刷新后保留：

![隔离容器认证错误刷新验收](/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast-docker-invalid-auth-dark.png)


#### 13511 发布后复验
- 前端提交 `a351a1a`，实际索引 SHA-256 `a065fd10b8365057e9f270ec61c16b63041a23258505bb9b58e3e78ba6dd17de`；33 个已部署 HTTP 资源逐个匹配构建。
- `LIVE_PREVIEW=1 node scripts/verify-global-fast-mode.cjs` 通过：六组真实页面检查、开关各一次全局写入、刷新与新浏览器同值、模型配置无速度入口、Esc 返回/关闭、注入一次失败回退；页面错误和真实消息发送均为 0。常规用例保留 Service Worker，只有注入失败上下文禁用它以可靠拦截请求。
- 完整 URL 为 `http://127.0.0.1:13511/#/thread/01a0797c-faa5-70a0-b29e-b4c92c0bb03c`，视口为 1440×900、375×812、768×1024，分别明暗两次；首页全局检查使用 `http://127.0.0.1:13511/#/`。截图在 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast/plus-{1440,375,768}-{light,dark}.png` 与 `models-{1440,375,768}-{light,dark}.png`，上方内联图片即发布后截图。
- 发布回执 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast/deployment.json`，浏览器明细同目录 `live-result.json`。主进程 491027 和 app-server 子进程 491058 不变，4 个验收会话保留，配置字段测试后恢复；正式 13510 静态文件校验不变。未创建备份、未重启后端，4191–4194 测试监听均已清理。
