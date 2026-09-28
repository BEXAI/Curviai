"use client";

import { useCallback, useState } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle, buttonVariants } from "@curvi/ui";
import {
  checkRows,
  flattenOnWhite,
  measurePixels,
  summaryLine,
  type CheckRow,
  type CheckerRules,
} from "@/lib/tools/main-image-analysis";
import { EmailGate } from "./email-gate";
import { checkerGateCopy, checkerVerdictCopy } from "./tool-copy";

export type { CheckerRules } from "@/lib/tools/main-image-analysis";

interface Analysis {
  fileName: string;
  width: number;
  height: number;
  previewUrl: string;
  rows: CheckRow[];
  allPass: boolean;
}

const ANALYSIS_MAX_SIDE = 1000;

/**
 * Runs the real Amazon main image checks in the browser: longest side,
 * pure white border share and product fill ratio from a non white pixel scan.
 * The canvas is filled white before the photo is drawn, so transparent
 * pixels read as white, the way a marketplace flattens them (Update.md 6.9).
 * Nothing is uploaded anywhere.
 */
function analyzeImage(img: HTMLImageElement, fileName: string, previewUrl: string, rules: CheckerRules): Analysis {
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

  const rows = checkRows({ width, height }, measurePixels(data, cw, ch), rules);
  return {
    fileName,
    width,
    height,
    previewUrl,
    rows,
    allPass: rows.every((row) => row.pass),
  };
}

export function MainImageChecker({ rules }: { rules: CheckerRules }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFile = useCallback((file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        setAnalysis(analyzeImage(img, file.name, url, rules));
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
  }, [rules]);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <label className="block cursor-pointer rounded-xl border-2 border-dashed border-ink-200 bg-ink-50 p-8 text-center transition-colors hover:border-accent-500">
            <span className="block text-sm font-medium text-ink-900">
              Choose your current Amazon main image
            </span>
            <span className="mt-1 block text-sm text-ink-500">
              The check runs in your browser. The file never leaves your device.
            </span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="Choose an image to check"
              onChange={(event) => onFile(event.target.files?.[0])}
            />
            <span className={buttonVariants({ className: "mt-4" })}>
              {busy ? "Checking" : "Select image"}
            </span>
          </label>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        </CardContent>
      </Card>

      {analysis ? (
        <Card data-testid="checker-report">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Report for {analysis.fileName}</CardTitle>
              {analysis.allPass ? (
                <Badge variant="success">Passes Amazon main image rules</Badge>
              ) : (
                <Badge variant="danger">Needs fixes before it passes</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-6 sm:flex-row">
              <img
                src={analysis.previewUrl}
                alt={`Preview of ${analysis.fileName}`}
                className="h-40 w-40 shrink-0 rounded-lg border border-ink-100 object-contain"
              />
              <div className="flex-1 space-y-3">
                <p data-testid="checker-summary" className="text-sm font-semibold text-ink-900">
                  {summaryLine(analysis.rows)}
                </p>
                <ul className="space-y-3">
                  {analysis.rows.map((row) => (
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
                      <span className="block text-sm font-medium text-ink-900">
                        {row.pass ? "Pass. " : "Fail. "}
                        {row.label}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-6">
              <EmailGate source="main-image-checker" title={checkerGateCopy.title} body={checkerGateCopy.body}>
                <ul data-testid="checker-measurements" className="space-y-2">
                  {analysis.rows.map((row) => (
                    <li key={row.key} className="text-sm text-ink-600">
                      <span className="font-medium text-ink-900">{row.label}.</span> {row.measured}.
                    </li>
                  ))}
                </ul>
                {!analysis.allPass ? (
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
