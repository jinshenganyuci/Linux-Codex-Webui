### 功能：围栏代码块复制按钮

#### 前置条件/设置
1. 从当前仓库启动应用，并打开一个可发送消息的测试线程。
2. 准备一条带唯一标记的助手回复，其中依次包含 YAML、bash（或 text）以及无语言的 Markdown 围栏代码块。
3. 分别准备浅色桌面视口、深色 `375×812` 触屏视口；额外检查 `768×1024` 响应式断点。

#### 操作步骤
1. 打开带唯一标记的回复，确认每个围栏代码块头部右侧都有一个“复制”按钮。
2. 依次点击 YAML、bash/text 和无语言代码块的复制按钮。
3. 每次点击后读取剪贴板，并与对应 `<code>` 的文本逐字比较，包括缩进、引号与换行。
4. 用键盘聚焦其中一个复制按钮并按 Enter，确认也能复制。
5. 打开包含围栏代码块的计划卡，重复一次复制操作。
6. 在浅色桌面、深色手机和 `768×1024` 视口中确认按钮均可点击、不与语言标签或横向滚动代码重叠，且页面没有横向溢出。

#### 预期结果
- YAML、bash、text、其他语言及无语言的围栏代码块均各有一个可访问的复制按钮。
- 复制结果仅包含代码原文，不包含语言标签、复制按钮文案或 Markdown 围栏。
- 点击后按钮短暂显示“已复制”，随后恢复“复制”。
- 普通聊天回复和计划卡中的代码块都能复制。
- 复制操作不触发发送、跳转、展开命令记录或任何额外 API 请求。

#### 回滚/清理
- 删除仅为验收创建的测试线程；不需要改动项目文件或持久化设置。

---


### 蓝色链接与 ChatGPT 风格代码块（2026-09-07）

#### 前置条件
- 独立 13511 服务，已完成的真实 TestChat 回复，唯一标记 `CHAT_PRESENTATION_1788765869513`；聊天 ID `01a07ac1-1655-7340-bead-0637d5eeab63`。源消息包含普通段落链接、列表链接、本地文件、行内代码及 YAML/Bash/JSON/未知语言/无语言五个代码块。
- 本地链接夹具 `/tmp/codex-webui-phase1-TestChat/message-presentation.txt` 存在，内容为无敏感信息的验收文字。
- 1440×1000、375×812、768×1024，浅色和深色各一次。普通浏览器无需悬停即可看到蓝色链接。

#### 操作和预期
1. 查看真实助手回复中的“查看项目文档”“打开资源页面”“验收说明”，检查三个链接的 `hrefOk`、`titleOk`、`textOk`、`targetOk`、`relOk` 均为 true；浅色 `#0969da`、深色 `#6cb6ff`，普通段落和 HTML 渲染的列表一致。已访问链接仍为蓝色，键盘聚焦时有轮廓和下划线。
2. 点击文件链接，打开真实本地文件；点击外链会打开新页。自动测试只拦截示例域名的导航，不联系外部网站、不运行代码块里的命令。链接 URL、标题、标签、右键行为和原有文件识别规则保持不变。
3. 代码块为浅灰/深灰圆角容器，移除终端三色圆点和黑色标题条；左侧显示代码图标与可读语言名（YAML、Bash、TypeScript 等），右侧有换行和复制图标。无语言显示“代码”，未知语言保留名称并显示纯文本。
4. 每个代码块点击复制，将剪贴板与源代码逐字比较，保留前导空格、换行、引号和 HTML 字符；不带标题、按钮文字、围栏或高亮标签。成功时显示勾号及“已复制”，随后恢复图标。复制另一块时前一块恢复；键盘 Enter 同样有效。
5. 默认长行只在代码区域横向滚动；点击“自动换行”或按 Enter，按钮 `aria-pressed=true`，长行折行、代码原文不变、页面不横向溢出。再次点击恢复，其他代码块不受影响。代码预览可用键盘聚焦；触屏两个按钮均至少 44×44。
6. 行内代码使用紧凑灰色底纹和等宽字；普通和深色页面的语法色都清晰，正文/终端/差异视图不套用此代码块配色。减少动态效果时不使用按钮缩放反馈。
7. 刷新后，链接仍默认蓝色，五个代码块仍正常显示。换行是当前代码块的临时阅读状态，不写入全局配置或消息原文。
8. 普通消息与计划卡/列表中的 HTML 代码块共用标题生成器和事件委托；计划卡也应有相同配色、复制和换行按钮。单元回归验证 HTML 分支嵌套代码及标签转义；浏览器使用真实聊天回复检查五个代码块和列表链接。

