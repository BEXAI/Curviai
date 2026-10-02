# Phase 23: repeatable pack preparation

Status: **planning only, not authorized for implementation or deployment**. Preserved from the original Phase 22 proposals on 2026-10-02 when Phase 22 was explicitly authorized for the Curvi ChatGPT plugin launch. This document proposes three future slices. It authorizes no feature code, migration, live message, integration activation, provider call or spending.

## Why these candidates

The [build plan](../../CURVI_BUILD_PLAN.md), sections 2.2 and 9.3, describes small teams preparing recurring product work. The existing product library, upload preflight, pack form and saved compliance reports provide foundations for making the next pack easier to prepare. The proposals below are grounded in those code paths. They are hypotheses to validate with a seller, not evidence of customer demand or promised retention gains.

| Priority | Candidate | Seller outcome | First pilot |
|---|---|---|---|
| 1 | P23-01 Reuse a saved pack brief | Repeat an intentional configuration without reconstructing every choice. | One workspace manually reuses a brief for two products. |
| 2 | P23-02 Prepare the photos a future pack needs | Understand which source photos and facts are missing before starting work. | A seller uses a read-only readiness list to prepare one product. |
| 3 | P23-03 Review the effect of changed channel rules | Understand which saved outputs may need another check after a verified rule changes. | An operator previews one verified registry change against fixture packs. |

## Existing work retains its owner and acceptance gates

Phase 18–22 implementation defects and incomplete acceptance evidence stay in those phases. This plan does not defer tenant isolation, credit accounting, source fidelity, interrupted-run settlement, delivery security, accessibility, failing checks or production verification. In particular, Phase 21 owns resolution-case privacy and retention, optional-budget concurrency and role enforcement, and webhook atomicity, signing, endpoint safety and delivery acceptance. A defect found in those paths is not a Phase 23 enhancement.

The Phase 18–20 release prerequisite and its pending security review remain release gates. Writing this plan does not authorize dismissing CodeQL findings, bypassing a failed check or merging a dependent branch. Use [the Phase 21 plan](PHASE_21.md) and its checkpoint for current evidence; this proposal is not a deployment status report. Funded evaluations, live billing and mail proof, actual client/OAuth installation, consenting receiver activation and other founder-gated proofs keep their existing requirements. Fixture success does not satisfy a live gate.

