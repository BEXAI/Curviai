# UIUpdate.md: Curvi.ai visual UI upgrade plan

Drafted 2026-09-27 from three audits: Manus (manus.im, production CSS pulled directly), Higgsfield (higgsfield.ai, production CSS pulled directly), and a full inventory of the Curvi.ai codebase.

## 1. What the audits found

### Manus: warm monochrome minimalism
- Warm neutrals instead of default grays. Ink is #34322D, canvas #F8F8F7, code background #F0F0EF. The warmth is why it reads as paper, not as a developer theme.
- Borders and fills are alpha black or alpha white (6 and 4 percent), never solid gray lines. Layers composite over any surface.
- System font stack in the app with weight 590 and negative letter spacing. A serif (Libre Baskerville) only for brand headlines. The contrast between the two is the identity.
- One waiting state motif everywhere: a slow 4 second shimmer sweep. Thinking labels, active tool rows, live session rows all use the same gradient sweep instead of five kinds of spinners.
- Progress made legible: a visible plan checklist, step counts, and a live view of what the agent is doing. Transparency turns latency into trust.
- Sub perceptual motion: a breathe animation that peaks at 5 percent opacity. Expressive easings reserved for entrances only.

### Higgsfield: dark cinema tool with one electric accent
- Blue tinted near black neutral ramp (#131416 to #5c626a). One accent, lime #d1fe17, shipped with a full alpha ramp so hovers and badges tint without a second hue.
- Elevation by inner light: inset 0 2px 3px rgba(255,255,255,0.05) top sheen plus hairline white alpha rings, not drop shadows.
- Display type is uppercase Space Grotesk with tight negative tracking, paired with small semibold monospace metadata labels. The display and mono contrast does the pro tool work.
- Thumbnail is proof: every preset is sold with a real output clip. Badges are 10px bold chips, accent at 20 percent opacity background with accent text.
- Layered loading choreography: skeleton shimmer, then animated gradient placeholder, then poster, then video, each fading into the next. Even the nav has skeleton classes.
- Semantic token discipline in three tiers: raw color, semantic role, component token.

### Curvi.ai today
- Tokens: two color ramps only (ink, accent orange #fd7f11) in a 26 line globals.css. No fonts loaded (system stack), no icons, no shadows or radii tokens, zero keyframes, no dark mode.
- shadcn/ui is not actually installed despite CLAUDE.md; a hand rolled 4 component library lives in packages/ui (Button, Card, Badge, Input).
- No loading treatment anywhere: the job board loading state is a bare sentence, busy buttons only swap label text, there are no skeletons, spinners, progress bars or toasts.
- The core product surface (job progress board) shows raw lowercase enum strings (qc, packaging) and has no progress bar or stage stepper despite a 7 stage pipeline.
- The CTA link style is a hand copied 40 character class string duplicated in at least 7 files with drifting heights.
- No mobile navigation. Root layout uses text-slate-900 while everything else uses the ink ramp.

## 2. Design direction for Curvi

Keep the existing identity (light theme, ink neutrals, orange accent) and upgrade its execution with the specific techniques the two references prove out:

1. Type contrast as identity. Inter for UI and body, Space Grotesk for display headlines, JetBrains Mono for spec and metadata labels (channel names, statuses, dimensions). Curvi is a channel spec compliance product; the mono metadata layer fits the domain the way it fits Higgsfield.
2. Alpha borders. Replace solid ink-100 hairlines with ink-950 at 8 to 10 percent so surfaces composite naturally.
3. One waiting motif. A single shimmer sweep keyframe used by every working state: skeletons, active status chips, busy buttons. No competing spinner styles.
4. Progress made visible. The job board gets an overall progress bar and a pipeline stage stepper, plus humanized status labels.
5. Accent with an alpha ramp. Use accent-500 at 10 to 20 percent opacity for badge backgrounds, hover tints and selected states instead of introducing new hues.
6. Motion at the threshold. 200ms color transitions, 300ms ease out entrances, one fade-in-up for hero content. Respect prefers-reduced-motion.

## 3. Phases

### Phase 1: tokens and typography (apps/web/src/app/globals.css, layout.tsx)
- Load Inter, Space Grotesk and JetBrains Mono with next/font, exposed as --font-sans, --font-display, --font-mono theme tokens.
- Add keyframes and animate tokens: shimmer (slow sweep for working states), fade-in-up (entrances), pulse-dot (live indicators).
- Add shadow tokens: a card shadow with an inset top sheen, and a raised hover shadow.
- Fix root layout: text-slate-900 becomes text-ink-950, body gets font-sans.

### Phase 2: primitives (packages/ui)
- Button: add a loading prop (shimmer label plus disabled), keep existing variants, and export a buttonVariants helper so links can share the exact button classes. Kills the 7 file class string duplication.
- New Skeleton component: shimmer sweep block.
- New Progress component: linear bar with animated fill.
- New Spinner component: small SVG ring for inline busy states.
- New Select component: styled native select with a chevron, replacing the two hand styled raw selects.
- Export all from the package index.

### Phase 3: product app surfaces (apps/web/src/components/app)
- StatusChip: map raw enum strings to plain spoken labels (analyzing becomes Analyzing product, qc becomes Quality check). Active pipeline states get a pulsing dot.
- JobProgressBoard: skeleton grid while loading, styled error card, overall progress bar in the header, a pipeline stage stepper (Queued, Analyzing, Planning, Generating, Quality check, Packaging, Done), and shot cards with hover elevation.
- new-pack-form and brand-kit-form: swap raw selects for the Select primitive.
- App layout header: use the shared Wordmark so both headers match.

### Phase 4: marketing surfaces (apps/web/src/components/marketing, (marketing) routes)
- SiteHeader: add a mobile menu (hamburger disclosure) so mobile users get more than a logo and CTA.
- Hero: subtle radial accent tint background and fade-in-up entrance on the headline block.
- Features grid: add inline SVG icons per feature card.
- Replace every hand copied CTA class string with buttonVariants.
- upload-box and tool-page-shell: use cn instead of raw string concatenation.

### Phase 5: verification
- pnpm lint, pnpm typecheck, pnpm test, pnpm e2e per repo rule 6.
- Visual pass on the deployed Render URL after merge.

### Phase 6: dark cinematic marketing pass (added after review)
The first pass kept the light theme and read as too conservative. This phase moves the marketing surface to the Higgsfield direction while keeping the Curvi orange as the single electric accent:
- A near black, blue tinted canvas (night #0b0d14) for the homepage, header and footer.
- Elevation by inner light: glass cards (white at 5 percent) with hairline white alpha rings and an inset top sheen instead of drop shadows.
- Uppercase Space Grotesk display headlines with tight tracking; the second headline phrase carries the accent color.
- Small monospace uppercase eyebrow labels for sections, echoing the channel spec domain.
- Accent used only through its alpha ramp for chips, icon tiles and hovers.
- The compliance report demo stays a white card on the dark canvas, a deliberate paper on table contrast.
- Interior marketing pages keep light bodies under the dark header and footer for now; the app stays light. A full dark pass on those surfaces is the next step if this direction is approved.

## 4. Explicitly out of scope for this pass
- Dark mode (needs a semantic token layer first; the alpha border work in Phase 1 is the prerequisite).
- Real photography or replacing the procedural SVG demo imagery.
- Toast system, dialog, tabs and the rest of the missing primitive set.
- The fake hero dropzone, dead brand kit logo uploader and other placeholder functionality: product work, not visual work.
- Adopting real shadcn/ui (would mean Radix and CVA dependencies; current hand rolled set plus these additions covers the need).
