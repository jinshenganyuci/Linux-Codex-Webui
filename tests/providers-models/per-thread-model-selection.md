### Feature: Persistent per-thread model and reasoning selection

#### Prerequisites
- Run the app from this repository with an isolated `CODEX_HOME`.
- Configure Codex CLI defaults to model `A` and reasoning effort `XHigh`.
- Make model `B` available with both `High` and `Max` reasoning efforts.
- Have two existing threads available, or create them during the test.

#### Steps
1. Open thread `1`, select model `B`, then select reasoning effort `Max` without sending another message.
2. Open thread `2`, select model `A`, then select reasoning effort `High`.
3. Switch repeatedly between threads `1` and `2`.
4. Refresh the browser on thread `1`, then open thread `2` again.
5. Open the WebUI in a fresh private browser context and inspect both threads.
6. Restart the WebUI service, reload the private browser, and inspect both threads again.
7. Stop and start the test VPS or container while preserving `CODEX_HOME`, then inspect both threads.
8. While thread `1` is running, queue a follow-up message and close the browser before the queued turn starts.
9. Reopen the browser after the queued turn starts and inspect the turn metadata or server request payload.
10. Open the new-thread screen and confirm its initial model and reasoning effort match the current Codex CLI defaults.
11. On the new-thread screen, manually select model `B` and `Max`, then send the first message.
12. Return to the new-thread screen and inspect the defaults again.
13. Fork thread `1` and inspect the forked thread's model and reasoning effort.

#### Expected Results
- Thread `1` always restores model `B` with `Max`; thread `2` always restores model `A` with `High`.
- Switching threads, refreshing, using a fresh browser, restarting the service, and restarting the host do not change either thread's selection.
- A manual selection is persisted immediately; sending another message is not required to save it.
- The queued turn uses thread `1`'s captured model and reasoning effort even while no browser is connected.
- Existing persisted selections are not overwritten by `thread/read`, `thread/resume`, global CLI defaults, or a temporarily incomplete model catalog.
- The new-thread screen starts from the current Codex CLI defaults and does not inherit the last opened thread or a previous new-thread draft.
- A manually customized first turn is persisted to the newly created thread, while the next new-thread screen returns to CLI defaults.
- A fork starts with its source thread's model and reasoning effort and then becomes independently editable.
- `${CODEX_HOME}/linux-codex-webui-thread-model-preferences.json` remains valid JSON with mode `0600`.

#### Rollback/Cleanup
- Stop the isolated test service.
- Remove the isolated `CODEX_HOME`; do not delete the preference file from a real user profile.
