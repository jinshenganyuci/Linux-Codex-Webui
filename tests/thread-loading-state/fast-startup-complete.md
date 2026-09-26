# 无缓存访问、历史发现与独立聊天启动

## 目标与验收边界

任何新浏览器在完成必要认证后，无需预存 Cookie、localStorage、HTTP 缓存或 Service Worker，即可开始新聊天、直接打开旧聊天，并查找首屏之外的历史。正常读取使用 Codex 实时索引；外部复制或索引缺条通过后台恢复补齐，不能以每次访问扫描全量 JSONL 代替恢复机制。

必须分别记录页面输入框出现、必要配置就绪、实际发出线程/回合请求、首个真实回复、列表出现和旧消息出现的时间。按钮可点击不等于消息已经成功发送。模型生成耗时与 WebUI 初始化耗时分开报告。

## 前置条件

1. 使用独立 13511 和隔离 CODEX_HOME；正式 13510 不在常规验证范围内。
2. 准备超过 150 条元数据记录、至少 51 条原生可见聊天，包含已知的首屏之外旧聊天、较长聊天及归档聊天。保存线程 ID、唯一搜索词与数据副本清单，禁止修改正式历史。
3. 固定 Codex 可执行文件并核对运行时返回的版本和 CODEX_HOME，不能只检查全局 CLI。
4. 每个浏览器用例新建上下文，核对初始 Cookie/origins 为空，禁用 HTTP 缓存和 Service Worker；认证场景通过密码重新登录，密码仅由测试进程环境传入。
5. 测试工具需要路由拦截以注入列表延迟、配置延迟和接口失败，因此直接使用 Playwright CJS。截图和结构化记录保存在 `output/playwright/startup-complete/`。

## 操作与预期

### 首页与旧对话

- 分别在桌面浅色/深色、375×812 手机和 768×1024 平板新上下文打开首页、旧对话直接链接；显示真实会话与消息，检查实际主题、可交互控件和页面错误。
- 人工延迟首屏 `thread/list` 8 秒，直接打开一个已知旧对话。历史消息必须在列表响应前显示，且保持原 URL，不误跳首页。
- 使用允许创建测试回合的独立场景，列表仍延迟时立即输入唯一标记并发送。核对真正的 `thread/start`、`turn/start` 或对应复合请求在列表释放前发出，模型、强度、权限及会话 Fast/Plan 语义正确。助手应返回测试标记；不能只等待按钮 enabled 就判定通过。
- 人工延迟必要配置读取，立即发送。应等待必要配置而不等列表；初始化响应不得覆盖用户在等待期间改变的模型或思考强度。

### 历史分页与搜索

- 记录首屏与后续页游标，确认每次只加载一个后续页，无固定 10 秒等待；聊天运行时仍能继续查找旧会话。
- 在后续页等待期间多次刷新首屏，确认后台分页没有被不断重置、没有同游标重复并发或丢失后续页。
- 在首屏之外搜索一个已知旧聊天。应显示完整可点击摘要，即使该聊天尚未进入普通侧栏；点击后消息和标题正确。
- 查询标题/摘要不应读取最近 100 条聊天的全部正文；用户明确选择搜索聊天内容时才开始有界的内容搜索，说明搜索范围和进度。
- 搜索时临时展开有匹配结果的聊天区、项目区和项目组，清空后恢复原折叠偏好；未启用的项目仍按原可见性规则过滤。
- 快速改写、清空搜索词或切换会话，旧响应不得覆盖最新结果；删除、归档和改名后搜索不使用永久过期的索引结果。

### 索引恢复与异常

- 在隔离 CODEX_HOME 放入标准格式的外部 JSONL，验证普通索引列表最初缺条、后台摘要恢复后可见；恢复不得读取所有历史正文。
- 仅在独立测试数据库删除该测试会话的索引行，保留文件；验证后台或明确恢复操作能重新发现它。
- 恢复正在进行时打开首页和旧聊天，普通请求必须保持响应。相同恢复任务合并、并发受限，不能每个浏览器都启动一次全量修复。
- 注入恢复失败，界面应显示可理解的同步状态和重试入口，保留已知正常聊天；恢复后状态消失或更新，不能静默显示“没有聊天”。
- 对已损坏或人为篡改的既有索引元数据，应区分缺条恢复与字段校验，不能宣称一次扫描可以修复所有情况。
- 原生列表不显示的空预览、无名称记录应按原生摘要确认为正常隐藏，不能误报索引损坏；未变化文件的下一轮检查不得重复读取摘要，文件变动或手动重试后重新核验。
- 导入一次性项目后确认新聊天可见，归档、目录与分页过滤正确；不依赖将无关最近 200 条聊天强行补入每一页。

