### Feature: 编辑对话与撤销文件分离（Codex 0.154.0 / 0.159.3）

#### 前置条件
- 在隔离的 13511 验收环境准备两版 CLI 和可丢弃的 legacy / paginated 会话，各包含至少三个已完成回合。
- 工作目录为可丢弃的 git 仓库，至少一个回合通过 `apply_patch` 修改文件；记录文件校验值。

#### 操作与预期
1. 点击第二回合用户消息下的“编辑对话”，确认按钮旁可见“仅调整对话，保留文件；旧会话可能另开分支”说明。
2. 0.154.0 legacy 会话：调用 `thread/rollback` 移除目标及后续回合；工作区文件校验值不变。
3. 两版 paginated 会话：调用 `thread/revert(beforeTurnId)`；重新加载最多 10 个回合的初始页，旧游标/已删除消息不再出现，刷新后保持回退结果。
4. 0.159.3 legacy 会话：调用 `thread/fork(beforeTurnId)`，进入不含目标回合的新分支；原会话完整保留，工作区文件不变。
5. 在任意模式下让能力目录或历史变更请求失败：原会话消息、工作区和输入框草稿不被提前修改；显示错误。
6. 慢请求期间切到其他会话：完成时不抢占选择，不向其他会话草稿添加文本。
7. 展开原会话文件变更卡并使用独立 `Undo` / `Redo`：仍按原测试撤销/恢复文件，不隐式变更聊天历史。

#### 清理
- 删除可丢弃的会话、分支和测试工作目录；清空测试草稿。
- 仅验收环境切换 CLI。历史回退是实际数据变更，测试前保留原会话备份。

### Feature: Chat file-change undo and redo

#### Prerequisites
- App is running from this repository (`pnpm run dev`).
- A thread exists with at least one completed assistant turn that applied file changes via `apply_patch`.
- The thread's `cwd` points to a writable worktree.

#### Steps
1. Open a thread with a visible file-change summary under an assistant response.
2. Expand the file-change summary, identify one changed file, and save its current contents with `cat <file> > /tmp/file-before-undo.txt`.
3. Confirm the file-change action row shows `Undo` and does not show a separate `Redo` button.
4. Click `Undo` in the file-change action row.
5. Confirm the button enters an `Undoing` pending state and then changes to `Redo`.
6. Verify the file contents on disk are restored to the pre-turn state with `diff -u /tmp/file-before-undo.txt <file>`.
7. Click `Redo` in the same file-change action row.
8. Confirm the button enters a `Redoing` pending state and then changes back to `Undo`.
9. Verify the file contents on disk match the assistant turn's changes again with `cat <file>` or a diff against the assistant-modified snapshot.
10. Repeat steps 1-9 in light theme and dark theme.

#### Expected Results
- Undo reverts the file changes applied by the selected turn without changing chat history.
- Redo reapplies the previously run `apply_patch` input without changing chat history.
- The file-change action row shows exactly one action button at a time: `Undo` before rollback, `Redo` after undo, and `Undo` again after redo.
- If Undo fails, the inline error stays visible and the single action still switches to `Redo` so the user can reapply or recover the visible action state.
- Any backend error appears inline in the file-change panel.
- The action row uses themed controls that remain readable in light and dark theme.

#### Verification Evidence
- Light screenshot: `output/playwright/chat-file-changes-failed-undo-single-redo-light.jpg`.
- Dark screenshot: `output/playwright/chat-file-changes-failed-undo-single-redo-dark.jpg`.
- Browser runtime profile: `output/playwright/browser-runtime-profile-home-2026-05-20T03-11-53-121Z.json`.
- Profile result on `http://127.0.0.1:4173/`: `warnings: []`, `threadReadDuplicateKeys: 0`, `totalApiKB: 337.9`.
- Code-path audit: file-change action state is component-local and keyed by thread plus turn, so it does not add startup or thread-list requests. Undo/redo server work is request-scoped, bounded to collected patch inputs for the selected turn or explicit patch subset, and uses sequential filesystem operations without background fanout.

#### Rollback/Cleanup
- Click `Undo` again if the test should leave the worktree without the assistant's file changes.
