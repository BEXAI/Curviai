/**
 * Calendar dates as people read them, pinned to UTC so the server render,
 * the browser and every time zone show the same day for one timestamp. A
 * plan's period end, for one, reads the same in the billing banner, the
 * cancel dialog and the outcome notice. Free of server only imports, so
 * client components use it too.
 */

function toDate(value: string | Date): Date | null {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "October 1, 2026", or null for a value that is not a date. */
export function longDate(value: string | Date): string | null {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : null;
}

/** "Oct 1, 2026", or null for a value that is not a date. */
export function shortDate(value: string | Date): string | null {
  const date = toDate(value);
  return date ? date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : null;
}