The [Phase 20 later and backlog list](PHASE_20.md#explicitly-later-and-backlog) also remains intact. These proposals do not accept CSV/catalog execution, Agency workspaces or shared credits, client review links, the Shopify app, video, localization, delivered-image editing, library pagination, customer MFA, checkpoint resume or operational provisioning. Phase 19 native MCP Events stays deferred. No proposal schedules generation or sends customer messages automatically.

## P23-01: reusable workspace pack briefs

**Code evidence.** [`new-pack-form.tsx`](../../apps/web/src/components/app/new-pack-form.tsx) already manages channel, output and seller choices, while [`services/types.ts`](../../apps/web/src/lib/services/types.ts) defines the estimate/create contracts. Product facts already persist on a product. [`services/db.ts`](../../apps/web/src/lib/services/db.ts) recomputes entitlement, source, pricing and reservation checks before creation. A reusable brief would preserve a seller's selected configuration, rather than copying the product's facts or bypassing those checks.

**Proposed scope.** Let an owner or admin save a named, versioned selection of channels and supported output options. A permitted editor may load a brief into the normal new-pack form, inspect the resulting choices and request a fresh estimate. Show which options changed or became unavailable since the brief was saved. Keep product facts, photo selection and the final start action explicit. Start with workspace-private briefs and a small seeded quota; no public template marketplace or new generation model is implied.

**Decisions before acceptance.** Confirm a real repeated configuration with a seller, choose whether editors can save or only use briefs, and define overwrite, version history and deletion behavior. Specify how a deleted channel or changed entitlement is presented. Decide whether any free text is necessary; the first pilot can omit it. State the quota and retention policy in the accepted plan before a schema is written.

**Security and accounting.** A saved brief contains validated configuration, not credentials, presigned URLs, source object keys, raw prompts or another product's facts. Any new tenant table needs workspace ownership, parent consistency where relevant, RLS and restrictive OAuth denial. Loading a brief grants no capability: current role, feature, source, credit and Phase 21 budget checks still run at estimate and reservation time. Do not reuse a saved quote or idempotency key. If text is later supported, bound it and use the existing user-input handling rather than inserting it into a system prompt.

**Acceptance.** Fixtures show that two products can reuse a brief while keeping their facts and photos separate. An unavailable option is explained before confirmation. The fresh estimate and reservation use current policy, and a stale estimate cannot bypass a lowered budget. A foreign workspace, client seat or raw unauthorized PostgREST write cannot alter a brief. Deleting a brief leaves already delivered packs unchanged. Keyboard and screen-reader users can select, review and save the configuration.

**External setup.** None for the initial pilot. A pack started from a brief uses the existing authorized generation path and its ordinary customer confirmation; the pilot does not authorize agent-funded live generation.

## P23-02: product source-readiness planning

**Code evidence.** [`preflight/types.ts`](../../apps/web/src/lib/preflight/types.ts) exposes measured photo size, product size, supported channel needs and concrete upload problems. [`product-library.ts`](../../apps/web/src/lib/product-library.ts) shows a product's photo count and previous packs. [`trust/purge.ts`](../../apps/web/src/lib/trust/purge.ts) removes eligible source media under the existing retention policy. These facts can explain what a future pack needs without claiming that an absent view can be invented.

**Proposed scope.** Add a read-only preparation view for one selected product and intended channels. Show available source angles, source availability, previously measured size limits, and seller facts that the selected outputs require. Separate "ready from saved evidence," "needs a photo or fact," and "needs a fresh check." Offer a concise capture checklist and a link to the existing upload flow. A stale or missing measurement must not appear as a pass.

**Decisions before acceptance.** Observe one seller preparing a repeat pack and establish which missing input causes avoidable rework. Define the freshness policy for preflight evidence and the exact deterministic checks eligible for reuse. Decide how to explain retention without promising an exact deletion date when recent use or a published share changes eligibility. Keep source-purge correctness in its current owner; this proposal adds planning visibility only.

**Security, retention and fidelity.** Read only the authenticated workspace's product and source metadata. Reuse existing signed-preview authorization and expiration; do not copy photos or extend source retention merely because the readiness page was viewed. Do not fetch third-party product URLs automatically, infer unseen product angles or make a paid vision call to fill an evidence gap. A new upload still passes normal validation and preflight. Any derived cache requires a workspace key, invalidation on source changes/deletion and its own retention rules.

**Acceptance.** Fixtures cover a missing angle, undersized photo, expired source, absent legacy measurements and a product with no saved photos. Removing or replacing a source invalidates the corresponding readiness result. Another tenant receives no source metadata or preview. Opening the view writes no ledger row, starts no job and changes no purge eligibility. The seller can complete a checklist with keyboard navigation and distinguish a requirement from optional advice. A real pilot measures whether the seller can identify the needed photo, without inventing a conversion target.

**External setup.** None. Existing live quality and preflight evaluation requirements continue to govern any model-assisted checks outside this read-only pilot.

## P23-03: channel-rule change impact review

**Code evidence.** [`packages/specs/src/index.ts`](../../packages/specs/src/index.ts) defines a versioned registry and verified channel specifications. [`packager/index.ts`](../../packages/pipeline/src/packager/index.ts) stores measured checks with delivered-file reports. [`compliance-report.ts`](../../apps/web/src/lib/compliance-report.ts) binds saved evidence to exact delivered variants and represents missing checks honestly. Those foundations could support a separate review when an operator verifies a changed channel rule.

**Proposed scope.** First build an operator-only preview that compares a proposed verified registry revision with current rules and identifies which measurable checks may be affected. For explicitly selected workspace packs, evaluate the saved measurements against the changed limits where sufficient evidence exists. Show the original result and the later assessment separately, with registry revision and assessment time. Explain when the stored evidence is insufficient and a new deterministic inspection of existing delivered bytes would be needed. Historical reports remain historical records; no output is silently rewritten, withheld or regenerated.

**Decisions before acceptance.** Identify a concrete official rule change and verify its source and effective date. Define an immutable rule snapshot or content hash, supported comparisons, bounded scan size and retention. Decide who can request a recheck and whether a later customer notification is warranted. A notification would require separate preferences, suppression and delivery acceptance; it is outside this first pilot. An existing incorrect compliance result remains a current-phase defect, not work deferred into this candidate.

**Security and cost.** The preview cannot make a draft rule active. Keep rule approval separate from applying a registry update. Scope any pack scan by workspace and cap work so it does not delay generation or cron. Do not expose customer product details in cross-workspace operator summaries. An exact-file recheck must authenticate storage reads, preserve the bytes and metadata, and make no AI/provider call. Never infer current compliance from a same-named older variant or present unverified rules as requirements.

**Acceptance.** Fixtures include a stricter dimension limit, unchanged rule, unverified rule, missing old measurements, changed picked variant and a same-named regenerated file. Repeating an assessment of the same file/rule revision returns the same result. The old report stays unchanged and the new assessment records what it actually measured. RLS and explicit client-role tests cover any new persisted assessment. The initial operator preview can be explained from official source evidence without sending a customer message or running generation.

**External setup.** Read official marketplace documentation when a candidate rule is selected, record the source and date in `docs/verification.md`, and review the rule before activation. No marketplace credentials, publishing access, worker purchase or live integration is authorized by this proposal.

## Selection and completion evidence

After applicable Phase 21 and Phase 22 release and pilot gates pass, choose a candidate using an actual seller task or verified rule change. Record the selected scope, owner, migration and rollback approach, role matrix, retention, seeded policies and acceptance fixtures before implementation. Prefer one small pilot at a time. Run repository lint, typecheck, unit and browser checks plus the meaningful database isolation/concurrency tests for the accepted slice. Track local evidence separately from CI, deployed commit and live acceptance. Until an explicit later instruction accepts a candidate, all three remain proposals.
