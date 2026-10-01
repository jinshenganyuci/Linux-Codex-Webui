# 任务计划进度卡、工具兼容与恢复

## 功能与范围

恢复多步骤任务的结构化计划工具，保留原紧凑卡片，常驻显示已确认完成数量和实际正在执行的步骤。计划文稿与执行清单分别保存；回合结束不能替代步骤完成。活动进度由服务端保存，刷新或无缓存浏览器从同一服务恢复；服务重启后先显示最后确认进度，再核验原生回合状态。

只在隔离的 `http://127.0.0.1:13511` 验收。正式 13510 不属于本轮部署范围。代码分支 `feat/plan-progress-20260927`，工作目录 `/root/.local/share/linux-codex-webui/worktrees/plan-progress-20260927`。

## 操作与预期

1. 用新浏览器开始一个有三步的任务。确认真实模型收到 `update_plan` 并调用它，WebSocket 收到 `turn/plan/updated` 与服务端确认后的 `codex-ui/plan-updated`。卡头常驻数量与进行中的步骤；模型没有标记进行中的步骤时，不能把下一条待做步骤当作正在执行。
2. 第一步完成、第二步进行中时收起卡片。确认折叠条仍显示 `1/3` 和第二步名称；后续更新不能把用户手动收起的卡片撑开。刷新后手动选择保留。
3. 全部三步已标记完成但回合仍运行时显示“步骤已完成”；回合正常结束后才显示“已完成”。只完成一步便正常结束时显示“本轮结束，剩余步骤未确认”，不补勾另外两步。
4. 分别测试失败、停止、重连和未知恢复状态。保留最后确认的步骤，显示真实标签；不能把网络断线标记为任务失败或成功。
5. 点击运行状态区的当前计划摘要。确认展开并聚焦到当前根任务的计划卡，不新增历史读取请求，不跳到子任务或其他回合。
6. 同回合放入两个不同原生计划文稿和一份执行清单。三份内容、身份与折叠选择独立，刷新前后不相互覆盖；只有计划文稿可显示“执行计划”按钮。
7. 模型执行期间关闭页面，稍后用空 Cookie、空 localStorage、禁用 HTTP 缓存和 Service Worker 的浏览器重开。确认服务端已保存的进度恢复，完成摘要留在所属回合，未载入的历史回合不在消息尾部堆叠。
8. 在隔离服务测试正常重启与恢复文件回放。活动快照先为“状态待确认”；原生核验后按实际状态显示，无法核验保持未知。正常优雅停止应等任务结束并保存最后事件；异常退出仅保证最近一次成功写入的状态。
9. 回放重复通知、终态后的迟到更新、旧握手晚于新事件、父子任务同名步骤，以及删除聊天后迟到事件。不能出现重复卡、终态复活、串线、删除复活或子代理加入主侧栏。
10. 分别在用户与项目信任配置中显式关闭计划工具。确认 WebUI 尊重原生解析出的配置层，不覆盖关闭项；重新开启后真实请求工具目录包含 `update_plan`。旧会话恢复保留原有开发者指令，新会话在保留已有指令的基础上附加简短进度指导。
11. 手机 `375×812`、平板 `768×1024`、桌面 `1440×900` 的明暗主题检查长步骤换行、状态文字、键盘焦点、触摸命中和横向溢出。减少动态效果设置下仍可清楚判断进行项。

## 自动化命令

```bash
pnpm run test:unit
pnpm run build
node -e "process.argv=['node','dist-cli/index.js','--help']; import('./dist-cli/index.js')"
PROFILE_BASE_URL=http://127.0.0.1:13511 node scripts/verify-plan-progress.cjs
PROFILE_BASE_URL=http://127.0.0.1:13511 PLAN_NATIVE_KEEP=1 node scripts/verify-plan-progress-native.cjs
PROFILE_BASE_URL=http://127.0.0.1:13511 PROFILE_WAIT_MS=7000 pnpm run profile:browser
```

浏览器脚本使用 Playwright CJS，因为需要受控通知回放、重复/迟到事件、缓存禁用、刷新和接口响应拦截。所有合成请求限定到测试 ID 并禁止真实写入；原生脚本单独建立自己的真实模型测试会话并在报告中标明，不能把合成回放算成模型实测。

工具启用涉及运行时与会话参数，另运行打包 Docker 的认证、错误刷新、供应商切换与快速模式回归。隔离容器仅使用假凭据和本地假供应商，不请求真实模型，结束后清理自己的容器与网络。

## 性能与数据边界

