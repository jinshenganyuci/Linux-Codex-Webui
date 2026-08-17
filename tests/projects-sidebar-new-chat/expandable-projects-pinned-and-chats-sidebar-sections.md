### Server-persisted sidebar sections and project collapse

#### Feature/Change Name
The sidebar uses the fixed order `Pinned → Chats → Projects` and stores section and per-project collapse state on the WebUI server so the same layout is restored in another browser.

#### Prerequisites/Setup
1. The current build is running at the approved test address `http://127.0.0.1:13511`
2. At least one projectless chat, two projects, and one pinned thread are available in the sidebar
3. Two isolated browser profiles or contexts can access the same WebUI instance and `CODEX_HOME`
4. The browser network panel can inspect `/codex-api/preferences/sidebar-layout`
5. Light and dark themes are available from the appearance switcher

#### Steps
1. In browser A with the light theme, open the app with the sidebar expanded
2. Verify the visible and keyboard navigation order is `Pinned`, `Chats`, then `Projects`
3. Open the Projects organize menu and verify there is no `Chats first` option; switch `Sort by` between `Created` and `Updated` and verify only chat row ordering changes
4. Collapse `Pinned`, `Chats`, and `Projects` one at a time; confirm each click updates immediately and sends one successful field-level `PATCH /codex-api/preferences/sidebar-layout`
5. Expand the three sections again, then collapse one named project and leave a second project expanded
6. Refresh browser A and verify the section and per-project states are restored by `GET /codex-api/preferences/sidebar-layout`
7. Open browser B and verify the same named project is collapsed, the second project is expanded, and the fixed section order matches browser A
8. In browser B, expand the collapsed project; return focus to browser A and verify browser A refreshes to the expanded server state
9. Collapse the project again, then navigate directly to a thread under that project using its URL; verify the project remains collapsed
10. Search for a thread under the collapsed project and refresh the thread list; verify neither operation changes the saved project collapse state
11. Pin and unpin a chat; verify `Pinned` remains above `Chats` and an unpinned projectless chat returns to `Chats`
12. Click `Show more` in `Chats` or a project with more than 10 rows, refresh, and verify this paging-only state returns to its default without changing section/project collapse state
13. Switch to the dark theme and repeat the fixed-order, chevron, collapsed-row, error-message, and hover checks

#### Expected Results
- The sidebar always renders `Pinned → Chats → Projects`; when there are no pinned rows, `Chats` is first
- `Chats first` and its old browser-local ordering preference no longer affect layout
- Section and per-project collapse changes are controlled only by explicit user clicks
- Route selection, search, incoming thread data, project reordering, and refresh do not automatically expand or collapse a project
- Server state wins over stale localStorage state after the one-time migration
- Two browsers using the same WebUI instance restore the same state; different project fields merge without replacing each other
- A failed GET or PATCH leaves the sidebar usable and presents a visible persistence error
- `Show more` remains a transient paging control rather than a persisted project-collapse preference
- Light and dark themes keep section headers, controls, and rows readable

#### Rollback/Cleanup
- Return the desired sections and projects to their normal state using their chevrons
- To repeat first-run migration testing, stop the disposable test instance and remove only its `linux-codex-webui-sidebar-preferences.json` file from that test instance's `CODEX_HOME`
- Do not remove or modify the formal instance's preference file during routine verification

---
