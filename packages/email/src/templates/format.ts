/**
 * Small number and word helpers the templates share. Every number in a
 * template comes from its data, which the cron fills from the seeds
 * (CLAUDE.md rule 2), never from a literal here.
 */

/** "1 credit", "15 credits", "2.5 credits". */
export function credits(amount: number): string {
  const rounded = Math.round(amount * 10) / 10;
  return `${rounded} ${rounded === 1 ? "credit" : "credits"}`;
}

/** "1 file", "6 files". */
export function files(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/** "$29", "$19.50". */
export function dollars(amount: number): string {
  return Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;
}

/** A color difference as the report prints it: at most two decimals. */
export function deltaE(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** How many typical packs an amount of credits covers, rounded down. */
export function packsFor(amount: number, typicalPackCredits: number): number {
  return typicalPackCredits > 0 ? Math.floor(amount / typicalPackCredits) : 0;
}

/** "enough for one full pack", "enough for 3 full packs", or a smaller promise. */
export function packsReach(amount: number, typicalPackCredits: number): string {
  const packs = packsFor(amount, typicalPackCredits);
  if (packs >= 2) return `enough for ${packs} full packs`;
  if (packs === 1) return "enough for one full pack";
  return "enough to try a main image and a few scenes";
}

/** A product title fit for a subject line, or null. */
export function productName(title: string | null | undefined): string | null {
  const clean = (title ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}...` : clean;
}
