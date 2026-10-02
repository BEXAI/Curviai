/**
 * Whether a free preview may start (docs/phases/PHASE_18.md P18-12, founder
 * decision 6), and the shared daily counters that cap its spend. Server only.
 *
 * Gates, in the plan's order:
 * 1. set up: NEXT_PUBLIC_FREE_PREVIEW=1, Upstash (so the per IP cap holds
 *    across instances and deploys), the database, R2, a cutout key and an
 *    LLM key for intake moderation. Anything missing keeps it closed;
 * 2. the platform_settings switch ops:free_preview_enabled (on by default), read
 *    through a 30 second per process cache and closed on any read failure;
 * 3. acquisition open: closed while packs are paused (the new pack
 *    preflight verdict packs_paused), so the preview switches itself off
 *    exactly when a pack could not be made either;
 * 4. the site wide day: at most freePreview.sitePerDay previews started and
 *    freePreview.siteSpendPerDayMicros booked per UTC day, counted in
 *    spend_cap_counters so every instance shares them.
 * The per IP day cap is the rate limiter's preview.create policy, applied
 * by the route.
 */

import { createHash, randomBytes } from "node:crypto";
import type { CapStore } from "@curvi/ai";
import { cutoutModelSeedRows, FREE_PREVIEW_SETTING, freePreview, opsSwitchDefaults } from "@curvi/pipeline/seed";
import { isR2Configured, isSupabaseConfigured, optionalEnv } from "@/lib/env";
import { anonymousSpendLimits } from "@/lib/anonymous-spend";
import { freePreviewOn } from "./copy";

/** The platform_settings row that switches previews off with no deploy, an
 * operator switch under its ops: key (P20-20); no row means its default. */
export const FREE_PREVIEW_SWITCH_KEY = FREE_PREVIEW_SETTING;

/** How long a process reuses the switch it read. */
export const FREE_PREVIEW_SWITCH_CACHE_MS = 30_000;

/** LLM keys either of which runs the intake recipe. */
const LLM_KEY_ENVS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

export type PreviewSetupGap = "flag" | "shared_limits" | "database" | "storage" | "cutout" | "llm";

/** What is missing before the preview may run; empty when it is set up. */
export function previewSetupGaps(): PreviewSetupGap[] {
  const gaps: PreviewSetupGap[] = [];
  if (!freePreviewOn()) gaps.push("flag");
  if (!optionalEnv("UPSTASH_REDIS_REST_URL") || !optionalEnv("UPSTASH_REDIS_REST_TOKEN")) gaps.push("shared_limits");
  if (!optionalEnv("DATABASE_URL") || !isSupabaseConfigured()) gaps.push("database");
  if (!isR2Configured()) gaps.push("storage");
  if (!cutoutModelSeedRows.some((row) => optionalEnv(row.keyEnv))) gaps.push("cutout");
  if (!LLM_KEY_ENVS.some((name) => optionalEnv(name))) gaps.push("llm");
  return gaps;
}

const switchScope = globalThis as typeof globalThis & { __curviFreePreviewSwitch?: { on: boolean; at: number } };

/** The kill switch through `read` (the stored value), cached per process:
 * a stored true opens it, a missing row (undefined) reads as the operator
 * switch's default (opsSwitchDefaults, on), and anything else or a failed
 * read keeps it shut. */
export async function freePreviewSwitchOn(read: () => Promise<unknown>, now: () => number = Date.now): Promise<boolean> {
  const cached = switchScope.__curviFreePreviewSwitch;
  if (cached && now() - cached.at < FREE_PREVIEW_SWITCH_CACHE_MS) {
    return cached.on;
  }
  let on = false;
  try {
    const stored = await read();
    on = stored === undefined ? opsSwitchDefaults[FREE_PREVIEW_SETTING].default : stored === true;
  } catch (err) {
    console.warn("[free-preview] could not read the switch; treating it as off", err);
  }
  switchScope.__curviFreePreviewSwitch = { on, at: now() };
  return on;
}

export function resetFreePreviewSwitchForTests(): void {
  delete switchScope.__curviFreePreviewSwitch;
}

/** The UTC day of an instant, YYYY-MM-DD. */
export function previewDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** spend_cap_counters keys: previews started and spend booked, per UTC day. */
export function previewCountKey(now: Date): string {
  return `preview:day:${previewDay(now)}`;
}

export function previewSpendKey(now: Date): string {
  return `preview:spend:${previewDay(now)}`;
}