#### 自动验证与结果
```bash
pnpm exec vitest run src/components/content/ThreadConversation.test.ts src/components/content/thread-conversation/markdownPipeline.test.ts src/components/content/thread-conversation/CommandExecutionBlock.test.ts
pnpm run build:frontend
node scripts/verify-message-presentation.cjs
LIVE_PREVIEW=1 node scripts/verify-message-presentation.cjs
```
- 相关 3 个测试文件共 36 项通过，前端类型检查与构建通过。新增回归覆盖语言别名、空语言、未知语言、围栏信息转义、中文按钮及原文缩进。
- 构建模式真实 TestChat 六组通过：每组三个链接属性/默认蓝色检查、真实文件和受控外链跳转、五个代码块逐字复制、长行换行和独立块状态、手机 44px 触控区域、无横向溢出、刷新后颜色保留。无页面错误，复制/换行不产生模型或配置写入。
- Playwright 直接用于主题 localStorage、剪贴板读取和外链导航拦截；测试操作真实聊天 DOM，不以 HTML 截图夹具替代真实消息。初次 Luna 测试请求等待过久，已只中断该测试回合；同一 TestChat 用 Astra low/priority 完成真实回复，未改全局模型或速度配置。
- 实际地址：`http://127.0.0.1:13511/#/thread/01a07ac1-1655-7340-bead-0637d5eeab63`。每组截图、链接属性和复制结果在 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/message-presentation/build-result.json`；必需 TestChat 截图 `/root/codex工作目录/Linux-Codex-Webui/output/playwright/testchat-message-presentation-cjs.png`。
- 本次只调整展示和本地阅读按钮，不改 provider/auth、消息传输或后端配置；保留原高亮按需加载、已有 LRU 缓存和复制回退。代码块操作仅查询所在块，不扫描全部历史，不引入依赖、额外 API、观察器、轮询或持续动画。主 JS 715235→715307 字节（gzip 222719→222762），主 CSS 534692→538294（gzip 60230→60998）。原大 chunk 提示仍存在。
- 真实手机软键盘、Safari/Firefox 和低端 GPU 未实测。代码块高度跟随正文，未添加折叠、运行代码或自动下载功能。

1440×1000 浅色，代码块与蓝色列表链接：

![浅色聊天代码块](/root/codex工作目录/Linux-Codex-Webui/output/playwright/message-presentation/code-1440-light.png)

375×812 深色，长代码换行及触控按钮：

![深色手机代码块](/root/codex工作目录/Linux-Codex-Webui/output/playwright/message-presentation/code-375-dark.png)

#### 清理与回退
- 验收聊天及文本夹具保留用于 13511 查看效果；验收结束可仅删除该 TestChat 和对应夹具，不删除其他线程，不修改用户源码。
- 回退从目标提交重新构建前端并原子替换独立 13511 入口；不创建备份、不重启后端，正式 13510 须另行明确授权升级。


#### 13511 发布后复验和性能采样
- 前端提交 `c7ea54d` 已发布到独立 13511；33 个实际 HTTP 资源与构建一致，索引 SHA-256 `d15f049af8f8ac894a4f73879c017e28ac365f0343c0280fa8d0d101526ebb04`。
- `LIVE_PREVIEW=1 node scripts/verify-message-presentation.cjs` 六组通过，保留 Service Worker 验证刷新：18 组链接属性/默认蓝色检查、30 次代码原文及剪贴板匹配、换行独立性、触屏按钮尺寸和无页面错误。最终截图路径同上，均已更新为已部署页面的截图；完整记录同目录 `live-result.json`。
- 使用完成态真实 TestChat、相同路由前后执行：
```bash
PROFILE_BASE_URL=http://127.0.0.1:13511 PROFILE_ROUTE='#/thread/01a07ac1-1655-7340-bead-0637d5eeab63' PROFILE_WAIT_MS=7000 pnpm run profile:browser
```
- `duplicateCounts` 前后相同：thread/resume 1 次、skills/list 1 次、模型目录 1 次，无重复 thread/read/history 分页；既有 thread/list 首页面仍为 2 次，保留警告，不归因本次修改。API 总量均 129.0 KB，高亮懒加载均 1 次。已核对 `warnings`、`apiSummary` / 汇总 `topApiSummary` 和 `slowestApiRows`；两次均正确加载真实消息且有 API 流量。最慢请求从 thread/list 581.8ms 变为模型目录 297.2ms，单次样本不作性能提升结论。
- 首条消息 996.4→532.2ms；长任务 2→3 次，最大 149→139ms，同样不作统计提升或退化结论。完整 JSON、截图与 trace 引用分别保存在 `output/playwright/message-presentation/profile-before.json`、`profile-after.json`。
- 除主入口外，聊天懒加载 JS 96705→97725 字节（gzip 28417→28882），聊天 CSS 109556→97050（gzip 11259→10342）。主入口与聊天这四项资源合计原始体积减少 7812 字节、gzip 增加 359 字节，没有隐藏新增高亮依赖。详细数值见同目录 `bundle.json`。
- 主进程 491027、app-server 子进程 491058 和 5 个验收会话保留；正式 13510 静态资源校验不变，配置/认证/模型目录哈希在浏览器验收后不变。回执同目录 `deployment.json` 明确 `backupCreated:false`、`backendRestarted:false`。未推送 GitHub 或发布 npm。
