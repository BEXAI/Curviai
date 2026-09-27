"use client";

import { useCallback, useState } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@curvi/ui";

interface CheckRow {
  label: string;
  pass: boolean;
  measured: string;
}

interface Analysis {
  fileName: string;
  width: number;
  height: number;
  previewUrl: string;
  rows: CheckRow[];
  allPass: boolean;
}

const ANALYSIS_MAX_SIDE = 1000;
const NON_WHITE_CHANNEL_THRESHOLD = 250;
const BORDER_WHITE_PASS_SHARE = 0.97;
const MIN_LONG_SIDE = 1600;
const MIN_FILL = 0.85;

/**
 * Runs the real Amazon main image checks in the browser: longest side,
 * pure white border share and product fill ratio from a non white pixel scan.
 * Nothing is uploaded anywhere.
 */
function analyzeImage(img: HTMLImageElement, fileName: string, previewUrl: string): Analysis {
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
  ctx.drawImage(img, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;

  const band = Math.max(2, Math.round(Math.min(cw, ch) * 0.02));
  let borderTotal = 0;
  let borderPureWhite = 0;
  let minX = cw;
  let minY = ch;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = (y * cw + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const isBorder = x < band || y < band || x >= cw - band || y >= ch - band;
      if (isBorder) {
        borderTotal++;
        if (r === 255 && g === 255 && b === 255) {
          borderPureWhite++;
        }
      }
      if (
        r < NON_WHITE_CHANNEL_THRESHOLD ||
        g < NON_WHITE_CHANNEL_THRESHOLD ||
        b < NON_WHITE_CHANNEL_THRESHOLD
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const longSide = Math.max(width, height);
  const borderWhiteShare = borderTotal > 0 ? borderPureWhite / borderTotal : 0;
  const hasProduct = maxX >= 0;
  const fillRatio = hasProduct
    ? Math.max((maxX - minX + 1) / cw, (maxY - minY + 1) / ch)
    : 0;

  const rows: CheckRow[] = [
    {
      label: `Longest side is at least ${MIN_LONG_SIDE} px so zoom works`,
      pass: longSide >= MIN_LONG_SIDE,
      measured: `Measured ${width} by ${height} px, longest side ${longSide} px`,
    },
    {
      label: "Background at the edges is pure white, RGB 255 255 255",
      pass: borderWhiteShare >= BORDER_WHITE_PASS_SHARE,
      measured: `Measured ${(borderWhiteShare * 100).toFixed(1)} percent of edge pixels at exactly 255 255 255`,
    },
    {
      label: "Product fills at least 85 percent of the frame",
      pass: hasProduct && fillRatio >= MIN_FILL,
      measured: hasProduct
        ? `Measured fill ${(fillRatio * 100).toFixed(1)} percent of the longest frame side`
        : "No product pixels found, the image is almost entirely white",
    },
  ];

  return {
    fileName,
    width,
    height,
    previewUrl,
    rows,
    allPass: rows.every((row) => row.pass),
  };
}

export function MainImageChecker() {
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
        setAnalysis(analyzeImage(img, file.name, url));
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
  }, []);

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
            <span className="mt-4 inline-flex h-10 items-center justify-center rounded-lg bg-ink-900 px-4 text-sm font-medium text-white">
              {busy ? "Checking" : "Select image"}
            </span>
          </label>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        </CardContent>
      </Card>

      {analysis ? (
        <Card>
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
              <ul className="flex-1 space-y-3">
                {analysis.rows.map((row) => (
                  <li key={row.label} className="flex gap-3 rounded-lg border border-ink-100 p-3">
                    <span
                      className={
                        "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white " +
                        (row.pass ? "bg-emerald-500" : "bg-red-500")
                      }
                      aria-hidden="true"
                    >
                      {row.pass ? "P" : "F"}
                    </span>
                    <span>
                      <span className="block text-sm font-medium text-ink-900">
                        {row.pass ? "Pass. " : "Fail. "}
                        {row.label}
                      </span>
                      <span className="block text-sm text-ink-500">{row.measured}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {!analysis.allPass ? (
              <p className="mt-4 rounded-lg bg-accent-50 p-4 text-sm text-ink-700">
                Curvi fixes all of this automatically. It keeps your real product pixels, rebuilds the
                background to pure white, corrects the fill ratio and exports at marketplace resolution.
              </p>
            ) : (
              <p className="mt-4 rounded-lg bg-emerald-50 p-4 text-sm text-ink-700">
                This image passes the automated checks. Curvi can still build the rest of your pack,
                lifestyle scenes, channel crops and video, from the same photo.
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
