"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, buttonVariants, cn } from "@curvi/ui";
import { OutputPreview } from "@/components/app/output-preview";
import { BeforeAfterSlider } from "@/components/marketing/before-after-slider";
import { ILLUSTRATION_LABEL, isIllustrationSrc } from "@/components/marketing/demo-images";
import {
  MAKEOVER_WORKSPACE_LINK_COPY,
  PACK_WORKSPACE_LINK_COPY,
  makeoverDownloadPath,
  makeoverShareLink,
  type RevealShot,
} from "@/lib/makeover";
import { channelName, SIZED_FOR_EACH_CHANNEL_TITLE } from "@/lib/output-options-copy";
import { isTransparentShot, previewAspect } from "@/lib/output-preview";
import { allHeroCandidatesOriginal } from "@/lib/shares/hero";
import { track } from "@/lib/track";

type View = "slider" | "side";

export interface PackRevealProps {
  jobId: string;
  sourceImageUrl: string;
  shots: RevealShot[];
}

function describeAlt(src: string, alt: string): string {
  return isIllustrationSrc(src) ? `${ILLUSTRATION_LABEL}, ${alt.toLowerCase()}` : alt;
}

/** The channels a shot shipped on, by name: "Amazon additional image, Etsy". */
function channelNames(shot: RevealShot): string {
  return shot.channels.map(channelName).join(", ");
}

/**
 * The makeover when every finished shot is the seller's own kept photo
 * (PHASE_15 item 34): a before and after would show the same photo twice, so
 * it shows each file in its channel's shape instead.
 */
