# iOS 磨砂界面、细滚动条与跟手面板

## 功能与准备

珍珠白/石墨色阅读区、磨砂导航与浮层、蓝色操作反馈、统一滚动条、分组设置和可拖动手机面板。
日常开发与验收仅使用独立 13511 发布目录；只有用户明确要求升级或验证 13510 时才操作正式地址。检查两者的 ExecStart、入口实际 import 和 dist 真实路径，确认没有共享可写前端资源或硬链接；保留文件哈希作为隔离边界证据。

视口：1440×1000、768×1024、375×812；每组明暗主题。准备已完成聊天和含等待/命令记录的独立测试会话。

## 操作与预期

1. 首页任务卡只填入草稿；侧栏、标题栏、输入框有一致的圆角、轻高光、磨砂材质和蓝色强调。正文和代码背景保持可读，不叠加动态模糊。
2. 有大量会话时滚动侧栏；检查细滑块、透明轨道、无上下箭头、圆角。滚轮、触摸、键盘和拖动原生滑块仍正常。检查滚动条中心的命中元素不是 desktop-resize-handle；从右侧内容区拖动调整条仍能改变侧栏宽度。根页面与侧栏父容器不出现第二条纵向滚动条。
3. 将会话从少消息变成长列表：正文、等待、命令、队列和输入框左右边界一致，两侧留白对称；滚动条出现不能挤动内容。浏览器实际滚动条占宽通过 ResizeObserver 测量，每个聊天列表只注册一个，卸载清理。
4. 电脑与手机均点击「＋ → 会话控制」：运行与权限、目标、队列使用分段选中背景与分组卡片。技术说明可展开，真实功能作用域仍明确，禁用原因可查看。
5. 目标填写但不保存，点击面板内标题，不关闭；点击外部关闭，重开保留草稿。Esc 立即关闭并返回可见入口焦点。权限搜索内 Esc 依次清搜索、关闭子菜单、关闭面板。
6. 手机按住顶部拖动条，下拉 65px 后取消触摸：面板跟手并回弹，保持打开；上拉 100px：展开为大面板；下拉 150px：关闭；顶部轻点可切换大小。内部内容滚动不触发关闭。
7. 快速连续打开并按 Esc 关闭三次：无残留遮罩、无未完成动画阻塞输入；键盘发起的打开与分段切换不等待动效。
8. 手机调出真实系统键盘，检查目标输入与内部滚动可达；旋转屏幕和关闭键盘后正确恢复。浏览器缩小视口验证只证明小空间布局，不替代真机键盘。
9. 开启减少动态效果，面板直接显示且不回弹；开启减少透明度或增强对比，浮层改为实色。深色截图无浅色面板残留。
10. 刷新真实 13511 并打开扩展/权限/模型菜单，確認资产仍来自独立发布，Service Worker 没有恢复旧构建。

## 自动验收

先 `pnpm run build`，执行：

```bash
pnpm exec vitest run src/components/content/sheetMotion.test.ts src/composables/desktop/nativeThreadController.test.ts src/runtimeItems.test.ts
UI_PREVIEW_OUTPUT_DIR=output/playwright/ios-preview UI_PREVIEW_THREAD_ID=<ID> node scripts/verify-chatgpt-preview.cjs
UI_PREVIEW_OUTPUT_DIR=output/playwright/ios-preview UI_PREVIEW_THREAD_ID=<ID> node scripts/verify-chatgpt-preview-runtime.cjs
UI_PREVIEW_THREAD_ID=<ID> node scripts/verify-ios-interactions.cjs
```

前两组通用回归沿用上一版脚本，检查对齐、目标草稿、权限、模型、任务卡和原生队列附件保留。iOS 脚本使用 CDP 触摸事件验证真实 Pointer Events 手势，在测试页面构造足量内容检查原生滚动；夹具不写到 CLI。构建拦截阶段禁止 Service Worker，避免它绕过页面路由拦截。发布后使用 `LIVE_PREVIEW=1` 复查真实资产与刷新，保留 Service Worker 验收。

## 性能与回滚

记录构建包大小、profile:browser 的实际 API 字节数/重复计数/首消息时间，检查没有新增轮询、历史扫描或展开时请求风暴。手势直接写 transform/opacity，不逐帧更改继承 CSS 变量；后台帧间隔有上限，收起/卸载停止动画与监听。主题变化不动画模糊半径。