- 实时进度复用原通知连接；无新增计划轮询，计划历史与聊天历史并行读取。
- 活动快照按变化合并写入、终态及时保存；缓存、文本、步骤和持久文件均有上限。活动/待确认计划应优先于可从历史恢复的终态摘要保留。
- 新建或恢复会话时通过原生配置层确认计划开关，合并同目录的并发读取，不自己解析 TOML、不修改用户配置、不重启 CLI 来启用工具。实际额外请求数与耗时以验收报告为准。
- 重启校验只查有限回合摘要，不读取全聊天正文；无结果、超时和不支持均不能推断完成。
- 历史终态摘要仍有每线程 128、全局 2048 条保留上限，不能把刷新恢复承诺为所有历史永久保存。过去没有采集到的清单不会凭文字伪造。
- 步骤进度是模型最后确认状态，不能当作耗时比例或生成时延承诺。
- Codex 0.154.0 对同一进程内已加载会话的工具配置具有粘性，重新调用 `thread/resume` 不保证改变既有工具目录。新会话及新进程第一次从磁盘恢复旧会话已通过真实工具目录验证；修改开关不等同于热更新，不为此强制卸载运行中的聊天。

## 验收记录

2026-09-27，最终 76 个测试文件、820 项全量单测通过；类型检查、完整构建、隔离 `CODEX_HOME` 的 CJS 动态导入 CLI 帮助检查通过。后续完成态单行调整的 21 项组件回归和前端构建通过。

- 13511 配套后端 `47e2280` 来自干净构建，实际 CLI `0.154.0`；最终前端 `5e67870` 包含单行卡与最后的状态去重修复，33 个实际 HTTP 文件与构建一致。新 release 为 `/root/.local/share/linux-codex-webui/releases/plan-progress-20260927`，沿用隔离验收 home 及原密码来源。持久 override 为 `/etc/systemd/system/codex-webui-13511.service.d/zzzzzzz-plan-progress-20260927.conf`。
- 真实模型沿用验收配置 `gpt-5.6-luna`，两轮任务分别收到真实 `turn/plan/updated` 与权威快照。第一轮明确只完成 1/3，终态为 `incomplete`，约 6.28 秒；第二轮有三次步骤更新并最终 3/3，终态为 `completed`，约 10.04 秒。时间含模型处理，不能当作页面加载耗时或 SLA。刷新与空浏览器均保留两份清单，无重复卡；配置 SHA 未变。报告 `output/playwright/plan-progress/native/report.json`。
- 自动触发实测：另在临时目录要求模型实现温度转换 CLI、编写并运行 unittest、检查命令行用法，提示中没有提及计划或 `update_plan`。模型自行产生四步清单，依次记录检查目录、实现、测试、总结，最终 4/4 完成；约 41.27 秒，五个权威版本，结束后已删除自建会话和临时目录。报告 `automatic-report.json`，脚本 `output/verify-plan-auto.cjs`。这证明本机多步骤任务能自动触发；简单问答仍可不生成计划，不能保证所有模型每次都遵从步骤更新。
- 真实重启验收：仅将上述自建测试会话的两份落盘快照改成 `live`，模拟停止前未收到终态，再启动 13511。握手先返回两份 `unconfirmed`，有界原生核验分别恢复 `incomplete` 和 `completed`，并继续递增版本。没有修改其他会话或伪装为突然断电实测。报告 `restart-report.json`，操作脚本 `output/verify-plan-restart.cjs`。
- 重启后在需要密码的 `127.0.0.2:13511` 使用两个全新浏览器实际登录，375×812 暗色及 1440×900 浅色均恢复两份卡，完成卡高 46px。登录约 315/322 ms，登录后到卡片检查通过约 248/434 ms；Cookie/origins 初始为空、HTTP 缓存及 Service Worker 禁用。报告 `authenticated-restart-report.json`。
- 合成 UI 验收 18/18，通过后另完成 6 组截图可见性复验。包括明暗三视口、真实 DOM 聚焦、手动折叠刷新、文稿与清单隔离、父子隔离、重复与迟到、截断、保存失败与恢复。每个 document 的会话摘要与计划历史各一次，真实写入/页面错误/HTTP 错误均为 0；报告 `final/report.json` 与 `final-visual/report.json`。数据均为合成回放，不能替代上面的真实模型验证。
- 两个独立 Node 进程同时保存各 20 份计划，40 份全部保留；删除后旧进程重放保持 39 份，不复活。64 个约 400,783 字节快照下 500 次更新和快照复制，中位 0.072 ms、p95 0.298 ms；活动写入突发合并、失败保留旧文件、后续恢复、删除与启动竞态均有回归。
- 最终性能复验：首次 profiler 报告重复首屏 2 次，追踪确认是目录外直链的已知摘要未参与 no-op 状态判断，与计划事件无关。`5e67870` 仅补齐该判断，保持目录过滤和真实状态变化刷新；183 项相关回归通过。最终 profiler `warnings=[]`，首屏列表 1 次、后续游标 1 次、resume 1 次、摘要 read 1 次、完整 thread/read 0 次、历史重复 0，API 总量 292.4 KiB。报告 `output/playwright/browser-runtime-profile-thread-01a0dec2-dde1-72c3-be41-a506b3ab7c90-2026-09-26T17-40-26-985Z.json`；此前失败样本保留。最终 23 个可达 JS/CSS 原始增加 12,575 字节、gzip 增加 4,226 字节；既有大 chunk 构建提示仍存在。
- 最终部署回执 `output/playwright/plan-progress/deployment.json` 为 `complete`。两项真实模型验收会话均已删除且活动/终态摘要清理；自动开发任务由原生 CLI 添加的唯一临时目录信任条目已移除，验收配置精确恢复到开始时 SHA。正式 PID 271118、启动时间、重启次数、配置及前后端入口哈希全部未变；没有向正式 13510 运行服务发布本次功能。4173、4191–4194、5900、5910 无本轮遗留监听。

