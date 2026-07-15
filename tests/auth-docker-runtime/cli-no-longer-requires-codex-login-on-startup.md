### Feature: CLI no longer requires codex login on startup

#### Prerequisites
- Remove `~/.codex/auth.json` to simulate a first-time user.

#### Steps
1. Run `npx codexui` or `pnpm run dev`.
2. Verify the CLI prints a message about not being logged in but does NOT block or prompt for login.
3. Verify the server starts and the web UI loads successfully.
4. Open Settings and confirm Provider shows only `Codex`.
5. Attempt to send without an account and confirm the Codex authentication error is shown instead of an external-provider fallback.

#### Expected Results
- CLI does not run `codex login` on startup.
- A friendly message is shown: "You can log in later via settings or run `codexui login`."
- The server and web UI remain available without a Codex account, but chatting requires Codex authentication.

#### Rollback/Cleanup
- Run `codexui login` to restore Codex authentication if needed.

---
