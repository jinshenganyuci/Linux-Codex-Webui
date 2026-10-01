# Codex 0.159.3 首批兼容与界面升级验收

## 范围与准备

- 日期：2026-10-01。功能分支：`feat/codex-01593-ui-20261001`；最终产品构建为 `51df375`，`dirty=false`。
- 唯一测试地址为 `http://127.0.0.1:13511`。正式 `13510` 不接受本轮 HTTP 测试、不重启、不替换。Docker 与持久预览顺序使用 13511，不并行占用。
- 系统 CLI 从 0.154.0 升至 0.159.3；13511 使用独立安装的 0.159.3。正式运行时仍可独立固定在 0.154.0，不能通过系统版本推断它已升级。
- 预览 home 为 `/root/.local/share/linux-codex-webui/acceptance/codex-01593-ui-20261001`。仅准备所需配置和模型目录，不复制正式会话数据库；测试不输出认证内容。
- 合入本地已验收的计划卡基线，保留旧预览现有的计划功能。本次没有重新执行历史正式部署作业，也没有推送 GitHub。

## 功能复验

1. 按[问题列表与草稿](../chat-composer-rendering/pending-response-inbox-and-drafts.md)切换阻塞/异步问题、跨会话同 ID、刷新及慢加载，验证本机草稿恢复。分别检查 `isSecret` 与旧 `secret` 标志，不得持久保存秘密答案。
2. 模拟一次回复 HTTP 503：错误提示应在操作栏内完整可见，按钮恢复可用、草稿保留；成功重试只清除本题草稿。手机视口也必须通过祖先 overflow 裁切检查，至少 95% 的提示面积可见。
3. 按[运行时诊断](../providers-models/codex-01593-runtime-diagnostics.md)核对系统 CLI、实际 app-server 与记忆状态来源。卡片折叠时不请求诊断；展开和显式刷新才查询。超时或接口不支持显示对应状态，不伪造记忆就绪。
4. 用两回合 TestChat 从首个回复建立分支，分支只保留第一个回合；编辑原聊天第二条用户消息，再刷新，原聊天剩一回合且编辑文本回到输入框。文件 SHA-256 应不变；历史编辑说明明确保留文件，文件撤销是独立操作。
5. 对分页旧错误与实时 interrupted 错误检查原始错误仍可见，计划卡显示“已中断”，不得将系统中断都标成用户停止。
6. 按[有界历史降级](../thread-loading-state/unsupported-items-bounded-history-fallback.md)验证明确不支持 `items/list` 时才顺序读取 full turns；无匹配、上游截断与预算耗尽不得混为完整空结果。

## 自动检查与实际结果

```sh
pnpm run test:unit
pnpm run build
node -e "process.argv=[process.execPath,'./dist-cli/index.js','help']; const entry=require('./dist-cli/index.js'); if(Object.keys(entry).length) throw new Error('Unexpected public CLI exports'); console.log('CJS public CLI help: PASS (no library exports)')"
```

- 全量 86 文件、947 项测试通过；最终错误提示 footer 布局调整后，11 项相关测试再次通过。最终前后端构建及类型检查通过。
- CJS 公共 CLI 帮助入口退出码 0，输出 `CJS public CLI help: PASS (no library exports)`，本包不提供库导出。
- 日志：`output/codex-01593/unit-final.log`、`build-final.log`、`cjs-smoke.log`。
- 原生 0.154.0/0.159.3 各自测试 legacy/paginated 两种模式：完整分支、截至指定回合分支与指定回合之前分支正确；`thread/revert` 仅支持 paginated，新版 legacy 使用前缀分支兼容。证据：`native-history-report.json`。
- 原生 0.159.3 五个白名单能力均完成修改、回读和恢复，配置不变；此测试无模型回合，不证明某个回答使用了这些能力。证据：`native-feature-switch-report.json`。

## 打包 Docker 回归

先在授权的测试服务空闲、审批及两类队列清空后停止 13511，再执行镜像测试；脚本发现端口被占用会报错，不会自行杀服务。构建步骤为：

