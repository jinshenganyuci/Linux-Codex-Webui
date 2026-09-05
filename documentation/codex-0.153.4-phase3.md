# Codex 0.153.4 第三批：原生扩展

日期：2026-09-05。第三批在 dev 上实现，不代表与整个 Codex CLI、桌面 App 或所有服务商能力完全对齐。13510 已在上一项独立升级中切到第二批 `0436c7d`；本批不动正式实例，验收目标仍为 13511。

## 功能与真实边界

| 能力 | 本批实现 | 不能据此认定的事情 |
| --- | --- | --- |
| 实时语音 | 原生 V1 WebRTC 音频；原生声音目录、麦克风授权、SDP、播放/静音、补充文本、有界转写、独占与停止清理 | Schema 接受 start 不等于 WebRTC 已连接；Astra 不是默认实时模型；没有真实供应商音频/音质/延迟验收 |
| 原生远控 | 读取状态，确认后 ephemeral 启停，临时配对码/到期、查询配对结果、客户端列表与撤销 | 不是 WebUI 的网页远程地址；有接口不等于当前 API key/provider 可以连接；没有真实远端设备配对验收 |
| 子任务 | 活动代理卡打开子线程；ancestorThreadId 查询当前线程后代，活动/归档历史、角色、摘要、配置与状态 | notLoaded 不是已完成；线程 model/effort 不是执行遥测；本次未擅自创建子代理，非空历史恢复采用夹具 |
| 插件与实验能力 | 原生已安装插件、启用/可用性/禁用原因/版本；实验生命周期、搜索、托管锁、经核对的临时开关 | 安装不等于工具可调用；不自动安装、认证、改 TOML 或打开开发中能力；安装/卸载仍复用原插件管理 |
| 上下文 | 全局默认与当前线程配置范围分开；运行时窗口、context_management 条件和普通压缩观察 | TOML 值不是实际窗口；普通 compaction 和 HTTP 200 都不是新上下文引擎已生效的证据 |

入口：已有会话底部“原生扩展”，或者首页设置里的“原生扩展：插件、语音与远控”。后者在没有选中线程时仍可读全局能力和远控，语音与子任务需要选定会话。

### 实测纠正的协议差异

- 方法来自本机固定 CLI 的 `app-server generate-json-schema --experimental`；子线程过滤也检查 Schema 的 ThreadListParams，而非只检查 thread/list 名称。
- 远控的客户端方法是 **remoteControl/client/list、remoteControl/client/revoke**，JSON 类型虽然叫 RemoteControlClientsListParams，方法里的 client 却是单数。真实元数据检查避免了“夹具通过但按钮永远不可用”。
- 0.153.4 的 runtime enablement 并不支持 apps/plugins：真实调用会返回空 enablement，状态不变。准确白名单来自 [rust-v0.153.4 config_processor.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/src/request_processors/config_processor.rs)，不能以通用文档或最新版主干替代安装版本。
- 本 UI 只给此精确版本内稳定的 auth_elicitation、memories、mentions_v2、remote_plugin、tool_suggest 提供临时开关。后台迁移和新 MCP 是开发中能力，remote_control 标记已移除，不提供对应实验开关。换成未核对版本时保持只读，而不是猜测沿用。
- 开关要求托管策略可读且未锁定，ACK 包含目标键且重新读出的 enabled 一致才确认。作用于整个 CLI 进程、重启恢复配置，不写 TOML；当前线程列表使用 threadId，provider 从不含 turns 的线程摘要读取，避免默认值冒充线程覆盖值。
- [rust-v0.153.4 realtime_conversation.rs](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/realtime_conversation.rs) 的 AVAS 校验只允许 WebRTC V1/V3，而不是 Schema 枚举中的任意版本。本批明确选择 V1/audio，不默认为 V2 或 Astra。

### 会话归属与停止

每个浏览器连接有 ownerId，同线程 start/stop/text/heartbeat 串行；不能接管其他页面或原生客户端。麦克风只在点击后获取；只在 peer 的 connectionState=connected 后显示已连接。连接超时、通知失联、关闭、切换扩展页签、后台、pagehide、刷新/BFCache 返回均释放媒体，不自动重连。

