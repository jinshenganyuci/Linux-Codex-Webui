### Composer mode scoping and Fast mode support

#### Feature/Change Name
Plan mode is scoped to the current chat, persists through the WebUI backend across browsers, and Fast mode is saved independently for each chat while following the live Codex model catalog. A one-turn Ask-first option can request structured clarification without changing the thread's saved mode.

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


### 历史全局快速模式验收（已由下方会话独立方案取代）

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


#### 正式 13510 升级与只读复验（用户明确授权）
- 前端 `a351a1a` 已从独立 13511 直接发布到 13510，33 个正式 HTTP 资源与已验收构建匹配；后台仍为 `2e17039` / Codex 0.153.4，不能用后台构建标识判断前端是否更新。
- 精确命令：`python3 output/playwright/global-fast-production-13510/deploy.py`，随后 `node output/playwright/global-fast-production-13510/verify.cjs`。未执行重新打包或重复预览端配置写入测试。
- 实际地址 `http://127.0.0.1:13510/#/`，1440×900、375×812、768×1024 明暗六组通过。保留 Service Worker，刷新后仍加载新版 JS/CSS；「＋」唯一 Fast 开关与当前服务端已保存的关闭状态一致，模型列表没有速度菜单，Esc 返回强度并关闭。检查过程中没有改动正式 Fast、模型或权限，也没有发送消息；真正开关写入和失败回退已在同一前端的隔离 13511 验证。
- 主进程 414785、app-server 子进程 414813、598 个会话保留；配置/认证/模型文件哈希在浏览器检查后不变，13511 资源和进程不变。无备份、无后端重启、无配置写入或页面错误。
- 完整回执 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast-production-13510/deployment.json`，浏览器断言同目录 `browser.json`。截图为该目录下 `plus-{1440,375,768}-{light,dark}.png` 与 `models-{1440,375,768}-{light,dark}.png`。如需恢复旧版，从指定提交重建前端并原子替换入口，不依赖此次不存在的备份。

正式 13510 首页，375×812 浅色，保留原快速模式开关状态：

![正式手机快速模式入口](/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast-production-13510/plus-375-light.png)

正式 13510 首页，1440×900 深色，模型配置已无速度菜单：

![正式桌面模型配置](/root/codex工作目录/Linux-Codex-Webui/output/playwright/global-fast-production-13510/models-1440-dark.png)


### 当前方案：按会话独立保存快速模式

#### 前置条件与操作
- 在独立 13511 中使用两个已完成 TestChat（A/B）和另一浏览器；配置文件即使保留旧 `service_tier = "priority"`，尚未单独选择速度的会话也默认标准。
- 打开 A 的「＋」，启用 Fast；切到 B 应关闭，回到 A 保留开启。刷新 A/B、另开浏览器重复；A 关闭或开启不得改变 B。
- 保存 A 时切到 B，B 应能独立操作。模拟 A 保存失败，回到 A 是之前已保存的值，B 的状态不变。延迟偏好读取不能覆盖较新的本地选择。
- 保存 Fast 的同时改模型，速度 PATCH 不能覆盖新模型，模型 PUT 不能覆盖速度；重载后两者均正确。
- 首页新会话默认关闭，发送前打开只用于该次新聊天；成功首回合后以 threadId 保存，下一次新聊天/分支恢复标准。未发送草稿的速度是临时选择，刷新首页恢复标准。
- 活动回合的速度不被自动改写；已有队列保持提交时快照，执行旧快照不会把新选择写回旧值。关闭时必须在实际请求中清除旧全局/会话 priority，不能只把开关画成关闭。
- 检查桌面 1440×900、手机 375×812、平板 768×1024 明暗；当前会话显示“仅当前会话，刷新后保留”，新聊天提示只用于新聊天；模型配置里仍无速度菜单。

#### 维护与兼容
- GET/PUT `/codex-api/thread-model-preferences` 沿用已有格式，新增可选 `speedMode`；PATCH 携带 threadId、速度和首次初始化所需模型/推理信息，只修改速度。模型更新忽略过期速度快照，文件锁合并保留其他会话。
- 旧记录没有速度字段时按 standard 读取，不批量改写历史记录；旧全局 config.toml 不变。需要完整前后端升级，旧后端不支持 PATCH 时必须报错回退，不能假装成功。
- 上方全局 Fast 章节和其部署记录仅保留为历史；旧 `verify-global-fast-mode.cjs` 已停止运行以免误写全局配置，当前验证使用 `verify-thread-fast-mode.cjs`。
- 验收只临时修改两个 TestChat 的偏好，结束后逐条恢复，不覆盖整个偏好文件；不修改全局配置或正式 13510。回退需部署目标版本的前后端，不能只切前端。

#### 本次验收命令和结果（2026-09-07）

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts src/api/codexGateway.test.ts src/server/threadModelPreferences.test.ts src/server/codexAppServerBridge.threadModelPreferencePersistence.test.ts
pnpm exec vitest run src/server/codexAppServerBridge.inlinePayload.test.ts src/server/codexAppServerBridge.archive.test.ts src/composables/desktop/nativeThreadController.test.ts src/api/nativeThreadGateway.test.ts
pnpm run build
node -e "const {execFileSync}=require('node:child_process');const assert=require('node:assert/strict');assert.match(execFileSync(process.execPath,['dist-cli/index.js','--help'],{encoding:'utf8'}),/Usage: linux-codex-webui/);console.log('PASS CLI help from CJS')"
pnpm pack --pack-destination /tmp
docker build -t linux-codex-webui-thread-fast:20260907 /tmp/codex-thread-fast-docker
VERIFY_THREAD_FAST=1 PHASE1_DOCKER_IMAGE=linux-codex-webui-thread-fast:20260907 CODEX_ACCEPTANCE_REPORT_PREFIX=thread-fast node scripts/verify-codex-phase1-docker.cjs
node scripts/verify-thread-fast-mode.cjs
PROFILE_BASE_URL=http://127.0.0.1:13511 PROFILE_ROUTE='#/thread/01a07ac1-1655-7340-bead-0637d5eeab63' PROFILE_WAIT_MS=7000 pnpm run profile:browser
```

