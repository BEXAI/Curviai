# Home page overhaul: the liquid metal hero

Date: 2026-09-29. Branch: home/liquid-metal. Asked for by the founder: a large UI overhaul of the home page built around a pasted 21st.dev component, LiquidMetalHero (a full bleed animated liquid metal WebGL shader from @paper-design/shaders-react behind a centered hero with a badge, a very large headline, a subtitle, two calls to action and a frosted feature card, with a staggered entrance).

## Decisions

| Decision | Why |
| --- | --- |
| The hero lives in apps/web/src/components/ui/liquid-metal-hero.tsx (the new home for imported UI components). It is not a client component. | The H1 is the LCP element and carries SEO. It must be server HTML, visible without JavaScript, never faded in from opacity 0. Chromium leaves opacity 0 elements out of LCP until they show. |
| Button, Badge and Card come from @curvi/ui. No shadcn copies, no @radix-ui/react-slot, no class-variance-authority. | One component system. The burgundy secondary Button stays the call to action. Links use buttonVariants on next/link, as elsewhere. |
| shadcn tokens mapped to ours: foreground to white, background to night, foreground/90 to ink-100, glass to bg-night/75 with a white/15 hairline. The missing Badge variant "secondary" became the default Badge with overrides. | No second token system. text-foreground generates nothing in our Tailwind v4 theme. |
| Calls to action are links: "Start free" to /signup (burgundy), "Test your main image free" to /tools/main-image-checker (glass). The props stay compatible with the pasted component (label plus optional click handler, features as strings) and add hrefs. | No alert() handlers. Labels match the UploadBox and the header. |
| No framer-motion. The stagger is CSS: the headline and subtitle use a new rise-in keyframe that moves but never fades; the badge, calls to action, note and card use the existing fade-in-up at 0, 240, 300, 360 ms, and the card items at 440, 520 and 600 ms. Hover lifts by 2 px on motion-safe devices. | Same look for 0 KB of JavaScript. It runs before hydration, and the existing global reduced motion rule makes it instant. framer-motion writes opacity 0 into the SSR HTML and cannot tree shake below about 34 KB. |
| @paper-design/shaders-react pinned to exactly 0.0.81, Apache 2.0. | 0.0.47 to 0.0.76 were PolyForm Shield (noncompete); 0.0.77 and later are Apache 2.0. The maintainers ship breaking changes under 0.0.x and ask users to pin. NOTICE kept in THIRD_PARTY_NOTICES.md. |
| The shader is a client island in two files: liquid-metal-backdrop.tsx (gate, fallback, fade) and liquid-metal-canvas.tsx (the shader), loaded with next/dynamic and ssr false after an idle callback. | The library stays out of the first load bundle (its lazy chunk is about 12 KB gzip) and never runs on the server. |
| The shader runs only on screens at least 48rem wide, without reduced motion, without Save-Data, with 4 GB or more of memory and 4 or more cores where reported, and with WebGL2 (probed first on a throwaway canvas). It unmounts live when reduced motion turns on, and falls back for good after a lost WebGL context or a library error. | The library throws inside an async effect without WebGL2, which no error boundary catches. On phones the text scrim covers almost all of it, so it would only cost battery. |
| The shader is scoped to the hero (absolute, oversized past the hero's edges and clipped), never position fixed. minPixelRatio 1, maxPixelCount 1280 by 720. | The library pauses its loop when its element leaves the viewport or the tab is hidden; a fixed mount always intersects and never pauses. The cap is several times fewer pixels than the library default of 2x and 8.3 megapixels. |
| The pasted `{...liquidMetalPresets[2]}` was a bug: presets are `{ name, params }`, so it rendered the default diamond and leaked `name` and `params` onto the div. The canvas writes its values out, starting from the Backdrop preset. | A version bump must not change the look silently. |
| Brand tuning: colorBack night #07080d, colorTint #d0587a (color burn gives wine chrome), shiftRed 0.3, shiftBlue 0 (burgundy and teal fringes instead of a rainbow), speed 0.35. Compared on one fixed frame against the plain Backdrop colors, #b03a5b, #e3a3b5, white and a wine back color. | The metal's own two colors are fixed in the GLSL; only the tint moves them. |
| A static CSS metal (.hero-metal-fallback: night, a burgundy and a teal glow, and a blurred conic sweep of wine and silver) always renders first and stays for reduced motion, no WebGL2 and phones. The closing section reuses it, so the page is bookended by metal with one WebGL context. | No layout shift, no blank hero while the chunk loads. |

## Contrast

Night #07080d is luminance 0.0025. Under a night scrim of opacity a over the brightest chrome, white text needs a of at least 0.55 for 4.5:1, ink-100 needs 0.60, ink-300 needs 0.74, and the #b03a5b headline line (3.43:1 even on pure night, large text) needs 0.93. The hero scrim (.hero-metal-scrim) is a pool of night at 0.94 behind the headline block that thins to 0.5 and 0.25 at the flanks, where only the metal shows, plus a fade to night at the bottom and the brand glows. The feature card is bg-night/75, which keeps its text above 9:1 whatever the metal does. Small text on night uses ink-400 or lighter (ink-500 is 4.3:1 and fails), so the slider caption moved from ink-500 to ink-400.

`.theme-base` now restores Tailwind's own red, amber and emerald tints. Inside the home page's theme-base scope they were still the dark theme's, so the white example compliance report showed light green text on white.

Founder decision still open: keep "Ready everywhere." in #b03a5b (the default here, which needs the 0.94 pool) or use a lighter #d0587a for the hero line only, which needs 0.80 and lets more metal show behind the words.

## Page order

1. Hero (LiquidMetalHero): badge homeHero.eyebrow, H1 "Shot once. Ready everywhere.", subtitle homeHero.lead, the two calls to action, the free credits note, and three live promises (fidelity, compliance report, channel count).
2. Before and after: the unchanged BeforeAfterSlider with its Illustration label, the fidelity lock tile, homeHero.proof, the UploadBox (hero-upload-box, "Nothing is uploaded from this page") and a gallery link.
3. How it works: the three homeSteps with outline numerals.
4. What a pack contains: one tile per line of the typical pack estimate (typicalPackLines, the new pack form's own estimate, so it cannot drift from the credits it states), the brand kit tile, the credits summary, and the two coming soon features.
5. Proof on every file: the compliance report tile and the example report.
6. Channels: the channel ready files tile and one link per live channel to its requirements page.
7. Pricing: home-pack-size, the Stripe conditional note, a Free tile with the burgundy Start free and the four paid tiers from the seed.
8. FAQ: homeFaqs, which still feed the FAQPage JSON-LD in order.
9. Guides and free tools: the four pillar pages in the Guides nav and the three free tools.
10. Closing: static metal, the email form and a free tool link.

Every homeFeatures entry renders once through FeatureTile, so each feature-{key} test id is unique and exactly the two coming soon features carry the Coming soon label. Metadata, JSON-LD and the footer links are unchanged.

Below the fold, sections use a CSS scroll driven reveal (.reveal) inside `prefers-reduced-motion: no-preference` and `@supports (animation-timeline: view())`. It starts at opacity 0.001, never 0, and finishes once 60 percent of an element is in view.

## Tests

- apps/web/src/components/ui/liquid-metal-hero.test.ts: headline, subtitle and link targets in the server HTML; no inline style or opacity on the H1 and subtitle; the static metal renders on the server with no canvas and nothing fixed; copy rules; the original props still render buttons; one H1 on the home page; the shader gate truth table, and no WebGL probe for reduced motion or phones.
- claims.test.ts: every new home copy export is in liveCopy (coming soon and copy rule checks), and the new files are in OWNED_SOURCES (no literal credits, prices, percents or 3 digit px).
- e2e/home-hero.spec.ts: the hero with JavaScript disabled, the server H1 without opacity, reduced motion and phones keep the fallback with no canvas, no page errors and nothing fixed in the hero, the copy rules, the slider label and the four guide links.

## Bundle

next build, route /: 7.18 kB page size and 188 kB First Load JS after, from 5.33 kB and 186 kB before. The shader chunk loads only when the gate passes: 39 KB minified, 12.4 KB gzip.
