import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import HelpPage from "@/app/(marketing)/help/page";
import SubprocessorsPage from "@/app/(marketing)/legal/subprocessors/page";
import PrivacyPage from "@/app/(marketing)/privacy/page";
import TermsPage from "@/app/(marketing)/terms/page";
import { SiteFooter } from "@/components/marketing/site-footer";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import { TERMS_VERSION } from "@/lib/trust/terms";
import { legalDate, pendingLegalFacts, supportReplyTime } from "./copy";
import { LEGAL_FACTS } from "./facts";
import { retentionRows, uploadRetentionSummary } from "./retention";
import { subprocessorsInUse, VENDORS, type LegalEnv } from "./subprocessors";

// docs/phases/PHASE_20.md P20-23: the terms, privacy, subprocessors, help
// and settings text comes from lib/legal, and a change to what a page says
// moves its Last updated date.

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...rest }, children),
}));

beforeAll(() => {
  // The web tsconfig keeps JSX for Next.js, so Vitest compiles it to
  // React.createElement calls against a global React.
  (globalThis as { React?: typeof React }).React = React;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function html(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The environment variable names the in use checks read. */
function vendorEnvNames(): string[] {
  const seen = new Set<string>();
  const recorder: LegalEnv = new Proxy(
    {},
    {
      get: (_target, name) => {
        seen.add(String(name));
        return "set";
      },
    },
  );
  for (const vendor of VENDORS) {
    for (const use of vendor.uses) use.inUse(recorder);
  }
  return [...seen];
}

/** Every vendor variable set, so the pages show every vendor they can. */
function stubEverythingOn(): void {
  for (const name of vendorEnvNames()) vi.stubEnv(name, "set");
}

/** No vendor variable set, and the Ads pixel off. */
function stubEverythingOff(): void {
  for (const name of vendorEnvNames()) vi.stubEnv(name, "");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("/terms", () => {
  it("prints the facts: date, contact, reply time, credits and refunds", () => {
    const page = text(html(TermsPage()));
    expect(page).toContain(`Last updated ${legalDate(LEGAL_FACTS.termsLastUpdated)}`);
    expect(LEGAL_FACTS.termsLastUpdated).toBe(TERMS_VERSION);
    expect(page).toContain(LEGAL_FACTS.support.email);
    expect(page).toContain(`We reply within ${supportReplyTime(LEGAL_FACTS)}.`);
    expect(page).toContain(LEGAL_FACTS.creditTermsSentence);
    expect(page).toContain(LEGAL_FACTS.refundPolicy);
    expect(page).toContain(`at least ${LEGAL_FACTS.termsChangeNoticeDays} days before it applies`);
    expect(page).not.toMatch(/rollover/i);
  });

  it("has every section the plan lists", () => {
    const markup = html(TermsPage());
    for (const id of ["who-we-are", "plans", "credits", "refunds", "ai-outputs", "governing-law"]) {
      expect(markup).toContain(`id="${id}"`);
    }
    for (const heading of ["Acceptable use", "Warranty and liability", "Changes and contact"]) {
      expect(text(markup)).toContain(heading);
    }
  });

  it("marks the entity and governing law as pending until the founder sets them", () => {
    const markup = html(TermsPage());
    const pending = markup.match(/data-testid="legal-pending"/g) ?? [];
    const missing = pendingLegalFacts(LEGAL_FACTS);
    const entityMissing = missing.includes("entity.name") || missing.includes("entity.postalAddress");
    const lawMissing = missing.includes("entity.governingLaw");
    expect(pending).toHaveLength(Number(entityMissing) + Number(lawMissing));
  });

  it("follows the copy rules and sells nothing that is not live", () => {
    const page = text(html(TermsPage()));
    expect(rule9Problems(page)).toEqual([]);
    expect(unqualifiedClaims(page)).toEqual([]);
  });
});

describe("/privacy", () => {
  it("prints the date, the contact and every retention row from lib/legal", () => {
    const markup = html(PrivacyPage());
    const page = text(markup);
    expect(page).toContain(`Last updated ${legalDate(LEGAL_FACTS.privacyLastUpdated)}`);
    expect(page).toContain(LEGAL_FACTS.support.email);
    expect(markup).toContain('data-testid="privacy-retention"');
    expect(markup).toContain('id="retention"');
    for (const row of retentionRows(LEGAL_FACTS)) {
      expect(markup).toContain(`data-testid="retention-${row.key}"`);
      expect(page).toContain(row.what);
      expect(page).toContain(row.howLong);
    }
    expect(page).toContain(`${LEGAL_FACTS.retention.sourcePhotoDays} days old`);
    // The visitor count section from site-visitors stays.
    expect(markup).toContain('data-testid="privacy-visitor-count"');
    // No retention statement left over from before the table.
    expect(page).not.toMatch(/thirty days|while your account is active/i);
  });

  it("names each processor in use and links the subprocessors page", () => {
    stubEverythingOn();
    const markup = html(PrivacyPage());
    expect(markup).toContain('href="/legal/subprocessors"');
    const sentence = /data-testid="privacy-processors">([\s\S]*?)<\/p>/.exec(markup)?.[1] ?? "";
    for (const vendor of subprocessorsInUse()) {
      expect(text(sentence)).toContain(vendor.name);
    }
    expect(text(sentence)).toContain("Sentry");
  });

  it("follows the copy rules", () => {
    expect(rule9Problems(text(html(PrivacyPage())))).toEqual([]);
  });
});

describe("/legal/subprocessors", () => {
  it("lists every subprocessor in use with what it does and receives", () => {
    stubEverythingOn();
    const markup = html(SubprocessorsPage());
    const page = text(markup);
    expect(page).toContain(`Last updated ${legalDate(LEGAL_FACTS.subprocessorsLastUpdated)}`);
    const inUse = subprocessorsInUse();
    expect(inUse.map((vendor) => vendor.key)).toContain("upstash");
    for (const vendor of inUse) {
      expect(markup).toContain(`data-testid="vendor-${vendor.key}"`);
      for (const line of [...vendor.purposes, ...vendor.receives]) {
        expect(page).toContain(line);
      }
    }
    expect(markup).toContain('href="/privacy"');
  });

  it("leaves out every vendor this deployment does not use", () => {
    stubEverythingOff();
    const markup = html(SubprocessorsPage());
    for (const key of ["upstash", "stripe", "sentry", "openai", "fal", "posthog", "shopify"]) {
      expect(markup).not.toContain(`data-testid="vendor-${key}"`);
    }
    expect(markup).toContain('data-testid="vendor-render"');
    expect(markup).not.toContain('data-testid="connected-services"');
    expect(text(markup)).not.toMatch(/Turnstile|bots/);
  });

  it("follows the copy rules and sells nothing that is not live", () => {
    stubEverythingOn();
    const page = text(html(SubprocessorsPage()));
    expect(rule9Problems(page)).toEqual([]);
    expect(unqualifiedClaims(page)).toEqual([]);
  });
});

describe("help, settings and the footer", () => {
  it("help states the support address and reply time from the facts", () => {
    const page = text(html(HelpPage()));
    expect(page).toContain(
      `If something is missing, email ${LEGAL_FACTS.support.email} and a person replies within ${supportReplyTime(LEGAL_FACTS)}.`,
    );
  });

  it("settings reads the upload retention sentence from lib/legal", () => {
    const source = readFileSync(new URL("../../app/app/settings/page.tsx", import.meta.url), "utf8");
    expect(source).toContain("uploadRetentionSummary(LEGAL_FACTS)");
    expect(source).toContain("/privacy#retention");
    expect(source).not.toMatch(/\b\d+ days old\b/);
    expect(uploadRetentionSummary(LEGAL_FACTS)).toContain(`${LEGAL_FACTS.retention.sourcePhotoDays} days old`);
  });

  it("the footer links the subprocessors page next to terms and privacy", () => {
    const markup = html(React.createElement(SiteFooter));
    expect(markup).toContain('href="/legal/subprocessors"');
    expect(markup).toContain('href="/terms"');
    expect(markup).toContain('href="/privacy"');
  });
});

describe("Last updated dates move with the text", () => {
  // A fingerprint of each page's text, rendered with every vendor on so the
  // whole subprocessor list counts. When a page's text changes, set its
  // Last updated date to the day the change ships (TERMS_VERSION in
  // lib/trust/terms.ts for the terms, privacyLastUpdated and
  // subprocessorsLastUpdated in lib/legal/facts.ts) and record the new date
  // and fingerprint here. Never record a new fingerprint under an old date.
  const RECORDED = {
    // Recorded again at the final combine (release/2026-10-02): PHASE_19's
    // assistant sections and PHASE_18's email, signup source and free
    // preview text joined PHASE_20's structure, dated the ship day.
    terms: { lastUpdated: "2026-10-02", sha256: "d7a7e44aa423a6e3a0f7b21845981e759b4baa1d13d4b068757c81cc93aa0a1f" },
    privacy: { lastUpdated: "2026-10-02", sha256: "1ee9da94b337c27805d2d4c9ab0b49789ed8b22a63310dc23b254d96ffb9da43" },
    subprocessors: {
      lastUpdated: "2026-10-02",
      sha256: "11e13d7a68cec76568f3567ac1f58dd8f43630beaadc6920be25bcbddc6d459c",
    },
  };

  it("has a fingerprint recorded for the current text of each page", () => {
    stubEverythingOn();
    const current = {
      terms: { lastUpdated: LEGAL_FACTS.termsLastUpdated, sha256: sha256(text(html(TermsPage()))) },
      privacy: { lastUpdated: LEGAL_FACTS.privacyLastUpdated, sha256: sha256(text(html(PrivacyPage()))) },
      subprocessors: {
        lastUpdated: LEGAL_FACTS.subprocessorsLastUpdated,
        sha256: sha256(text(html(SubprocessorsPage()))),
      },
    };
    expect(current).toEqual(RECORDED);
  });
});

describe("one source for legal statements", () => {
  const SRC = fileURLToPath(new URL("../..", import.meta.url));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
    });
  }

  it("states refunds and retention windows only through lib/legal", () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const where = relative(SRC, path);
      if (where.startsWith("lib/legal/")) continue;
      const source = readFileSync(path, "utf8");
      if (/non refundable|not refundable|thirty days|\b\d+ days old\b|rollover policy/i.test(source)) {
        offenders.push(where);
      }
    }
    expect(offenders).toEqual([]);
  });
});
