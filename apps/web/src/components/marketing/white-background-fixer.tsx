"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardContent, buttonVariants } from "@curvi/ui";
import { EmailGate } from "./email-gate";
import { FreePreviewBox } from "./free-preview-box";
import { fixerGateCopy } from "./tool-copy";

const DEFAULT_THRESHOLD = 230;
const MIN_THRESHOLD = 180;
const MAX_THRESHOLD = 254;
const PREVIEW_MAX_SIDE = 1200;

/** The slider reads as strength: further right lowers the brightness a pixel
 * needs to turn white, so more of the photo is whitened. */
function thresholdFor(strength: number): number {
  return MIN_THRESHOLD + MAX_THRESHOLD - strength;
}

/**
 * Threshold based background whitening, entirely in the browser. Pixels where
 * every channel clears the threshold become pure 255 white. This is a preview
 * quality tool. The real pipeline in the app masks the product and rebuilds
 * the background without touching product pixels. The canvas is filled white
 * before the photo is drawn, so a transparent background comes out white
 * instead of staying transparent (Update.md 6.9). The preview is free; the
 * download sits behind the email gate.
 */
export function WhiteBackgroundFixer() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [strength, setStrength] = useState(MIN_THRESHOLD + MAX_THRESHOLD - DEFAULT_THRESHOLD);
  const [loaded, setLoaded] = useState(false);
  const [fileName, setFileName] = useState("image");
  const [sourceFile, setSourceFile] = useState<File | undefined>();
  const [error, setError] = useState<string | null>(null);

  const render = useCallback((img: HTMLImageElement, t: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const cw = Math.max(1, Math.round(img.naturalWidth * scale));
    const ch = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    const imageData = ctx.getImageData(0, 0, cw, ch);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] >= t && data[i + 1] >= t && data[i + 2] >= t) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, []);

  // The last chosen file's object URL, released when the next file is
  // chosen and when the tool unmounts.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const onFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      setError(null);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      const img = new Image();
      img.onload = () => {
        imageRef.current = img;
        setFileName(file.name.replace(/\.[^.]+$/, ""));
        setSourceFile(file);
        setLoaded(true);
        render(img, thresholdFor(strength));
      };
      img.onerror = () => {
        setError("That file could not be read as an image. Try a jpg or png.");
        URL.revokeObjectURL(url);
        if (urlRef.current === url) urlRef.current = null;
      };
      img.src = url;
    },
    [render, strength],
  );

  const onStrength = useCallback(
    (value: number) => {
      setStrength(value);
      if (imageRef.current) {
        render(imageRef.current, thresholdFor(value));
      }
    },
    [render],
  );

  const download = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `${fileName}-white-preview.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }, [fileName]);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <label className="block cursor-pointer rounded-xl border-2 border-dashed border-ink-200 bg-ink-50 p-8 text-center transition-colors hover:border-accent-500">
            <span className="block text-sm font-medium text-ink-900">Choose a product photo</span>
            <span className="mt-1 block text-sm text-ink-500">
              Runs in your browser. Nothing is uploaded unless you choose a Curvi cutout below.
            </span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              aria-label="Choose an image to whiten"
              onChange={(event) => onFile(event.target.files?.[0])}
            />
            <span className={buttonVariants({ className: "mt-4" })}>
              Select image
            </span>
          </label>
          {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        </CardContent>
      </Card>

      <Card className={loaded ? "" : "hidden"}>
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex flex-1 items-center gap-3 text-sm font-medium text-ink-700">
              Whitening strength
              <input
                type="range"
                min={MIN_THRESHOLD}
                max={MAX_THRESHOLD}
                value={strength}
                onChange={(event) => onStrength(Number(event.target.value))}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-ink-100 accent-accent-500"
              />
            </label>
          </div>
          <canvas
            ref={canvasRef}
            className="mx-auto max-h-[28rem] w-auto max-w-full rounded-lg border border-ink-100"
            aria-label="Whitened preview"
          />
          <p className="text-sm text-ink-500">
            Preview quality only. Bright pixels near the threshold are pushed to pure white, so light
            product edges can clip. The full Curvi pipeline masks your product first and never changes
            product pixels.
          </p>
          <EmailGate source="white-background-fixer" title={fixerGateCopy.title} body={fixerGateCopy.body}>
            <Button variant="secondary" onClick={download}>
              Download preview
            </Button>
          </EmailGate>
          {sourceFile ? <FreePreviewBox key={urlRef.current} file={sourceFile} /> : null}
        </CardContent>
      </Card>
    </div>
  );
}
