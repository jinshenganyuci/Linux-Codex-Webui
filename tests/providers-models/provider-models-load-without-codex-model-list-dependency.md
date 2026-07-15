### Provider models load without Codex model-list dependency

#### Feature/Change Name
Models from a Codex-configured `model_provider` remain available when `model/list` is slow or unavailable.

#### Prerequisites/Setup
1. Run a temporary Responses-compatible test backend whose `/v1/models` route returns `proxy-default` and `proxy-fast`.
2. In an isolated `CODEX_HOME/config.toml`, set `model_provider = "myproxy"` and configure `[model_providers.myproxy]` with that base URL and `wire_api = "responses"`.
3. Start the current build and open the home screen.

#### Steps
1. In light theme, wait for initial model loading and open the model selector.
2. Simulate a slow or failed Codex `model/list` call while keeping the configured provider `/models` route available.
3. Confirm `proxy-default` and `proxy-fast` remain available through `/codex-api/provider-models`.
4. Switch to dark theme and repeat the selector check.

#### Expected Results
- Provider-backed model loading does not require a successful `model/list` response.
- The configured Codex provider models populate the selector without a blank list.
- The selector remains readable in light and dark themes.

#### Rollback/Cleanup
- Stop the temporary backend and restore the isolated `config.toml`.
