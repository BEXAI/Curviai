"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, Input, Label, Select, Textarea, cn } from "@curvi/ui";
import type { TierKey } from "@curvi/pipeline/seed";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { CONCEPT_MODE_AVAILABLE } from "@/lib/features";
import { estimatePackCredits, type EstimateMode } from "@/lib/pack-estimate";
import { intentFor, type SubmitIntent } from "@/lib/submit-intent";
import { track } from "@/lib/track";

export interface ChannelOption {
  id: string;
  marketplace: boolean;
  /** What createJob would say about this channel on this plan (from the
   * seed entitlements). Only "available" channels can be picked; missing
   * means available. */
  availability?: "available" | "coming_soon" | "upgrade_required";
  /** The cheapest plan that includes an upgrade_required channel. */
  upgradeTo?: TierKey | null;
}

function isPickable(channel: ChannelOption): boolean {
  return (channel.availability ?? "available") === "available";
}

function planName(key: TierKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export interface ProductOption {
  id: string;
  title: string;
  mode: "listing" | "concept";
}

interface NewPackFormProps {
  products: ProductOption[];
  channels: ChannelOption[];
  tier: TierKey;
  creditBalance: number;
  /** Product to preselect, e.g. from "New pack for this product". Anything
   * not in `products` is ignored. */
  initialProductId?: string | null;
}

const DEFAULT_CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];

/**
 * Whether a failed submit used up its Idempotency-Key, so the next try is a
 * new intent. A 409 means the key belongs to a different request. A 503 the
 * jobs route answered with reason "unavailable" means the server refused
 * before the pack started (a draining server writes nothing, and a job it
 * had to abandon has its key freed), so the retry must create a fresh job.
 * Any other failure keeps the key: the server may have started the pack,
 * and a retry with the same key replays it instead of starting a second one.
 */
export function submitFailureSpendsKey(status: number, reason?: string): boolean {
  return status === 409 || (status === 503 && reason === "unavailable");
}

/** The credit line under the estimate. A balance below zero is explained,
 * never shown as a bare negative number. */
export function creditBalanceLine(creditBalance: number): string {
  if (creditBalance < 0) {
    const owed = -creditBalance;
    return `Your balance is ${owed.toLocaleString("en-US")} ${owed === 1 ? "credit" : "credits"} below zero because a move to a smaller plan took credits back. New packs start again once a top up or your next renewal covers it.`;
  }
  return `You have ${creditBalance.toLocaleString("en-US")} credits. Only assets that pass QC are charged.`;
}

