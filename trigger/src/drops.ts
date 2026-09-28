/**
 * Fresh Creative Drop planning, pure code (CURVI_BUILD_PLAN.md sections 3.2
 * and 8). Every Monday, active workspaces on an eligible plan get fresh
 * creative variants for their top 3 products. Presets rotate week by week so
 * the drop always looks new; the rotation is deterministic in the date so a
 * retried cron run plans the same drop.
 */

import { creditCosts, isEntitled, presets, type PresetKey, type TierKey } from "@curvi/pipeline/seed";

export const TOP_PRODUCTS_PER_DROP = 3;
export const DEFAULT_VARIANTS_PER_PRODUCT = 2;

export interface DropProduct {
  id: string;
  name: string;
  /** Ranking metric, higher is better: sales, views or recency composite. */
  performanceScore: number;
  primaryMediaId?: string;
  useContexts?: string[];
}

export interface DropWorkspace {
  id: string;
  tier: TierKey;
  active: boolean;
  products: DropProduct[];
}

export interface DropVariant {
  productId: string;
  productName: string;
  shotType: "lifestyle";
  preset: PresetKey;
  scene: string;
  credits: number;
}

export interface WeeklyDropPlan {
  workspaceId: string;
  items: DropVariant[];
}

export interface WeeklyDropSkip {
  workspaceId: string;
  reason: "workspace inactive" | "plan tier not eligible" | "no products";
}

export interface WeeklyDropResult {
  plans: WeeklyDropPlan[];
  skipped: WeeklyDropSkip[];
}

/**
 * The Fresh Creative Drop ships to tiers whose seed entitlements include it,
 * derived from @curvi/pipeline seed data rather than a hardcoded tier name or
 * the wording of the pricing copy.
 */
export function dropEligible(tier: TierKey): boolean {
  return isEntitled(tier, "freshDrop");
}

/** ISO like week number used only to rotate presets deterministically. */
export function weekNumber(date: Date): number {
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((utc - yearStart) / (7 * 24 * 60 * 60 * 1000));
}

export interface PlanWeeklyDropsOptions {
  now: Date;
  variantsPerProduct?: number;
}

export function planWeeklyDrops(
  workspaces: DropWorkspace[],
  opts: PlanWeeklyDropsOptions,
): WeeklyDropResult {
  const presetKeys = Object.keys(presets) as PresetKey[];
  const week = weekNumber(opts.now);
  const perProduct = opts.variantsPerProduct ?? DEFAULT_VARIANTS_PER_PRODUCT;

  const plans: WeeklyDropPlan[] = [];
  const skipped: WeeklyDropSkip[] = [];

  for (const workspace of workspaces) {
    if (!workspace.active) {
      skipped.push({ workspaceId: workspace.id, reason: "workspace inactive" });
      continue;
    }
    if (!dropEligible(workspace.tier)) {
      skipped.push({ workspaceId: workspace.id, reason: "plan tier not eligible" });
      continue;
    }
    const top = [...workspace.products]
      .sort((a, b) => b.performanceScore - a.performanceScore)
      .slice(0, TOP_PRODUCTS_PER_DROP);
    if (top.length === 0) {
      skipped.push({ workspaceId: workspace.id, reason: "no products" });
      continue;
    }

    const items: DropVariant[] = [];
    for (let p = 0; p < top.length; p++) {
      const product = top[p];
      const contexts = product.useContexts?.length ? product.useContexts : ["everyday use scene"];
      for (let v = 0; v < perProduct; v++) {
        const preset = presetKeys[(week + p + v) % presetKeys.length];
        const scene = contexts[v % contexts.length];
        items.push({
          productId: product.id,
          productName: product.name,
          shotType: "lifestyle",
          preset,
          scene,
          credits: creditCosts.generativeStill,
        });
      }
    }
    plans.push({ workspaceId: workspace.id, items });
  }

  return { plans, skipped };
}
