### Thread detail load avoids duplicate history fetch and eager resume

#### Feature/Change Name
Opening a legacy thread reads its detail without first calling `/codex-api/thread-live-state` or eagerly materializing it with `thread/resume`. The thread is resumed only when the user sends a new turn.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. Browser dev tools Network panel open
3. An existing thread with a large history

#### Steps
1. Open the existing thread
2. Inspect network/RPC calls during the message load
3. Send a new message in the opened thread
4. Inspect the RPC order for the send

#### Expected Results
- The initial message load performs one `thread/read` for the thread
- Merely opening the thread does not call `thread/resume`
- It does not first call `/codex-api/thread-live-state` for the same normal message load
- Sending calls `thread/resume` before `turn/start`
- Messages and active/in-progress state still render correctly

#### Rollback/Cleanup
- Stop only the disposable test server if one was started; do not stop the persistent development server.

---
