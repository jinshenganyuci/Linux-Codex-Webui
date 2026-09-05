### Active thread switches after delete

#### Feature/Change Name
删除当前聊天后直接进入新建聊天，不再自动选择相邻聊天。

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Sidebar contains at least three disposable test threads
3. Light theme and dark theme are available from the appearance switcher

#### Steps
1. In light theme, open the middle disposable thread
2. Click that thread's delete icon, then click `Confirm`
3. 核心删除确认后，检查弹窗关闭并进入新建聊天，路由为 `#/`
4. Open the last disposable thread
5. Delete and confirm it
6. 检查删除最后一个聊天后也进入新建聊天，不打开前一个聊天
7. Repeat steps 1 through 6 in dark theme
8. 在第二个标签页打开同一聊天，确认收到删除通知后也退出已删除聊天
9. 模拟核心删除请求慢、失败，以及附属清理延迟 3～10 秒：慢请求显示“正在删除”；核心失败保留弹窗、提示并允许重试；附属清理不阻塞界面
10. 删除等待期间切换到其他聊天，检查删除成功后不抢走新选择
11. 模拟旧 `thread/read`、`thread/goal/get` 响应迟到，检查新页面不被旧错误覆盖；返回已删除地址也不会重新打开旧聊天

#### Expected Results
- Deleting the active thread does not leave the deleted thread selected
- 删除当前聊天后选中状态清空，路由进入新建聊天；删除非当前聊天不打断对话
- 核心删除确认后立即更新界面，不等待附属清理，客户端不再发出三个清理 DELETE 请求
- A stale deleted-thread URL does not switch the UI back to the archived thread
- Light-theme and dark-theme sidebar selection states remain readable after the automatic switch

#### Rollback/Cleanup
- Delete any disposable threads created only for this test
- 永久删除本身不可撤销，回滚代码不能恢复聊天
- 附属清理由服务端有界并行执行，失败最多尝试三次并记录日志；进程退出停止未执行的重试，不影响已确认的删除

---
