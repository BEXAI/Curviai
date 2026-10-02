/** Browser-safe CSV formatting shared by pack downloads and billing history. */
export const ADS_CSV_NAME = "ads/ads.csv";

/** One CSV field, quoted when it holds a comma, quote or line break. A field
 * a spreadsheet would read as a formula (=, +, -, @ first) gets a leading
 * apostrophe, so opening the CSV never runs anything. */
export function csvField(raw: string, options: { numeric?: boolean } = {}): string {
  const number = options.numeric === true && /^-?\d+(?:\.\d+)?$/.test(raw);
  const formula = /^[\t\r]/.test(raw) || /^[\u0000-\u0020]*[=+\-@]/.test(raw);
  const value = !number && formula ? `'${raw}` : raw;
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** The ads CSV: one row per ad file with its placement, file, headline and call to action. */
export function adsCsv(rows: ReadonlyArray<{ specId: string; file: string; headline: string; cta: string }>): string {
  const lines = [["placement", "file", "headline", "call_to_action"].join(",")];
  for (const row of rows) {
    lines.push([row.specId, row.file, row.headline, row.cta].map((value) => csvField(value)).join(","));
  }
  return `${lines.join("\n")}\n`;
}