### 运行时与部署

- 服务启动后由服务端预热，确认首次浏览器打开前原生后端已就绪；多个新浏览器不能产生多个原生进程或重复初始化。
- 在确认 13511 空闲后重启，仅核验该服务；构建提交号、CODEX_HOME、CLI 子进程、索引恢复状态和无缓存访问均正确。
- 持久配置必须位于 `/etc/systemd/system/` 或等价持久位置，不能只靠 `/run` 中重启后消失的覆盖文件。核对 systemd 合并后的实际启动路径和服务启用状态。

## 清理与回滚

- 删除仅由本轮创建的唯一测试会话、临时导入项目和测试空目录；保留原历史副本与正式目录不变。
- 关闭本轮独立容器和临时监听；13511 保留已验收版本供用户使用，13510 不受影响。
- 回退时恢复记录的原 13511 启动配置并在空闲时重启；索引读取策略不修改聊天正文，正常历史保持兼容。
- 每次结果须附实际命令、提交号、URL、视口、截图绝对路径、断言、测量值及未覆盖边界；失败用例修复并重跑后才能记录为通过。

## 2026-09-26 核心路径结果

隔离服务为 `http://127.0.0.1:13511`，CLI 固定 0.154.0，历史副本包含 833 个文件（755 个活动目录文件、78 个归档文件）；其中文件数量不等于原生默认列表的可见主聊天数量。主列表搜索候选必须由实际原生分页证明在首 50 条之外，并符合已保存项目的可见性条件。

运行命令（所有结果目录均在当前 worktree）：

```bash
STARTUP_SEND=1 \
STARTUP_CONFIG_PATH=/root/.local/share/linux-codex-webui/acceptance/startup-20260924/config.toml \
STARTUP_SEARCH_THREAD_ID=019ff3bc-fc05-7a81-8dd9-7f31c96c05c8 \
STARTUP_SEARCH_NEEDLE='hermes 这些' \
STARTUP_CASES=delayed-send,search,refresh,index-status \
STARTUP_RUN_LABEL=core-confirm \
node scripts/verify-startup-complete.cjs
```

- 列表人工延迟 8 秒：旧聊天 547 ms 出现（`core` 的独立已通过用例）；完整复验中真实发送 902 ms 被后端接受、4812 ms 收到完整标记回复，均发生在列表释放前。
- 首批之外的旧聊天在阻塞所有后续页时，搜索 308 ms 显示并可打开；没有通过提前放行分页使断言假成功。
- 三次真实 reload 均继续分页；同页 35 次通知引发 12 次首屏刷新时，4 个不同后续游标仍完成，每个后续请求额外人工延迟 500 ms。
- 历史同步 `partial` 与 HTTP 503 的提示、重试在明暗主题通过，成功后提示消失。
- 实际回合创建新独立工作目录时，原生 Codex 会在隔离 `config.toml` 添加该目录的 `trust_level = "trusted"`。验收在内存中解析前后 TOML，只允许本轮真实新线程目录的这一项新增；剔除该项后全部配置一致。不能用整文件哈希变化误报模型配置被覆盖，也不能声称文件逐字节不变。测试线程均已删除。

上述结果见 `output/playwright/startup-complete/core-confirm/report.json`。初始失败报告保留，分别用于追溯真实的目标通知重复刷新，以及测试候选未启用目录、同 URL goto 未真正 reload、配置哈希断言过宽等测试问题；不能把初始失败的报告算作整体通过。

### 原生恢复与搜索边界