WebUI 自建租约每 10 秒续期，失联 30 秒后由后端清理；清理失败最多重试三次，保持失败状态，避免循环风暴。原生明确拒绝“线程不支持 realtime”时立即释放假租约；启动结果不确定时不会重发 start。桥接关闭时阻止尚未开始的排队连接。没有 turn/interrupt，也不清理外部原生客户端的会话。

实时 SDP、音频、转写不进入通知重放或旧聊天流快照。音频不落盘，转写仅保留本页 12 段、每段 8000 字符。配对码只在远控面板内存中显示；关闭面板不擅自停用用户显式打开的全局远控，停用需要按钮操作。

## 验证与复现

详细前置、操作、预期、回退/清理见 [分域手工用例](../tests/chat-composer-rendering/native-extensions.md)。复用当前 node_modules，不重新安装依赖；核对 4173 PID/cwd 后使用当前 dev 服务及独立 acceptance HOME。

```bash
pnpm run test:unit
pnpm run build
node -e "process.argv=['node','dist-cli/index.js','--help']; import('./dist-cli/index.js')"
PHASE3_THREAD_ID=<隔离TestChat线程> node scripts/verify-codex-phase3-native.cjs
PHASE3_THREAD_ID=<隔离TestChat线程> node scripts/verify-codex-phase3.cjs
PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_WAIT_MS=7000 pnpm run profile:browser
PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_ROUTE='#/thread/<隔离TestChat线程>' PROFILE_WAIT_MS=7000 pnpm run profile:browser
```

- 66 个测试文件、640 个用例通过；类型检查、Vite/tsup 构建通过。公开入口为 ESM，CJS 的上述动态导入 CLI 帮助命令退出 0，无须虚构不存在的 CJS 导出。
- 真实 CLI 0.153.4 返回 135 项实验能力、9 个 V1 声音（默认 cove）、空已安装插件和 disabled 远控。13 个使用中的方法都在安装 Schema 中；线程范围能力读取与 ancestor 查询成功。
- 隔离环境真实 tool_suggest 临时切换、ACK 与 enabled 回读、finally 恢复均通过，配置哈希未变。禁用 realtime 的真实请求被拒，最终租约 inactive；不把拒绝测试当音频成功。
- 真实 Astra low 只读 TestChat 完成 README 工具读取，生成 PHASE3_LINK_20260905；README 文件链接 hrefOk/titleOk/textOk 全为 true。
- Playwright 直接用于网络拦截/合成通知和媒体夹具，覆盖真实 changed UI，而不是只看首页。1280×900、375×812、768×1024 × light/dark 六组通过，页面异常为 0。覆盖开关确认/托管锁/刷新恢复、未生效处理、配置范围、运行窗口、活动子线程链接和历史恢复、远控先通知后 ACK 的竞争、配对/撤销、音频失败/关闭清理、不自动重连。
- 当前 provider 为 myproxy、认证类别未由 CLI 识别，realtime_conversation 与 context_management 未启用。真实麦克风/供应商音频、真实远端配对和新上下文引擎执行仍需对应账户/服务商/显式实验配置，不在此处宣称完成。

### 打包容器

复用已有第二批镜像内的固定 CLI 与 npm 缓存，在独立 `/opt/phase3` 前缀安装本次约 1.5 MiB tarball；不对旧全局目录做 rename/copy-up。本次 164 个包安装约 22 秒。新前缀用于隔离包验收，不是正式升级备份。

```bash
pnpm pack --pack-destination /tmp
BUILD_CONTEXT=$(mktemp -d /tmp/codexui-phase3-package.XXXXXX)
cp /tmp/linux-codex-webui-0.1.87.tgz "$BUILD_CONTEXT/linux-codex-webui.tgz"
docker build -t linux-codex-webui-phase3:8069dfb -f scripts/docker-codex-phase3.Dockerfile "$BUILD_CONTEXT"
PHASE1_DOCKER_IMAGE=linux-codex-webui-phase3:8069dfb CODEX_ACCEPTANCE_REPORT_PREFIX=phase3 node scripts/verify-codex-phase1-docker.cjs
rm "$BUILD_CONTEXT/linux-codex-webui.tgz"
rmdir "$BUILD_CONTEXT"
```

沿用 Codex-only 架构的四场景：4191 无 auth、4192 畸形 auth、4193 假凭据 401 刷新保留错误、4194 原生 provider alpha→beta。不会重新加入已移除的 Zen/OpenRouter 独立路径，不使用真实无效凭据，也不留下测试容器。

