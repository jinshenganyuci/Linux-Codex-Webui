# 子代理摘要与主聊天列表隔离

## 问题与修复

`ee66a77` 在历史模式探测完成后，把所有 `thread/read(includeTurns:false)` 摘要交给主列表的 `mergeThreads`。实时 `turn/started`、`turn/completed` 会为后台子代理读取历史，因此子代理被误当成普通聊天；累加分页又会保留这些行。整页刷新清空内存，原生 `thread/list` 默认只列普通交互会话，所以刷新后暂时正常。

现在历史摘要保存在独立的会话元数据缓存中，只供直链标题、目录和历史使用。主侧栏成员由正常列表分页与显式搜索结果确定，读取一条历史不会增加侧栏行。元数据沿用已有历史 LRU、删除、裁剪和停止清理，不创建持久缓存。列表刷新保留已打开或已缓存会话的运行状态，避免子会话离开主列表后被误判为空闲。

## 前置条件

- 使用已启动的 13511；正式 13510 只在用户授权本次升级/回归修复后验证。
- `node_modules` 包含 Playwright。用请求拦截和页面内原生通知回放构造可重复场景，因此使用 CJS Playwright，不能以 Browser Use 的普通点击代替这些能力。
- 测试不创建真实子代理、不发送真实回合、不写模型或偏好。测试 ID、列表和两种 `source.subAgent` 结构由浏览器内 fixture 提供，其余允许的只读接口仍来自实际服务。

## 操作与预期

1. 新浏览器上下文打开只有父聊天和普通 fork 的主列表，分别在 375×812、1440×900 的明暗主题执行。
2. 向实际前端通知处理器发送两个子代理的 `turn/started` 和 `turn/completed`，覆盖 `{subAgent:{thread_spawn:…}}` 与 `{subAgent:'review'}`。确认前端实际读取子会话摘要和历史后，主列表仍只有父聊天及普通 fork；不以单纯未发请求来假通过。
3. 打开子会话直链，标题、目录及消息正常，侧栏不新增子会话；返回父聊天仍正确。另用全新上下文直接访问子会话，避免只覆盖已缓存导航。
4. 让已打开子会话处于运行中，再刷新主列表，运行状态保持，不因子会话不是列表成员就变成空闲。
5. 首列表延迟 5 秒，普通旧会话的标题、目录和历史应先显示；摘要不强行加入普通侧栏。显式搜索未分页加载的普通旧聊天时仍显示可点击结果。
6. 校验无 JavaScript 错误、无发送/配置写入、无重复摘要探测；截图前等待 2.3 秒并核对主题。

```bash
pnpm exec vitest run src/composables/useDesktopState.test.ts src/composables/desktop/threadListLoader.test.ts
pnpm run build:frontend
SUBAGENT_EXPECT=bug SUBAGENT_CASES=realtime SUBAGENT_VIEWPORTS=375 SUBAGENT_THEMES=light \
SUBAGENT_RUN_LABEL=before node scripts/verify-subagent-sidebar.cjs
# 上一行仅可对修复前的13511运行，切勿在正式服务复现旧bug。
SUBAGENT_RUN_LABEL=after node scripts/verify-subagent-sidebar.cjs
```

## 验证记录

- 新增两个回归用例在修复前均失败：后台子会话和归档摘要进入主列表，原生子回合通知也能触发同样结果。修复后相关 185 项通过。
- 额外断言先复现了“已打开的运行中子会话，在主列表刷新后被清为空闲”，随后补齐运行状态的独立保留。
- 修复前 13511 手机浅色真实 UI 回放：主列表由 2 条变 4 条，两条新增行分别是 spawn/review 子代理；无真实写入。
- 第一轮修复后桌面/手机明暗 12 组通过：列表保持两条、fork 保留、子会话可读、搜索正常。首屏列表延迟 5 秒时旧会话标题/目录/历史 276–325 ms 显示；这些是同一 fixture 的前后对照，不当作真实长历史或模型响应测速。
- 证据目录 `output/playwright/subagent-sidebar/`，`before` 保留旧版复现，`after` 保留修复矩阵；最终状态保留和正式静态发布结果随后补充。

## 部署与回滚

只更新已验收前端静态文件，先发布带哈希资源、最后原子替换 `index.html`；保留旧哈希资源供已打开页面使用，不停止 13510/13511，也不改后端入口、模型配置或会话正文。用户刷新一次即可加载修复。回滚可按同样方式发布选定旧前端，但旧版本会重新出现本次列表污染；不能通过删除真实子代理记录代替修复。
