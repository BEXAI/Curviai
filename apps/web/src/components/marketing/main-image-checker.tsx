"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import {
  checkRows,
  flattenOnWhite,
  measurePixels,
  summaryLine,
  type CheckerRules,
  type PixelMeasurements,
} from "@/lib/tools/main-image-analysis";
import { track } from "@/lib/track";
import { EmailGate } from "./email-gate";
import { FreePreviewBox } from "./free-preview-box";
import { checkerCopy } from "./search-copy";
import { SignupLink } from "./signup-link";
import { checkerGateCopy, checkerVerdictCopy } from "./tool-copy";

export type { CheckerRules } from "@/lib/tools/main-image-analysis";

/** One channel the picker offers, from lib/tools/checker-rules (the registry). */
export interface CheckerChannelOption {
  key: string;
  name: string;
  requirementsPath: string;
  rules: CheckerRules;
}

interface Measured {
  file: File;
  fileName: string;
  width: number;
  height: number;
  previewUrl: string;
  pixels: PixelMeasurements;
}

const ANALYSIS_MAX_SIDE = 1000;

interface CheckerChannelState {
  channels: readonly CheckerChannelOption[];
  channel: CheckerChannelOption;
  choose: (key: string) => void;
}

const CheckerChannelContext = createContext<CheckerChannelState | null>(null);

function useCheckerChannel(): CheckerChannelState {
  const state = useContext(CheckerChannelContext);
  if (!state) {
    throw new Error("Checker components need a CheckerChannelProvider");
  }
  return state;
}

/**
 * Holds the picked channel (P18-10) for the title, the intro, the checker
 * and the link back to the rules. A pick applies the new rules at once,
 * to an image already checked too, and replaces ?channel= in the address
 * so the link can be shared; nothing reloads.
 */
export function CheckerChannelProvider({
  channels,
  initialKey,
  children,
}: {
  channels: readonly CheckerChannelOption[];
  initialKey: string;
  children: React.ReactNode;
}) {
  const [key, setKey] = useState(initialKey);
  const fallback = channels[0];
  if (!fallback) {
    throw new Error("The main image checker needs at least one channel");
  }
  const channel = channels.find((option) => option.key === key) ?? fallback;
  const choose = useCallback(
    (next: string) => {
      if (!channels.some((option) => option.key === next)) {
        return;
      }
      setKey(next);
      try {
        const url = new URL(window.location.href);
        url.searchParams.set("channel", next);
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      } catch {
        // The address bar keeps the old channel; the checker still uses the new one.
      }
      track("checker_channel_picked", { channel: next });
    },
    [channels],
  );
  const value = useMemo(() => ({ channels, channel, choose }), [channels, channel, choose]);
  return <CheckerChannelContext.Provider value={value}>{children}</CheckerChannelContext.Provider>;
}

/** "Google Merchant Main Image Checker". */
export function CheckerTitle() {
  const { channel } = useCheckerChannel();
  return <>{checkerCopy.title(channel.name)}</>;
}

/** The intro sentence with the picked channel's rules. */
export function CheckerIntro() {
  const { channel } = useCheckerChannel();
  return <span data-testid="checker-intro">{checkerCopy.intro(channel.name, channel.rules)}</span>;
}

/** The link back to the picked channel's requirements page. */
export function CheckerRulesLink() {
  const { channel } = useCheckerChannel();
  return (
    <p className="mt-6 text-sm text-ink-500">
      {checkerCopy.rulesLinkLead}{" "}
      <Link
        href={channel.requirementsPath}
        data-testid="checker-rules-link"
        className="font-medium text-ink-900 underline"
      >
        {checkerCopy.rulesLinkLabel(channel.name)}
      </Link>{" "}
      {checkerCopy.rulesLinkTail}
    </p>
  );
}

/**
 * Reads the photo's pixels in the browser: the canvas is filled white
 * before the photo is drawn, so transparent pixels read as white, the way a
 * marketplace flattens them (Update.md 6.9). Nothing is uploaded anywhere.
 */
function measureImage(img: HTMLImageElement, file: File, previewUrl: string): Measured {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const scale = Math.min(1, ANALYSIS_MAX_SIDE / Math.max(width, height));
  const cw = Math.max(1, Math.round(width * scale));
  const ch = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas is not available in this browser");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(img, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;
  flattenOnWhite(data);
  return { file, fileName: file.name, width, height, previewUrl, pixels: measurePixels(data, cw, ch) };
}

/**
 * The main image checker (P18-10): longest side or minimum size, edge
 * whiteness and product fill, against the picked channel's registry rules.
 * The pass or fail rows and the measured fill are free; the other
 * measurements sit behind the email gate.
 */