- 单测分别 197、81 项通过，共 8 个文件 278 项。完整构建及 CLI 的 CJS 调用通过；首页标识说明修正后再执行 `pnpm run build:frontend` 并发布，六组页面断言全部通过。
- 镜像从已有 `linux-codex-webui-global-fast:20260907` 复用 Codex 0.153.4，将当前打包产物安装到 `/opt/thread-fast`；运行 `CODEX_HOME=/codex-home` 和 `linux-codex-webui --port ${PORT:-4190} --no-password --no-open --no-tunnel --no-login`，使用隔离假认证及本地 mock。
- 容器五项通过：4191 无认证、4192 损坏认证保持当前 Codex-only 行为；4193 无效认证失败回合刷新保留、重复浮层 0；4194 alpha→beta 模型切换，以及两个独立会话的实际 CLI 请求捕获。旧全局 priority 存在时，唯一 Fast 用户标记对应 priority，Standard 用户标记对应空服务等级；偏好各自为 fast/standard。额外无标记请求不计作用户回合。容器与 4191–4194 监听均已清理，报告 `output/playwright/thread-fast-docker-report.json`。
- 浏览器直接使用 Playwright，因为需修改主题 localStorage、注入延迟和失败；禁用测试上下文的 Service Worker 以可靠拦截。脚本读取现有两个 TestChat 标识文件，要求会话无活动回合；不发送模型消息。A 的开关、B 的开关、失败回退各按 threadId 断言，重新加载及全新浏览器均保持独立；首页每次进入默认标准，未发送草稿不写偏好。共记录 4 次 PATCH（含 1 次预期失败），全局配置写入、发送消息、页面异常均为 0，finally 已逐条恢复原有记录。