/** True while today's site wide count and spend both have room. */
export async function previewDayOpen(counters: Pick<CapStore, "get">, now: Date): Promise<boolean> {
  const [count, spend] = await Promise.all([counters.get(previewCountKey(now)), counters.get(previewSpendKey(now))]);
  return count < anonymousSpendLimits().previewSitePerDay && spend < freePreview.siteSpendPerDayMicros;
}

/**
 * Takes one of today's site wide previews, or false when the day is full
 * (count or spend). add is atomic per key, so concurrent callers on every
 * instance see the true total; an overshoot gives its slot back.
 */
export async function reservePreviewSlot(counters: CapStore, now: Date): Promise<boolean> {
  if ((await counters.get(previewSpendKey(now))) >= freePreview.siteSpendPerDayMicros) {
    return false;
  }
  const total = await counters.add(previewCountKey(now), 1);
  if (total > anonymousSpendLimits().previewSitePerDay) {
    await counters.add(previewCountKey(now), -1);
    return false;
  }
  return true;
}

/** Gives a slot back for a preview that never reached a provider. */
export async function releasePreviewSlot(counters: CapStore, now: Date): Promise<void> {
  await counters.add(previewCountKey(now), -1);
}

/** Books a preview's provider spend on today's preview key. */
export async function bookPreviewSpend(counters: CapStore, now: Date, costMicros: number): Promise<void> {
  if (costMicros > 0) {
    await counters.add(previewSpendKey(now), Math.round(costMicros));
  }
}

export type PreviewClosedReason = "not_set_up" | "switched_off" | "packs_paused" | "daily_limit";

export type PreviewGate = { open: true } | { open: false; reason: PreviewClosedReason };

export interface PreviewGateDeps {
  setupGaps: () => PreviewSetupGap[];
  switchOn: () => Promise<boolean>;
  /** P18-03's acquisition state; until Lane 2 merges, packs not paused. */
  acquisitionOpen: () => Promise<boolean>;
  counters: Pick<CapStore, "get">;
  now: () => Date;
}

/** The gates in order; the first closed one is the reason. */
export async function previewGate(deps: PreviewGateDeps, opts: { checkDay?: boolean } = {}): Promise<PreviewGate> {
  if (deps.setupGaps().length > 0) {
    return { open: false, reason: "not_set_up" };
  }
  if (!(await deps.switchOn())) {
    return { open: false, reason: "switched_off" };
  }
  if (!(await deps.acquisitionOpen().catch(() => false))) {
    return { open: false, reason: "packs_paused" };
  }
  if (opts.checkDay !== false && !(await previewDayOpen(deps.counters, deps.now()).catch(() => false))) {
    return { open: false, reason: "daily_limit" };
  }
  return { open: true };
}

const runScope = globalThis as typeof globalThis & { __curviPreviewsRunning?: number };

/** Previews this process is working on right now. */
export function previewsRunning(): number {
  return runScope.__curviPreviewsRunning ?? 0;
}

/** True when this process may start another preview (a quick look, before
 * the per IP count, so a busy instance does not use up a visitor's day). */
export function previewRoomNow(): boolean {
  return previewsRunning() < freePreview.maxConcurrentPerInstance;
}

/**
 * Takes one of this process's preview places, or false when all are taken
 * (seed freePreview.maxConcurrentPerInstance). Synchronous, so two requests
 * can never both take the last place. Give it back with leavePreviewRun.
 */
export function enterPreviewRun(): boolean {
  if (!previewRoomNow()) {
    return false;
  }
  runScope.__curviPreviewsRunning = previewsRunning() + 1;
  return true;
}

export function leavePreviewRun(): void {
  runScope.__curviPreviewsRunning = Math.max(0, previewsRunning() - 1);
}

const saltScope = globalThis as typeof globalThis & { __curviPreviewSalt?: { day: string; salt: string } };

/**
 * A 32 hex digest of the client IP under a salt that changes every UTC day
 * and lives only in this process, never stored, so a stored ip_hash can
 * group one day's previews from one connection and can never be recomputed
 * or matched to an address afterwards.
 */
export function previewIpHash(ip: string, now: Date): string {
  const day = previewDay(now);
  if (saltScope.__curviPreviewSalt?.day !== day) {
    saltScope.__curviPreviewSalt = { day, salt: randomBytes(32).toString("hex") };
  }
  return createHash("sha256").update(`${saltScope.__curviPreviewSalt.salt}\n${ip}`).digest("hex").slice(0, 32);
}
