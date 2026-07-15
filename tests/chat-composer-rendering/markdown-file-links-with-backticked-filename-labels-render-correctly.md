### Feature: Markdown file links with backticked filename labels render correctly

#### Prerequisites
- App is running from this repository.
- A disposable `TestChat` thread is open.
- Light and dark themes are both available.
- Local file exists at `/home/ubuntu/andClaw-srcmatch/app/src/main/java/com/coderred/andclaw/ui/util/TrustedBrowserLauncher.kt`.
- Browser developer tools are available, and `output/playwright/` exists if screenshot evidence is being captured.

#### Steps
1. Choose a unique marker such as `markdown-pipeline-<timestamp>`. In light theme, send one message containing: ``markdown-pipeline-<timestamp> Added [`TrustedBrowserLauncher.kt`](/home/ubuntu/andClaw-srcmatch/app/src/main/java/com/coderred/andclaw/ui/util/TrustedBrowserLauncher.kt)``.
2. Confirm the rendered message shows one clickable file link with visible text `TrustedBrowserLauncher.kt`.
3. In the developer console, replace the marker value below with the exact marker sent and run:
   ```js
   const marker = 'markdown-pipeline-<timestamp>'
   const row = [...document.querySelectorAll('.message-row')]
     .find((element) => element.textContent?.includes(marker))
   const link = row?.querySelector('a.message-file-link')
   const expectedPath = '/home/ubuntu/andClaw-srcmatch/app/src/main/java/com/coderred/andclaw/ui/util/TrustedBrowserLauncher.kt'
   const result = {
     hrefOk: link?.getAttribute('href') === `/codex-local-browse${expectedPath}`,
     titleOk: link?.getAttribute('title') === expectedPath,
     textOk: link?.textContent?.trim() === 'TrustedBrowserLauncher.kt',
     targetOk: link?.getAttribute('target') === '_blank',
     relOk: link?.getAttribute('rel') === 'noopener noreferrer',
   }
   result
   ```
4. Verify `hrefOk`, `titleOk`, `textOk`, `targetOk`, and `relOk` are all `true`, with no visible backticks or split link fragments.
5. Click the link and confirm it opens local browse for `/home/ubuntu/andClaw-srcmatch/app/src/main/java/com/coderred/andclaw/ui/util/TrustedBrowserLauncher.kt`.
6. Right-click the same link and choose `Copy link`, then paste it into a text field and verify it resolves to the same full path.
7. Switch to dark theme, return to the same uniquely marked row, rerun the five assertions, and verify all remain `true` and the link remains readable.
8. Capture the real rendered row after waiting 2-3 seconds. For automated Playwright acceptance, save the evidence as `output/playwright/testchat-markdown-pipeline-cjs.png` and record the tested URL and viewport with the result.

#### Expected Results
- The markdown link renders as one clickable file link instead of splitting around backticks.
- The visible link text is the markdown label `TrustedBrowserLauncher.kt`, without backtick glyphs.
- Clicking opens the local browse route for the full file path.
- Copied link includes the full encoded path and still resolves to the same file.
- Light and dark theme message surfaces keep the link readable and styled consistently.
- The uniquely marked `TestChat` row reports `hrefOk`, `titleOk`, and `textOk` as `true` before and after switching themes.
- The extracted Markdown pipeline preserves the anchor target, raw-path title, backtick-free label, `_blank` navigation behavior, and `noopener noreferrer` relationship.

#### Rollback/Cleanup
- Return the previous appearance setting.
- Delete the disposable `TestChat` thread and local fixture file only if they were created solely for this verification; retain or remove the screenshot according to the acceptance evidence policy.