截图 URL：`http://127.0.0.1:13511/#/thread/01a0aaaa-0000-7000-8000-000000000001`（合成，脚本运行期间有效），视口 375×812 暗色。当前步骤及完成小条均已目视确认，无横向溢出、无深色页面亮底错误。

![当前步骤与本轮定位](/root/.local/share/linux-codex-webui/worktrees/plan-progress-20260927/output/playwright/plan-progress/final/live-375-dark-current-step.png)

![完成后保持单行小卡](/root/.local/share/linux-codex-webui/worktrees/plan-progress-20260927/output/playwright/plan-progress/final-visual/restoration-375-dark-completed-compact.png)

真实重启、重新登录 URL：`http://127.0.0.2:13511/#/thread/01a0dec2-dde1-72c3-be41-a506b3ab7c90`，视口 375×812 暗色。测试会话在全部验收结束后删除，截图仍保留：

![真实任务完成后重新登录恢复](/root/.local/share/linux-codex-webui/worktrees/plan-progress-20260927/output/playwright/plan-progress/authenticated-restored-375-dark.png)

### 打包 Docker 回归

```bash
pnpm pack --pack-destination <temporary-context>
# 将本机已验证的 @openai/codex 与 codex-linux-x64 发行包复制进临时 context/codex-runtime，勿复制 CODEX_HOME。
docker build -f scripts/docker-plan-progress-acceptance.Dockerfile \
  --build-arg BASE_IMAGE=linux-codex-webui-startup-complete:20260926 \
  --build-arg CODEX_VERSION=0.154.0 \
  -t linux-codex-webui-plan-progress:20260927-47e2280-cli01540 <temporary-context>
PHASE1_DOCKER_IMAGE=linux-codex-webui-plan-progress:20260927-47e2280-cli01540 \
  CODEX_EXPECTED_VERSION=0.154.0 VERIFY_THREAD_FAST=1 \
  CODEX_ACCEPTANCE_REPORT_PREFIX=plan-progress-20260927 \
  node scripts/verify-codex-phase1-docker.cjs
```

五类通过：4191 无认证、4192 损坏认证均可打开界面且不启用已移除的 Zen 回退；4193 的假 401 错误明暗刷新后保留一条、实时浮层 0；4194 本地假供应商 alpha→beta 的模型目录切换，以及独立 Fast=`priority`/Standard=`null` 请求和偏好均正确。没有真实凭据或真实模型请求。实际 CLI 为 0.154.0，镜像入口和 CLI 二进制 SHA 与来源一致。报告及哈希在 `output/playwright/plan-progress-20260927-docker-report.json` 和 `plan-progress-docker-provenance.json`；容器、网络、4191–4194 监听及临时 context 已清理。

测试环境修正：基础镜像原来继承 CLI 0.153.4，版本断言已抓到并改为明确复制固定 0.154.0 发行包；注册表当前无法安装该版本，没有静默替换版本。此主机 Docker internal bridge 无法发布测试端口，改成临时普通 bridge 且只绑定 localhost。准备失败记录保留，最终成功只指上述镜像。另一次 CLI 帮助探测参数错误曾短暂启动自己的 5900，已停止并修正为隔离 home；误写的密码提示已按正式 runner 恢复，确认的测试快照移出正式 home，正式运行凭据未变。后续全量测试在临时 home 执行，桥接单测的持久化改为显式选择，防止继承真实 home。

## 部署、回滚和清理

前后端和通知版本标记需同次发布。先在隔离 13511 创建独立 release、保留原配置及认证来源，确认无活动任务后切换；不得复制测试 home 到正式服务。回退恢复原 13511 服务入口并空闲重启，新增活动快照文件可保留，旧版忽略它；既有历史摘要维持兼容格式。

