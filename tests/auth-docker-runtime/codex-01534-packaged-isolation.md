### Feature: 首批升级的打包隔离与错误持久化

#### Prerequisites
- 按 `documentation/codex-0.153.4-phase1.md` 构建、pack，再用 `scripts/docker-codex-phase1.Dockerfile` 建镜像。
- Docker 和 Playwright 依赖可用，4191–4194 没有监听者；不得使用正式配置或真实凭据。

#### Steps
1. 执行 `node scripts/verify-codex-phase1-docker.cjs`，或通过 `PHASE1_DOCKER_IMAGE` 指定已打包的同版本镜像。
2. 无 auth 与畸形 auth 两个容器检查启动、CLI 0.153.4 和 `/codex-home`，页面保持 Codex-only，无 Zen 自动回退。
3. 假 API key 场景由容器内 mock 返回 401；检查真实 CLI 失败回合、错误原文，刷新后分别保存明暗截图。
4. 原生配置从 alpha 切换为 beta，检查 provider-models 由 Astra 更新为 Luna，而不是继续使用旧目录。
5. 对最终包执行公开 ESM CLI 的 CJS 动态导入帮助命令；检查退出码为 0。

#### Expected Results
- 打包安装可启动，不依赖源码树；四个容器与正式 HOME、会话和端口完全隔离。
- 401 只保留一个失败回合，刷新后恰好一个错误、零重复 live overlay，无自动回滚/换模型/重发。
- 输出报告记录测试端口、版本、配置模式、错误持久化和截图；不记录真实 token。
- provider 切换通过原生 Codex 配置完成，不重新引入已经删除的 Zen/OpenRouter 独立 UI。

#### Rollback/Cleanup
- 脚本 finally 删除它自己创建的容器和临时 HOME；失败时按输出名称复查，不停止其他容器。
- 验收镜像可保留复现；清理临时打包目录，不操作正式服务。
