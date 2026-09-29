import type { ReactNode } from "react";
import { Card, cn } from "@curvi/ui";
import type { EstimateLine } from "@/lib/pack-estimate";
import { amazonMainRules, formatCredits } from "@/lib/marketing-facts";
import { ComingSoonBadge } from "./coming-soon-badge";
import { homeFeatures, homePack, type HomeFeatureKey } from "./home-copy";

/**
 * Building blocks for the home page sections: the shared section header,
 * the feature tile every homeFeatures entry renders through (so each
 * feature-{key} test id appears once, with the Coming soon label exactly
 * where the feature is not live), and the tiles of the typical pack.
 */

/** Inline 20 by 20 icons for the home features, drawn in currentColor. */
export const featureIcons: Record<HomeFeatureKey, ReactNode> = {
  fidelity: (
    <>
      <rect x="5" y="9" width="10" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 9V6.5a2.5 2.5 0 0 1 5 0V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  compliance: (
    <>
      <circle cx="10" cy="10" r="6.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="m7 10 2 2 4-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  channels: (
    <>
      <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="3.5" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3.5" y="11" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="11" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  brandKit: (
    <>
      <circle cx="7.25" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12.75" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="12.75" r="3.5" stroke="currentColor" strokeWidth="1.5" />
    </>
  ),
  freshCreativeDrop: (
    <>
      <rect x="3.75" y="5" width="12.5" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.75 8.5h12.5M7.5 3.25v3M12.5 3.25v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  directPublishing: (
    <>
      <path d="M10 13V4.5M6.5 8 10 4.5 13.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 15.75h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
};

export function FeatureIcon({ feature, className }: { feature: HomeFeatureKey; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={cn("size-5", className)} aria-hidden="true">
      {featureIcons[feature]}
    </svg>
  );
}

/** Eyebrow, two tone H2 and lead, shared by every section below the hero. */
export function SectionHeader({
  id,
  eyebrow,
  title,
  titleMuted,
  lead,
  align = "center",
  className,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  titleMuted?: string;
  lead?: ReactNode;
  align?: "center" | "left";
  className?: string;
}) {
  return (
    <div className={cn(align === "center" ? "mx-auto max-w-3xl text-center" : "max-w-2xl", className)}>
      <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-teal-brand">{eyebrow}</p>
      <h2
        id={id}
        className="mt-4 text-balance font-display text-3xl font-bold uppercase tracking-tight text-white sm:text-4xl lg:text-5xl"
      >
        {title}
        {titleMuted ? (
          <>
            {" "}
            <span className="text-ink-400">{titleMuted}</span>
          </>
        ) : null}
      </h2>
      {lead ? (
        <p className={cn("mt-4 text-base text-ink-300 sm:text-lg", align === "center" ? "mx-auto max-w-2xl" : null)}>
          {lead}
        </p>
      ) : null}
    </div>
  );
}

/** Glass tile treatment shared by the home page cards. */
export const glassTile =
  "rounded-2xl border-white/10 bg-white/[0.04] shadow-sheen backdrop-blur-sm transition-[border-color,box-shadow] duration-200 hover:border-white/20 hover:shadow-[0_20px_50px_-24px_rgb(176_58_91/0.35)]";

/**
 * One home feature, by key. Coming soon features get the dashed muted
 * treatment and the shared Coming soon label; live ones never do.
 */
export function FeatureTile({ featureKey, className }: { featureKey: HomeFeatureKey; className?: string }) {
  const feature = homeFeatures.find((entry) => entry.key === featureKey);
  if (!feature) {
    return null;
  }
  const soon = feature.status === "coming_soon";
  return (
    <Card
      data-testid={`feature-${feature.key}`}
      className={cn(
        glassTile,
        "p-6",
        soon ? "border-dashed border-white/15 bg-transparent shadow-none hover:shadow-none" : null,
        className,
      )}
    >
      <div className="flex items-start gap-4">
        <span
          className={cn(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset",
            soon ? "bg-white/5 text-ink-400 ring-white/10" : "bg-teal-brand/10 text-teal-brand ring-teal-brand/25",
          )}
        >
          <FeatureIcon feature={feature.key} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cn("text-base font-semibold", soon ? "text-ink-200" : "text-white")}>{feature.title}</h3>
            {soon ? <ComingSoonBadge tone="dark" /> : null}
          </div>
          <p className={cn("mt-2 text-sm", soon ? "text-ink-400" : "text-ink-300")}>{feature.body}</p>
        </div>
      </div>
    </Card>
  );
}

/** A generic product drawn as a jar, standing in for the seller's photo in the pack tiles. */
function ProductGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 56" className={cn("h-auto", className)} aria-hidden="true">
      <rect x="11" y="2" width="18" height="8" rx="2" fill="#1d2433" />
      <rect x="6" y="10" width="28" height="44" rx="6" fill="#9b3052" />
      <rect x="6" y="10" width="10" height="44" rx="5" fill="#d0587a" opacity="0.55" />
      <rect x="11" y="24" width="18" height="14" rx="2" fill="#fdf2f8" opacity="0.9" />
    </svg>
  );
}

function Swatch({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <span className={cn("relative flex items-center justify-center overflow-hidden rounded-lg", className)}>
      {children}
    </span>
  );
}

type PackVisual =
  | "main"
  | "white"
  | "angles"
  | "cutout"
  | "sweep"
  | "lifestyle"
  | "infographic"
  | "thumbnail"
  | "social"
  | "file";

/** Which drawing a pack line gets. Labels come from the estimate; an unknown one gets a plain file tile. */
function visualFor(label: string): PackVisual {
  const rules: [RegExp, PackVisual][] = [
    [/^Amazon main/i, "main"],
    [/^White front/i, "white"],
    [/^Alternate angle/i, "angles"],
    [/^Transparent cutout/i, "cutout"],
    [/^Background sweep/i, "sweep"],
    [/^Lifestyle/i, "lifestyle"],
    [/^Infographic/i, "infographic"],
    [/^Collection thumbnail/i, "thumbnail"],
    [/^Social crop/i, "social"],
  ];
  return rules.find(([pattern]) => pattern.test(label))?.[1] ?? "file";
}

const checkerboard =
  "bg-[conic-gradient(#e9ecf1_0_25%,#ffffff_0_50%,#e9ecf1_0_75%,#ffffff_0)] bg-[length:0.75rem_0.75rem]";

function PackDrawing({ visual }: { visual: PackVisual }) {
  switch (visual) {
    case "main": {
      return (
        <Swatch className="aspect-square w-full max-w-[16rem] bg-white">
          <span className="absolute inset-[8%] rounded-md border border-dashed border-teal-brand/70" />
          <ProductGlyph className="w-[42%]" />
        </Swatch>
      );
    }
    case "white":
      return (
        <Swatch className="aspect-square w-16 bg-white">
          <ProductGlyph className="w-6" />
        </Swatch>
      );
    case "angles":
      return (
        <span className="flex gap-1.5 sm:gap-2">
          {["-rotate-12", "rotate-0", "rotate-12"].map((turn) => (
            <Swatch key={turn} className="aspect-square w-8 bg-white sm:w-12">
              <ProductGlyph className={cn("w-4", turn)} />
            </Swatch>
          ))}
        </span>
      );
    case "cutout":
      return (
        <Swatch className={cn("aspect-square w-16", checkerboard)}>
          <ProductGlyph className="w-6" />
        </Swatch>
      );
    case "sweep":
      return (
        <span className="flex gap-2">
          <Swatch className="aspect-square w-11 bg-gradient-to-b from-[#f1f2f5] to-[#b9bec9] sm:w-14">
            <ProductGlyph className="w-5" />
          </Swatch>
          <Swatch className="aspect-square w-11 bg-gradient-to-b from-[#b03a5b] to-[#4a1226] sm:w-14">
            <ProductGlyph className="w-5" />
          </Swatch>
        </span>
      );
    case "lifestyle":
      return (
        <span className="grid w-full grid-cols-2 gap-2">
          <Swatch className="aspect-[4/3] bg-[radial-gradient(circle_at_30%_30%,#f6d9b8,#a8674a_60%,#3b1a26)]">
            <ProductGlyph className="w-[22%]" />
          </Swatch>
          <Swatch className="aspect-[4/3] bg-[radial-gradient(circle_at_70%_20%,#c8f1ea,#2f8f84_55%,#0f2a2e)]">
            <ProductGlyph className="w-[22%]" />
          </Swatch>
        </span>
      );
    case "infographic":
      return (
        <Swatch className="aspect-square w-16 justify-start gap-1.5 bg-white pl-2">
          <ProductGlyph className="w-5" />
          <span className="flex flex-col gap-1">
            <span className="h-1 w-5 rounded-full bg-teal-brand" />
            <span className="h-1 w-4 rounded-full bg-ink-300" />
            <span className="h-1 w-5 rounded-full bg-ink-300" />
          </span>
        </Swatch>
      );
    case "thumbnail":
      return (
        <span className="grid grid-cols-2 gap-1">
          {["bg-white", "bg-white/30", "bg-white/30", "bg-white/30"].map((tone, index) => (
            <Swatch key={index} className={cn("aspect-square w-7 rounded-md", tone)}>
              {index === 0 ? <ProductGlyph className="w-3" /> : null}
            </Swatch>
          ))}
        </span>
      );
    case "social":
      return (
        <Swatch className="aspect-square w-16 bg-[linear-gradient(135deg,#3b1a26,#7a1f3d_55%,#2dd4bf)]">
          <ProductGlyph className="w-6" />
        </Swatch>
      );
    case "file":
      return <Swatch className="aspect-square w-16 bg-white/10 ring-1 ring-inset ring-white/15" />;
  }
}

/** One file of the typical pack: a drawing, its name and its credits. */
export function PackTile({ line, className }: { line: EstimateLine; className?: string }) {
  const visual = visualFor(line.label);
  const main = visual === "main";
  const rules = amazonMainRules();
  const caption = main
    ? `Pure white, RGB ${rules.rgb.join(" ")}. Product fill ${rules.fillMinPercent} to ${rules.fillMaxPercent} percent.`
    : visual === "lifestyle"
      ? homePack.lifestyleCaption
      : visual === "sweep"
        ? homePack.sweepCaption
        : null;

  return (
    <Card
      className={cn(
        glassTile,
        "flex flex-col gap-4 p-4 sm:p-5",
        main ? "col-span-2 lg:row-span-2" : null,
        visual === "lifestyle" ? "col-span-2" : null,
        className,
      )}
    >
      <div className={cn("flex flex-1 items-center justify-center", main ? "py-4" : "min-h-20")}>
        <PackDrawing visual={visual} />
      </div>
      <div>
        <div
          className={cn(
            "flex gap-x-3 gap-y-1",
            main ? "items-baseline justify-between" : "flex-col sm:flex-row sm:items-baseline sm:justify-between",
          )}
        >
          <h3 className={cn("font-semibold text-white", main ? "text-lg" : "text-sm")}>{line.label}</h3>
          <span className="shrink-0 font-mono text-xs text-teal-brand">{formatCredits(line.credits)}</span>
        </div>
        {caption ? <p className="mt-1 text-xs text-ink-400">{caption}</p> : null}
      </div>
    </Card>
  );
}
