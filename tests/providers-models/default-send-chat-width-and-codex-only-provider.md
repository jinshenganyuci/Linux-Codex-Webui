### Default send mode, chat width, and Codex-only provider

#### Feature/Change Name
New browser profiles require Command/Ctrl+Enter to send, use the wide chat layout, and expose only Codex as the provider.

#### Prerequisites/Setup
1. Start the current build on the verification port.
2. Use a fresh browser profile, or remove only `codex-web-local.send-with-enter.v1` and `codex-web-local.chat-width.v1` from local storage.
3. Have a usable Codex account available when verifying an actual send.

#### Steps
1. Open the home screen in light theme and open Settings.
2. Confirm “Require ⌘ + enter to send” is enabled and “Chat width” reads “Wide”.
3. Confirm the Provider row shows `Codex` as a fixed value and offers no provider dropdown, API-key field, endpoint field, or API-format control.
4. Type a message. Press Enter and confirm it remains in the composer; then press Command+Enter on macOS or Ctrl+Enter on Linux/Windows and confirm it sends.
5. Set valid existing preferences for Enter-to-send and Standard width, reload, and confirm those explicit preferences are still respected.
6. Repeat the Settings checks in dark theme.

#### Expected Results
- Fresh profiles default to Command/Ctrl+Enter sending and the Wide layout.
- Existing valid stored preferences are not overwritten.
- Codex is the only provider surface, with no external-provider configuration controls.
- The settings row, value chips, and composer remain readable in light and dark themes.

#### Rollback/Cleanup
- Restore or remove the two local-storage keys used during verification.
- Return the appearance setting to the preferred theme.