```sh
pnpm run build
pnpm pack --pack-destination /tmp/codex-cli-audit-20261001/package
docker build -t linux-codex-webui-codex-01593:local -f output/codex-01593/docker-context/Dockerfile output/codex-01593/docker-context
node scripts/verify-codex-01593-docker.cjs
```

- 镜像安装生成的 `linux-codex-webui-0.1.87.tgz`，`CODEX_HOME=/codex-home`，启动命令为 `linux-codex-webui --port 13511 --no-password --no-open --no-tunnel --no-login`。本机 Docker 内 npm registry 无法解析 0.159.3，改用已核实的 npm 安装目录复制公开运行时包，镜像内再次验证版本；未复制配置或认证。
- 镜像 ID：`sha256:dabfd3be5f12fd871862df7818a13fd19dcb634acf0e54271667d0d02d9e2653`。打包文件 41 项，无 auth、config、sessions、`.env` 或 output 产物。
- 无认证、损坏认证、无效凭据、过期凭据、供应商切换五项全部通过。所有容器顺序使用 `127.0.0.1:13511`，结束自动删除。
- invalid/expired 使用容器内假供应商返回 401，明暗主题下错误刷新后仍在，重复 live overlay 数为 0；不把此结果当成真实 ChatGPT OAuth 刷新验证。
- 当前仓库已取消自动 Zen 回退。因此无认证/损坏认证验证当前启动行为，供应商切换使用隔离 `alpha`/`beta` 模拟服务验证 model/list 和实际 Responses 路由，没有调用外部 Zen/OpenRouter。
- 容器内真实 CLI 两回合 fork/revert 验证通过，第一次回合物化期间的短暂原生不支持错误按 60 秒上限等待，超时会报告最后一次错误。
- Docker 产物对应 `0240536` 的产品代码；后续回复按钮、失败提示三项前端修正由最终预览浏览器验收覆盖，未声称旧镜像包含最终 CSS。报告：`output/playwright/codex-01593-docker-report.json`。

## 浏览器与真实模型

网络故障、localStorage、主题及 pending 请求身份需要可控路由和页面存储，因此直接使用 Playwright CJS。只对隔离夹具发送模拟答案，不回应真实待答问题。

```sh
node scripts/verify-codex-01593-ui.cjs
node output/codex-01593/real-chat-acceptance.cjs
```

- UI 验收为 light/dark × `1280×900`、`375×812`、`768×1024`；覆盖问题列表、悬停、刷新恢复、秘密题、回复失败/重试、运行时卡片与不支持降级。六组业务流程在 `3a22c10` 通过。截图前等待 2–3 秒，断言实际变化的界面，不以侧栏或基础页面代替。
- 目视发现暗色失败文字仍沿用深红，实测对比仅 2.42:1；`51df375` 把主题覆盖移至全局样式后，三个暗色尺寸均达到 8.42:1，提示面积 100% 可见。独立报告 `output/playwright/codex-01593-ui-dark-feedback-fix-report.json` 记录前后构建；六场景汇总关联此复验后标记 passed。最终图为 `codex-01593-ui-dark-feedback-fixed-375.png`（375×812）和 `codex-01593-ui-dark-feedback-fixed-768.png`（768×1024），不能使用旧暗色截图代表最终效果。
- UI 夹具故意展示系统 0.159.3 / 运行时 0.154.0 的版本不一致场景；这是视觉测试数据。报告内另有只读真实接口样本，确认系统与当前 13511 均为 0.159.3。
- 真实模型使用隔离配置的 `myproxy` / `gpt-5.6-luna` / low，完成两个回合，约 5.4/2.1 秒。TestChat 的本地文件链接与 OpenAI 链接均通过 `hrefOk`、`titleOk`、`textOk`。
- 原聊天 `01a0f5fb-15de-7a31-81fe-cae2586b428e`、分支 `01a0f5fb-4223-7690-9cf9-fd39d1c07501`。实际写请求为 turn/start 2 次、fork 1 次、revert 1 次，rollback 和文件 Undo 均 0 次，pageErrors 0，测试文件哈希不变。
- 真实模型验收在 `4bcf3a9` 产品构建执行，最终前端布局修正后的 `3a22c10` 重启再次确认两个聊天各保留一回合；未为布局变化重复发送收费模型回合。
- 最终 `51df375` 发布后继续只读核对两会话各一回合及原生子进程归属，结果见 `output/codex-01593/final-runtime-check.json`。
- 报告为 `output/codex-01593/real-chat-acceptance-report.json`、`output/playwright/codex-01593-ui-report.json`。
- 实际页面 URL：`http://127.0.0.1:13511/#/thread/01a0f5fb-15de-7a31-81fe-cae2586b428e`；夹具问题 URL：`http://127.0.0.1:13511/#/thread/01593000-0000-4000-8000-000000000001`。夹具会话仅存在于测试浏览器，不在原生聊天列表。
- 截图根目录为工作树下的 `output/playwright/`；`testchat-codex-01593-cjs.png` 为真实链接桌面暗色图，`codex-01593-real-edit-dark-375.png` 为真实手机图，`codex-01593-ui-questions-submit-failure-dark-375.png` 为手机错误提示图。所有完整绝对路径、尺寸及断言结果列在上述 JSON。

