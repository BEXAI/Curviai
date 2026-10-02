"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input } from "@curvi/ui";
import { freePreview } from "@curvi/pipeline/seed";
import { SignupLink } from "@/components/marketing/signup-link";
import { MarketingConsentCheckbox } from "@/components/marketing/marketing-consent";
import { Turnstile, turnstileEnabled } from "@/components/marketing/turnstile";
import {
  FREE_PREVIEW_COPY,
  freePreviewOn,
  fullSizeReadyLine,
  previewCheckFailLine,
  previewNextStepLine,
  previewPassLine,
  previewTooLargeLine,
} from "@/lib/free-preview/copy";
import { LEAD_HONEYPOT_FIELD } from "@/lib/lead-sources";

interface PreviewResult {
  previewId: string;
  preview: string;
  checks: { name: string; label: string; pass: boolean }[];
  checksPass: boolean;
  fidelity: { meanDeltaE: number };
}

type Phase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "done"; result: PreviewResult }
  | { kind: "error"; message: string; offerSignup: boolean };

function isPreviewResult(value: unknown): value is PreviewResult {
  const v = value as Partial<PreviewResult> | null;
  return Boolean(
    v &&
      typeof v.previewId === "string" &&
      typeof v.preview === "string" &&
      v.preview.startsWith("data:image/jpeg;base64,") &&
      Array.isArray(v.checks) &&
      typeof v.fidelity?.meanDeltaE === "number",
  );
}

/**
 * The free white main image before signup (docs/phases/PHASE_18.md P18-12):
 * drop one product photo, get a measured Amazon main image with no account.
 * Renders nothing unless this build has NEXT_PUBLIC_FREE_PREVIEW=1 and the
 * server says previews are open (GET /api/preview), so a paused or capped
 * day hides it instead of failing a visitor.
 */
