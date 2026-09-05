# 第三批原生扩展

## 协议与运行时边界

- 前置条件：第二批之后的 dev、固定 Codex CLI 0.153.4，13511 独立验收 HOME。浏览器/性能验证用当前工作树的 4173；13510 不用于开发或重启。
- 操作：读取扩展能力、CLI 加载的 feature 阶段、托管 featureRequirements、provider 和认证类别。以含敏感字段的配置夹具同时发起 20 次查询；再对项目配置不同的已加载线程查询。
- 预期：接口只返回经过筛选的能力信息，不含 token/邮箱/完整配置；同一个范围的缓存周期共用 4 类 RPC，分页有上限。全局默认与线程范围分开：线程 feature/list 携带 threadId，provider 来自 thread/read 摘要，不携带 turns。最多缓存 32 个范围、TTL 15 秒；配置、线程设置或运行时开关写入、CLI generation 改变后失效。
- 操作：两页同时请求同线程实时 start；使用不同 ownerId 请求 stop/text/heartbeat；断开原页面且停止心跳。
- 预期：只有一个页面取得实时会话，其他页面不能操作；30 秒租约过期后仅停止自建实时会话，不调用 turn/interrupt、不清理其他原生客户端的会话。所有操作按线程串行，64 个线程上限。
- 操作：模拟启动确认丢失、重复 SDP、CLI generation 改变和 late media permission；发送大量实时通知后重新连接消息流。
- 预期：不重发 start，不回放 SDP、音频或旧转写；本页媒体资源释放。旧请求不会接管新连接，普通聊天历史保持原逻辑。
- 操作：请求 WebRTC V2 和 V1/audio。
- 预期：V2 在适配层明确拒绝，因为 0.153.4 core 实际只允许 AVAS WebRTC V1/V3；本批使用 V1/audio。Schema 可接收某字段不等于底层执行支持。
- 性能：扩展面板、语音和远控均懒加载；无语音时没有心跳请求，活动语音每 10 秒一个租约心跳。转写最多 12 段，每段 8000 字符；不积累音频。子线程只按 Schema 确认的 ancestorThreadId 分页，最多 200 条，不逐条拉取历史。
- 清理：关闭实时面板释放麦克风与 WebRTC；远控由用户显式停用，不因关面板擅自断开已授权远端客户端。测试不生成备份、不修改正式配置。

## 插件、生命周期与实际可用开关

- 前置：打开隔离 TestChat 的“原生扩展”，或从首页设置打开全局能力；CLI 0.153.4。使用 `node scripts/verify-codex-phase3-native.cjs` 验证真实协议，`node scripts/verify-codex-phase3.cjs` 验证稀有 UI 状态。
- 操作：查看插件已安装/启用状态、availability、disabledReason 和本地/目录版本；搜索 removed、underDevelopment 能力。尝试临时关闭 tool_suggest，先取消，再确认；刷新核对。查看被 featureRequirements 锁定的 memories。
- 预期：插件安装不被当成可调用；管理入口复用现有插件管理。仅精确 0.153.4 中确认支持的稳定键 auth_elicitation、memories、mentions_v2、remote_plugin、tool_suggest 提供临时开关；锁定项、未核对版本、开发中/已移除项不提供开关。apps/plugins 的 enablement/set 在此版本被忽略，必须只读，不能根据通用文档或 HTTP 200 冒充成功。
- 预期：写入 ACK 和重新读取的实际 enabled 都一致才成功；失败不自动重试、不写 TOML。明确作用于整个 CLI 进程，显示的读取范围不能混淆默认配置与当前线程。刷新后从 CLI 恢复，不用浏览器存储冒充生效。
- 清理：真实脚本在 finally 恢复 tool_suggest 原状态，校验 config.toml 哈希不变；UI 稀有状态只在浏览器网络夹具中变化，不提交到真实 CLI。

## 实时语音生命周期

