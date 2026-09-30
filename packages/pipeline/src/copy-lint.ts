/**
 * Plain text for words printed on an image (CLAUDE.md rule 9): no emojis, no
 * arrows, no dashes used as punctuation, single spaced, cut at a word
 * boundary. Sharp free, so the copy step, the renderer and tests share one
 * definition. The still renderer's sanitizeCallout is this at 40 characters.
 */

/** Emojis, pictographs, keycaps, variation selectors, joiners, flags. */
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}⃣︎️‍]/gu;
/** Arrow characters. */
const ARROW_CHARS = /[←-⇿⟰-⟿⤀-⥿⬀-⯿]/gu;
/** ASCII arrows. */
const ASCII_ARROWS = /<-+>?|-+>|=+>|<=+/g;
/** Dash characters other than the hyphen: figure, en, em, bar, minus sign,
 * small and fullwidth forms. */
const DASH_CHARS = /[‒-―−⸺⸻﹘﹣－]/gu;

export function sanitizeCopyLine(raw: string, maxChars: number): string {
  let s = raw.normalize("NFC");
  s = s.replace(EMOJI, "");
  s = s.replace(ARROW_CHARS, " ");
  s = s.replace(ASCII_ARROWS, " ");
  // Unicode hyphens (U+2010, U+2011) behave like the ASCII hyphen: kept
  // inside a word, dropped when spaced. Every other dash character and a
  // doubled ASCII hyphen ("fast--easy") are always punctuation here; a
  // spaced or leading or trailing hyphen is too. Hyphens inside words
  // (12-inch) stay.
  s = s.replace(/[‐‑]/gu, "-");
  s = s.replace(DASH_CHARS, " ");
  s = s.replace(/-{2,}/g, " ");
  s = s.replace(/(^|\s)-+(?=\s|$)/g, " ");
  s = s.replace(/^[\s*•·-]+/u, "");
  // Control characters and collapsed whitespace.
  s = s.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace >= maxChars / 2 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return s.replace(/[\s,;:]+$/, "");
}

/**
 * The rule 9 problems in a string, empty when it is clean: an emoji, an
 * arrow, an en or em dash (or another dash character), or a spaced hyphen
 * used as punctuation. For tests and for copy lint on generated slots.
 */
export function rule9Problems(text: string): string[] {
  const problems: string[] = [];
  if (new RegExp(EMOJI.source, "u").test(text)) problems.push("emoji");
  if (new RegExp(ARROW_CHARS.source, "u").test(text) || new RegExp(ASCII_ARROWS.source).test(text)) {
    problems.push("arrow");
  }
  if (new RegExp(DASH_CHARS.source, "u").test(text) || /(^|\s)-+(\s|$)|-{2,}/.test(text)) {
    problems.push("dash");
  }
  return problems;
}