实际 URL 为 `http://127.0.0.1:13511/#/thread/01a0797c-faa5-70a0-b29e-b4c92c0bb03c`（A）和 `http://127.0.0.1:13511/#/thread/01a07ac1-1655-7340-bead-0637d5eeab63`（B）。桌面 1440×900、手机 375×812、平板 768×1024 明暗六组截图位于 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/thread-fast/a-fast-{1440,375,768}-{light,dark}.png` 和同目录 `b-standard-{1440,375,768}-{light,dark}.png`；详细断言在 `live-result.json`。

A 会话，375×812 浅色，刷新后保持开启：

![会话 A 刷新后快速模式开启](/root/codex工作目录/Linux-Codex-Webui/output/playwright/thread-fast/a-fast-375-light.png)

B 会话，375×812 深色，独立保持关闭：

![会话 B 独立保持标准模式](/root/codex工作目录/Linux-Codex-Webui/output/playwright/thread-fast/b-standard-375-dark.png)

4193 无效认证，1280×900 深色，失败刷新后保留且无重复浮层：

![独立速度版本认证错误回归](/root/codex工作目录/Linux-Codex-Webui/output/playwright/thread-fast-docker-invalid-auth-dark.png)

#### 性能、部署和清理记录

- 主入口 JS 715307→716330 字节（gzip 222762→222982），CSS 原始大小均 538294 字节；复用现有偏好读取，不新增依赖、轮询、会话历史扫描或请求扇出。按会话 pending 项在 finally 清理，模型 PUT 只写模型字段，速度 PATCH 在原串行锁内合并，避免并发覆盖和无界待办。
- 当前完成态 B 聊天 profiler 正常渲染，API 总量 128.4 KB；偏好 GET 1 次、447 字节、17.3ms，thread/resume 1 次，无重复历史页请求。唯一 warning 是既有 thread/list 首页 2 次；最慢 API 是模型目录 302.8ms。首条消息 463ms 为单次样本，不声明速度提升；未测供应商真实加速、实机软键盘或低端设备。完整报告和 trace 路径见 `output/playwright/thread-fast/profile.json`，体积见 `bundle.json`。
- 13511 后端完整发布 `f2019e5`，保留原发布目录和验收 CODEX_HOME，服务重启一次，当前主进程 538954、实际 app-server 子进程 539008 / Codex 0.153.4。因 CLI 懒启动，使用只读 config/read 初始化后验证真实子进程；33 个 HTTP 资源通过，5 个验收会话及原配置/认证/模型文件保留。首页说明修正仅追加前端发布，无第二次重启。
- 回执 `output/playwright/thread-fast/deployment.json` 标记 `completed:true`、`backendRestarted:true`、`backupCreated:false`；测试记录已恢复、全局配置未改。正式 13510 未升级，仍为此前全局 Fast 版本。未创建备份、未推送 GitHub 或发布 npm。回退必须成套构建并部署目标前后端，保留原数据目录；不能以旧前端配新后端代表回退完成。

#### 正式 13510 升级安排（用户明确授权）

- 使用 `output/playwright/thread-fast-production-13510/deploy.py --prepare` 核对已验收的前端 `ea320f8`、后端 `f2019e5`、35 个构建文件、配置哈希和服务入口；未创建旧数据或代码备份。此次提交只记录安排，正式完成状态必须读取同目录 `status.json`，不能把 `prepared` 或 `waiting-for-current-turn` 当作完成。
- 部署由独立 systemd 服务执行 `python3 output/playwright/thread-fast-production-13510/deploy.py`，等待当前对话结束、全服务无活动回合/待审批/队列后才重启 13510。使用原发布目录、原 runner、原 `/root/.codex` 和 Codex 0.153.4；不改 13511。发生超时或并发配置/服务变化时，状态写为 failed 并保留错误原因。
- 发布后核对实际后端版本、CLI 子进程归属和 CODEX_HOME、13510 监听 PID、33 个 HTTP 资源、升级前会话集合、配置和模型目录哈希；随后执行 `node output/playwright/thread-fast-production-13510/verify.cjs`。正式验证不修改 Fast、模型、配置或发送消息；实际开关写入和失败隔离沿用同产物 13511 已通过的验证。
- 正式脚本在 `VERIFY_PREVIEW=1 node output/playwright/thread-fast-production-13510/verify.cjs` 的 13511 手机深色预演通过。正式 URL 为 `http://127.0.0.1:13510/#/thread/01a07a8a-cff4-76d1-aea2-0c8e6c8142e9` 和 `http://127.0.0.1:13510/#/`；1440×900、375×812、768×1024 明暗共六组自动检查刷新后会话开关匹配服务端偏好、新会话默认关闭、唯一加号入口、模型面板无速度菜单、手机菜单居中且无溢出。保留 Service Worker，使用 Playwright 设置主题 localStorage。
- 完成的必要条件是 `status.json` 为 `phase: complete` 且同目录 `browser.json` 有六组成功记录；截图绝对路径为 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/thread-fast-production-13510/thread-{1440,375,768}-{light,dark}.png` 和 `new-{1440,375,768}-{light,dark}.png`。以下内联图片在后台正式验收成功后生成：

![正式手机会话独立 Fast 刷新验收](/root/codex工作目录/Linux-Codex-Webui/output/playwright/thread-fast-production-13510/thread-375-dark.png)

![正式桌面新会话默认标准](/root/codex工作目录/Linux-Codex-Webui/output/playwright/thread-fast-production-13510/new-1440-light.png)

- 查看 `browser.log` 定位页面失败。成功后仅留下回执、日志和截图，没有临时 WebUI 监听或配置变更；回退仍需成套构建目标代码，不依赖本次不存在的备份。性能复用上一节同产物测量，不将此次只读正式验收描述为新一轮性能基准。