## 性能审计

```sh
PROFILE_BASE_URL=http://127.0.0.1:13511 PROFILE_ROUTE='#/thread/01a0f5fb-15de-7a31-81fe-cae2586b428e' PROFILE_WAIT_MS=7000 pnpm run profile:browser
```

- 有效应用页面、有实际 API 流量、没有停留在 Loading threads；首条真实消息 476.3 ms，总 API 165.7 KiB，warnings 为空。
- 首屏 thread/list、resume、摘要 read 各 1 次；完整历史 read、历史分页重复、重复摘要 read 均 0；skills、限额及供应商模型各 1 次。普通聊天路径 runtime-diagnostics 为 0 次。
- `browser-runtime-profile-thread-01a0f5fb-15de-7a31-81fe-cae2586b428e-2026-10-01T05-47-32-698Z.json` 和同名前缀 trace zip 保存请求数、载荷、慢请求与时序。浏览器不能看到桥接内部 RPC，因此有界降级另以单测及代码路径检查核实。
- 草稿保存 250 ms 防抖，最多 24 项/128 Ki 字符总量/单项 16 Ki 字符/7 天，不随每个按键发送 RPC。诊断 30 秒缓存、同请求合并、2.5 秒超时并撤销 WebUI pending 等待，不增加轮询或阻塞 drain。
- 历史降级最多 16 个单回合顺序请求、1600 items、8 MiB 解码预算。单个上游回合必须收到后才能检查大小，因此不声称限制了原生单次传输的峰值；真实大型历史峰值内存未测。
- 主入口 gzip 相比原预览约增加 3.3 KiB（最终文字布局微调前采样），运行时面板继续懒加载；构建仍有已有的 >500 KiB chunk 提示。本次 476 ms 来自本机小历史样本，不是长历史、外网或任意模型响应保证。

## 部署、回滚与清理

- 最终 release：`/root/.local/share/linux-codex-webui/releases/codex-01593-ui-20261001-51df375`；13511 持久覆盖：`/etc/systemd/system/codex-webui-13511.service.d/zzzzzzzz-codex-01593-ui-20261001.conf`。
- 部署先核实空闲、无未决问题和队列，再优雅重启测试服务；启动后核对构建 commit、实际 app-server 版本、home 和进程归属。回执：`output/codex-01593/deployment.json`。
- 回滚时先等待测试回合、审批与队列清空，停测试服务，保留本轮测试 home，再移除上述单个新增覆盖、执行 daemon-reload 并启动 13511，核对回到原测试 release/home。不要复制新聊天到旧数据库，不要移除其他覆盖，不要操作正式服务。
- 测试保留两个专属 TestChat 和 proof/report 供用户检查；临时浏览器配置关闭，Docker 容器清理，不残留新增 WebUI 监听。不得清空用户 localStorage 或删除真实聊天。
- 正式 PID、原生子进程、保护文件哈希与原有 1563 个会话路径另记 `output/codex-01593/preservation.json`，本轮不以测试成功代替正式升级完成。
