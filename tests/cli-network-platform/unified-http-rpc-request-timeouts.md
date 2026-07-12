# Unified HTTP and RPC Request Timeouts

## Purpose

Verify that browser HTTP and JSON-RPC requests stop waiting after the configured deadline without changing WebSocket/SSE behavior or claiming that server-side side effects were cancelled.

## Prerequisites

- Install project dependencies.
- Start the current project on a disposable local port.
- Use a browser with developer tools available.
- Use test endpoints, request interception, or a temporary local proxy that can delay selected responses without modifying production data.

## Cases

### Ordinary HTTP timeout

1. Delay an ordinary state or list endpoint for more than 15 seconds.
2. Trigger the related UI action.
3. Confirm the loading state ends and the failure is reported as a timeout.
4. Confirm a later ordinary request still succeeds.

Expected result: the browser stops waiting after about 15 seconds, no automatic retry occurs, and subsequent requests are unaffected.

### RPC timeout

1. Delay `POST /codex-api/rpc` without returning headers or a body.
2. Trigger a non-long RPC request.
3. Wait more than 30 seconds.

Expected result: the request fails with the RPC operation name and timeout classification. WebSocket/SSE notification connections remain active.

### Long operations

Exercise project ZIP import/export, GitHub clone, worktree creation, Composio installation, file upload, Skills install/sync, and transcription with an artificial delay longer than 15 and 30 seconds but shorter than 120 seconds.

Expected result: these operations are not terminated by the ordinary or RPC deadline. If the 120-second deadline is exceeded, the browser stops waiting and reports a timeout.

### Caller cancellation

1. Start transcription.
2. Cancel it before the long timeout expires.

Expected result: the request is classified as user cancellation rather than timeout, and recording/transcription state returns to idle.

### Side-effect uncertainty

1. Delay a Git, clone, import, worktree, Skills, or automation action past its timeout.
2. Allow the backend to continue or complete independently.
3. Refresh or query the relevant state before attempting the action again.

Expected result: the client does not automatically retry and does not claim the server-side operation stopped. State can be reconciled before a manual retry.

### Realtime regression

1. Keep a thread open long enough to receive heartbeats and notifications.
2. Temporarily interrupt and restore the realtime connection.

Expected result: existing WebSocket-to-SSE fallback, watchdog, sequence replay, and reconnect behavior remain unchanged.

## Cleanup

- Remove request interception or proxy delay rules.
- Delete any disposable cloned repository, imported project, worktree, uploaded file, or test Skill created during verification.
