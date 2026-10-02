import { describe, expect, it } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { mcpCopyProblems } from "@/lib/api-v1/mcp-copy";
import { PACK_VIEWER_COPY } from "./copy";
import { PACK_VIEWER_MAX_BYTES, PACK_VIEWER_SETTINGS, packViewerHtml, scriptJson } from "./html";
import { renderPackViewer } from "./render";
import { packViewerResources } from "./resource";
import { startPackViewer } from "./runtime";
import { initialViewerState, reduceViewer, viewerViewOf } from "./state";

// The pack viewer's one HTML file (PHASE_19 P19-19): self contained, inside
// its size budget, loading nothing and naming no URL but the site's, with
// copy that passes rule 9 and the MCP word list.

const ORIGIN = "https://curvi.ai";
const html = packViewerHtml(ORIGIN);
const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));

describe("the viewer document", () => {
  it("is one HTML5 document with one inline style and one inline script", () => {
    expect(html.startsWith("<!doctype html>\n<html lang=\"en\">")).toBe(true);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(html.match(/<style\b/g)).toHaveLength(1);
    expect(html).toContain('<main id="root" aria-live="polite"></main>');
    expect(html).not.toMatch(/<!--|<link\b|<iframe\b|<object\b|<embed\b|<base\b|<form\b/i);
    // Nothing is loaded by the document itself: no src or href attribute, no
    // stylesheet import, font or background image.
    expect(html).not.toMatch(/\s(src|href|srcset|action)\s*=/i);
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style).not.toMatch(/@import|@font-face|url\(/i);
  });

  it("names no URL but the site origin", () => {
    const urls = html.match(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\\]*/gi) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url, url).toBe(ORIGIN);
    }
  });

  it("stays inside its size budget", () => {
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(PACK_VIEWER_MAX_BYTES);
  });

  it("never writes markup, evaluates text or imports code", () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|\bimport\s*\(|setAttribute\(\s*["']on/);
    expect(script).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|document\.cookie/);
  });

  it("parses as a script, and embeds each function from its own source", () => {
    expect(() => new Function(script)).not.toThrow();
    for (const fn of [initialViewerState, reduceViewer, viewerViewOf, renderPackViewer, startPackViewer]) {
      expect(script).toContain(fn.toString());
      // Self contained: each one evaluates with nothing else in scope.
      expect(typeof new Function(`return (${fn.toString()});`)()).toBe("function");
    }
    expect(script).toContain(`"tool":"get_pack"`);
    expect(PACK_VIEWER_SETTINGS).toMatchObject({ tool: "get_pack", pollMs: 5000, pollCapMs: 1_800_000, maxCarousel: 8 });
  });

  it("keeps JSON from closing the script", () => {
    expect(scriptJson({ text: "</script><script>alert(1)</script>\u2028&" })).toBe(
      '{"text":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e\\u2028\\u0026"}',
    );
  });
});

describe("the viewer copy", () => {
  it("has the plan's lines", () => {
    expect(PACK_VIEWER_COPY).toMatchObject({
      making: "Making your images",
      awaiting: "Waiting for your go ahead",
      progress: "{done} of {total} ready",
      ready: "Ready",
      download: "Download",
      seeAll: "See all {n} files",
      openInCurvi: "Open in Curvi",
      someFailed: "Some images did not pass their checks and were not charged.",
    });
  });

  it("passes rule 9 and never promotes a plan, a price or a key, nor does the resource description", () => {
    const resource = packViewerResources(() => ORIGIN).list()[0]!;
    const lines = [...Object.values(PACK_VIEWER_COPY), String(resource.title), String(resource.description)];
    for (const line of lines) {
      expect(rule9Problems(line), line).toEqual([]);
      expect(mcpCopyProblems(line), line).toEqual([]);
    }
  });
});
