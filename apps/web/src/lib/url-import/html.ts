/**
 * Small, dependency free HTML helpers for reading product pages. They only
 * pull text and attribute values out of markup; nothing here renders HTML,
 * and the text they return is shown through React, which escapes it.
 *
 * The pages are attacker controlled and can be megabytes long, so the tag
 * scanning is done with indexOf loops that never revisit a character, not
 * with backtracking regular expressions: an unclosed "<meta" or "<script"
 * repeated a million times cannot make the scan quadratic.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  trade: "™",
  reg: "®",
  copy: "©",
  deg: "°",
  times: "×",
  frac12: "½",
  eacute: "é",
};

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "";
  }
  return String.fromCodePoint(value);
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return codePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** ASCII only lowercase, so indexes line up with the original string
 * (String.prototype.toLowerCase can change the length of some letters). */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export interface Tag {
  /** Lowercase tag name, with a leading "/" for a closing tag. */
  name: string;
  /** The tag's full source, from "<" to ">". */
  source: string;
  start: number;
  end: number;
}

/** Each tag in order, found in one forward pass. Stops at a "<" with no
 * closing ">". Comments are skipped whole. A "<" that does not start a tag
 * name (as in "5 < 6") is left in the text. */
export function* scanTags(html: string, lower: string = asciiLower(html)): Generator<Tag> {
  let pos = 0;
  // The first ">" at or after some index, reused while it is still ahead,
  // so a run of stray "<" never rescans the same stretch.
  let nextGt = -1;
  while (pos < html.length) {
    const start = lower.indexOf("<", pos);
    if (start < 0) {
      return;
    }
    if (lower.startsWith("<!--", start)) {
      const close = lower.indexOf("-->", start + 4);
      if (close < 0) {
        return;
      }
      pos = close + 3;
      continue;
    }
    if (nextGt <= start) {
      nextGt = lower.indexOf(">", start + 1);
      if (nextGt < 0) {
        return;
      }
    }
    const end = nextGt;
    const nameMatch = /^<(\/?[a-z][a-z0-9-]*)(?=[\s/>])/.exec(lower.slice(start, Math.min(end + 1, start + 64)));
    if (!nameMatch?.[1]) {
      pos = start + 1;
      continue;
    }
    pos = end + 1;
    yield { name: nameMatch[1], source: html.slice(start, end + 1), start, end: end + 1 };
  }
}

const SKIPPED_CONTENT = new Set(["script", "style", "noscript", "template"]);
const BLOCK_TAGS = new Set(["br", "/p", "/div", "/li", "/h1", "/h2", "/h3", "/h4", "/h5", "/h6", "/tr", "/ul", "/ol"]);

/** Visible text of an HTML fragment: scripts and styles dropped, block
 * ends turned into line breaks, whitespace collapsed, empty lines removed. */
export function htmlToText(html: string): string {
  const lower = asciiLower(html);
  const parts: string[] = [];
  let pos = 0;
  let skipUntil = -1;
  for (const tag of scanTags(html, lower)) {
    if (tag.start < skipUntil) {
      continue;
    }
    parts.push(html.slice(pos, tag.start));
    pos = tag.end;
    if (SKIPPED_CONTENT.has(tag.name)) {
      const close = lower.indexOf(`</${tag.name}`, tag.end);
      if (close < 0) {
        return finishText(parts);
      }
      skipUntil = close;
      pos = close;
    } else if (BLOCK_TAGS.has(tag.name)) {
      parts.push("\n");
    } else {
      parts.push(" ");
    }
  }
  parts.push(html.slice(pos).replace(/<[^>]*$/, ""));
  return finishText(parts);
}

function finishText(parts: string[]): string {
  return decodeEntities(parts.join(""))
    .split("\n")
    .map((line) => line.replace(/[\s ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Text of each <li> in the fragment, in order. */
export function listItems(html: string): string[] {
  const lower = asciiLower(html);
  const items: string[] = [];
  let open: Tag | null = null;
  for (const tag of scanTags(html, lower)) {
    if (tag.name === "li") {
      open = tag;
    } else if (tag.name === "/li" && open) {
      const text = htmlToText(html.slice(open.end, tag.start)).replace(/\n+/g, " ").trim();
      if (text) {
        items.push(text);
      }
      open = null;
    }
  }
  return items;
}

/** The value of one attribute in a single tag's source, entity decoded. */
export function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = pattern.exec(tag);
  if (!match) {
    return null;
  }
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** content of the first <meta> whose property or name is `key`. */
export function metaContent(html: string, key: string): string | null {
  const wanted = key.toLowerCase();
  for (const tag of scanTags(html)) {
    if (tag.name !== "meta") {
      continue;
    }
    const name = (attribute(tag.source, "property") ?? attribute(tag.source, "name"))?.toLowerCase();
    if (name === wanted) {
      const content = attribute(tag.source, "content")?.trim();
      if (content) {
        return content;
      }
    }
  }
  return null;
}

/** The first element with this id: its opening tag and where it ends.
 * Looks at no more than a few matches and a bounded stretch around each. */
export function tagWithId(html: string, id: string): Tag | null {
  const lower = asciiLower(html);
  const needle = `id="${asciiLower(id)}"`;
  let from = 0;
  for (let tries = 0; tries < 20; tries += 1) {
    const hit = lower.indexOf(needle, from);
    if (hit < 0) {
      return null;
    }
    from = hit + 1;
    const windowStart = Math.max(0, hit - 4096);
    const lt = lower.slice(windowStart, hit).lastIndexOf("<");
    const gt = lower.slice(hit, hit + 16384).indexOf(">");
    if (lt < 0 || gt < 0) {
      continue;
    }
    const start = windowStart + lt;
    const end = hit + gt;
    const source = html.slice(start, end + 1);
    const nameMatch = /^<([a-z][a-z0-9-]*)\s/.exec(asciiLower(source.slice(0, 64)));
    if (nameMatch?.[1] && !source.slice(1, hit - start).includes(">")) {
      return { name: nameMatch[1], source, start, end: end + 1 };
    }
  }
  return null;
}

/** Source between an element's opening tag and the first closing tag with
 * the same name after it, capped at maxChars. Good enough for the flat
 * elements read here (a title span, a description block). */
export function elementInner(html: string, tag: Tag, maxChars: number, closeName: string = tag.name): string {
  const lower = asciiLower(html.slice(tag.end, tag.end + maxChars));
  const close = lower.indexOf(`</${closeName}`);
  return html.slice(tag.end, tag.end + (close < 0 ? Math.min(maxChars, html.length - tag.end) : close));
}

/** An absolute https URL for a link found in a page, or null. Protocol
 * relative links (//cdn...) are read as https. */
export function absoluteHttpsUrl(raw: string, base: URL): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) {
    return null;
  }
  try {
    const url = new URL(trimmed.startsWith("//") ? `https:${trimmed}` : trimmed, base);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Cuts text to at most `max` characters, at a word break when one is near. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}
