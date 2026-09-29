/**
 * A+ module copy (docs/phases/PHASE_16.md workstream 2). Sharp free, so the
 * planner, the runner and the web app's copy share one definition.
 *
 * - Which modules a product can have: moduleSkipReason reads the analyzer's
 *   profile and the seller's endorsements. A results module never plans for
 *   a product flagged with a medical or food claim.
 * - The copy request for the copy_generator recipe (version 2) and the
 *   strict tool schema of its answer, AplusCopyResult.
 * - The claims guard: every generated headline and line is linted for rule 9
 *   and dropped when it holds a number or a claim word (seed aplusCopy) the
 *   seller did not type. A module left with fewer lines than its seeded
 *   minimum is skipped, never padded, and never charged.
 * - The endorsement module prints only the seller's own lines.
 */
import { z } from "zod";
import { sanitizeCopyLine } from "./copy-lint";
import { APLUS_MODULE_SHOT_TYPES, type AplusModuleShotType, type ProductProfile, type Shot } from "./schemas";
import { aplusCopy, aplusModules } from "./seed/templates";

/** Reason recorded when the seller added no press quote or award (Amazon
 * does not allow customer reviews in A+ content; docs/verification.md). */
export const NO_ENDORSEMENT_REASON = "seller did not add a quote or award";

/** Reason recorded for a module a compliance flag drops (results on a
 * product flagged for a medical or food claim). */
export const APLUS_CLAIMS_FLAG_REASON = "left out because the product may carry a health or food claim";

/** Reason recorded when the product shows too little for a module. */
export const APLUS_NO_FACTS_REASON = "the photos show too little for this module";

/** Reason recorded when too few generated lines passed the claims guard. */
export const APLUS_COPY_SHORT_REASON = "not enough copy we could stand behind";

/** Reason recorded for an A+ file past the document's module cap. */
export const APLUS_MODULE_CAP_REASON = "more A plus modules than one page holds";

/** The modules whose words the copy recipe writes. */
export const GENERATED_APLUS_MODULES = APLUS_MODULE_SHOT_TYPES.filter(
  (type) => aplusModules[type].copy === "generated",
) as AplusModuleShotType[];

/** Module types the copy recipe may answer for. */
const GeneratedModuleType = z.enum(
  APLUS_MODULE_SHOT_TYPES.filter((type) => aplusModules[type].copy === "generated") as [
    AplusModuleShotType,
    ...AplusModuleShotType[],
  ],
);

/** The copy_generator version 2 answer, sent as its strict tool schema:
 * every field required, lengths checked by the guard after the call. */
export const AplusCopyResult = z.object({
  modules: z.array(
    z.object({
      type: GeneratedModuleType,
      headline: z.string(),
      lines: z.array(z.string()),
    }),
  ),
});
export type AplusCopyResult = z.infer<typeof AplusCopyResult>;

/** True when the plan holds a module whose words the copy recipe writes. */
export function needsAplusCopy(shots: readonly Pick<Shot, "type">[]): boolean {
  return shots.some((shot) => (GENERATED_APLUS_MODULES as readonly string[]).includes(shot.type));
}

/**
 * Why the product cannot have this module, or null when it can. Only facts
 * the analyzer saw or the seller typed count: a module is never planned on
 * the hope that a model invents its lines.
 */
export function moduleSkipReason(
  type: AplusModuleShotType,
  profile: Pick<ProductProfile, "features" | "benefits" | "materials" | "useContexts" | "complianceFlags">,
  hasEndorsements: boolean,
): string | null {
  const seed = aplusModules[type];
  const drops: readonly string[] = "dropOnComplianceFlags" in seed ? seed.dropOnComplianceFlags : [];
  if (profile.complianceFlags.some((flag) => drops.includes(flag))) {
    return APLUS_CLAIMS_FLAG_REASON;
  }
  const facts = (list: readonly string[]) => list.some((item) => item.trim().length > 0);
  switch (type) {
    case "aplus_endorsement":
      return hasEndorsements ? null : NO_ENDORSEMENT_REASON;
    case "aplus_ingredients":
      return facts(profile.materials) ? null : APLUS_NO_FACTS_REASON;
    case "aplus_features":
      return facts(profile.features) || facts(profile.benefits) ? null : APLUS_NO_FACTS_REASON;
    case "aplus_pain_points":
    case "aplus_results":
      return facts(profile.benefits) ? null : APLUS_NO_FACTS_REASON;
    case "aplus_how_to":
      return facts(profile.useContexts) || facts(profile.features) ? null : APLUS_NO_FACTS_REASON;
  }
}

