# iOS 磨砂界面、细滚动条与跟手面板

## 功能与准备

珍珠白/石墨色阅读区、磨砂导航与浮层、蓝色操作反馈、统一滚动条、分组设置和可拖动手机面板。
仅使用独立 13511 发布目录。检查 13510 与 13511 的 ExecStart、入口实际 import 和 dist 真实路径，确认没有共享可写前端资源或硬链接；保留正式发布目录哈希作为隔离边界证据。

视口：1440×1000、768×1024、375×812；每组明暗主题。准备已完成聊天和含等待/命令记录的独立测试会话。

## 操作与预期

1. 首页任务卡只填入草稿；侧栏、标题栏、输入框有一致的圆角、轻高光、磨砂材质和蓝色强调。正文和代码背景保持可读，不叠加动态模糊。
2. 有大量会话时滚动侧栏；检查细滑块、透明轨道、无上下箭头、圆角。滚轮、触摸、键盘和拖动原生滑块仍正常。检查滚动条中心的命中元素不是 desktop-resize-handle；从右侧内容区拖动调整条仍能改变侧栏宽度。根页面与侧栏父容器不出现第二条纵向滚动条。
3. 将会话从少消息变成长列表：正文、等待、命令、队列和输入框左右边界一致，两侧留白对称；滚动条出现不能挤动内容。浏览器实际滚动条占宽通过 ResizeObserver 测量，每个聊天列表只注册一个，卸载清理。
4. 电脑点击输入框会话控制图标，手机「＋ → 会话控制」：运行与权限、目标、队列使用分段选中背景与分组卡片。技术说明可展开，真实功能作用域仍明确，禁用原因可查看。
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

清空未提交草稿并关闭测试页面。只恢复 13511 对应 systemd 预览 drop-in，绝不往正式 dist 复制文件；保留验收 CODEX_HOME 和会话。记录未进行的真机、Safari/Firefox 与低端 GPU 验收，不能把 Chromium 视口模拟视为真机实测。

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
