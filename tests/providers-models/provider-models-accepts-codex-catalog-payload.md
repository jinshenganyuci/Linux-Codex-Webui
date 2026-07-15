### Provider models accept Codex catalog payloads

#### Feature/Change Name
Codex-configured provider discovery accepts both OpenAI-compatible and Codex catalog `/models` payloads.

#### Prerequisites/Setup
1. Run a test backend that returns `{"models":[{"slug":"gpt-5.4"}]}` from `GET /v1/models`.
2. In an isolated `CODEX_HOME/config.toml`, set `model_provider = "myproxy"` and configure `[model_providers.myproxy]` with the test base URL and `wire_api = "responses"`.
3. Start the current build and open it in the browser.

#### Steps
1. Open the model selector for the provider-backed new-chat composer.
2. Confirm the selector includes the id from `models[].slug`.
3. Select that model and start a thread.

#### Expected Results
- `/codex-api/provider-models` accepts ids from either `data[].id` or `models[].slug`.
- The selected model id is passed through to Codex.

#### Rollback/Cleanup
- Restore the isolated `config.toml` and stop the test backend.
