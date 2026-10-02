# Phase 22 browser acceptance handoff

Status: root's complete production-build/browser run passed all199 tests, including the four Phase22 journeys, on reviewed source commit `55bbce4b7987eb145ae0ab62b98e852be49456b8`.

## Fixture boundary

`e2e/phase22.spec.ts` reads the actual enabled version 2 viewer through the local `/api/mcp` resource methods, checks its MIME type and CSP descriptor, and mounts the returned HTML in an opaque sandboxed iframe. The fixture parent implements the MCP Apps handshake and records each tool call, link handoff and display-mode request. It refuses every tool except `get_pack` and every unknown host method. The host applies the descriptor's preview origins and denies connections and nested frames.

Every preview is intercepted and supplied as a generated sample SVG. Unexpected network requests are aborted and fail the checks. Download actions are recorded as host handoffs and never follow the links. Test values are sample pack data and deliberately invalid fixture tokens. No credentials, live receiver, paid generation, external preview access or installed ChatGPT connection is involved.

The fixture represents an authenticated host bridge but does not establish server authentication or actual ChatGPT behavior. Existing server authorization/integration tests and separately recorded real-client acceptance own those proofs. These browser checks cannot establish native attachment/Library behavior or downloaded production bytes.

## Coverage

1. A create result shows progress and becomes delivered previews after one `get_pack`, with per-file channel checks and measured/unknown fidelity. No further poll starts after completion.
2. An existing pack's replayed links remain unused until a new `get_pack` result arrives. At 375 pixels wide, keyboard actions hand off the current image, ZIP and report URLs and the document does not overflow horizontally.
3. A fixture HTTP 410 preview produces an expiry notice. Explicit refresh requests only `get_pack` and displays replacement links. A later refused refresh retries within the existing bound, removes stale links and never creates another pack.
4. A canceled terminal pack retains its explanation alongside exactly the delivered partial image and report actions. Missing outputs stay absent and polling stops.

Every scenario checks script errors, unexpected network activity, unknown host methods and the exact `get_pack({ pack_id })` argument contract. The chat-assets owner reviewed the planned bridge and labels before edits. An accessible-name gap in the progressbar was reported to that owner rather than editing their source.

## Static evidence

- `pnpm exec tsc -p tsconfig.json`: passed. Log: `/tmp/curvi-phase22-qa-types.log`.
- `pnpm exec eslint e2e/phase22.spec.ts`: passed. Log: `/tmp/curvi-phase22-qa-lint.log`.
- `git diff --check -- e2e/phase22.spec.ts`: passed.

No browser execution or production build was started by this lane. Root executed the complete frozen-source run successfully; evidence is `/tmp/curvi-phase22-e2e-final.log`. This lane changed only the new browser spec and this handoff, with no Git, database, environment, package or live-service mutation. The result is local fixture-host proof; actual installed ChatGPT acceptance remains pending.
