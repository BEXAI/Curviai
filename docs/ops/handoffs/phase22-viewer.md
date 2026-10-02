# Phase 22 viewer implementation handoff

Implemented in `/tmp/curvi-phase-22`, branch `codex/phase22-chatgpt-launch`, from the frozen Phase 21 base. This lane changed only `apps/web/src/lib/mcp-ui/pack-viewer/**`, `apps/web/src/app/api/mcp/mcp-viewer.test.ts`, and this handoff. No Git mutation, dependency installation, environment/secret read, live connection, generation, submission, or publication was performed.

## Delivered behavior

- Enabled the viewer before first submission, as explicitly authorized for Phase 22. Resource URI is `ui://curvi/pack-viewer/v2.html`; MIME, same-origin CSP, and resource export contracts remain intact. The connection lane attaches it to `create_pack` and `show_pack`; only `get_pack` is available to widget calls.
- Revalidates every host-delivered terminal result through authenticated `get_pack` before exposing preview or download URLs. A replayed conversation result cannot start a new 24-hour clock on old links. Only a response to this mounted viewer's read starts link age.
- Persists only the pack handle and expanded presentation choice through the optional host widget-state helper. Restoration ignores any saved files/status/credits and reads the current pack. No URLs, credentials, or business results are saved in widget state.
- Adds an explicit `Refresh files` action, a disabled `Refreshing files` state, duplicate-click protection, and bounded retry/error behavior. Both MCP Apps requests and the legacy `window.openai.callTool` fallback have deadlines. Refresh never calls creation or any write tool.
- Displays legitimate server-provided partial image/ZIP/report output alongside the neutral failed/canceled status. It does not recover withheld assets or invent a successful result. ZIP and report have direct labeled actions, including narrow layouts.
- Labels each image's channel check and measured product-color result. Unknown measurements stay unknown; exact-file wording requires the existing exact measurement flag. Download accessible names include the filename; status/busy semantics, keyboard buttons, and a named progress bar are present.
- Fences stale responses/errors by pack lifecycle. A new pack resets the earlier pack's polling cap/error state. Teardown prevents late initialization or polling from restarting the UI. Detached preview errors cannot expire a freshly rendered pack.

## Validation

- Focused viewer/resource suite: **61 tests passed in four files**. `/tmp/curvi-phase22-viewer-tests.log`.
- Scoped ESLint with required `--fix`: passed. `/tmp/curvi-phase22-viewer-lint.log`.
- Web TypeScript check: passed; repeated after the final detached-preview guard. `/tmp/curvi-phase22-viewer-types.log`.
- Owned-file diff whitespace check: passed.
- Independent reviewer examined lifecycle reset, asynchronous request fencing, teardown, terminal revalidation, restoration, and detached-image handling and reported no blocking viewer finding.

Regression tests exercise old conversation links, restored untrusted state, foreign-pack responses, stale success/error after switching pack, capped/error lifecycle recovery, teardown during initialization/polling, legacy timeout exhaustion, duplicate refresh clicks, refusal after refresh, expired/partial output, and per-file check/measurement labels. Embedded HTML is executed as a standalone script in the fixture host, retaining the existing self-contained-function and size-budget checks.

The E2E lane owns `e2e/phase22.spec.ts` and the parent owns production build/full checks. No actual ChatGPT behavior is claimed from these fixtures. Real OAuth, accepted screening evaluation/activation, authorized test data/spend, client screenshots/download evidence, and public review remain separate launch gates from the readiness audit.

## Official contract verification

The 2026-10-02 readiness audit checked the [OpenAI plugin reference](https://developers.openai.com/plugins/reference) and [UI guide](https://developers.openai.com/plugins/build/chatgpt-ui). The implementation continues to use the standard MCP Apps bridge, optional capability-detected host helpers, server-owned business state, and a versioned UI resource. It introduces no undocumented native-download or Library-import API. The parent should include the dated verification in its shared `docs/verification.md` batch.