function SizedForEachChannel({ shots }: { shots: RevealShot[] }) {
  return (
    <div data-testid="reveal-sized">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Your photo on each channel">
        {shots.map((shot) => (
          <li key={shot.shotId}>
            <OutputPreview
              src={shot.imageUrl}
              alt={describeAlt(shot.imageUrl, `${shot.title} result`)}
              aspect={previewAspect(shot.channels)}
              transparent={isTransparentShot(shot.shotType)}
              testId="reveal-preview"
            />
            {shot.channels.length > 0 ? <p className="mt-1.5 text-xs text-ink-600">{channelNames(shot)}</p> : null}
          </li>
        ))}
      </ul>
      {shots.some((shot) => isIllustrationSrc(shot.imageUrl)) ? (
        <p className="mt-2 text-xs text-ink-500" data-testid="reveal-illustration-note">
          {ILLUSTRATION_LABEL}. Demo mode has no stored photo, so a drawing stands in for yours.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Before and after on a finished pack: the seller's original photo against
 * the finished shots, as a draggable slider or side by side, with a shot
 * picker and a "Share this makeover" panel (copy link, download a side by
 * side image). Hides itself if the original photo cannot be shown in this
 * browser (a TIFF upload, or a preview that expired and failed to load).
 * When every finished shot is the seller's kept photo, it is titled "Sized
 * for each channel" and shows the files without a before and after.
 */
export function PackReveal({ jobId, sourceImageUrl, shots }: PackRevealProps) {
  const [selectedId, setSelectedId] = useState<string>(shots[0]?.shotId ?? "");
  const [view, setView] = useState<View>("slider");
  const [sourceBroken, setSourceBroken] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const linkInputRef = useRef<HTMLInputElement>(null);

  const selected = shots.find((s) => s.shotId === selectedId) ?? shots[0];
  const sized = allHeroCandidatesOriginal(shots);

  // Probe the original once per url: a format the browser cannot draw
  // would leave a broken image in the middle of the slider.
  useEffect(() => {
    setSourceBroken(false);
    const probe = new Image();
    probe.onerror = () => setSourceBroken(true);
    probe.src = sourceImageUrl;
    return () => {
      probe.onerror = null;
    };
  }, [sourceImageUrl]);

  const share = useMemo(
    () => makeoverShareLink(typeof window === "undefined" ? "" : window.location.origin, jobId),
    [jobId],
  );

  useEffect(() => {
    if (copyState === "manual") {
      linkInputRef.current?.select();
    }
  }, [copyState]);

  // The sized view never shows the original, so a photo this browser cannot
  // draw only hides the before and after.
  if (!selected || (sourceBroken && !sized)) {
    return null;
  }

  const illustration = isIllustrationSrc(sourceImageUrl);
  const aspect = previewAspect(selected.channels);

  async function copyLink() {
    track("makeover_shared", { jobId, method: "copy_link", audience: share.audience });
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(share.url);
      setCopyState("copied");
    } catch {
      // No clipboard access (an insecure origin or a denied permission):
      // show the link selected so it can be copied by hand.
      setCopyState("manual");
    }
  }

  return (
    <Card data-testid="pack-reveal" data-reveal-kind={sized ? "sized" : "before_after"}>
      <CardContent className="space-y-5 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold tracking-tight text-ink-950">
              {sized ? SIZED_FOR_EACH_CHANNEL_TITLE : "Before and after"}
            </h2>
            <p className="mt-1 max-w-xl text-sm text-ink-600">
              {sized
                ? "Your photo, kept as you took it and fitted to each channel you picked. Nothing in it was redrawn."
                : `Your original photo next to the finished ${shots.length === 1 ? "shot" : "shots"}. The product itself is never regenerated, so what a buyer sees is the real item.`}
            </p>
          </div>
          {sized ? null : (
            <div className="inline-flex rounded-lg border border-ink-950/10 bg-ink-50 p-0.5" role="group" aria-label="Compare as">
              {(
                [
                  { key: "slider", label: "Slider" },
                  { key: "side", label: "Side by side" },
                ] as const
              ).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={view === option.key}
                  onClick={() => setView(option.key)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                    view === option.key ? "bg-white text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-900",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          {sized ? (
            <SizedForEachChannel shots={shots} />
          ) : (
            <div>
              {view === "slider" ? (
                <div className="mx-auto max-w-xl" data-testid="reveal-slider">
                  <BeforeAfterSlider beforeSrc={sourceImageUrl} afterSrc={selected.imageUrl} />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3" data-testid="reveal-side-by-side">
                  {[
                    { src: sourceImageUrl, label: "Before", alt: "Your original photo", transparent: false },
                    {
                      src: selected.imageUrl,
                      label: "After",
                      alt: `${selected.title} result`,
                      transparent: isTransparentShot(selected.shotType),
                    },
                  ].map((panel) => (
                    <figure key={panel.label} className="relative">
                      <OutputPreview
                        src={panel.src}
                        alt={describeAlt(panel.src, panel.alt)}
                        aspect={aspect}
                        transparent={panel.transparent}
                        testId="reveal-preview"
                      />
                      <figcaption className="absolute left-2 top-2 rounded-full bg-ink-900/80 px-2.5 py-0.5 text-xs font-medium text-white">
                        {panel.label}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
              {illustration && view === "side" ? (
                <p className="mt-2 text-xs text-ink-500" data-testid="reveal-illustration-note">
                  {ILLUSTRATION_LABEL}. Demo mode has no stored photo, so a drawing stands in for yours.
                </p>
              ) : null}

              {shots.length > 1 ? (
                <div className="mt-4">
                  <p className="text-xs font-medium text-ink-600" id={`reveal-picker-${jobId}`}>
                    Compare with
                  </p>
                  <ul className="mt-2 flex flex-wrap gap-2" aria-labelledby={`reveal-picker-${jobId}`}>
                    {shots.map((shot) => (
                      <li key={shot.shotId}>
                        <button
                          type="button"
                          aria-pressed={shot.shotId === selected.shotId}
                          onClick={() => setSelectedId(shot.shotId)}
                          className={cn(
                            "block overflow-hidden rounded-lg border-2 transition-colors",
                            shot.shotId === selected.shotId ? "border-accent-500" : "border-transparent hover:border-ink-200",
                          )}
                          title={shot.title}
                        >
                          <img src={shot.imageUrl} alt={shot.title} className="size-14 bg-ink-100 object-contain" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}

          <div className="rounded-xl border border-ink-950/10 bg-ink-50/60 p-4" data-testid="share-makeover">
            <h3 className="text-sm font-semibold text-ink-950">{sized ? "Share this pack" : "Share this makeover"}</h3>
            <p className="mt-1 text-xs text-ink-600">
              {sized
                ? "Show a teammate or a client the files made for each channel."
                : "Show a teammate, a client or your followers what one photo turned into."}
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <Button size="sm" variant="outline" onClick={() => void copyLink()} data-testid="copy-makeover-link">
                {copyState === "copied" ? "Link copied" : "Copy link"}
              </Button>
              {sized ? null : (
                <a
                  href={makeoverDownloadPath(jobId, selected.shotId)}
                  download
                  className={buttonVariants({ size: "sm", variant: "secondary" })}
                  data-testid="download-makeover"
                  onClick={() =>
                    track("makeover_shared", { jobId, method: "download", shotType: selected.shotType })
                  }
                >
                  Download side by side image
                </a>
              )}
            </div>
            {copyState === "manual" ? (
              <label className="mt-3 block text-xs text-ink-600">
                Copy this link
                <input
                  ref={linkInputRef}
                  readOnly
                  value={share.url}
                  className="mt-1 w-full rounded-md border border-ink-200 bg-white px-2 py-1 font-mono text-xs text-ink-900"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
            ) : null}
            <p className="sr-only" aria-live="polite">
              {copyState === "copied" ? "Link copied to the clipboard." : ""}
            </p>
            <p className="mt-3 text-xs text-ink-500" data-testid="share-audience">
              {share.audience === "public"
                ? sized
                  ? "Anyone with the link can see this pack."
                  : "Anyone with the link can see this before and after."
                : sized
                  ? PACK_WORKSPACE_LINK_COPY
                  : MAKEOVER_WORKSPACE_LINK_COPY}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