/**
 * Lines the planner can print without the copy recipe: the analyzer's
 * features for the features module, its materials for the ingredients
 * module, the seller's endorsements for the endorsement module. The runner
 * still runs them through the claims guard; the copy step replaces them
 * when the recipe answers.
 */
export function plannedModuleLines(
  type: AplusModuleShotType,
  profile: Pick<ProductProfile, "features" | "materials">,
  endorsements: readonly string[],
): string[] {
  const source =
    type === "aplus_features"
      ? profile.features
      : type === "aplus_ingredients"
        ? profile.materials
        : type === "aplus_endorsement"
          ? endorsements
          : [];
  const out: string[] = [];
  for (const raw of source) {
    const line = sanitizeCopyLine(raw, aplusCopy.lineMaxChars);
    if (line.length > 0 && !out.includes(line)) {
      out.push(line);
    }
  }
  return out.slice(0, aplusModules[type].maxLines);
}

/** What the copy recipe is sent: facts, not the photos. */
export interface AplusCopyRequest {
  product: {
    name: string;
    category: string;
    formFactor: string;
    materials: string[];
    features: string[];
    benefits: string[];
    useContexts: string[];
  };
  modules: Array<{
    type: AplusModuleShotType;
    brief: string;
    minLines: number;
    maxLines: number;
    headlineMaxChars: number;
    lineMaxChars: number;
  }>;
  /** The seller's note wrapped in <user_description> tags, or null. */
  userDescription: string | null;
}

export function aplusCopyRequest(
  profile: ProductProfile,
  types: readonly AplusModuleShotType[],
  wrappedUserDescription: string | null,
): AplusCopyRequest {
  const wanted = GENERATED_APLUS_MODULES.filter((type) => types.includes(type));
  return {
    product: {
      name: profile.name,
      category: profile.category,
      formFactor: profile.formFactor,
      materials: profile.materials,
      features: profile.features,
      benefits: profile.benefits,
      useContexts: profile.useContexts,
    },
    modules: wanted.map((type) => ({
      type,
      brief: aplusModules[type].brief,
      minLines: aplusModules[type].minLines,
      maxLines: aplusModules[type].maxLines,
      headlineMaxChars: aplusCopy.headlineMaxChars,
      lineMaxChars: aplusCopy.lineMaxChars,
    })),
    userDescription: wrappedUserDescription,
  };
}

// Claims guard

/** Lowercase words joined by single spaces, with hyphens and punctuation
 * (other than # and the decimal point) as spaces, padded for whole word
 * matching. */
function wordsOf(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#.]+/gu, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** Every figure in a text, with thousands separators removed: "1,200" and
 * "1200" are the same figure, "1.5" keeps its decimal point. */
export function figuresIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, "").replace(/,/g, "."));
}

/** What the guard knows about the seller: every string the seller typed
 * (the note, box contents, comparison facts, endorsements). */
export interface ClaimsContext {
  sellerText: readonly string[];
}

/** Why a generated line fails the claims guard, or null when it passes:
 * a figure the seller never typed, or a claim word the seller never used. */
export function claimProblem(line: string, ctx: ClaimsContext): string | null {
  const seller = ctx.sellerText.join("\n");
  const sellerFigures = new Set(figuresIn(seller));
  const figure = figuresIn(line).find((f) => !sellerFigures.has(f));
  if (figure !== undefined) {
    return `figure ${figure}`;
  }
  const words = wordsOf(line);
  const sellerWords = wordsOf(seller);
  const term = aplusCopy.blockedTerms.find((t) => {
    const needle = wordsOf(t);
    return words.includes(needle) && !sellerWords.includes(needle);
  });
  return term === undefined ? null : `claim word ${term}`;
}

