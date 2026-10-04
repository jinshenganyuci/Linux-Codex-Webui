# 手机恢复聊天时同一回复重复显示

## 问题与复现条件

用户报告界面偶尔把一次回复显示成两条相同消息，刷新后恢复。已定位的触发条件是：浏览器没有已知活动回合（例如接入或恢复时未收到 `turn/started`），但随后收到带明确 `turnId` 的助手增量和完成通知。旧缓存只保存 thread/item，刷新文字时重新读取当时的活动回合，导致增量行无回合或归错回合，完整消息被当作另一行。

这是一条经测试确认的触发路径，不能据此判断每次用户设备上的重复都来自同一通知顺序。验证保留消息身份，不以文本相同删除真实的多条回复。

## 前置条件

- 使用唯一测试地址 `http://127.0.0.1:13511`，不要修改或重启正式 13510。
- 使用独立浏览器上下文、明暗主题和 `375×812`、`768×1024` 视口。
- 需要确定控制增量/完成通知、历史响应和恢复时间，因此使用 Playwright CJS 的网络及 WebSocket 夹具。禁止给真实会话注入答案、发模型回合或写配置。
- 旧版基线为产品提交 `51df375`，Codex 0.159.3；历史数据只包含一个指定回合、指定消息 ID 的助手回复。

## 操作与预期

1. 打开夹具会话，保持没有已知活动回合。发送 `item/agentMessage/delta`，带相同 thread、明确 `turnId=T`、`itemId=M` 和唯一测试文字；等待超过 180 ms。
2. 发送 `item/completed`，带同一 T/M 和完整相同文字。检查实际助手消息 DOM 行数；旧版可出现两条，修复版必须只有一条。
3. 将历史响应设置为只有该 T/M 的完整消息，刷新同一页面。旧版及修复版都应为一条，记录刷新前后差异。
4. 用恢复通知触发历史补齐，将历史返回延迟到增量之后，重复同样过程。不得因延迟历史或迟到完成通知再次生成第二行。
5. 活动回合已切换为 B 时，接收属于 A 的迟到增量和完成通知；文字必须留在 A，不得生成归属 B 的副本。
6. 分别准备同一回合中两个不同消息 ID 的相同文本、不同回合复用消息 ID 的相同文本。两条合法消息必须保留，不能按文本粗暴去重。
7. 验证缺少回合 ID 的旧兼容通知，只有身份可唯一确定时才归位；明确属于不同回合的消息不得互相覆盖。
8. 重复明暗主题和两种手机/平板尺寸，截图前等待 2–3 秒；实际消息列表不重复、不横向溢出，暗色表面正确。

## 性能与请求检查

- 缓存仍用单一 180 ms 定时批次，不能为每个字符新增请求或计时器。
- 入队时确定 thread/turn/item 身份，刷新缓存时不通过额外 RPC 查询回合。
- 记录通知次数、历史/实时状态请求、可见消息数、重复页读取及 API 载荷。浏览器恢复可以进行既有的历史补齐，修复不得增加轮询、无界扫描或每次 delta 的网络请求。
- 用仓库 profiler 验证有效聊天页面、有真实 API 流量且不处于加载错误页；性能数字需说明数据规模和测量范围。

## 清理与回滚

- 关闭隔离浏览器、撤销所有夹具，不清空用户浏览器存储，不删除真实聊天。
- 若临时使用打包 Docker，顺序复用 13511 并清理本轮容器；测试服务恢复到核验过的入口/home。
- 修复仅改变客户端消息缓存与回合归属，无数据库迁移。回退前端构建会恢复旧显示行为，原生聊天数据不受影响。
- 验收需分别保留状态层、旧版浏览器复现、修复版浏览器和真实回复证据，不以单测代替浏览器成功。

## 2026-10-04 实际复现与修复验证

- 产品修复提交：`feb33192fe3edd96f73775d42d59121a039fd495`。只在独立分支 `fix/mobile-duplicate-reply-20261004` 实现，13511 运行该干净构建和固定 CLI 0.159.3。
- 旧版 `51df375` 在 375×812 / 768×1024 明暗主题，以及 375 暗色的重连历史延迟场景，五案均呈现 `1 → 2 → 2 → 1`：增量一行、完成两行、等待截图仍两行、刷新一行。是实际助手 DOM 行重复，不是活动浮层或一次模型发出两条。
- 修复版按相同事件顺序运行五案，均为 `1 → 1 → 1 → 1`。未按文案去重，回归单测确认同文不同消息、同 ID 不同回合仍独立。
- 命令：`MODE=before node scripts/verify-mobile-duplicate-reply.cjs`（旧版）与 `MODE=after node scripts/verify-mobile-duplicate-reply.cjs`（修复版）。浏览器只注入夹具请求/通知，真实模型和配置写入尝试均 0，页面 JS 错误 0。
- 报告：`output/playwright/mobile-duplicate-reply/before-report.json`、`after-report.json`、`comparison-report.json`；测试 URL 为 `http://127.0.0.1:13511/#/thread/01593000-0000-4000-8000-000000000001`。
- 已目视检查暗色 375 和浅色 768：实际消息完整、无横向溢出。绝对截图根目录为 `/root/.local/share/linux-codex-webui/worktrees/mobile-duplicate-reply-20261004/output/playwright/mobile-duplicate-reply/`；前后代表图分别是 `before-missing-turn-start-completed-live-dark-375.png` 与 `after-missing-turn-start-completed-live-dark-375.png`。每张图的 URL、视口与消息快照记录在报告。