原生脚本只允许删除自己创建的会话。使用 `PLAN_NATIVE_KEEP=1` 时记录报告内的 `threadId`，完成重启验证后删除该测试会话及其摘要；不清理其他聊天、配置、登录和历史数据。合成浏览器脚本不写真实会话。

## 随后的正式 13510 升级授权（2026-09-30 发起，10-01 准备完成）

用户已明确要求升级 13510。新正式 release 为 `/root/.local/share/linux-codex-webui/releases/plan-progress-13510-20260930`，复制已验收后端 `47e2280`、前端 `5e67870`，源构建与 13511 当前发布的 33/2 个文件哈希一致；固定 CLI 0.154.0 不变。继续使用正式 `/root/.codex`、`/root/Codex-Webui` 工作目录以及旧 runner 的密码来源，测试 home 不复制到正式端。

部署脚本与两个验证脚本复制到独立目录，文件哈希写入准备回执，防止工作区后续变化影响待执行作业。作业 `codex-webui-deploy-plan-20260930.service` 在服务外持久运行，并持有 `13510-deploy.lock`；三个空闲样本后才记录原交互列表 ID、配置/偏好、登录令牌摘要和 JSONL 文件前缀 SHA。切换使用原子服务覆盖 `/etc/systemd/system/codex-webui-13510.service.d/zzzzzzz-plan-progress-20260930.conf`，优雅等待抢先进入的任务完成。若主机在等待期间重启，只在旧版本与原单元指纹不变时重新准备；若切换阶段中断，核对实际新旧版本再继续验证或回滚。

计划兼容副本与完整聊天备份分开：只保存小型 `plan-summary-history` 和 `active-plans` 原始文件及存在性/哈希，升级后校验已有摘要内容保留。回滚前停止新版并另存其最后状态，副本一旦完整写入便不再被重试覆盖；不会以升级前副本覆盖新聊天。旧版本无法表示同回合的独立文稿/清单，保留新版副本是恢复该信息的依据。

```bash
node scripts/deploy-plan-production.cjs --self-test
node scripts/deploy-plan-production.cjs --prepare
systemd-analyze verify /etc/systemd/system/codex-webui-deploy-plan-20260930.service
systemctl show codex-webui-deploy-plan-20260930.service -p ActiveState -p SubState -p MainPID -p ControlGroup
cat /root/.local/share/linux-codex-webui/deployments/13510-plan-progress-20260930/status.json
```

实际准备阶段通过：隔离 home 的 CLI 帮助检查、脚本语法与空闲/中断/副本不覆盖自测、单元校验、7 个验收 URL 门控用例，以及 13511 手机暗色两项夹具预演。预演报告 `output/playwright/plan-progress/production-rehearsal-20260930/report.json`，视口 375×812、URL `http://127.0.0.1:13511/#/thread/01a0aaaa-0000-7000-8000-000000000001`。下图是预演证据，不代表正式升级已完成：

![13511 正式升级前计划卡预演](/root/.local/share/linux-codex-webui/worktrees/plan-progress-20260927/output/playwright/plan-progress/production-rehearsal-20260930/live-375-dark-current-step.png)

切换后作业自动运行两项真实密码登录浏览器检查（首页/旧聊天，1440×900 明暗），再在显式允许的 `127.0.0.1:13510` 运行手机暗色 live/restoration 两项计划夹具；夹具不写真实聊天，不调用生产模型。另直接检查真实 WebSocket `ready.planSnapshotsVersion=1`。旧聊天恢复可能由后端为当前会话启用计划工具并追加原生上下文，所以校验允许 JSONL 尾部正常追加，禁止已有字节被改写或截短。

```bash
PLAN_ALLOW_PRODUCTION=1 PROFILE_BASE_URL=http://127.0.0.1:13510 \
PLAN_RUN_LABEL=production-20260930 PLAN_VIEWPORTS=375 PLAN_THEMES=dark \
PLAN_CASES=live,restoration node scripts/verify-plan-progress.cjs
```

最终回执目录 `/root/.local/share/linux-codex-webui/deployments/13510-plan-progress-20260930` 包含 `preflight.json`、`status.json`、`deploy.log` 和 `browser/report.json`；计划卡报告在工作区 `output/playwright/plan-progress/production-20260930/report.json`。记录时作业为 `waiting-for-idle`，发起对话仍在执行，正式覆盖尚未安装；必须看到最终 `complete` 才能认定正式升级成功。出错时回滚需同时校验旧后端和旧前端 HTTP 文件，而非只比后端提交号。13511 保持原进程与产物。