/** A generated line ready to print, or null when rule 9 lint leaves it
 * empty or the claims guard drops it. */
export function guardedLine(raw: string, maxChars: number, ctx: ClaimsContext): string | null {
  const line = sanitizeCopyLine(raw.replace(/!+/g, ""), maxChars);
  if (line.length === 0 || claimProblem(line, ctx) !== null) {
    return null;
  }
  return line;
}

/** Guarded lines, duplicates dropped, at most maxLines. */
function guardedLines(raw: readonly string[], type: AplusModuleShotType, ctx: ClaimsContext): string[] {
  const out: string[] = [];
  for (const line of raw) {
    const clean = guardedLine(line, aplusCopy.lineMaxChars, ctx);
    if (clean !== null && !out.some((kept) => kept.toLowerCase() === clean.toLowerCase())) {
      out.push(clean);
    }
  }
  return out.slice(0, aplusModules[type].maxLines);
}

function withoutHeadline(shot: Shot): Shot {
  const copy = { ...shot };
  delete copy.headline;
  return copy;
}

/**
 * Puts the module copy on the plan's A+ module shots. For each module the
 * recipe writes: the recipe's guarded lines and headline when enough lines
 * pass, else the planner's own lines (the analyzer's features or materials)
 * when enough of those pass, else the module goes to skipped with
 * APLUS_COPY_SHORT_REASON and is never generated or charged. The seller's
 * endorsement module and every other shot pass through untouched. Pure.
 */
export function applyAplusCopy(
  shots: readonly Shot[],
  copy: AplusCopyResult | null,
  ctx: ClaimsContext,
): { shots: Shot[]; skipped: Array<{ type: string; reason: string }> } {
  const out: Shot[] = [];
  const skipped: Array<{ type: string; reason: string }> = [];
  for (const shot of shots) {
    const type = shot.type as AplusModuleShotType;
    if (!(GENERATED_APLUS_MODULES as readonly string[]).includes(shot.type)) {
      out.push(shot);
      continue;
    }
    const { minLines } = aplusModules[type];
    const answer = copy?.modules.find((module) => module.type === type);
    const written = answer ? guardedLines(answer.lines, type, ctx) : [];
    if (answer && written.length >= minLines) {
      const headline = guardedLine(answer.headline, aplusCopy.headlineMaxChars, ctx);
      out.push({ ...withoutHeadline(shot), callouts: written, ...(headline ? { headline } : {}) });
      continue;
    }
    const planned = guardedLines(shot.callouts ?? [], type, ctx);
    if (planned.length >= minLines) {
      out.push({ ...withoutHeadline(shot), callouts: planned });
      continue;
    }
    skipped.push({ type: shot.type, reason: APLUS_COPY_SHORT_REASON });
  }
  return { shots: out, skipped };
}

/**
 * Keeps at most seed aplusCopy.maxModulesPerDocument A+ files (the hero
 * banner and the modules) in plan order and records the rest with
 * APLUS_MODULE_CAP_REASON, so a pack never makes more A+ images than one
 * product page takes. Pure; other shots pass through.
 */
export function capAplusModules<T extends Pick<Shot, "type">>(
  shots: readonly T[],
  skipped: Array<{ type: string; reason: string }>,
): T[] {
  let count = 0;
  const out: T[] = [];
  for (const shot of shots) {
    const aplus = shot.type === "aplus_banner" || (APLUS_MODULE_SHOT_TYPES as readonly string[]).includes(shot.type);
    if (aplus && ++count > aplusCopy.maxModulesPerDocument) {
      skipped.push({ type: shot.type, reason: APLUS_MODULE_CAP_REASON });
      continue;
    }
    out.push(shot);
  }
  return out;
}
