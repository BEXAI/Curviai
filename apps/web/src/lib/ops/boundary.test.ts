import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/phases/PHASE_20.md, W7: the founder cockpit's queries live in
// apps/web/src/lib/ops/ and run on the owner connection, so only operator
// surfaces may import them: app/app/ops/**, app/api/cron/**, app/api/ops/**
// and apps/web/scripts/**, plus lib/ops itself. The isOperator gate in
// apps/web/src/lib/ops.ts (a file, not this folder) is not covered: the app
// nav and PHASE_18's gallery label import it.

const WEB_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const SRC = join(WEB_ROOT, "src");
const OPS_DIR = join(SRC, "lib", "ops");

const ALLOWED_IMPORTERS = [
  join(SRC, "app", "app", "ops"),
  join(SRC, "app", "api", "cron"),
  join(SRC, "app", "api", "ops"),
  join(WEB_ROOT, "scripts"),
  OPS_DIR,
];

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bvi\.mock\s*\(\s*)["']([^"']+)["']/g;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}${sep}`);
}

/** True when an import specifier written in `file` points inside lib/ops/. */
function importsOpsFolder(file: string, specifier: string): boolean {
  if (specifier.startsWith("@/lib/ops/")) {
    return true;
  }
  if (specifier.startsWith(".")) {
    // "./ops" or "../ops" names lib/ops.ts (a file wins over a folder), so
    // only a path below the folder counts.
    return resolve(dirname(file), specifier).startsWith(`${OPS_DIR}${sep}`);
  }
  return false;
}

/** The imports of lib/ops/ from files outside the allowed surfaces. */
function boundaryViolations(files: Array<{ path: string; text: string }>): string[] {
  const violations: string[] = [];
  for (const { path, text } of files) {
    if (ALLOWED_IMPORTERS.some((dir) => within(path, dir))) continue;
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1]!;
      if (importsOpsFolder(path, specifier)) {
        violations.push(`${relative(WEB_ROOT, path)} imports ${specifier}`);
      }
    }
  }
  return violations;
}

describe("lib/ops boundary", () => {
  it("is imported only from the operator pages, cron and ops routes and scripts", () => {
    const files = [...sourceFiles(SRC), ...sourceFiles(join(WEB_ROOT, "scripts"))].map((path) => ({
      path,
      text: readFileSync(path, "utf8"),
    }));
    expect(files.length).toBeGreaterThan(100);
    expect(boundaryViolations(files)).toEqual([]);
  });

  it("catches an alias, relative and dynamic import from elsewhere, and allows the gate file", () => {
    const appPage = join(SRC, "app", "app", "billing", "page.tsx");
    const libFile = join(SRC, "lib", "billing", "store.ts");
    const component = join(SRC, "components", "app", "nav.tsx");
    expect(
      boundaryViolations([
        { path: appPage, text: 'import { writeOpsAudit } from "@/lib/ops/audit";' },
        { path: libFile, text: 'const m = await import("../ops/grants");' },
        { path: component, text: 'import { isOperator } from "@/lib/ops";\nimport { x } from "../../lib/ops";' },
        { path: join(SRC, "app", "app", "ops", "page.tsx"), text: 'import { a } from "@/lib/ops/economics";' },
        { path: join(SRC, "app", "api", "cron", "tick", "route.ts"), text: 'import { b } from "@/lib/ops/alerts";' },
        { path: join(WEB_ROOT, "scripts", "grant-credits.ts"), text: 'import { c } from "../src/lib/ops/grants";' },
        { path: join(OPS_DIR, "grants.ts"), text: 'import { writeOpsAudit } from "./audit";' },
      ]),
    ).toEqual([
      "src/app/app/billing/page.tsx imports @/lib/ops/audit",
      "src/lib/billing/store.ts imports ../ops/grants",
    ]);
  });
});