清空未提交草稿并关闭测试页面。预览回滚只恢复 13511 对应 systemd drop-in，未经用户正式升级授权不得写入正式 dist；保留验收 CODEX_HOME 和会话。记录未进行的真机、Safari/Firefox 与低端 GPU 验收，不能把 Chromium 视口模拟视为真机实测。

## 独立服务最终验证（2026-09-07）

- 13511 实际发布目录 `/root/.local/share/linux-codex-webui/releases/ios-preview-20260907`，入口导入同目录 dist-cli；dist/index.html 与正式目录不是同一文件或硬链接。只复用现有依赖目录。
- 实际运行构建 `fcb39a303cf38ddb22b1112c78287c2510b77cbe`，dirty=false；CLI 0.153.4。13511 主进程 491027、Codex 子进程 491058；仍使用原验收 CODEX_HOME，配置哈希与 4 个会话 ID/文件清单保留。
- 13510 主进程 414785 不变，正式发布目录全部已记录文件在验收后哈希保持一致，没有写入正式前端目录。
- `LIVE_PREVIEW=1` 的 1440×1000、768×1024、375×812 明暗六组通过，页面异常为零；目标外部关闭、Esc、草稿保留、权限子菜单、首页任务卡和模型菜单通过。
- 手机 CDP 触摸：取消回弹、上拉展开、下拉关闭、重复快速开关、缩小视口、刷新后扩展通过；减少动态效果和减少透明度通过。浏览器实际 backdrop-filter 包含 blur(18px)，修复了声明顺序导致构建仅剩 WebKit 前缀的问题。
- 滚动条样式实测：上下箭头 display:none，底槽透明，桌面宽 8px、圆角 999px；滚动前后输入框坐标保持一致，根页面与侧栏父容器没有第二条滚动条。
- 构建与 18 项相关单测通过；公开 CLI 在 CJS 中用 execFileSync 调用 `node dist-cli/index.js --help` 成功，ESM CLI 没有可供 require 的公共导出。
- 单次同会话性能采样：API 119.6→118.9 KB，thread/resume 均 1 次，历史重复页均 0；既有 thread/list 首页面请求均 2 次，未声称修复。首条消息 427.3→449.2ms，长任务数量均 1，仅为单次本机采样，不作为统计性能结论。
- 证据目录：`output/playwright/ios-preview/` 的 isolation.json、performance.json、live-result.json、interactions.json 和截图；原始 profile JSON/trace 在其上级目录。真机键盘、Safari/Firefox 与低端 GPU 未测。

### 原生滑块命中回归

补充真实拖动验收时发现：desktop-resize-handle 的透明伪元素向左扩展 8px，覆盖了新细滚动条。修复为只向内容区扩展 12px，保持滚动条与调宽操作各自命中。使用有窗口 Chromium（Xvfb）及关闭 headless 的隐藏滚动条选项复验，不能只凭 CSS 计算样式判定滑块可操作。

```bash
DISPLAY=:91 UI_PREVIEW_HEADLESS=false LIVE_PREVIEW=1 UI_PREVIEW_THREAD_ID=<ID> node scripts/verify-ios-interactions.cjs
```

`:91` 是本次临时 Xvfb 显示地址，测试完关闭该进程；无持久新 WebUI 监听端口。

- 最终有窗口 Chromium 全流程复验完成，明暗两组的原生滑块拖动和侧栏调宽均通过，重新验证手机触摸、取消回弹、展开/关闭、刷新、减少动态效果及减少透明度。截图包含 `scrollbar-detail-light.png` 和 `scrollbar-detail-dark.png`。本次临时 Xvfb 在验收后关闭。
- 命中修复只改变 CSS 伪元素的左右边界，不增加运行时监听或请求；静态前端再次发布仅发生在独立预览目录，后端维持 fcb39a3 构建，正式目录仍保持哈希一致。

## 手机首页高度不足与项目按钮遮挡回归

