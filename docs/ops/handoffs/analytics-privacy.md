# Analytics privacy correction

This is a Phase 19/20 privacy correction discovered during Phase 21 review, not a future proposal. Scope is the global PostHog initializer, the existing API key panel, and focused regression coverage. No analytics project setting, credential or external event was changed.

The extracted `initializeAnalytics` calls the installed SDK with `autocapture: false` and `disable_session_recording: true`. Consented client-navigation pageviews, pageleave events and explicit typed product events remain enabled. An already-loaded SDK receives the local privacy settings before consent opt-in resumes capture, so an old initialization cannot preserve broader DOM/replay capture settings.

The Analytics effect rechecks its current consent choice and mounted state when a lazy SDK import resolves. A grant queued before withdrawal or unmount does not initialize the SDK and emit a late pageview. The API key panel's outer boundary now uses `ph-no-capture ph-mask`, covering key names, prefixes and the one-time credential display as additional protection. Case and webhook boundaries belong to their feature owners.

Verified 2026-10-02 against installed `posthog-js` **1.434.16** and official sources:

- https://posthog.com/docs/libraries/js/config explains `autocapture`, `disable_session_recording`, `capture_pageview` and configuration controls. Disabling autocapture preserves pageviews.
- https://posthog.com/docs/privacy/data-collection explains programmatic collection controls and `ph-no-capture` sensitive boundaries.
- https://posthog.com/docs/libraries/js/usage explains replay `blockClass: 'ph-no-capture'` and `maskTextClass: 'ph-mask'`; the independent reviewer verified this source and owns `docs/verification.md`.
- Local installed SDK confirms `set_config` invokes `sessionRecording.startIfEnabledOrStop()` in `lib/src/posthog-core.js`; replay defaults are in `lib/src/extensions/replay/external/lazy-loaded-session-recorder.js`, and autocapture honors the sensitive class in `lib/src/autocapture.js`.

The web tool could not read the official markdown content type; the official configuration and privacy pages were retrieved read-only with curl and parsed locally. No nonofficial source was used.

Behavioral validation: **15 tests passed in three files**, covering the actual init arguments, privacy configuration before reconsent, already-consented instances, no initial load before consent, withdrawal while lazy loading, unmount while loading, explicit billing-event capture while consented, cessation after withdrawal, re-enable, missing configuration and listener cleanup. Tests call the actual initializer/effect with an SDK fixture and never transmit to PostHog.

```sh
pnpm --filter @curvi/web test src/lib/analytics-init.test.ts src/components/analytics.test.ts src/lib/consent.test.ts
```

Evidence: `/tmp/curvi-analytics-privacy-tests.log`, `/tmp/curvi-analytics-privacy-lint.log`, `/tmp/curvi-analytics-privacy-types.log`. Root owns full repository gates and publication.

Scoped lint and diff checks pass. Root subsequently passed full repository lint, full typechecking, the production build and all 195 browser tests (`/tmp/curvi-phase21-{lint,types,e2e}.log`). The complete unit run passed this analytics coverage and found two unrelated Phase 21 privacy/retention integration failures, assigned to their owner. This prerequisite correction does not depend on the Phase 21 tables or services.