export function MainImageChecker() {
  const { channels, channel, choose } = useCheckerChannel();
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const next = measureImage(img, file, url);
          setMeasured(next);
          const checked = checkRows({ width: next.width, height: next.height }, next.pixels, channel.rules);
          track("main_image_checked", { channel: channel.key, pass: checked.every((row) => row.pass) });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not analyze that file");
          URL.revokeObjectURL(url);
        } finally {
          setBusy(false);
        }
      };
      img.onerror = () => {
        setError("That file could not be read as an image. Try a jpg or png.");
        URL.revokeObjectURL(url);
        setBusy(false);
      };
      img.src = url;
    },
    [channel],
  );

  const rows = useMemo(
    () => (measured ? checkRows({ width: measured.width, height: measured.height }, measured.pixels, channel.rules) : []),
    [measured, channel],
  );
  const allPass = rows.length > 0 && rows.every((row) => row.pass);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4 pt-6">
          {channels.length > 1 ? (
            <div>
              <label htmlFor="checker-channel" className="block text-sm font-medium text-ink-900">
                {checkerCopy.pickerLabel}
              </label>
              <select
                id="checker-channel"
                data-testid="checker-channel"
                value={channel.key}
                onChange={(event) => choose(event.target.value)}
                className="mt-1 block w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 sm:w-72"
              >
                {channels.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <label className="block cursor-pointer rounded-xl border-2 border-dashed border-ink-200 bg-ink-50 p-8 text-center transition-colors hover:border-accent-500">
            <span className="block text-sm font-medium text-ink-900">{checkerCopy.chooseFile(channel.name)}</span>
            <span className="mt-1 block text-sm text-ink-500">
              The check runs in your browser. Nothing is uploaded unless you choose a Curvi cutout below.
            </span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="Choose an image to check"
              onChange={(event) => onFile(event.target.files?.[0])}
            />
            <span className={buttonVariants({ className: "mt-4" })}>{busy ? "Checking" : "Select image"}</span>
          </label>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        </CardContent>
      </Card>

      {measured ? (
        <Card data-testid="checker-report">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Report for {measured.fileName}</CardTitle>
              {allPass ? (
                <Badge variant="success">{checkerCopy.passBadge(channel.name)}</Badge>
              ) : (
                <Badge variant="danger">{checkerCopy.failBadge}</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-6 sm:flex-row">
              <img
                src={measured.previewUrl}
                alt={`Preview of ${measured.fileName}`}
                className="h-40 w-40 shrink-0 rounded-lg border border-ink-100 object-contain"
              />
              <div className="flex-1 space-y-3">
                <p data-testid="checker-summary" className="text-sm font-semibold text-ink-900">
                  {summaryLine(rows)}
                </p>
                <ul className="space-y-3">
                  {rows.map((row) => (
                    <li key={row.key} className="flex gap-3 rounded-lg border border-ink-100 p-3">
                      <span
                        className={
                          "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white " +
                          (row.pass ? "bg-emerald-500" : "bg-red-500")
                        }
                        aria-hidden="true"
                      >
                        {row.pass ? "P" : "F"}
                      </span>
                      <span className="block">
                        <span className="block text-sm font-medium text-ink-900">
                          {row.pass ? "Pass. " : "Fail. "}
                          {row.label}
                        </span>
                        {row.key === "fill" ? (
                          // The one measured value shown above the gate (P18-10).
                          <span data-testid="checker-fill-measured" className="mt-1 block text-sm text-ink-600">
                            {row.measured}.
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {!allPass ? (
                  <FreePreviewBox key={measured.previewUrl} file={measured.file} startLabel={checkerCopy.fixCta} fallback={
                  <SignupLink
                    source={`tool_checker_${channel.key}`}
                    extra={{ channel: channel.key }}
                    data-testid="checker-fix"
                    onClick={() => track("checker_fix_clicked", { channel: channel.key })}
                    className={buttonVariants({ variant: "secondary" })}
                  >
                    {checkerCopy.fixCta}
                  </SignupLink>
                  } />
                ) : null}
              </div>
            </div>
            <div className="mt-6">
              <EmailGate source="main-image-checker" title={checkerGateCopy.title} body={checkerGateCopy.body}>
                <ul data-testid="checker-measurements" className="space-y-2">
                  {rows.map((row) => (
                    <li key={row.key} className="text-sm text-ink-600">
                      <span className="font-medium text-ink-900">{row.label}.</span> {row.measured}.
                    </li>
                  ))}
                </ul>
                {!allPass ? (
                  <p className="mt-4 rounded-lg bg-accent-50 p-4 text-sm text-ink-700">{checkerVerdictCopy.fail}</p>
                ) : (
                  <p className="mt-4 rounded-lg bg-emerald-50 p-4 text-sm text-ink-700">{checkerVerdictCopy.pass}</p>
                )}
              </EmailGate>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
