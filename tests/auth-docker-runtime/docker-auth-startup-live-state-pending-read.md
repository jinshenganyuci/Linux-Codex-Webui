### Docker auth startup live-state pending read

#### Feature/Change Name
Docker authenticated first-turn live-state pending read handling.

#### Prerequisites/Setup
1. Build the project with `pnpm run build`.
2. Build a fresh Docker image that installs `@openai/codex` and runs the packed `codexapp` artifact.
3. Prepare two isolated `CODEX_HOME` states: one empty and one with only a valid `auth.json` mounted.

#### Steps
1. Start the no-auth container and open the app in light theme.
2. Confirm Settings shows only Codex and `config/read` contains no WebUI-injected provider override.
3. Send `hi` and confirm a Codex authentication error is shown.
4. Start the auth-mounted container and open the app in light theme.
5. Confirm `config/read` has no WebUI-injected provider override.
6. Send `hi` and poll `/codex-api/thread-live-state?threadId=<id>` while the first turn is starting.
7. Confirm early live-state responses do not expose `liveStateError.kind="readFailed"` for `not materialized yet; includeTurns is unavailable before first user message`.
8. Wait for the assistant reply, then switch to dark theme and repeat the visual checks for the composer/thread area.

#### Expected Results
- No-auth Docker startup keeps the Codex-only provider path and surfaces the authentication requirement.
- Auth-mounted Docker startup uses the normal Codex provider path and returns a `hi` response.
- The transient first-turn materialization window is represented as an in-progress empty live state, not a visible chat error.
- Real `thread/read` failures still surface through `liveStateError`.
- Light theme and dark theme keep the chat/composer readable throughout the first-turn transition.

#### Rollback/Cleanup
- Stop temporary containers with `docker rm -f codexui-noauth-test codexui-auth-test` when finished.

---