### 自动检查与打包

```sh
pnpm run test:unit
pnpm run build
node -e "process.argv=[process.execPath,'./dist-cli/index.js','help']; const entry=require('./dist-cli/index.js'); if(Object.keys(entry).length) throw new Error('Unexpected public CLI exports'); console.log('CJS public CLI help: PASS (no library exports)')"
pnpm pack --pack-destination output/mobile-duplicate-reply/docker-context
docker build --pull=false --network=none -t linux-codex-webui-mobile-duplicate:local output/mobile-duplicate-reply/docker-context
CODEX_01593_DOCKER_IMAGE=linux-codex-webui-mobile-duplicate:local node scripts/verify-codex-01593-docker.cjs
```

- 87 文件、961 项单测通过；其中 12 项新状态回归和 7 项缓冲测试直接检查消息身份边界。类型检查、前后端构建通过，CJS 输出 `PASS (no library exports)`；日志均在 `output/mobile-duplicate-reply/`。
- Docker 离线复用已有 CLI 0.159.3 和依赖，只安装新打包 WebUI。五案无认证、损坏认证、invalid/expired 401、alpha→beta 假供应商切换全部通过；invalid/expired 明暗刷新后错误保留，重复 live overlay 0。原生 fork/revert 回归正确。
- 当前产品已移除自动 Zen 回退，使用 alpha/beta 隔离 mock 验证模型与实际 Responses 路由；不是外部 Zen/OpenRouter 或真实 OAuth 刷新测试。镜像 ID `sha256:9b119ae0877a7f88c9c8ed6d0398529180694186c134c259ac2515f03792520b`。
- Docker 与正式预览顺序复用唯一测试端口 13511，全部容器清理后恢复修复版预览，没有并行占用端口。证据 `output/mobile-duplicate-reply/docker-summary.json`、`docker-report.json` 和 `output/playwright/codex-01593-docker-*.png`。

### 单次真实模型回复

- 在最终 13511 构建上，执行 `output/mobile-duplicate-reply/real-chat-smoke.cjs`，要求显式指定 `MOBILE_DUP_EXPECTED_HOME=/root/.local/share/linux-codex-webui/acceptance/codex-01593-ui-20261001`、`MOBILE_DUP_EXPECTED_COMMIT=feb33192fe3edd96f73775d42d59121a039fd495`、`MOBILE_DUP_EXPECTED_VERSION=0.159.3`，核对 home/版本与空闲后才发送。
- 仅一次真实 `myproxy / gpt-5.6-luna / low` 回合，线程 `01a10586-66a1-73a0-b577-73a214f5870f`、回合 `01a10588-c6be-7122-9205-1a5dd09f7f93`。浏览器 30 ms 连续采样的最大助手行数为 1，375×812 明暗主题的完成与刷新四次检查也都是 1。
- Markdown、本地 proof 与 OpenAI 链接的 `hrefOk/titleOk/textOk` 全通过；页面错误和禁止写入尝试为 0，proof 文件内容不变。实际 URL：`http://127.0.0.1:13511/#/thread/01a10586-66a1-73a0-b577-73a214f5870f`。
- 报告 `output/mobile-duplicate-reply/real-chat-smoke-report.json`，截图位于上述绝对截图根目录，命名为 `testchat-mobile-duplicate-reply-{live,refresh}-{light,dark}-cjs.png`。明色完成与暗色刷新图均已目视检查。
- 首次测试脚本创建空线程后未设置名称，导致尚未物化的历史 resume 失败、发送等待超时，当时原生与浏览器均为零回合。补齐同一线程的命名后继续验证，只发出一个实际模型回合；报告保留此前测试失败，不将它算成重复发送或产品修复失败。

### 性能与部署

