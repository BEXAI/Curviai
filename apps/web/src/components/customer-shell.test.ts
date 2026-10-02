import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EnvironmentBanner } from "./environment-banner";
import { ErrorScreen } from "./error-screen";
beforeAll(() => { (globalThis as { React?: typeof React }).React = React; });
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children) }));
describe("customer shell", () => {
  it("shows an environment banner only with an explicit label", () => {
    expect(renderToStaticMarkup(React.createElement(EnvironmentBanner, {}))).toBe("");
    expect(renderToStaticMarkup(React.createElement(EnvironmentBanner, { label: "staging" }))).toContain("staging environment");
  });
  it("never renders an exception message or stack, and offers retry and help", () => {
    const error = Object.assign(new Error("private customer data"), { digest: "digest-123" });
    const html = renderToStaticMarkup(React.createElement(ErrorScreen, { error, reset: () => {} }));
    expect(html).not.toContain("private customer data"); expect(html).toContain("digest-123"); expect(html).toContain("Try again"); expect(html).toContain("/support");
  });
  it("keeps app and marketing captions at least twelve pixels", () => {
    function walk(path: string): string[] { return readdirSync(path).flatMap((name) => { const full = join(path, name); return statSync(full).isDirectory() ? walk(full) : /\.(tsx|css)$/.test(name) ? [full] : []; }); }
    const files = walk(fileURLToPath(new URL("../", import.meta.url)));
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/text-\[(?:10|11)px\]/);
  });
});
