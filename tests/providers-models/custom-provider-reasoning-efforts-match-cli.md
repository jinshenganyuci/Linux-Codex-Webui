# 自定义提供商的推理强度遵循 CLI 模型目录

## 前置条件

- 在隔离 `CODEX_HOME` 与 `127.0.0.1:4173` 测试服务中，将默认模型设为 `gpt-6.1-sol`、强度设为 `ultra`，提供商设为自定义值；该提供商模型发现返回空列表，但当前 CLI 的 `model/list` 返回 Sol 的 `low, medium, high, xhigh, max, ultra`。
- 另备 `gpt-6-luna` 的目录样例，强度为 `low, medium, high, xhigh, max`；准备一个 `model/list` 不认识的自定义模型样例。
- 不使用真实模型发送，不改正式 `5173` 服务的模型配置。

## 操作

1. 打开新聊天，检查模型/强度摘要，再展开模型强度菜单。
2. 核对 Sol 滑杆恰有六个强度，初始值显示 `Ultra`，高级选项明确显示 Max 与 Ultra；分别点选两者。
3. 切到 Luna 样例，核对只有五个目录支持的强度，不能选择 Ultra。
4. 切到未知自定义模型样例，核对不显示硬编码的“关闭/最小/轻度…”范围；若已有配置强度，摘要仍如实显示当前值，并说明可选范围尚不可得。
5. 在未知目录样例中预置新聊天默认强度 `ultra`，打开设置，确认默认强度显示当前 `Ultra`，而不是误显示“跟随 Codex 配置”。
6. 在桌面浅色、手机暗色及 768×1024 视口复查布局和可读性；检查 `model/list` 请求次数与模型/配置写请求。

## 预期结果

- 当前配置模型即使不在自定义提供商的发现列表内，也只从 CLI `model/list` 精确继承该模型的强度范围，不将整个 CLI 模型目录暴露为此提供商可选模型。
- 未经提供商验证的 Fast 能力不因 CLI 目录元数据自动启用；未知模型不伪造可选强度。
- Max/Ultra 可见且可选，Luna 不出现 Ultra；未知目录只保留已保存的强度显示，不伪造其他可选范围；浏览器无页面错误、横向溢出或额外的模型发送/配置写入。

## 回滚与清理

- 结束隔离服务，保留测试报告与截图；仅清理本轮临时 `CODEX_HOME`，不得修改正式认证、模型偏好或 `5173` 持久服务。

## 2026-11-11 隔离验收

- 只读核对现有 `5173`：实际 CLI 为 0.167.0，配置为自定义提供商、`gpt-6.1-sol` / `ultra`；`provider-models?provider=custom` 返回空的独占列表，`model/list` 返回 Sol 的六档。修复前页面误显示“关闭”，修复后显示 Ultra，且 Max/Ultra 均可见。
- 使用独立 `CODEX_HOME` 的 `127.0.0.1:4173` 执行 `REASONING_BASE_URL=http://127.0.0.1:4173 node scripts/verify-model-reasoning-range.cjs`：英文桌面、平板、手机明暗六组，目录缺失一组，以及中文桌面浅色、手机暗色两组，共九案通过。六档与 `model/list` 一致；目录缺失时仍显示当前 Ultra，但不伪造滑杆。每个页面只有一次 `model/list` 和一次提供商模型查询，没有模型发送或模型配置写入，也没有页面错误或横向溢出。报告与截图位于 `output/playwright/model-reasoning-range/`。
- 在同一临时 home 中将模型短暂设为 Luna/Max，手机暗色页仅显示 `low, medium, high, xhigh, max` 与 Max 高级按钮，不出现 Ultra；完成后已回读确认恢复 Sol/Ultra。截图为 `output/playwright/model-reasoning-range/model-reasoning-luna-dark-375.png`。
- 91 文件、978 项单测与类型检查通过。`pnpm run build` 因沙箱外的全局 pnpm store 只读而未启动构建；改用仓库已安装的 `vue-tsc`、Vite、tsup 完成前后端构建，再以 `pnpm pack --pack-destination /tmp/...` 打包成功。构建仍有既有的 500 kB 大 chunk 提示。
- 打包镜像 `linux-codex-webui-reasoning-range:local` 安装当前 tarball 与 `@openai/codex@0.167.0`，在唯一回环端口 `4191` 顺序完成无认证、损坏认证、假无效认证、假过期认证、假提供商切换五案；后两种认证错误刷新后仍在，重复 live overlay 数为 0。报告为 `output/playwright/reasoning-range-docker-20261111-port4191-report.json`，截图路径由报告逐项列出。假提供商不证明真实 ChatGPT OAuth 或服务商可用性。4190 的先前准备尝试被 Node `fetch` 的禁用端口规则拦截，不是产品服务错误；4191 复验通过。
- 性能审计：九案中每页均只有一次 `model/list` 和一次提供商模型查询，回退只在已返回的目录中匹配当前模型，没有额外请求、阻塞操作或无界 fanout；缓存键纳入回退模型 ID，避免跨模型复用旧目录。最终前端构建主 chunk 为 761.68 kB（gzip 239.12 kB），仍有既有的大 chunk 提示；未在真实模型会话中测量交互延迟。打包验收容器已清理，`4191` 未残留监听；因容器映射 UID 导致临时测试 home 无法由当前用户删除，脚本在报告中明确保留其路径，未触碰正式数据。