四场景均通过；假 401 在明暗主题刷新后各保留一条错误，重复 live overlay 为 0；provider 目录由 Astra 变为 Luna。新安装入口为 `/opt/phase3/node_modules/linux-codex-webui/dist-cli/index.js`，业务提交 `8069dfb`；CJS 动态导入该入口 `--help` 退出 0。截图为 `output/playwright/phase3-docker-*.png`。

## 性能审计

- 首页 API **182.0 KiB**，thread/list 1 次；线程页 **125.8 KiB**，首次真实消息 **773.7 ms**、resume 1 次、重复历史页 0。未打开扩展面板时第三批扩展/实时/远控请求 **0 次**。
- 仍有原有线程 `threadListFirstPage=2` 和首页 config/read 2 次。本次不扩大范围修改旧列表调度。首页/线程各 1 个长任务，最大分别 137/138 ms；最慢 provider-models 332.2/324.0 ms。不是多轮生产 P95，也未测量 CLI 内部 item hydration。
- 主入口 **694.16 kB / gzip 215.29 kB**，第二批约 693.4 kB。三个异步块分别为扩展 16.90 kB、实时 9.74 kB、远控 7.23 kB；没有新增依赖，已有大 chunk 告警未掩盖。
- 同范围能力读取并发合并；单元夹具 20 并发只执行 4 类 RPC；真实 20 个缓存读取合计约 276 ms、单份结果 17639 字节。135 项能力实际要读 2 页，不能把“4 类 RPC”说成永远只有 4 次请求。
- 能力缓存 32 范围/15 秒，Schema 按 CLI 身份缓存；子任务只做 ancestor 分页（至多 200 项、首屏 20 项），不逐项 resume；相关通知合并 1 秒且只在子任务页加载。远控客户端最多 10 页，无自动远程请求轮询；实时仅活动租约心跳，语音帧不进入聊天历史热路径。
- 所有新通知复用已有 WebSocket，不增加 socket 或无界音频 buffer。配置、线程设置、运行时开关和 CLI generation 的失效路径有回归测试；开启扩展仍有明确的按需读取成本，不声称零成本升级。

原始报告位于 `output/playwright/phase3-{native,browser,docker}-report.json` 及 `browser-runtime-profile-*-2026-09-05T14-42-*.json`；截图位于 `phase3-*-<light|dark>-<1280|375|768>-cjs.png`。真实 TestChat URL 为 `http://127.0.0.1:4173/#/thread/01a0718c-5e56-7641-acdf-b8a99fb9b6e6`。

## 部署与未覆盖事项

- 第三批仅更新 13511；复用原隔离 HOME、固定 CLI 0.153.4 和兼容 node_modules。新产物放入单独 phase3 release，不能覆盖已被 13510 使用的 phase2 目录。没有备份、正式历史复制、全量依赖复制、推送或 npm 发布。
- 部署前核对空闲、审批、兼容/原生队列与线程集合，后续核对 systemd、监听、HTTP/LAN 登录、实际构建提交/dirty、CLI 路径/HOME、线程集合及扩展接口。正式 PID 保持第三批开始时的值，supports_websockets=false 仍在。
- 边界复核发现：正式 config.toml 于 22:33:42 更新，哈希相对任务开始时不同，来源未确认；两个隔离 HOME 配置哈希均未改变。本批没有向正式配置发起写入，也不覆盖或还原这次并行变化。不能宣称整个任务期间正式文件字节不变；13511 更新前会重新记录并保留其现状。
- 不静默启用语音、新上下文或远控，也不升级用户全局 Codex。语音需要安全浏览器上下文；Responses provider 的 supports_websockets=false 与另行选择的实时 WebRTC 是两条不同链路。
- 回退时先显式停止自建实时会话与远控、等待原生队列清空，再切到现有已验证产物；不新建回滚备份，不直接删除归属文件。临时开关随 CLI 进程重启恢复配置。
- 非文本工具图片的完整渲染、旧 quoted-title Markdown 问题、旧 thread/list 重复请求、全量 P95 性能优化和整个 CLI 的完全对齐仍是独立后续任务，不藏进第三批“已完成”。
