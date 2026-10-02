"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, cn } from "@curvi/ui";
import { SHARE_PROOF_HINT, SHARE_PROOF_TOGGLE } from "@/lib/proof-copy";
import { track } from "@/lib/track";
import type { ShareKind, ShareStatus } from "@/lib/shares/types";
import { ShareButtons } from "./share-buttons";

/** How often the panel asks again while the pack is still running. */
const WAIT_POLL_MS = 10_000;
/** Stop asking after this long; a reload picks it up again. */
const WAIT_POLL_LIMIT_MS = 30 * 60 * 1000;

const KIND_OPTIONS: { kind: ShareKind; label: string; hint: string }[] = [
  { kind: "before_after", label: "Before and after", hint: "Your original photo next to the best result." },
  { kind: "pack", label: "The whole pack", hint: "The before and after, plus every image in the pack." },
];

async function readShare(response: Response): Promise<{ share?: ShareStatus; error?: string }> {
  return (await response.json().catch(() => ({}))) as { share?: ShareStatus; error?: string };
}

/**
 * "Share this makeover" on a finished pack (plan 9.6.1): publish the pack to
 * a public page at /s/{slug}, optionally list it in the public gallery, copy
 * the link, or take the page down. Renders nothing until the pack has
 * finished images. Owners and admins publish; other roles see the status.
 */
export function SharePanel({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [kind, setKind] = useState<ShareKind>("before_after");
  const [gallery, setGallery] = useState(false);
  // The measured checks on the public page (P18-16), off until the owner opts in.
  const [proof, setProof] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const apply = useCallback((share: ShareStatus) => {
    setStatus(share);
    setKind(share.kind);
    setGallery(share.galleryRequested ?? share.inGallery);
    setProof(share.showProof === true);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const load = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}/share`, { cache: "no-store" });
        if (stopped || !response.ok) {
          return;
        }
        const { share } = await readShare(response);
        if (!share) {
          return;
        }
        apply(share);
        if (!share.eligible && Date.now() - startedAt < WAIT_POLL_LIMIT_MS) {
          timer = setTimeout(load, WAIT_POLL_MS);
        }
      } catch {
        // The panel is optional; the board keeps working without it.
      }
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, apply]);

  const send = useCallback(
    async (method: "POST" | "DELETE") => {
      setBusy(true);
      setMessage(null);
      try {
        const response = await fetch(`/api/jobs/${jobId}/share`, {
          method,
          headers: method === "POST" ? { "content-type": "application/json" } : undefined,
          body: method === "POST" ? JSON.stringify({ kind, gallery, proof }) : undefined,
        });
        const { share, error } = await readShare(response);
        if (!response.ok || !share) {
          setMessage(error ?? "That did not work. Try again in a minute.");
          return;
        }
        apply(share);
        setMessage(
          method === "DELETE"
            ? "Your share page is down. The link no longer works."
            : share.galleryReviewStatus === "pending"
              ? "Published. Your gallery submission is waiting for review."
            : share.inGallery
              ? "Published, and listed in the public gallery."
              : "Published. Anyone with the link can see it.",
        );
        track(method === "DELETE" ? "share_unpublished" : "share_published", { kind, gallery, proof });
      } catch {
        setMessage("We could not reach Curvi. Check your connection and try again.");
      } finally {
        setBusy(false);
      }
    },
    [jobId, kind, gallery, proof, apply],
  );

  const copy = useCallback(async () => {
    if (!status?.path) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${status.path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage("Copy did not work here. Select the link and copy it instead.");
    }
  }, [status]);

  if (!status?.eligible) {
    return null;
  }

  const changed =
    status.published && (kind !== status.kind || gallery !== (status.galleryRequested ?? status.inGallery) || proof !== (status.showProof === true));

  return (
    <Card id="share" data-testid="share-panel" className="mt-8">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Share this makeover</CardTitle>
          {status.published ? (
            <Badge variant="success" data-testid="share-published">
              Published
            </Badge>
          ) : (
            <Badge variant="outline">Private</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {status.published && status.path ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-ink-50 p-3">
            <Link
              href={status.path}
              target="_blank"
              data-testid="share-link"
              className="min-w-0 flex-1 truncate font-mono text-sm text-ink-900 underline"
            >
              {status.path}
            </Link>
            <Button variant="secondary" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </Button>
            <span className="text-xs text-ink-500">
              {status.views} {status.views === 1 ? "view" : "views"}
            </span>
          </div>
        ) : (
          <p className="text-sm text-ink-600">
            Publish a public page for this pack and share the link anywhere. Only people with the link
            can see it, unless you also list it in the gallery. You can take it down any time.
          </p>
        )}

        {/* Post the page on X, LinkedIn, Pinterest or Reddit (P18-14). */}
        {status.published && status.path ? <ShareButtons path={status.path} /> : null}

        {status.canPublish ? (
          <>
            <fieldset>
              <legend className="text-sm font-semibold text-ink-900">What to show</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {KIND_OPTIONS.map((option) => (
                  <label
                    key={option.kind}
                    className={cn(
                      "flex cursor-pointer gap-3 rounded-lg border p-3 text-sm transition-colors",
                      kind === option.kind ? "border-accent-500 bg-accent-50" : "border-ink-100 hover:bg-ink-50",
                    )}
                  >
                    <input
                      type="radio"
                      name={`share-kind-${jobId}`}
                      value={option.kind}
                      checked={kind === option.kind}
                      onChange={() => setKind(option.kind)}
                      className="mt-0.5 accent-accent-500"
                    />
                    <span>
                      <span className="block font-medium text-ink-900">{option.label}</span>
                      <span className="block text-xs text-ink-500">{option.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {!status.hasBefore ? (
                <p className="mt-2 text-xs text-ink-500">
                  The original photo is no longer stored, so the page shows the results only.
                </p>
              ) : null}
            </fieldset>

            <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-700">
              <input
                type="checkbox"
                data-testid="share-gallery"
                checked={gallery}
                onChange={(event) => setGallery(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-accent-500"
              />
              <span>
                Submit it for the public gallery at /gallery. Approved submissions can be found by search engines. I have
                the right to share these photos.
              </span>
            </label>

            {status.galleryReviewStatus === "pending" ? <p className="text-sm text-ink-600">Your gallery submission is waiting for review. Your share link already works.</p> : null}
            {status.galleryReviewStatus === "rejected" ? <p className="text-sm text-ink-600">This submission was not added to the gallery. You can still share its link.</p> : null}

            <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-700">
              <input
                type="checkbox"
                data-testid="share-proof"
                checked={proof}
                onChange={(event) => setProof(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-accent-500"
              />
              <span>
                <span className="block">{SHARE_PROOF_TOGGLE}</span>
                <span className="block text-xs text-ink-500">{SHARE_PROOF_HINT}</span>
              </span>
            </label>

            <div className="flex flex-wrap gap-3">
              {!status.published || changed ? (
                <Button onClick={() => send("POST")} disabled={busy} data-testid="share-publish">
                  {busy ? "Saving" : status.published ? "Save changes" : "Publish share page"}
                </Button>
              ) : null}
              {status.published ? (
                <Button variant="secondary" onClick={() => send("DELETE")} disabled={busy} data-testid="share-unpublish">
                  Take it down
                </Button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-ink-500">Only owners and admins can publish or take down a share page.</p>
        )}

        {message ? (
          <p className="text-sm text-ink-700" role="status">
            {message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