- `output/index-recovery-20260926/integration-result.json`：真实 Codex 验证外部历史、归档、旧导入路径及删除索引行后恢复。
- `zip-integration-result.json`：真实 ZIP 导出→导入→原生恢复约 96 ms 可见，标题、项目文件和消息保留；归档、目录、provider、搜索和每页一条的三页过滤正确。
- `hidden-integration-result.json` / `real-hidden-sample-result.json`：有效空记录归为正常隐藏，二次定期检查不再读摘要；20 条真实遗漏样本在独立副本验证分类。
- 正文搜索明确只涉及最近 100 条，读取前要求普通 rollout 文件且单个不超过 2 MiB、本轮候选累计不超过 8 MiB；无法安全读取的项目显示跳过数量。缓存保留量另有限制，真实 RPC 未完成前不会因超时重试再发一个。文件大小守卫不是协议响应字节的绝对上限，文件在 stat 后增长仍存在时间窗口。
- 缺条恢复不擅自修写已有索引的标题或时间。人为修改已存在记录或外部追加内容导致的元数据不一致，仍可能需要原生维护；错误不能静默当作成功。

### 最终矩阵、冷服务与性能剖析

`output/playwright/startup-complete/acceptance-summary.json` 聚合 23 个唯一成功用例；不把旧失败报告计为通过。桌面 1440×900、手机 375×812、平板 768×1024 的首页和旧对话均覆盖明暗主题；折叠搜索另有明暗两组。测试 URL 为 `http://127.0.0.1:13511/#/` 与 `http://127.0.0.1:13511/#/thread/01a09549-9bb5-71c0-955e-dd74cc8e32be`。

- 正常已启动实例、全新浏览器：输入框 220–435 ms，桌面/平板列表 348–515 ms，旧历史 430–699 ms。手机首页默认隐藏侧栏，因此不把侧栏不可见当成列表显示测量。
- 服务重启后首次旧会话（`cold-final`）：输入 317 ms、列表 368 ms、正文 749 ms；WebSocket 实际包含首次 MCP 启动及 `thread/status/changed`、`thread/goal/cleared`，截图等待后主列表仍只有一次请求。这是进程重启后的首个会话读取，不代表重启整台主机或清空操作系统页缓存的测量。
- 整体 732 项单元测试、完整构建通过。构建仍有既有大于 500 kB chunk 提示，不能称为没有任何构建 warning；本次可达 JS/CSS 相比原 13511 增加 10,875 字节（gzip 3,448 字节）。33 个实际 HTTP 文件均与构建哈希一致。

```bash
pnpm run test:unit
pnpm run build
node -e "const {execFileSync}=require('node:child_process'); const assert=require('node:assert/strict'); const help=execFileSync(process.execPath,['dist-cli/index.js','--help'],{encoding:'utf8'}); assert.match(help,/--port/); assert.match(help,/--no-login/); console.log('CJS launcher -> ESM CLI: --port and --no-login available');"
PROFILE_BASE_URL=http://127.0.0.1:13511 \
PROFILE_ROUTE='#/thread/01a09549-9bb5-71c0-955e-dd74cc8e32be' \
PROFILE_WAIT_MS=7000 pnpm run profile:browser
```

标准 profiler 报告 `output/playwright/browser-runtime-profile-thread-01a09549-9bb5-71c0-955e-dd74cc8e32be-2026-09-26T08-55-21-423Z.json`：`warnings=[]`、`totalApiKB=321.9`、首屏列表 1 次、后续页 1 次、resume 1 次、历史分页重复键 0、skills/rateLimits 各 1 次；`topApiSummary`、`slowestApiRows` 已复核，同名前缀 trace ZIP 保留。首页/新回合生命周期仍有现存 prompts、project-root-suggestion 等轻量请求，不宣称消除了所有类型的重复请求。未做外网弱网络 p95、并发压力或长时间内存趋势测试。

截图为实际变更的搜索区域，视口均 1440×900，断言包括临时展开、过滤非匹配行、清空恢复和零布局写入：

![明主题搜索临时展开](/root/.local/share/linux-codex-webui/worktrees/perf-startup-20260924/output/playwright/startup-complete/final-matrix-rest/collapsed-search-light-expanded-results.png)

![暗主题搜索临时展开](/root/.local/share/linux-codex-webui/worktrees/perf-startup-20260924/output/playwright/startup-complete/final-matrix-rest/collapsed-search-dark-expanded-results.png)

### 打包 Docker 回归

