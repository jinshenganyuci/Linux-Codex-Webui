# Codex 0.153.4 第二批：原生会话控制

日期：2026-09-05。基于首批 `d2242b1`，协议以本机固定 CLI 0.153.4 的 `app-server generate-json-schema --experimental` 和真实 RPC 为准。背景协议见 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。本批不代表已经实现整个 CLI 的全部能力。

## 能力与边界

| 能力 | 本批行为 | 不做的事情 |
| --- | --- | --- |
| 原生插话 | 活动线程走 turn/steer，精确 expectedTurnId，支持原有文本、文件、图片、skill 输入构建；拒绝保留草稿并显示错误 | 不携带 turn/start 设置，不重启回合、resume、自动换模型或重发 |
| 当前回合设置 | 模型、推理、速度通过 turn/settings/update；区分 applied 和 targetUnavailable | 不声称修改已开始的推理；applied 也不保证一定还有下一次推理 |
| 后续会话设置 | thread/settings/update，显示 CLI 通知/resume 确认的有效设置；已有原生线程的速度选择不写全局默认 | 不用全局 TOML 值冒充该线程当前设置；不自动覆盖其他线程 |
| 原生 Goal | 创建、修改、清除、启用/暂停、状态/Token 预算/已用量/时间；通知与刷新恢复 | 不与 update_plan 卡合并；仅改预算不提交 objective，不把用量当完成百分比 |
| 原生队列 | 显式选择原生归属后，add/list/update/delete/reorder/start 和 changed 通知；CLI 自动续跑 | 不让旧调度器同时领取；不把旧逐条模型/Plan 选项塞进不支持它们的原生协议 |
| 权限 | permissionProfile/list，仅允许 allowed=true；通过 thread/settings/update 应用到后续回合 | 不在当前步骤静默提权；不改全局默认，不自动选择更宽松配置 |

### 开发中开关

0.153.4 虽然在实验 Schema 中公开 turn/settings/update，但默认 `step_model_switching=false`。缺少开关时真实 RPC 拒绝；WebUI 会禁用对应按钮并给出原因。若需要验收，只在**隔离 HOME** 的既有 features 表中设置：

```toml
[features]
step_model_switching = true
```

等待隔离会话空闲后启动新的隔离 app-server，再用分页 experimentalFeature/list 确认 enabled=true。不能重复添加已有的 features 表。实测 experimentalFeature/enablement/set 对该开关可返回 200/空结果但不启用，不能把 HTTP 成功当成生效。正式 `/root/.codex/config.toml` 不由本批修改；`supports_websockets=false` 保留。这里的开关与浏览器到 WebUI 的通知 WebSocket 无关。

### 队列归属与竞争

- 旧兼容队列默认保持原样。只有线程空闲、无待审批、两种队列都为空时才允许切换；不会自动迁移有逐条模型、推理、速度和一次性规划指令的旧消息。
- 归属在独立 `CODEX_HOME/webui-native-queue-owners.json` 中原子写入，避免项目/标题等共享 global-state 写入覆盖。损坏时失败关闭；不要手工删除文件来强迫降级。
- 同一 WebUI 后端按线程串行处理原生写入/归属切换，旧队列写入和领取都检查归属。CLI 降级后仍保留原生归属，不能隐式切回旧路径。
- 原生队列只保存输入，按 CLI 会话设置执行。CLI 0.153.4 会自动领取，包括空闲 add；因此点击“开始此条”可能与自动领取竞争，失败后刷新真实队列，不重新 add/start。
- 提交确认丢失时，按本次 clientUserMessageId 查询对账；不能确定时保留草稿并提示人工核对，不自动重发。这不是跨刷新/人工再次点击的永久 exactly-once 保证。
- 页面编辑队列保留图片、skill 等非文本输入；一次性规划指令不兼容原生队列时明确拒绝并保稿。

## 自动化复现

使用当前工作树与已安装依赖。4173 只用于仓库要求的浏览器/性能验证，须检查 PID/cwd；13511 为常驻验收实例，13510 不作为本批测试目标。

```bash
pnpm run test:unit
pnpm run build
node -e "process.argv=['node','dist-cli/index.js','--help']; import('./dist-cli/index.js')"
PHASE2_THREAD_ID=<隔离TestChat线程> node scripts/verify-codex-phase2-native.cjs
PHASE2_THREAD_ID=<隔离TestChat线程> node scripts/verify-codex-phase2.cjs
PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_WAIT_MS=7000 pnpm run profile:browser
PROFILE_BASE_URL=http://127.0.0.1:4173 PROFILE_ROUTE='#/thread/<隔离TestChat线程>' PROFILE_WAIT_MS=7000 pnpm run profile:browser
```

原生脚本要求独立 acceptance HOME、固定版本、起始空队列且无 Goal；只对自建只读 TestChat 发起有界命令及标记请求。先准备 README 和真实 `PHASE2_READY_20260905` 文件链接回复，保存 thread ID。UI 脚本先验证真实文件链接，再在浏览器内拦截和合成稀有状态，不向真实 CLI 提交夹具变更。

详细操作、预期与清理见 [分域手工用例](../tests/chat-composer-rendering/native-thread-controls.md)。输出 `phase2-native-report.json`、`phase2-browser-report.json`、`phase2-docker-report.json` 和截图均在 `output/playwright/`。

