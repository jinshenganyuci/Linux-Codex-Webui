# Codex 0.153.4 首批升级与验收

基准日期：2026-09-05。代码起点为 `dev` 的 `69750e8`，协议与模型目录取自完整安装的 Codex CLI `0.153.4`。这里的“支持”不等于供应商已经开放全部能力，也不代表 WebUI 已经与 CLI 全量功能对齐。

本文保留首批验收时的能力边界；后续原生会话控制见 [第二批说明](codex-0.153.4-phase2.md)。首批之后用户已单独要求升级 13510，并明确今后升级不创建备份；后续操作遵循这个最新约定。

## 已实现的边界

| 能力 | 实现与证据 | 未承诺的部分 |
| --- | --- | --- |
| 运行身份 | 设置中展示 WebUI 构建提交、是否有未提交文件、CLI 握手版本、启动时间、可执行路径与 CODEX_HOME；GET `/codex-api/runtime-info` 可核对 | 全局 `codex --version` 不能代替常驻进程身份；开发服务器显示 development |
| Astra 目录 | 隔离准备工具从指定 CLI 的完整 bundled 目录补入缺失的完整条目；保留原模型、提供商及默认设置 | 不覆盖既有同名自定义条目，不修改正式配置，不自动切换默认模型 |
| 推理与 Fast | 优先使用运行中 `model/list`，缺失条目才使用同版本 bundled 元数据；保留六档到 ultra，Fast 使用真实 tier `priority`；展示元数据来源说明 | 别名不猜测匹配；元数据未知不冒充支持；真实 ultra 的推理效果、Fast 加速或计费未实测 |
| 请求生命周期 | 数字与字符串 ID 区分；处理原生 `serverRequest/resolved`、generation、线程归属、重复通知与过期快照 | 原生关闭仅记录“未作答”，不编造答案；有界去重不承诺无限期重放日志 |
| 非阻塞提问 | `isBlocking: false` 不占用普通聊天输入，不把普通消息误当答案；保留独立回答入口和明确文案 | 命令、文件与权限审批仍按阻塞请求处理；不扩展成第二批原生 steering |
| 运行提示 | 独立展示安全缓冲、账号验证、认证恢复、服务端模型重路由、审核信息；随现有 runtime-state 恢复 | 验证不自动通过；重路由不等于客户端修改模型；不展示任意审核或认证原始 JSON；进程重启会清空瞬态提示 |
| 消息渲染 | sleep、functionCallOutput、subAgentActivity、hookPrompt、contextCompaction 的折叠摘要；agentMessage phase；未知类型安全文本摘要 | 非文本工具输出的完整图片展示不是本批目标；不实现原生 Goals/新权限管理全套界面 |
| 错误保留 | 移除“不支持模型”时自动换模型、回滚并重发消息的旧路径；保留原错误与用户选择 | 不把供应商 401 或不支持模型错误伪装成成功，不自动降级到其他提供商 |

## 隔离准备和固定运行时

固定的是完整 npm 安装树（JS 入口、平台包、辅助程序），不是从 `/proc` 拷出的单个旧二进制。实际部署通过 `CODEXUI_CODEX_COMMAND` 指向该树中的有效程序；应先执行该路径的 `--version`，不要假设不同发布的 vendor 子目录一致。

在新目录预览，不写源目录：

```bash
node scripts/prepare-codex-acceptance.mjs \
  --source-home /root/.codex \
  --target-home /root/.local/share/linux-codex-webui/acceptance/example-new-home \
  --codex-command /absolute/path/to/pinned/codex \
  --add-model gpt-6-astra
```

确认预览后加 `--apply`。目标必须不存在，且不能位于源 CODEX_HOME 内；再次运行不会覆盖已有目标。只在确实需要复制 `auth.json` 时显式加 `--copy-auth`，源文件缺失会报错而不是静默忽略。

- 复制配置及模型目录，但不复制 sessions、SQLite、队列、历史和终端状态。
- `model_catalog_json`、`sqlite_home`、`log_dir` 改为目标内的路径；保留上下文窗口、压缩阈值、默认模型及提供商设置。
- 配置可能本身包含 `experimental_bearer_token`、HTTP headers 等凭据。目录为 0700，配置/目录文件为 0600；不把这些文件加入 Git、Docker 构建上下文或验收截图。
- 同名自定义模型条目保持原样；若它本身过时，需要另行审阅，不用 bundled 数据静默覆盖。
- 模型元数据的外部命令按路径及实际运行版本合并缓存。100 个并发读取仅执行一次版本检查和一次目录读取；单次 8 秒超时、16 MiB 输出上限。版本不一致或命令不支持时明确降级，失败结果不会产生重试风暴。

## 本机部署与回滚边界

- `13510` 为正式实例，本批不重启、不部署、不迁移其数据库或模型目录。
- `13511` 为业务验收实例，使用独立 CODEX_HOME、固定 CLI 和独立发布目录；浏览器验收使用仓库规则指定的 `4173`，也有单独 CODEX_HOME。
- 切换测试实例前先核对 systemd PID、监听端口与 cwd；确认 runtime-info 的 `busy: false`、无活动回合、pending 请求及队列为空。按用户最新要求不创建备份，复用已有兼容依赖，只切换已验证产物。切换后同时验证 HTTP、实际 CLI 握手、运行目录、模型目录和保留的验收线程。
- 源码回退不是运行时回退。正式实例没有升级，无需正式回滚。测试回滚应指向保存的旧 WebUI 产物，同时保留隔离 CODEX_HOME 和完整固定 CLI，不直接恢复会共享正式 HOME 的原 runner。
- 今后正式升级须有明确的 13510 升级请求，不再备份 home/config/catalog 或重复复制完整依赖树；直接使用已验证发布产物和固定 CLI，仍不得拿正式数据库做隔离升级验收。

