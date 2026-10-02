/**
 * Stripe event fixtures for the billing flow suite (docs/phases/PHASE_20.md
 * P20-03). Each JSON file is one event, or one invoice line, in the shape
 * Stripe sends on API version 2025-08-27.basil, with every id, amount and
 * time that a case varies written as a placeholder.
 *
 * Today these were written from Stripe's documented object shapes and the
 * installed stripe-node 18.5.0 types. "Do before the phase" item 11: the
 * founder captures the real test mode events (`stripe listen`), and the
 * agent scrubs each into these files by replacing the ids, amounts and
 * times with the same placeholders, keeping every other field exactly as
 * Stripe sent it. The flow suite then replays the real payloads unchanged.
 *
 * Placeholders: a string that is exactly `{{NAME}}` becomes the value given
 * for NAME (any JSON value, so `"{{AMOUNT}}"` becomes a number and
 * `"{{LINES}}"` an array); `{{NAME}}` inside a longer string is replaced by
 * the value as text. A placeholder with no value throws, so a fixture can
 * never reach the route half filled.
 *
 * Test only: node:fs, never imported by app code.
 */

import { readFileSync } from "node:fs";

export const FIXTURE_NAMES = [
  "checkout.session.completed.subscription",
  "checkout.session.topup",
  "customer.subscription",
  "invoice.paid",
  "invoice.line",
  "charge.refunded",
  "charge.dispute",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export type FixtureVars = Record<string, unknown>;

const WHOLE = /^\{\{([A-Z0-9_]+)\}\}$/;
const INNER = /\{\{([A-Z0-9_]+)\}\}/g;

function raw(name: FixtureName): unknown {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), "utf8")) as unknown;
}

function valueOf(vars: FixtureVars, key: string, name: FixtureName): unknown {
  if (!(key in vars)) {
    throw new Error(`Fixture ${name} needs a value for {{${key}}}.`);
  }
  return vars[key];
}

function fill(node: unknown, vars: FixtureVars, name: FixtureName): unknown {
  if (typeof node === "string") {
    const whole = WHOLE.exec(node);
    if (whole) {
      return valueOf(vars, whole[1], name);
    }
    return node.replace(INNER, (_, key: string) => String(valueOf(vars, key, name)));
  }
  if (Array.isArray(node)) {
    return node.map((item) => fill(item, vars, name));
  }
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, fill(value, vars, name)]));
  }
  return node;
}

/** The fixture with every placeholder filled. */
export function loadFixture<T = unknown>(name: FixtureName, vars: FixtureVars): T {
  return fill(raw(name), vars, name) as T;
}

/** Every placeholder a fixture uses, sorted. */
export function fixturePlaceholders(name: FixtureName): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(INNER)) found.add(match[1]);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      Object.values(node).forEach(walk);
    }
  };
  walk(raw(name));
  return [...found].sort();
}
