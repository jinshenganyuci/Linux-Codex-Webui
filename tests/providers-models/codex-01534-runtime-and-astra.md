### Feature: Codex 0.153.4 运行身份与 Astra 能力来源

#### Prerequisites
- 构建当前分支，准备完整固定的 0.153.4 CLI；正式 13510 不参与测试。
- 按 `documentation/codex-0.153.4-phase1.md` 在新 HOME 中预览、再应用隔离配置；源配置有旧模型目录时保留其备份及哈希。

#### Steps
1. 比较源配置的模型、context window、压缩阈值及 hash，确认准备脚本未修改源文件，目标 HOME 中没有正式 sessions/数据库。
2. 用目标 HOME 和固定 `CODEXUI_CODEX_COMMAND` 启动 13511，打开设置→运行信息，对比 RPC 握手版本、实际可执行路径和构建提交。
3. 选择 Astra，检查 low/medium/high/xhigh/max/ultra 六档及来源说明；重新加载确认选择持久化。
4. 显式选择 Fast，用请求拦截检查 `turn/start.serviceTier` 为 native 元数据声明的 `priority`，标准模式为 null；不能仅凭 HTTP 200 判定加速或计费。
5. 在隔离 TestChat 让 Astra 只读取当前 README 并输出唯一标记，检查工具与最终回答；不要用正式历史测试。
6. 模拟 native model/list 无条目、bundled 缺失及全局 CLI 与运行版本不同；检查来源/未知状态，不出现错误猜测的别名能力。

#### Expected Results
- 默认模型及正式上下文设置不变；实际运行版本不是全局 npm 版本的替身。
- 同名自定义目录条目不被覆盖；新增缺失 Astra 条目包含完整运行 profile，不只添加显示名称。
- 新线程显式选择的模型不被异步初始加载覆盖；模型拒绝时保留错误及选择，不自动换模型、回滚或重发。
- 元数据缓存合并并发请求；版本不匹配不使用新磁盘目录冒充旧运行版本。

#### Rollback/Cleanup
- 只停止/回退测试实例，保留隔离 HOME 便于复查；正式实例无需回滚。
- 删除一次性 TestChat 或浏览器 fixture 状态前先保留报告；不删除共享依赖或正式数据。