export function FreePreviewBox({ file, startLabel, fallback = null }: { file?: File; startLabel?: string; fallback?: ReactNode } = {}) {
  const enabled = freePreviewOn();
  const [available, setAvailable] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [email, setEmail] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [fullSize, setFullSize] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  const honeypot = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let live = true;
    fetch("/api/preview")
      .then((response) => response.json() as Promise<{ available?: unknown }>)
      .then((body) => {
        if (live) setAvailable(body.available === true);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled]);

  if (!enabled || !available) {
    return fallback;
  }

  async function send(file: File) {
    if (turnstileEnabled && !captchaToken) return;
    if (file.size > freePreview.maxBytes) {
      setPhase({ kind: "error", message: previewTooLargeLine(), offerSignup: false });
      return;
    }
    setPhase({ kind: "working" });
    const form = new FormData();
    form.set("photo", file);
    form.set("captchaToken", captchaToken);
    form.set(LEAD_HONEYPOT_FIELD, honeypot.current?.value ?? "");
    try {
      const response = await fetch("/api/preview", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as ({ status?: string; error?: string } & Partial<PreviewResult>) | null;
      if (response.ok && body?.status === "done" && isPreviewResult(body)) {
        setPhase({ kind: "done", result: body });
        return;
      }
      const limited = response.status === 429 || response.status === 503;
      setPhase({ kind: "error", message: body?.error ?? FREE_PREVIEW_COPY.unavailable, offerSignup: limited });
    } catch {
      setPhase({ kind: "error", message: FREE_PREVIEW_COPY.unavailable, offerSignup: false });
    } finally {
      setCaptchaToken("");
      setCaptchaReset((value) => value + 1);
    }
  }

  async function unlock(previewId: string) {
    setFullSize({ busy: true, message: null });
    try {
      const response = await fetch(`/api/preview/${previewId}/full`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, marketingConsent, [LEAD_HONEYPOT_FIELD]: honeypot.current?.value ?? "" }),
      });
      const body = (await response.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (response.ok && body?.url) {
        window.location.assign(body.url);
        setFullSize({ busy: false, message: fullSizeReadyLine() });
        return;
      }
      setFullSize({ busy: false, message: body?.error ?? FREE_PREVIEW_COPY.unavailable });
    } catch {
      setFullSize({ busy: false, message: FREE_PREVIEW_COPY.unavailable });
    }
  }

  return (
    <div data-testid="free-preview" className="mt-6 rounded-2xl bg-ink-950 p-5 ring-1 ring-inset ring-white/15">
      <p className="font-display text-lg font-semibold text-white">{FREE_PREVIEW_COPY.boxTitle}</p>
      <p className="mt-2 text-sm leading-relaxed text-ink-200">{FREE_PREVIEW_COPY.box}</p>
      <Turnstile action="preview" resetKey={captchaReset} onToken={setCaptchaToken} />
      {file && (phase.kind === "idle" || phase.kind === "error") ? (
        <div className="mt-4 space-y-2">
          <p className="text-sm text-ink-200">{FREE_PREVIEW_COPY.handoff}</p>
          <Button type="button" variant="secondary" data-testid="free-preview-use-photo" disabled={turnstileEnabled && !captchaToken} onClick={() => void send(file)}>
            {startLabel ?? FREE_PREVIEW_COPY.usePhoto}
          </Button>
        </div>
      ) : null}
      {/* Honeypot: hidden from people, filled by bots. */}
      <input
        ref={honeypot}
        type="text"
        name={LEAD_HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="absolute left-[-10000px] h-px w-px overflow-hidden"
      />
      {phase.kind === "idle" || phase.kind === "error" ? (
        <label className="mt-4 inline-flex cursor-pointer items-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-ink-100">
          {FREE_PREVIEW_COPY.pick}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            data-testid="free-preview-file"
            disabled={turnstileEnabled && !captchaToken}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void send(file);
            }}
          />
        </label>
      ) : null}
      {phase.kind === "working" ? (
        <p role="status" className="mt-4 text-sm text-ink-200">
          {FREE_PREVIEW_COPY.working}
        </p>
      ) : null}
      {phase.kind === "error" ? (
        <div role="alert" className="mt-4 space-y-2 text-sm text-amber-200">
          <p>{phase.message}</p>
          {phase.offerSignup ? (
            <SignupLink source="free_preview" className="font-medium text-teal-brand underline">
              {FREE_PREVIEW_COPY.signupButton}
            </SignupLink>
          ) : null}
        </div>
      ) : null}
      {phase.kind === "done" ? (
        <div data-testid="free-preview-result" className="mt-4 space-y-4">
          <img
            src={phase.result.preview}
            alt="Your product on a pure white background"
            className="mx-auto max-h-80 w-auto rounded-lg bg-white"
          />
          <p className="text-sm leading-relaxed text-white">
            {phase.result.checksPass
              ? previewPassLine(phase.result.fidelity.meanDeltaE)
              : previewCheckFailLine(phase.result.fidelity.meanDeltaE)}
          </p>
          <ul className="space-y-1 text-xs text-ink-200">
            {phase.result.checks.map((check) => (
              <li key={check.name}>
                {check.pass ? "Pass" : "Does not pass"}: {check.label}
              </li>
            ))}
          </ul>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (phase.kind === "done") void unlock(phase.result.previewId);
            }}
          >
            <p className="text-sm font-semibold text-white">{FREE_PREVIEW_COPY.fullSizeTitle}</p>
            <p className="text-xs text-ink-300">{FREE_PREVIEW_COPY.fullSizeHelp}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                required
                autoComplete="email"
                placeholder="you@yourbrand.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <Button type="submit" variant="secondary" disabled={fullSize.busy}>
                {FREE_PREVIEW_COPY.fullSizeButton}
              </Button>
            </div>
            <p className="text-xs text-ink-400">{FREE_PREVIEW_COPY.fullSizeNotice}</p>
            <MarketingConsentCheckbox id="preview-marketing-consent" checked={marketingConsent} onChange={setMarketingConsent} tone="dark" />
            {fullSize.message ? (
              <p role="status" className="text-xs text-ink-200">
                {fullSize.message}
              </p>
            ) : null}
          </form>
          <div className="space-y-2">
            <p className="text-sm text-white">{previewNextStepLine()}</p>
            <SignupLink
              source="free_preview"
              extra={{ preview: phase.result.previewId }}
              className="inline-flex rounded-lg bg-teal-brand px-4 py-2 text-sm font-semibold text-ink-950"
            >
              {FREE_PREVIEW_COPY.signupButton}
            </SignupLink>
          </div>
        </div>
      ) : null}
    </div>
  );
}
