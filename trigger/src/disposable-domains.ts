import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { disposableDomainSeedSource } from "@curvi/pipeline/seed";

/** Verify the exact vendored bytes before seed-cli opens a database. */
export function parseDisposableDomainSeed(text: string): string[] {
  if (createHash("sha256").update(text).digest("hex") !== disposableDomainSeedSource.sha256) {
    throw new Error("Disposable domain seed digest does not match its pinned source");
  }
  const domains = text.trim().split(/\r?\n/);
  if (domains.length !== disposableDomainSeedSource.domainCount || new Set(domains).size !== domains.length) {
    throw new Error("Disposable domain seed count does not match its pinned source");
  }
  return domains;
}

export function readDisposableDomainSeed(): string[] {
  const seedEntry = createRequire(import.meta.url).resolve("@curvi/pipeline/seed");
  const file = new URL(disposableDomainSeedSource.file, pathToFileURL(seedEntry));
  return parseDisposableDomainSeed(readFileSync(file, "utf8"));
}