## 自动化验收

```bash
pnpm run test:unit -- --reporter=dot
pnpm run build
CODEX_HOME=/absolute/path/to/isolated-home node -e "process.argv=['node','linux-codex-webui','--help']; import('./dist-cli/index.js')"
PHASE1_THREAD_ID=<isolated-TestChat-thread> node scripts/verify-codex-phase1.cjs
```

包公开入口是 ESM；最后一条 Node 入口冒烟从 CJS `node -e` 动态导入公开 CLI，预期打印帮助并退出 0，不启动服务。

Browser Use 无法可靠完成本批的 RPC 拦截和 WebSocket/page-context 合成事件，因此按仓库例外直接使用 Playwright CJS。UI 脚本默认 `127.0.0.1:4173`，检查真实 TestChat 的 README 文件链接、六档菜单、非阻塞请求、原生关闭、刷新恢复、五种新消息以及运行信息。安全提示等稀有事件在浏览器内注入，不伪造上游真实回包、不向真实 CLI 提交虚构答案。覆盖 1280×900、375×812、768×1024 的明暗主题；报告与截图在 `output/playwright/`。

Docker 打包路径：

```bash
pnpm run build
BUILD_CONTEXT=$(mktemp -d /tmp/codexui-phase1-package.XXXXXX)
pnpm pack --pack-destination "$BUILD_CONTEXT"
mv "$BUILD_CONTEXT"/linux-codex-webui-*.tgz "$BUILD_CONTEXT/linux-codex-webui.tgz"
docker build -t linux-codex-webui-phase1:20260905 \
  -f scripts/docker-codex-phase1.Dockerfile "$BUILD_CONTEXT"
node scripts/verify-codex-phase1-docker.cjs
rm -r "$BUILD_CONTEXT"
```

先确认本机 4191–4194 空闲。容器内部监听 4190，宿主验收不用 4190，因为当前 fetch/浏览器会把该端口判为受限端口。四场景为无 auth、畸形 auth、假凭据 401、原生 custom provider alpha→beta。均使用 `/codex-home` 和假凭据，401 来自容器内 mock；并非真实账号失效实验。脚本退出后删除自己的容器与临时 home，不处理其他容器。

当前项目为 Codex-only，旧文档中的 Zen 自动回退和独立 OpenRouter UI 已移除，因此不重新引入它们；通过原生 Codex 配置切换 alpha/beta 验证模型目录刷新。无/畸形 auth 应保持可用界面且不回退到其他提供商；401 应持久留在失败回合，刷新后恰好一条错误，无重复 live overlay，无自动回滚或换模型。

## 2026-09-05 验收记录与性能审计

- 单元测试：59 文件、591 用例通过；包含数字/字符串 ID、原生/手动作答竞争、过期 generation、非阻塞聊天、模型来源、版本错配、敏感字段不外泄和输出预算。
- 真实 Astra：隔离 TestChat 中以 low 读取当前目录 README，commandExecution 与最终标记均完成。只证明这一条实际工具读取链路；没有把 UI 选项存在当成 ultra/Fast 已生效。
- Docker 四场景通过；401 在明暗两种主题刷新后保留，重复 live overlay 为 0；切换后的 provider 模型由 Astra 变为 Luna。
- 浏览器六种主题/尺寸组合通过，页面异常为 0；README 链接的 `hrefOk`、`titleOk`、`textOk` 均为 true；原生关闭后刷新不复活提问。
- 首页 profiler：API 总量 156.3 KiB，provider-models、skills、rateLimits、thread/list 首屏各 1 次，无告警。
- 线程 profiler：API 总量 92.6 KiB，首次真实消息约 656 ms，thread/resume 1 次，无重复历史页；报告有 `threadListFirstPage=2`。`69750e8` 已有终态恢复后强制刷新列表的路径，本批未更改其触发条件，保留为后续列表去重优化项，不伪报零重复。
- 新状态复用已有 runtime-state 请求，无新增轮询；运行信息懒加载，仅打开设置时读取一次。提示最多 64 线程、每线程 5 类，每条最多 4×1000 字符；新输出事件 64 KiB、历史与命令输出共用 512 KiB 预算，UI 摘要 32 KiB 并默认折叠。
- 构建主入口 666.29 kB / gzip 204.92 kB，运行信息懒加载块 1.92 kB / gzip 0.94 kB；CLI 778.57 KiB。构建体积是当前实测值，不与身份不明的旧部署混算回归比例。
- 没有同环境多轮旧版 P95 基线，不宣称性能提升或满足某个百分比阈值。记录真实请求数、首次消息时间和构建体积，而不是以构建通过替代性能审计。

## 另行跟进

TestChat 发现原有 Markdown 解析器对带可选 quoted title 的外部链接处理不正确；本批没有修改该解析器，README 文件链接验收通过不代表该旧问题已修复。原生 steering/queue、Goals、新权限完整管理、工具图片输出完整呈现属于后续批次。
