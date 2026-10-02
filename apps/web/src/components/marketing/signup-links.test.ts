import * as React from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { isSellerCategoryKey, signupSourceChoices } from "@curvi/pipeline/seed";
import { categories } from "./categories";
import { pillarPages } from "./pillar-copy";
import { SIGNUP_SOURCE_COPY, SignupSourceField } from "./signup-source-field";

// docs/phases/PHASE_18.md P18-01: every Start free link on the marketing
// site carries its page's seeded source key (through signupHref and
// SignupLink), so a bare /signup link can never come back.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/services", () => ({ getServices: () => ({}), isDbMode: () => false }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

const here = dirname(fileURLToPath(import.meta.url));
const SCANNED = [join(here, "..", "..", "app", "(marketing)"), here];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A link or form target written as a literal /signup string. */
const SIGNUP_TARGET = /\b(href|action)\s*[=:]\s*\{?\s*(["'`])(\/signup[^"'`]*)\2/g;

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="(\/signup[^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));
}

describe("signup links in the marketing site", () => {
  it("never link to a bare /signup", () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(SIGNUP_TARGET)) {
          const target = match[3];
          // Built from the query it was given (the login and signup pages'
          // switch link carries the same source on).
          const carried = target.startsWith("/signup${");
          // A GET form sends its hidden source field as the query.
          const formWithSource = match[1] === "action" && /name="source"/.test(text);
          if (!target.includes("source=") && !carried && !formWithSource) {
            offenders.push(`${relative(here, file)}: ${match[0]}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("give the header, home, guides, comparisons, help, gallery and share their own source", async () => {
    const { HeaderActionsView } = await import("./header-actions");
    expect(hrefs(render(React.createElement(HeaderActionsView, { signedIn: false, links: [] })))).toEqual([
      "/signup?source=header",
    ]);

    const { default: HomePage } = await import("@/app/(marketing)/page");
    const home = hrefs(render(React.createElement(HomePage)));
    expect(home.length).toBeGreaterThan(0);
    expect(new Set(home)).toEqual(new Set(["/signup?source=home"]));

    const { PillarPageView } = await import("./pillar-page");
    for (const page of pillarPages) {
      const expected = page.path.startsWith("/compare/") ? "/signup?source=compare" : "/signup?source=pillar";
      const links = hrefs(render(React.createElement(PillarPageView, { page })));
      expect(links.length, page.path).toBe(2);
      expect(new Set(links), page.path).toEqual(new Set([expected]));
    }

    const { default: HelpPage } = await import("@/app/(marketing)/help/page");
    expect(hrefs(render(React.createElement(HelpPage)))).toEqual(["/signup?source=help"]);

    const { default: GalleryPage } = await import("@/app/(marketing)/gallery/page");
    expect(hrefs(render(await GalleryPage()))).toEqual(["/signup?source=gallery"]);

    const { default: SharePage } = await import("@/app/(marketing)/s/[slug]/page");
    // P18-14: Make mine also carries the share's slug.
    expect(hrefs(render(await SharePage({ params: Promise.resolve({ slug: "example" }) })))).toEqual([
      "/signup?source=share&s=example",
    ]);
  });

  it("carry the channel on requirement pages and the category on category pages", async () => {
    const { default: ChannelPage } = await import("@/app/(marketing)/channels/[channel]/image-requirements/page");
    const amazon = hrefs(render(await ChannelPage({ params: Promise.resolve({ channel: "amazon-main" }) })));
    expect(amazon).toEqual(["/signup?source=channel&channel=amazon"]);

    const { default: CategoryPage } = await import("@/app/(marketing)/for/[category]/page");
    // The category travels only when it is a seeded sellerCategories key
    // (P18-20 preselects it on /welcome); other category pages send the
    // source alone.
    for (const category of categories) {
      const html = render(await CategoryPage({ params: Promise.resolve({ category: category.slug }) }));
      const expected = isSellerCategoryKey(category.slug)
        ? `/signup?source=category&category=${category.slug}`
        : "/signup?source=category";
      expect(hrefs(html), category.slug).toEqual([expected]);
      expect(html).toContain('<input type="hidden" name="source" value="email_capture"/>');
    }
  });

  it("put a source field on the email capture forms", async () => {
    const { ToolPageShell } = await import("./tool-page-shell");
    const html = render(
      React.createElement(ToolPageShell, { currentPath: "/tools/main-image-checker", title: "Tool", description: "About.", children: null }),
    );
    expect(html).toContain('action="/signup"');
    expect(html).toContain('<input type="hidden" name="source" value="tools"/>');
  });
});

describe("the How did you hear about Curvi field", () => {
  it("offers every seeded choice, optional, with plain copy", () => {
    const html = render(
      React.createElement(SignupSourceField, { value: { choice: "", other: "" }, onChange: () => undefined }),
    );
    expect(html).toContain(SIGNUP_SOURCE_COPY.label);
    expect(html).toContain(SIGNUP_SOURCE_COPY.helper);
    expect(html).not.toContain("required");
    for (const choice of signupSourceChoices) {
      expect(html).toContain(`<option value="${choice.key}">${choice.label}</option>`);
    }
    expect(html).not.toContain('id="signup-source-other"');
    for (const text of Object.values(SIGNUP_SOURCE_COPY)) {
      expect(text).not.toMatch(/[‒-―←-⇿⟵-⟿]|\s-\s|--|\p{Extended_Pictographic}/u);
    }
  });

  it("opens a short text field for Other", () => {
    const html = render(
      React.createElement(SignupSourceField, { value: { choice: "other", other: "" }, onChange: () => undefined }),
    );
    expect(html).toContain('id="signup-source-other"');
    expect(html).toContain('maxLength="80"');
  });
});