- 同五组 before/after 浏览器回放，各 RPC 方法请求计数完全相同；修复没有增加历史拉取、重试或轮询。数据结构变化仅给现有缓冲保存 turnId，仍单一 180 ms 定时器，按 thread/turn/item 分桶；兼容归位仅在 completed 且存在无回合候选时扫描当前线程已加载消息，无网络扇出。
- 主入口 gzip 从 232887 增至 233011 字节，差额 124 字节，见 `output/mobile-duplicate-reply/bundle-comparison.json`。
- `PROFILE_BASE_URL=http://127.0.0.1:13511 PROFILE_ROUTE='#/thread/01a0f5fb-15de-7a31-81fe-cae2586b428e' PROFILE_WAIT_MS=7000 pnpm run profile:browser` 检查实际旧 TestChat；首条真实消息 668.1 ms、API 164.6 KiB、warnings 为空，列表/resume/摘要读取各一次，完整历史读取及重复历史请求均 0。
- profiler 为本机小历史样本，不是手机实体设备或外网速度保证，也不把前后不同运行时条件的延迟直接当成性能提升。浏览器无法统计 app-server 内部 RPC；本次变化在客户端，没有新增后端读取路径。
- 最终测试 release 为 `/root/.local/share/linux-codex-webui/releases/mobile-duplicate-reply-20261004-feb3319`，沿用隔离 home `/root/.local/share/linux-codex-webui/acceptance/codex-01593-ui-20261001`。实际原生子进程验证为 0.159.3，`dirty=false`。
- 本次正式 13510 的进程/启动时间、后端/前端字节、保护配置和原有 904 个会话路径均保留，未部署此修复到正式端。回执为 `output/mobile-duplicate-reply/deployment.json`、`preservation.json`。
- 回滚测试预览需等待回合/审批/队列为空，优雅停止后等待原生子进程退出，移除本轮单个 `zzzzzzzzz-mobile-duplicate-reply-20261004.conf` 覆盖，再 daemon-reload/start 并核对原入口；不删测试 home、不动正式覆盖。本次没有推送 GitHub。

## 后续用户授权：13510 静态发布完成

- 用户随后明确要求升级 13510 并提交最近更新到 GitHub。代码比较确认 `51df375..feb3319` 无服务端、CLI 或依赖变化，因此直接发布已验收前端，保留正在执行本次对话的正式服务。
- 在共享部署锁内执行 `flock -n /root/.local/share/linux-codex-webui/deployments/13510-deploy.lock node scripts/deploy-mobile-duplicate-frontend.cjs --deploy`。新增 12 个带内容哈希的 JS，旧资源保留，依赖全部就位后才在同目录原子替换 `index.html`；不移动整个 dist，不重启 Node/CLI，不重新构建不同前端。
- 新构建 33 个文件及 32 个保留旧资源的实际 HTTP 字节哈希均通过。旧 ETag 请求新入口得到 200，新 ETag 条件请求得到 304。Node fetch 的条件检查需显式 `cache: 'no-cache'`，否则默认行为会影响 304 断言。现有 SW 对页面/JS/CSS network-first，在线刷新一次会加载修复，无需清理浏览器存储。
- 后端仍诚实报告 `51df375` / CLI 0.159.3，前端独立标记为 `feb3319`；以实际入口及 JS 哈希确认升级，不把 backend runtime-info 当成前端版本证据。
- 正式 PID 639、原生 CLI PID 808、13511 PID 306263 及发布前建立的 WebSocket 均保留。配置、登录会话、模型偏好与后端入口哈希不变；905 个原有会话路径存在且长度未减少，允许正在进行的会话追加。这项检查不声称对全部原有会话内容做了逐字节散列。
- 正式复验命令：`PROFILE_BASE_URL=http://127.0.0.1:13510 MOBILE_DUP_ALLOW_PRODUCTION=1 MODE=after node scripts/verify-mobile-duplicate-reply.cjs`。正式地址默认拒绝，显式启用后只允许 after 和完整五案；`--self-test` 验证地址门控和真实写操作隔离，13511 `MODE=after ... --smoke` 先行通过。
- 测试 URL 为 `http://127.0.0.1:13510/#/thread/01593000-0000-4000-8000-000000000001`；375×812、768×1024 明暗与 375 暗色重连五案全程单条，页面错误和真实写入尝试均 0。实际 served index SHA-256 为 `ecc32a55f15f45e6d86b89591cff3e843289456a832dadeb347a442024ef0016`，与验收文件一致。正式夹具只在浏览器内，不创建或发送原生会话。
- 报告和截图绝对根目录：`/root/.local/share/linux-codex-webui/worktrees/mobile-duplicate-reply-20261004/output/playwright/mobile-duplicate-reply/production/`；报告 `production-report.json`，暗色手机图 `production-missing-turn-start-completed-live-dark-375.png` 已目视确认单条、正确主题及无横向溢出。
- 最终回执 `/root/.local/share/linux-codex-webui/deployments/13510-mobile-duplicate-20261004/status.json` 为 `complete`，`restartPerformed=false`。失败回滚只原子恢复保存的旧 index，保留两版依赖；后续人工回滚应先检查是否存在更新发布，避免覆盖更晚入口。不恢复或覆盖聊天数据库。
- 本次只是发布脚本/验证工具新增，无应用热路径变化；实际静态切换约一秒内完成，资源核验有界、顺序执行一次。正式端不发送额外模型回合；功能性能沿用上文相同构建的请求数及 profiler 证据。

- 正式夹具与 13511 的请求量不能作等量断言：常规场景限额读取多一次，768 两组各多 20 次摘要读取，重连案一致；两实例历史与侧栏条件不同，未将这项差异归因于本修复；详细计数见 `production-verification.json`。相同 13511 上的修复前后对照仍为每个方法增量 0。
