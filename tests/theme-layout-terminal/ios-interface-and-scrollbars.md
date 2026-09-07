# iOS 磨砂界面、细滚动条与跟手面板

## 功能与准备

珍珠白/石墨色阅读区、磨砂导航与浮层、蓝色操作反馈、统一滚动条、分组设置和可拖动手机面板。
仅使用独立 13511 发布目录。检查 13510 与 13511 的 ExecStart、入口实际 import 和 dist 真实路径，确认没有共享可写前端资源或硬链接；保留正式发布目录哈希作为隔离边界证据。

视口：1440×1000、768×1024、375×812；每组明暗主题。准备已完成聊天和含等待/命令记录的独立测试会话。

## 操作与预期

1. 首页任务卡只填入草稿；侧栏、标题栏、输入框有一致的圆角、轻高光、磨砂材质和蓝色强调。正文和代码背景保持可读，不叠加动态模糊。
2. 有大量会话时滚动侧栏；检查细滑块、透明轨道、无上下箭头、圆角。滚轮、触摸、键盘和拖动原生滑块仍正常。根页面与侧栏父容器不出现第二条纵向滚动条。
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