```bash
pnpm pack --pack-destination output/startup-complete-package
cp output/startup-complete-package/linux-codex-webui-0.1.87.tgz output/startup-complete-package/linux-codex-webui.tgz
docker build -t linux-codex-webui-startup-complete:20260926 \
  -f scripts/docker-codex-phase3.Dockerfile output/startup-complete-package
PHASE1_DOCKER_IMAGE=linux-codex-webui-startup-complete:20260926 \
CODEX_ACCEPTANCE_REPORT_PREFIX=startup-complete VERIFY_THREAD_FAST=1 \
node scripts/verify-codex-phase1-docker.cjs
```

容器使用固定 Codex 0.153.4、`CODEX_HOME=/codex-home` 和本地模拟供应商，不访问真实收费 API。4191 无认证、4192 损坏认证、4193 失效认证、4194 provider 切换及线程 Fast 模式全部通过。保持本 fork 既有 Codex 行为，没有恢复旧 Zen 回退；失效认证错误在明暗刷新后仍各只显示一次，重复运行覆盖层为 0，普通模式显式覆盖旧全局 priority。

报告 `output/playwright/startup-complete-docker-report.json`；截图绝对目录 `/root/.local/share/linux-codex-webui/worktrees/perf-startup-20260924/output/playwright/`，文件前缀 `startup-complete-docker-`（含 `invalid-auth-light.png`、`invalid-auth-dark.png`）。全部容器及 4191–4194 临时监听已由脚本清理，13511 保留。

### 干净构建、认证与持久部署复验

最终运行版本为 `fbc6bbc5aa048452f226f03e487be0f52dcc2159`，`dirty=false`。构建代码对应 `9967b19`，后续提交仅补验收与部署记录。服务从 `/root/.local/share/linux-codex-webui/releases/startup-complete-20260926` 启动，固定独立验收 `CODEX_HOME` 与 Codex 0.154.0；实际合并的持久覆盖为 `/etc/systemd/system/codex-webui-13511.service.d/zzzzzz-startup-complete-20260926.conf`，`UnitFileState=enabled`。保留原覆盖文件，回退时只移除该新增覆盖后 daemon-reload 并在空闲时重启 13511。没有重启整台主机来验证开机流程。

最后一次空闲重启后，后端约 849 ms 预热就绪，两个全新浏览器完成真实密码登录。密码仅从现有本机配置读取后经子进程环境传递，不写入脚本或报告：

```bash
PROFILE_BASE_URL=http://127.0.0.2:13511 \
STARTUP_CASES=fresh \
STARTUP_FRESH_CASES=home-1440-light,thread-1440-light \
STARTUP_RUN_LABEL=auth-final \
STARTUP_CONFIG_PATH=/root/.local/share/linux-codex-webui/acceptance/startup-20260924/config.toml \
node scripts/verify-startup-complete.cjs
# WEBUI_TEST_PASSWORD 由调用进程私下提供；不要将密码写在终端命令或日志。
```

地址 `127.0.0.2` 确实进入密码页面，报告断言两个用例都有 `loginMs > 0`，不能以 localhost 免认证跳过来替代认证验收。1440×900 浅色首页登录流程 363 ms，登录后列表 245 ms；旧会话登录流程 1396 ms，登录后历史 1328 ms。登录后计时和登录耗时分别记录，不宣称完整登录到旧消息只用一秒。两个新上下文的 Cookie/origins 起始为空、缓存和 Service Worker 禁用，配置文件 SHA 完全未变；后端世代始终为 1，浏览器访问没有重启原生进程。

认证报告 `output/playwright/startup-complete/auth-final/report.json`；截图为同目录的 `home-1440-light.png`、`thread-1440-light.png`，实际 URL 分别为 `http://127.0.0.2:13511/#/` 与 `http://127.0.0.2:13511/#/thread/01a09549-9bb5-71c0-955e-dd74cc8e32be`。加上此前 23 个用例共 25 个浏览器用例，另有 Docker 测试。

最终保留记录 `final-deployment.json`、`preservation-final.json`：13510 PID 656、启动时间、重启次数与原工作目录均未变，正式配置和前后端入口哈希未变；没有向 13510 发送 HTTP 验收请求。13511 检查结果为 833 个文件、480 个原生可见索引、353 个正常隐藏、缺失与失败 0、状态 `ready`；临时 4173、4191–4194、5910 均无本轮 WebUI 监听。代码与文档均本地提交，本轮未推送 GitHub 或升级 13510。