- 前置：浏览器支持 WebRTC、HTTPS 或 localhost；只有用户主动配置 realtime_conversation 并重启选定的隔离 CLI 后才允许尝试真实音频。不要启用正式配置，不改变 Responses provider 的 supports_websockets。
- 操作：进入语音页但不点击连接；点击连接后允许麦克风，分别模拟启动被拒、只收到 started、收到 SDP 且 peer connected；发补充文本，收到 transcript delta/done，停止、关闭、切换标签页、后台、刷新和 pagehide/BFCache 返回。
- 预期：未点击不申请麦克风；未获得 peer connected 不能显示已连接。声音来自 V1 listVoices，不把 Astra 当默认实时模型。done 替换未完成转写而非重复；文本不发往 turn/start。启动失败、断线、关面板及 BFCache 返回均释放 track/peer/audio，不自动重连，刷新后没有残留“已连接”。HTTP 局域网页面即使没有 randomUUID 也能显示 HTTPS 限制，而不是崩溃。
- 预期：租约不抢占其他页面；原生明确返回 does not support realtime conversation 后不留下假租约。启动确认不确定时仍尝试清理且不重发 start；桥接关闭后不能启动已排队请求。
- 验证边界：当前真实 CLI 未启用 realtime_conversation，真实验收证明拒绝及清理、声音目录与方法存在；媒体交换使用 WebRTC/通知夹具，不等于已通过真实麦克风、供应商语音或音质/延迟验收。
- 清理：关闭语音面板，检查 track.stop/peer.close 调用及服务端租约；测试不留录音文件。

## 远程控制与子任务恢复

- 前置：远控初始 disabled；仅网络夹具模拟配对，真实脚本只读 status，不私自开放远控。子任务使用真实 ancestor 查询加浏览器历史夹具，不为了验收擅自生成子代理。
- 操作：点击临时启用，先检查未确认时没有请求，再确认；模拟通知先到而 enable 返回 connecting 后到。生成配对码、查询 claimed、刷新客户端、确认撤销、停用。另模拟过期、错误及切换 environmentId。
- 预期：仅发送 ephemeral=true，不写配置；旧 ACK 不覆盖新通知。客户端方法为 remoteControl/client/list 和 remoteControl/client/revoke（单数 client），参数含 environmentId。配对码不写存储/日志，成功、过期或离开后不继续有效展示；关闭面板不擅自停用全局远控。
- 操作：查看活动代理卡“打开子线程”和“子任务”页，刷新浏览器恢复 child 元数据，打开链接查看原线程；无子任务时看空状态。
- 预期：父子关系、任务摘要、角色、模型/推理配置、状态明确；notLoaded 不标完成。不扫描全量历史，不对每项 resume；只在子任务页按相关通知合并刷新，读取有界。只有 Schema 确认 ancestorThreadId 才调用。
- 清理：夹具的配对码与设备都是假的；没有真实 remote enable/revoke，也没有创建子代理或修改正式线程。

## 上下文、主题与性能

- 操作：在上下文页查看 context_management、remote_compaction_v2、provider、accountType；注入 runtime modelContextWindow=123456 与普通压缩通知。分别在 1280×900、375×812、768×1024 的 light/dark 检查五个页签和实际输入/确认控件。
- 预期：开关、认证/provider 路径、执行证据分层；普通压缩不是新引擎证明；仅显示收到的运行窗口，不用 TOML 值替代。明暗表面/输入控件正确、无横向溢出，模态框内部滚动。
- 操作：实际 Astra 只读 TestChat 产生唯一 PHASE3_LINK_20260905 与 README 链接，检查 hrefOk/titleOk/textOk；使用当前 4173 跑首页及线程 profile:browser，检查重复请求、长任务、总载荷和懒加载，截图保存 output/playwright/。
- 预期：新面板关闭时不读取扩展详情、不启动媒体/配对轮询、不新增通知 WebSocket。报告必须说明已有重复 thread/list 或开发服务器长任务，不能把单次测量叫 P95 改善。
- 清理：测试容器只删除本脚本创建的实例；4173 按仓库规则保留，13510 不重启、不部署，不生成升级备份。
