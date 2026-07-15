### Provider-backed scheduled refreshes keep model menus populated

#### Feature/Change Name
Background ancillary refreshes preserve models for threads created with a Codex-configured `model_provider`.

#### Prerequisites/Setup
1. Use an isolated `CODEX_HOME` configured with `model_provider = "myproxy"` and a working `[model_providers.myproxy]` Responses endpoint.
2. Create a thread whose session metadata records `modelProvider: "myproxy"`.
3. Start the current build on the verification port.

#### Steps
1. In light theme, open the provider-backed thread.
2. Wait for the background refresh after route load and open the model dropdown.
3. Confirm the dropdown contains the configured provider models and is not empty.
4. Repeat in dark theme.

#### Expected Results
- Scheduled refreshes request models for the selected thread's configured provider context.
- The model dropdown does not fall back to a disabled or empty state.
- The dropdown remains readable in light and dark themes.

#### Rollback/Cleanup
- Stop the temporary server/backend and remove the isolated `CODEX_HOME` if no longer needed.
