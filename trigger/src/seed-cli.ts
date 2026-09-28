/**
 * Production seeding entrypoint: pnpm db:seed with DATABASE_URL set upserts
 * the channel spec registry, the recipe prompt rows and the platform settings
 * (the free signup grant), so runtime code and database functions read them
 * from tables per CLAUDE.md rule 2. Then it settles the signup grant of any
 * confirmed user who could not be paid before the settings existed.
 * Idempotent; run it after migrations on every deploy.
 */

import { createDb, loadChannelSpecs, loadRecipes } from "@curvi/db";
import { recipeSeedRows } from "@curvi/pipeline/seed";
import { grantPendingSignupCredits, loadPlatformSettings } from "./platform-settings";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || url.length === 0) {
    console.error("db:seed needs DATABASE_URL");
    process.exitCode = 1;
    return;
  }
  const db = createDb(url, { max: 1, prepare: false });
  const specs = await loadChannelSpecs(db);
  const recipes = await loadRecipes(db, recipeSeedRows);
  const settings = await loadPlatformSettings(db);
  const settled = await grantPendingSignupCredits(db);
  console.log(
    `Seeded ${specs} channel specs, ${recipes} recipe rows and ${settings} platform settings. Settled ${settled} pending signup grants.`,
  );
  process.exit(0);
}

void main();