export function channelLabel(id: string): string {
  const pretty = id.replaceAll(".", " ").replaceAll("_", " ");
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; name: string }
  | { phase: "uploaded"; name: string; key: string; sha256: string; kind: "image" | "video" }
  | { phase: "notice"; message: string }
  | { phase: "error"; message: string };

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function NewPackForm({ products, channels, tier, creditBalance, initialProductId }: NewPackFormProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // One Idempotency-Key per submission intent (Update.md 6.1): a retry of the
  // same contents reuses it, any change to the contents gets a new one.
  const intentRef = useRef<SubmitIntent | null>(null);
  // Only the most recent upload may update the form, so a slow earlier
  // upload never replaces a newer photo.
  const uploadSeq = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ phase: "idle" });
  // A new photo is a new product unless the seller picks an existing one
  // and confirms the photo shows it, so photos of two items never mix.
  const [productId, setProductId] = useState(() =>
    initialProductId && products.some((p) => p.id === initialProductId) ? initialProductId : "new",
  );
  const [confirmedAttach, setConfirmedAttach] = useState<string | null>(null);
  const [newProductTitle, setNewProductTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>(
    DEFAULT_CHANNELS.filter((id) => channels.some((c) => c.id === id && isPickable(c))),
  );
  const [mode, setMode] = useState<EstimateMode>("listing");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Channels that can be picked first; coming soon and upgrade ones after.
  const ordered = [...channels].sort((a, b) => Number(!isPickable(a)) - Number(!isPickable(b)));
  const marketplaceChannels = ordered.filter((c) => c.marketplace);
  const socialChannels = ordered.filter((c) => !c.marketplace);
  const effectiveMode: EstimateMode = CONCEPT_MODE_AVAILABLE ? mode : "listing";
  const estimate = useMemo(
    () => estimatePackCredits(selected, effectiveMode, tier),
    [selected, effectiveMode, tier],
  );
  const selectedProduct = products.find((p) => p.id === productId) ?? null;
  const uploading = upload.phase === "uploading";
  const attachKey = upload.phase === "uploaded" && selectedProduct ? `${upload.key}:${selectedProduct.id}` : null;
  const needsAttachConfirm = attachKey !== null && confirmedAttach !== attachKey;

  function toggleChannel(id: string) {
    // A channel the server would refuse is never added to the pack.
    if (!channels.some((c) => c.id === id && isPickable(c))) {
      return;
    }
    setSelected((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  function renderChannel(channel: ChannelOption) {
    const pickable = isPickable(channel);
    const label = channelLabel(channel.id);
    return (
      <div
        key={channel.id}
        className={cn(
          "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm",
          pickable ? "text-ink-700 hover:bg-ink-50" : "text-ink-400",
        )}
        data-testid={`channel-${channel.id}`}
      >
        <label className={cn("flex items-center gap-2", pickable ? "cursor-pointer" : "cursor-not-allowed")}>
          <input
            type="checkbox"
            checked={pickable && selected.includes(channel.id)}
            disabled={!pickable}
            onChange={() => toggleChannel(channel.id)}
            className="h-4 w-4 rounded border-ink-300 accent-ink-900"
          />
          {label}
        </label>
        {channel.availability === "coming_soon" ? <ComingSoonBadge /> : null}
        {channel.availability === "upgrade_required" ? (
          <Link
            href="/app/billing"
            className="shrink-0 text-xs font-medium text-ink-900 underline"
            data-testid="channel-upgrade"
          >
            {channel.upgradeTo ? `${planName(channel.upgradeTo)} plan` : "Upgrade"}
          </Link>
        ) : null}
      </div>
    );
  }

  async function handleFile(file: File) {
    const seq = ++uploadSeq.current;
    const update = (state: UploadState) => {
      if (seq === uploadSeq.current) {
        setUpload(state);
      }
    };
    setSubmitError(null);
    update({ phase: "uploading", name: file.name });
    try {
      const response = await fetch("/api/uploads/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: file.type.startsWith("video/") ? "video" : "image",
          contentType: file.type,
          bytes: file.size,
        }),
      });
      const data = (await response.json()) as { url?: string; key?: string; notice?: string; error?: string };
      if (response.status === 503) {
        update({
          phase: "notice",
          message: data.notice ?? "Uploads are not configured yet. The pack will use the demo photo instead.",
        });
        return;
      }
      if (!response.ok || !data.url || !data.key) {
        update({ phase: "error", message: data.error ?? "The upload could not be signed." });
        return;
      }
      const put = await fetch(data.url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) {
        update({ phase: "error", message: "The upload failed. Try again." });
        return;
      }
      update({
        phase: "uploaded",
        name: file.name,
        key: data.key,
        sha256: await sha256Hex(file),
        kind: file.type.startsWith("video/") ? "video" : "image",
      });
    } catch {
      update({ phase: "error", message: "The upload failed. Check your connection and try again." });
    }
  }

  async function submit() {
    setSubmitError(null);
    if (uploading || submitting) {
      return;
    }
    if (selected.length === 0) {
      setSubmitError("Pick at least one channel.");
      return;
    }
    if (needsAttachConfirm && selectedProduct) {
      setSubmitError(`Confirm whether this photo shows ${selectedProduct.title}.`);
      return;
    }
    const intent = intentFor(
      intentRef.current,
      {
        productId,
        channels: selected,
        mode: effectiveMode,
        uploadKey: upload.phase === "uploaded" ? upload.key : null,
        newProductTitle,
        description,
      },
      () => crypto.randomUUID(),
    );
    intentRef.current = intent;
    setSubmitting(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": intent.key,
        },
        body: JSON.stringify({
          productId,
          channels: selected,
          mode: effectiveMode,
          uploads:
            upload.phase === "uploaded"
              ? [{ key: upload.key, sha256: upload.sha256, kind: upload.kind }]
              : undefined,
          newProductTitle: productId === "new" && newProductTitle.trim() ? newProductTitle.trim() : undefined,
          userDescription: description.trim() ? description.trim() : undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        job?: { id: string };
        error?: string;
        reason?: string;
        replayed?: boolean;
      };
      if (!response.ok || !data.job) {
        if (submitFailureSpendsKey(response.status, data.reason)) {
          // The next try is a new intent with a new key, so it creates a
          // fresh job instead of replaying this refusal.
          intentRef.current = null;
        }
        setSubmitError(data.error ?? "The pack could not be started. Try again in a moment.");
        setSubmitting(false);
        return;
      }
      track("pack_created", {
        product_is_new: productId === "new",
        photo_count: upload.phase === "uploaded" ? 1 : 0,
        replayed: data.replayed === true,
      });
      intentRef.current = null;
      // Stay in the submitting state until the job page takes over, so a
      // second click cannot start a second pack.
      router.push(`/app/jobs/${data.job.id}`);
    } catch {
      // The same intent keeps its key, so trying again replays this request
      // if the server already started the pack.
      setSubmitError("The pack could not be started. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  const buttonLabel = uploading ? "Uploading photo" : submitting ? "Starting" : "Create pack";

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-8">
        <section>
          <h2 className="text-lg font-semibold text-ink-950">1. Add your product</h2>
          <div
            className={cn(
              "mt-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
              dragOver ? "border-accent-500 bg-accent-50" : "border-ink-200 bg-white",
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              const file = event.dataTransfer.files[0];
              if (file) {
                void handleFile(file);
              }
            }}
          >
            <p className="text-sm font-medium text-ink-900">Drop one product photo here</p>
            <p className="mt-1 text-xs text-ink-500">JPEG, PNG, WEBP, GIF or TIFF up to 25 MB. Video up to 200 MB.</p>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/tiff,video/mp4,video/quicktime"
              className="sr-only"
              aria-label="Upload a product photo"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleFile(file);
                }
              }}
            />
            <Button
              variant="outline"
              className="mt-4"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {upload.phase === "uploaded" ? "Choose a different file" : "Choose a file"}
            </Button>
            <div aria-live="polite">
              {upload.phase === "uploading" ? (
                <p className="mt-3 text-sm text-ink-500" data-testid="upload-progress">
                  Uploading {upload.name}
                </p>
              ) : null}
              {upload.phase === "uploaded" ? (
                <p className="mt-3 text-sm text-emerald-700" data-testid="upload-done">
                  Uploaded {upload.name}
                </p>
              ) : null}
              {upload.phase === "notice" ? (
                <p className="mt-3 text-sm text-amber-700" data-testid="upload-notice">
                  {upload.message}
                </p>
              ) : null}
              {upload.phase === "error" ? (
                <p className="mt-3 text-sm text-red-600" role="alert">
                  {upload.message}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="product-select">Product</Label>
              <Select
                id="product-select"
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                className="mt-1"
              >
                <option value="new">New product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.title}
                  </option>
                ))}
              </Select>
              {productId === "new" ? (
                <div className="mt-3">
                  <Label htmlFor="new-product-title">Product name</Label>
                  <Input
                    id="new-product-title"
                    value={newProductTitle}
                    maxLength={120}
                    onChange={(event) => setNewProductTitle(event.target.value)}
                    placeholder="Ceramic pour over mug"
                    className="mt-1"
                  />
                </div>
              ) : null}
              <p className="mt-1 text-xs text-ink-400">
                {productId === "new"
                  ? "A new photo starts a new product."
                  : "Leave the photo empty to use the photos already saved for this product."}
              </p>
              {needsAttachConfirm && selectedProduct ? (
                <div
                  className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3"
                  role="group"
                  aria-labelledby="attach-question"
                  data-testid="attach-confirm"
                >
                  <p id="attach-question" className="text-sm text-ink-800">
                    Does this photo show {selectedProduct.title}? Photos of different items in one pack give mixed
                    results.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => attachKey && setConfirmedAttach(attachKey)}>
                      Add this photo to {selectedProduct.title}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setProductId("new")}>
                      It is a new product
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div>
              <Label htmlFor="product-description">Anything we should know</Label>
              <Textarea
                id="product-description"
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Materials, sizes, what is in the box, claims you can back up."
                className="mt-1"
              />
              <p className="mt-1 text-xs text-ink-400">
                Optional. The analyzer reads this as seller notes when planning your shots.
              </p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-950">2. Pick your channels</h2>
          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-ink-700">Marketplaces</h3>
              <div className="mt-2 space-y-1">{marketplaceChannels.map(renderChannel)}</div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-ink-700">Social and video</h3>
              <div className="mt-2 space-y-1">{socialChannels.map(renderChannel)}</div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-950">3. How it is made</h2>
          {CONCEPT_MODE_AVAILABLE ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2" role="group" aria-label="Pack mode">
              <button
                type="button"
                aria-pressed={mode === "listing"}
                onClick={() => setMode("listing")}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  mode === "listing" ? "border-ink-900 bg-white" : "border-ink-200 bg-white hover:border-ink-400",
                )}
              >
                <p className="font-medium text-ink-900">Listing Mode</p>
                <p className="mt-1 text-xs text-ink-500">
                  The default. Needs at least one real photo. Your product pixels are never regenerated, and any
                  angle you did not photograph is marked Needs photo instead of being invented.
                </p>
              </button>
              <button
                type="button"
                aria-pressed={mode === "concept"}
                onClick={() => setMode("concept")}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  mode === "concept" ? "border-ink-900 bg-white" : "border-ink-200 bg-white hover:border-ink-400",
                )}
              >
                <p className="font-medium text-ink-900">Concept Mode</p>
                <p className="mt-1 text-xs text-ink-500">
                  Text only, for prelaunch pitches, crowdfunding and supplier briefs. Outputs carry a visible
                  Concept render label and are excluded from marketplace packs and publishing.
                </p>
              </button>
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-ink-200 bg-white p-4" data-testid="listing-mode">
              <p className="font-medium text-ink-900">Listing Mode</p>
              <p className="mt-1 text-xs text-ink-500">
                Built from your real photo. Your product pixels are never regenerated, and any angle you did not
                photograph is marked Needs photo instead of being invented.
              </p>
            </div>
          )}
        </section>
      </div>

      <div>
        <Card className="sticky top-6">
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold text-ink-950">Pack summary</h2>
            <ul className="mt-4 space-y-2 text-sm text-ink-600">
              {estimate.lines.map((line) => (
                <li key={line.label} className="flex items-baseline justify-between gap-3">
                  <span>{line.label}</span>
                  <span className="font-medium text-ink-900">{line.credits}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-ink-100 pt-4">
              <p className="flex items-baseline justify-between text-sm">
                <span className="font-semibold text-ink-900">Estimated credits</span>
                <span className="text-2xl font-bold text-ink-950" data-testid="credit-estimate">
                  {estimate.total}
                </span>
              </p>
              <p
                className={cn("mt-1 text-xs", creditBalance < 0 ? "text-amber-700" : "text-ink-400")}
                data-testid="credit-balance-line"
              >
                {creditBalanceLine(creditBalance)}
              </p>
            </div>
            <Button
              variant="secondary"
              size="lg"
              className="mt-5 w-full"
              disabled={submitting || uploading}
              aria-disabled={submitting || uploading}
              onClick={() => void submit()}
              data-testid="create-pack"
            >
              {buttonLabel}
            </Button>
            {submitError ? (
              <p className="mt-3 text-sm text-red-600" role="alert">
                {submitError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
