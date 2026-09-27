# Phases 4 and 5: Pipeline core and generative stills

Status: complete (2026-09-27). 90 tests green; eval harness 10 of 10 golden mains pass; fidelity lock proven byte identical under a corrupting mock provider.
Date started: 2026-09-27

## Plan

Phase 4 (deterministic core): Zod schemas from plan 5.2 verbatim; recipe seeds with the five system prompts from 5.3 verbatim (model IDs live only in seed data); CIEDE2000 color math with reference vector tests; makeAmazonMain (force white outside mask, trim, pad to fill band, lanczos3 resize, sRGB JPEG q90); cutout and sweeps; QC pixel checks parameterized by channel spec with the 5.6 thresholds, including the 254 white trap.

Phase 5 (generative stills): compositing pipeline that generates the scene plate and harmonizes around the product, then pastes the original product pixels back inside the eroded mask with 3 px feather. The fidelity test corrupts the product region with a mock provider and asserts the final output restores the original bytes (CLAUDE.md rule 3). Deterministic fallback shot planner implementing the 5.3 planner rules for demo mode and tests. IPTC DigitalSourceType writing via exiftool-vendored with roundtrip test. Packager with per channel naming and compliance-report.json. Eval harness generating a synthetic golden set at runtime.

## Acceptance

Golden set main images pass pixel tests at 100 percent; fidelity mask test proves unchanged product pixels; pnpm eval runs and reports. pnpm test packages/pipeline green.

## Notes

OCR and embedding similarity checks are pluggable interfaces with mocks for now (real OCR engine and DINOv2 or CLIP endpoint are follow ups recorded in docs/verification.md). PDF compliance report is a follow up; JSON ships first.