- 前置：打开 13511 首页，依次使用 376×694（浏览器栏占位后的内容高度）、376×640、360×568、375×812、768×1024、1440×900，明暗两套；360×568 将任务卡和项目控件文字放大到 18px 作为溢出压力。
- 操作：不滚动先观察顶部图标和底部输入框；向上滚动首页内容，点击创建项目再关闭弹窗；输入四行草稿后把视口缩到 600px 高，再滚动到项目按钮；清空草稿并刷新。
- 预期：图标保持正方形，不被纵向压扁；首页内容只在输入框上方独立滚动，输入框位置稳定。常规手机高度时项目按钮可直接看到；高度不足或文字放大时滚动即可完整看到并点击，每个按钮中心真实命中按钮。弹窗可打开关闭，刷新后不恢复遮挡，页面无外层横向/纵向溢出。
- 实现：移除首页外层滚动，让内容块拥有 overflow-y:auto；子项不压缩，用首尾自动外边距在宽裕时居中。窄屏短窗口改用紧凑横向图标卡片。仅 CSS，无新增请求、监听器或遍历。
- 命令：构建后 `node scripts/verify-ios-home-height.cjs`，独立发布后 `LIVE_PREVIEW=1 node scripts/verify-ios-home-height.cjs`。截图和坐标证据在 `output/playwright/ios-home-height/`。本轮不替代实际手机 OS 文字缩放或软键盘测试。
- 回退：恢复独立 13511 更新前的 index；不重启后端，不操作正式目录。清理浏览器测试草稿和未提交弹窗。

- 本轮构建回归 12 组通过。376×640 修改前记录：mark 48×30、项目按钮 bottom=538.39、输入框 top=491，约 47px 遮挡；修改后图标保持比例，按钮与输入框分别处于独立区域。12 组还覆盖 18px 控件文字压力、四行草稿、创建项目弹窗与刷新。最终真实服务复验结果位于 `ios-home-height/live-result.json`。

## 用户授权的正式 13510 发布（2026-09-07）

- 前提：用户明确要求「直接升级13510 不要备份东西」。确认正式后端 `2e17039` 与前端目标 `af2aabe` 之间无后端或依赖变化，复用 13511 已通过验收的前端字节，不复制旧文件、不创建备份。
- 操作：将 14 个新增内容哈希资源写入正式目录，最后原子替换 index；逐一请求 33 个 HTTP 资源核对 SHA-256。保留原有静态块以兼容尚未刷新的页面，正式与预览仍为不同文件。
- 验收：通过 Playwright 的独立浏览器上下文设置 localStorage 主题，访问 `http://127.0.0.1:13510/#/`；按 376×694、375×812、768×1024、1440×900 分别检查明暗主题。确认首页内容和输入框分离，图标比例正常，项目按钮中心可命中，创建项目弹窗可打开关闭。刷新后再次检查新 JS/CSS 名称与布局；不提交项目或消息。
- 结果：8 组全部通过，页面异常及 HTTP 错误为 0，有真实 API 流量；明暗截图已人工查看。入口 SHA-256 为 `d00bff2255e1f2ebcf180b2d3c5ce4d0140d8ec9a0e7b7d16e1ba7b2d68e2324`。13510 主进程 414785、子进程 414813，13511 主进程 491027、子进程 491058 均不变；598 个会话文件与配置哈希保留，后端文件和 13511 前端文件不变。
- 版本与性能：前端 `af2aabe`，后端 runtime-info 仍为 `2e17039` / CLI 0.153.4；这次只发布已验收产物，没有新增运行时逻辑。沿用上文性能审计，未重测正式长会话、真机键盘或 GPU 表现。
- 清理与回退：浏览器上下文全部关闭，没有创建测试项目。无此次备份可供恢复；需要回退时从指定提交重新构建前端，再通过相同的先资源后入口流程发布。
- 完整证据：`/root/codex工作目录/Linux-Codex-Webui/output/playwright/ios-production-13510/deployment.json`、同目录 `browser.json`；截图按 `home-<宽>x<高>-<light|dark>.png` 命名，包含全部 8 个视口主题组合。

正式手机浅色 376×694：

![正式手机浅色](/root/codex工作目录/Linux-Codex-Webui/output/playwright/ios-production-13510/home-376x694-light.png)

正式桌面深色 1440×900：

![正式桌面深色](/root/codex工作目录/Linux-Codex-Webui/output/playwright/ios-production-13510/home-1440x900-dark.png)