打包容器复用首批已验证镜像中的 CLI 与 npm 缓存，将本次小 tarball 安装到独立 `/opt/phase2` 前缀，PATH 优先使用新入口；不是升级备份。避免全局重装对旧包目录的 rename/copy-up 慢路径，本次 164 个依赖安装耗时 19 秒。无此缓存镜像时先使用首批 Dockerfile 构建基础镜像，不能假设 Docker Hub 存在这个本地标签。

```bash
pnpm pack --pack-destination /tmp
BUILD_CONTEXT=$(mktemp -d /tmp/codexui-phase2-package.XXXXXX)
cp /tmp/linux-codex-webui-0.1.87.tgz "$BUILD_CONTEXT/linux-codex-webui.tgz"
docker build -t linux-codex-webui-phase2:5eba11f -f scripts/docker-codex-phase2.Dockerfile "$BUILD_CONTEXT"
PHASE1_DOCKER_IMAGE=linux-codex-webui-phase2:5eba11f CODEX_ACCEPTANCE_REPORT_PREFIX=phase2 node scripts/verify-codex-phase1-docker.cjs
rm "$BUILD_CONTEXT/linux-codex-webui.tgz"
rmdir "$BUILD_CONTEXT"
```

四个场景沿用当前 Codex-only 架构：无 auth、畸形 auth、假凭据 401 持久错误、原生自定义 provider 切换。不重新引入已经移除的 Zen 回退和独立 OpenRouter UI。仅占用 4191–4194，脚本最终清理自己的容器，绝不停止其他容器。

## 验证与性能证据

- 63 个测试文件、620 个用例通过，vue-tsc、Vite/tsup 构建及公开 ESM CLI 的 CJS 动态导入帮助命令退出 0。
- 真实 Astra low 的同回合插话进入最终回复；Goal CRUD/预算保留、thread settings 和只读权限、turn settings applied、队列增删改排序及 CLI 自动续跑均有真实 RPC 和模型输出证据。手动 start 在实测中输给 CLI 自动领取，未冒充该次手动开始成功；该竞争的无重发/重新对账路径有单测，UI 的 start 请求另有夹具覆盖。
- 浏览器六种主题/尺寸（1280×900、375×812、768×1024 × light/dark）通过，页面异常为 0；文件 href/title/text、过期插话保稿、权限禁止项、目标刷新/双标签同步、队列附件与排序都检查实际控件。面板整体不超过半屏。
- 打包 Docker 四场景（4191–4194）通过；假 401 在明暗主题刷新后均保留一条错误、零重复 live overlay，原生 provider 由 Astra 目录切换到 Luna。配置与 auth 均为自建假数据，未向供应商发送真实坏凭据。安装入口核实位于 `/opt/phase2/node_modules/linux-codex-webui/dist-cli/index.js`，包含本批业务提交，并通过 CJS 动态导入帮助冒烟；测试容器已清理。
- Schema 目录 20 个并发调用合并为 1 次外部生成，按 CLI 路径/大小/mtime 失效；临时目录 finally 清理。前端能力 Promise 合并；运行 generation/通知流更换或手动重读后失效。
- 原生新状态复用既有 WebSocket，没有新增 socket 或原生队列轮询。目标/设置缓存有版本校验，设置最多 128 线程；队列列表 20 页/2000 项/8 MiB 上限、首屏 20 条，120 ms 合并通知；权限仅展开面板后加载。原生归属最多 4096 项，活跃线程锁最多 64 个，不读取大份聊天历史来确认设置。
- 4173 首页 API 182.0 KiB、thread/list 1 次；线程 API 126.3 KiB、resume 1 次、首次真实消息 1288.7 ms、重复历史页 0。新增开关发现为每个前端能力缓存周期 2 页、19.9 KiB；选中线程另有 1 次归属/设置快照和 1 次 Goal 读取。不是零成本升级。
- 线程仍有原有 `threadListFirstPage=2` 告警，首页 config/read 2 次；不扩大本批去改旧列表/配置调度。线程观察到 2 个长任务、最大 185 ms，首页 1 个、最大 176 ms。此为单次开发服务器采样，不是多轮生产 P95，不证明性能改善；CLI 内部 item 查询未被浏览器 profiler 测量。
- 本批主入口约 693.4 kB / gzip 215 kB，首批为 666.29 kB / gzip 204.92 kB；新原生控制增加约 27 kB，仍存在已有 chunk 大小警告，无新增运行时依赖。后续拆包应作为独立优化验证。

## 部署与剩余工作

- 本批只允许更新 13511 的隔离验收产物，不升级/重启 13510。复用现有兼容 node_modules 和固定 CLI，不备份、不复制全量依赖或正式历史。
- 更新前核对 13511 无活动任务、审批和待执行消息；保留已有验收 HOME 与会话，升级所需开关只加在验收配置。更新后验证 systemd、监听、HTTP 登录、实际 WebUI 提交、CLI 路径/HOME、线程集合及原生方法。
- 若回退，先清空原生队列并切回兼容归属；也可继续使用支持原生归属的构建。回退更旧且不识别原生归属的 WebUI 前，不能遗留待执行原生消息。已有历史版本可直接调用，不为回滚新建备份。
- 第三批的实时音频/远控、更多 agents/plugins 工具、非文本工具图片完整呈现、旧 quoted-title Markdown 问题和全量 CLI 对齐均未包含在本批。
