/**
 * Production seeding entrypoint: pnpm db:seed with DATABASE_URL set upserts
 * the channel spec registry and the recipe prompt rows, so runtime code reads
 * them from tables per CLAUDE.md rule 2. Idempotent; run it after migrations
 * on every deploy.
 */

import { createDb, loadChannelSpecs, loadRecipes } from "@curvi/db";
import { recipeSeedRows } from "@curvi/pipeline/seed";

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
  console.log(`Seeded ${specs} channel specs and ${recipes} recipe rows.`);
  process.exit(0);
}

void main();
