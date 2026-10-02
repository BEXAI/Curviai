"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Textarea, cn } from "@curvi/ui";
import { draftEmail, fidelityLine, PROSPECT_PAGE_COPY } from "@/lib/prospects/copy";
import type { OutreachKit } from "@/lib/prospects/kit";
import type { ProspectRow } from "@/lib/prospects/store";
import { PHOTO_ACCEPT, uploadSourcePhoto } from "@/lib/upload-photo";
import { requestPhotoImport, requestProductImport } from "@/lib/url-import/client";
import { sellerNotesFrom } from "@/lib/url-import/types";

const COPY = PROSPECT_PAGE_COPY;
/** How often the list refreshes while a pack is being made. */
const POLL_MS = 10_000;

interface CreditsView {
  usedThisMonth: number;
  cap: number;
  balance: number;
}

interface ChannelOption {
  value: string;
  label: string;
}

interface KitView {
  /** Null when the kit was shown again and no live link can be rebuilt. */
  link: string | null;
  expiresAt: string | null;
  kit: OutreachKit;
}

export function ProspectsNotice({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-3xl" data-testid="prospects-notice">
      <h1 className="font-display text-2xl font-bold tracking-tight text-ink-950">{COPY.title}</h1>
      <p className="mt-3 text-sm text-ink-600">{message}</p>
    </div>
  );
}

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

function CreditsCard({
  credits,
  maxCreditsPerAdd,
  onChange,
}: {
  credits: CreditsView | null;
  maxCreditsPerAdd: number;
  onChange: (credits: CreditsView) => void;
}) {
  const [amount, setAmount] = useState("40");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function add() {
    const credits = Number(amount);
    if (!Number.isInteger(credits) || credits < 1 || credits > maxCreditsPerAdd) {
      setMessage(COPY.creditsInvalid);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/ops/prospects/credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credits }),
      });
      const data = await readJson<{ credits?: CreditsView; added?: number }>(response);
      if (!response.ok || !data.credits) {
        setMessage(data.error ?? COPY.failedGeneric);
        return;
      }
      onChange(data.credits);
      setMessage(COPY.creditsAdded(data.added ?? credits));
    } catch {
      setMessage(COPY.failedGeneric);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="prospect-credits">
      <CardHeader>
        <CardTitle>{COPY.creditsTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {credits ? <p className="text-sm text-ink-700">{COPY.creditsLine(credits.usedThisMonth, credits.balance)}</p> : null}
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm text-ink-700">
            <span className="block font-medium">{COPY.creditsLabel}</span>
            <Input
              type="number"
              min={1}
              max={maxCreditsPerAdd}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="mt-1 w-32"
              data-testid="prospect-credits-amount"
            />
          </label>
          <Button onClick={() => void add()} disabled={busy} data-testid="prospect-credits-add">
            {COPY.creditsButton}
          </Button>
        </div>
        {message ? (
          <p className="text-sm text-ink-700" role="status">
            {message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NewProspectForm({
  channels,
  defaultChannels,
  onCreated,
}: {
  channels: ChannelOption[];
  defaultChannels: string[];
  onCreated: () => void;
}) {
  const [store, setStore] = useState("");
  const [productUrl, setProductUrl] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string[]>(defaultChannels);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "importing" | "uploading" | "working">("idle");
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  const busy = phase !== "idle";

  async function submit() {
    if (!store.trim()) {
      setMessage({ tone: "error", text: COPY.needStore });
      return;
    }
    if (picked.length === 0) {
      setMessage({ tone: "error", text: COPY.needChannel });
      return;
    }
    if (!file && !productUrl.trim()) {
      setMessage({ tone: "error", text: COPY.needPhoto });
      return;
    }
    setMessage(null);
    let upload: { key: string; sha256: string; kind: "image" } | null = null;
    let packTitle = title.trim();
    let packNote = note.trim();
    try {
      if (file) {
        setPhase("uploading");
        const uploaded = await uploadSourcePhoto(file);
        if (!uploaded.ok) {
          setMessage({ tone: "error", text: uploaded.message });
          return;
        }
        upload = { key: uploaded.key, sha256: uploaded.sha256, kind: "image" };
      } else {
        setPhase("importing");
        const imported = await requestProductImport(productUrl.trim());
        if (!imported.ok) {
          setMessage({ tone: "error", text: COPY.importFailed(imported.message) });
          return;
        }
        const first = imported.product.images[0];
        if (!first) {
          setMessage({ tone: "error", text: COPY.importFailed("The page lists no photo.") });
          return;
        }
        const photo = await requestPhotoImport(first.url, imported.product.title);
        if (photo.phase !== "uploaded") {
          setMessage({ tone: "error", text: COPY.importFailed(photo.message) });
          return;
        }
        upload = { key: photo.key, sha256: photo.sha256, kind: "image" };
        packTitle = packTitle || imported.product.title;
        packNote = packNote || sellerNotesFrom(imported.product);
      }
      setPhase("working");
      const response = await fetch("/api/ops/prospects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          store: store.trim(),
          productUrl: productUrl.trim(),
          title: packTitle.slice(0, 120) || undefined,
          note: packNote || undefined,
          channels: picked,
          upload,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await readJson<{ prospect?: ProspectRow }>(response);
      if (!response.ok) {
        setMessage({ tone: "error", text: data.error ?? COPY.failedGeneric });
        return;
      }
      setStore("");
      setProductUrl("");
      setTitle("");
      setNote("");
      setFile(null);
      setMessage({ tone: "info", text: COPY.created });
      onCreated();
    } catch {
      setMessage({ tone: "error", text: COPY.failedGeneric });
    } finally {
      setPhase("idle");
    }
  }

  const label = { importing: COPY.importing, uploading: COPY.uploading, working: COPY.working, idle: COPY.submit }[phase];

  return (
    <Card data-testid="prospect-form">
      <CardHeader>
        <CardTitle>{COPY.formTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="block text-sm text-ink-700">
            <span className="font-medium">{COPY.storeLabel}</span>
            <span className="block text-xs text-ink-500">{COPY.storeHint}</span>
            <Input value={store} maxLength={80} onChange={(event) => setStore(event.target.value)} className="mt-1" data-testid="prospect-store" />
          </label>
          <label className="block text-sm text-ink-700">
            <span className="font-medium">{COPY.linkLabel}</span>
            <span className="block text-xs text-ink-500">{COPY.linkHint}</span>
            <Input
              type="url"
              value={productUrl}
              onChange={(event) => setProductUrl(event.target.value)}
              className="mt-1"
              data-testid="prospect-url"
            />
          </label>
          <label className="block text-sm text-ink-700">
            <span className="font-medium">{COPY.photoLabel}</span>
            <span className="block text-xs text-ink-500">{COPY.photoHint}</span>
            <input
              type="file"
              accept={PHOTO_ACCEPT}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 block text-sm"
              data-testid="prospect-photo"
            />
          </label>
          <label className="block text-sm text-ink-700">
            <span className="font-medium">{COPY.titleLabel}</span>
            <Input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} className="mt-1" />
          </label>
          <fieldset>
            <legend className="text-sm font-medium text-ink-700">{COPY.channelsLabel}</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {channels.map((channel) => (
                <label
                  key={channel.value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm",
                    picked.includes(channel.value) ? "border-accent-500 bg-accent-50" : "border-ink-100",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={picked.includes(channel.value)}
                    onChange={(event) =>
                      setPicked((current) =>
                        event.target.checked ? [...current, channel.value] : current.filter((value) => value !== channel.value),
                      )
                    }
                    className="accent-accent-500"
                  />
                  {channel.label}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm text-ink-700">
            <span className="font-medium">{COPY.noteLabel}</span>
            <Textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} className="mt-1 min-h-16" />
          </label>
          {message ? (
            <p className={cn("text-sm", message.tone === "error" ? "text-red-700" : "text-ink-700")} role={message.tone === "error" ? "alert" : "status"}>
              {message.text}
            </p>
          ) : null}
          <Button type="submit" disabled={busy} data-testid="prospect-submit">
            {label}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CopyButton({ text, testId }: { text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      data-testid={testId}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? COPY.copied : COPY.copy}
    </Button>
  );
}

function KitPanel({ view }: { view: KitView }) {
  const { kit } = view;
  const [name, setName] = useState("");
  const [founder, setFounder] = useState("");
  const build = useCallback(
    () =>
      draftEmail({
        name,
        product: kit.productTitle,
        whitePercent: kit.check?.whitePercent ?? null,
        fillPercent: kit.check?.fillPercent ?? null,
        link: view.link ?? COPY.kitLinkPlaceholder,
        founder,
      }),
    [name, founder, kit, view.link],
  );
  const [note, setNote] = useState(build);
  useEffect(() => {
    setNote(build());
  }, [build]);

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-ink-100 bg-ink-50/60 p-4" data-testid="prospect-kit">
      <h4 className="text-sm font-semibold text-ink-900">{COPY.kitTitle}</h4>
      <div>
        <p className="text-xs font-medium text-ink-700">{COPY.kitLink}</p>
        {view.link ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-xs text-ink-900" data-testid="prospect-kit-link">
              {view.link}
            </code>
            <CopyButton text={view.link} testId="prospect-kit-copy-link" />
          </div>
        ) : (
          <p className="mt-1 text-xs text-ink-500" data-testid="prospect-kit-no-link">
            {COPY.kitNoLink}
          </p>
        )}
      </div>
      <div>
        <p className="text-xs font-medium text-ink-700">{COPY.kitCheck}</p>
        {kit.check ? (
          <ul className="mt-1 space-y-1 text-xs text-ink-700">
            <li className="font-medium">{kit.check.summary}</li>
            {kit.check.rows.map((row) => (
              <li key={row.key}>
                {row.pass ? COPY.kitPass : COPY.kitFail}: {row.label}. {row.measured}.
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-ink-500">{COPY.kitCheckMissing}</p>
        )}
      </div>
      <div>
        <p className="text-xs font-medium text-ink-700">{COPY.kitFidelity}</p>
        <p className="mt-1 text-xs text-ink-700">{fidelityLine(kit.fidelity)}</p>
      </div>
      <div className="space-y-2">
        <p className="text-xs font-medium text-ink-700">{COPY.kitNote}</p>
        <p className="text-xs text-ink-500">{COPY.kitNoteHint}</p>
        <div className="flex flex-wrap gap-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={COPY.kitName} aria-label={COPY.kitName} className="w-48" />
          <Input
            value={founder}
            onChange={(event) => setFounder(event.target.value)}
            placeholder={COPY.kitFounder}
            aria-label={COPY.kitFounder}
            className="w-48"
          />
        </div>
        <Textarea value={note} onChange={(event) => setNote(event.target.value)} className="min-h-32 text-xs" data-testid="prospect-kit-note" />
        <CopyButton text={note} testId="prospect-kit-copy-note" />
      </div>
    </div>
  );
}

function ProspectItem({ row }: { row: ProspectRow }) {
  const [view, setView] = useState<KitView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function showKit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/ops/prospects/${row.id}/link`, { cache: "no-store" });
      const data = await readJson<KitView>(response);
      if (!response.ok || !data.kit) {
        setError(data.error ?? COPY.failedGeneric);
        return;
      }
      setView({ link: data.link ?? null, expiresAt: data.expiresAt ?? null, kit: data.kit });
    } catch {
      setError(COPY.failedGeneric);
    } finally {
      setBusy(false);
    }
  }

  async function makeLink() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/ops/prospects/${row.id}/link`, { method: "POST" });
      const data = await readJson<KitView>(response);
      if (!response.ok || !data.link) {
        setError(data.error ?? COPY.failedGeneric);
        return;
      }
      setView({ link: data.link, expiresAt: data.expiresAt, kit: data.kit });
    } catch {
      setError(COPY.failedGeneric);
    } finally {
      setBusy(false);
    }
  }

  const canLink = row.state === "ready" || row.state === "expired";
  return (
    <li className="rounded-lg border border-ink-100 bg-white p-4" data-testid="prospect-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink-900">{row.label}</p>
          <p className="text-xs text-ink-500">{row.productTitle}</p>
          {row.sharePublished && row.shareSlug ? (
            <p className="mt-1 text-xs text-ink-500">
              /s/{row.shareSlug}, {row.shareViews} {row.shareViews === 1 ? "view" : "views"}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={row.state === "ready" ? "success" : "outline"} data-testid="prospect-state">
            {COPY.states[row.state]}
          </Badge>
          <Link href={`/app/jobs/${row.jobId}`} className="text-xs font-medium text-ink-900 underline">
            {COPY.openPack}
          </Link>
          {canLink && !view ? (
            <Button size="sm" variant="outline" onClick={() => void showKit()} disabled={busy} data-testid="prospect-show-kit">
              {COPY.showKit}
            </Button>
          ) : null}
          {canLink ? (
            <Button size="sm" onClick={() => void makeLink()} disabled={busy} data-testid="prospect-make-link">
              {view?.link ? COPY.remakeLink : COPY.makeLink}
            </Button>
          ) : null}
        </div>
      </div>
      {view?.link ? <p className="mt-2 text-xs text-ink-500">{COPY.remakeHint}</p> : null}
      {error ? (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      ) : null}
      {view ? <KitPanel view={view} /> : null}
    </li>
  );
}

/**
 * The operator's prospect makeover tool (docs/phases/PHASE_18.md P18-04):
 * prospect credits under the monthly cap, the form that makes a pack from a
 * product link or listing photo, and the list with each pack's claim link
 * and outreach kit. Every call goes through the operator gated routes.
 */
export function ProspectsDashboard({
  channels,
  defaultChannels,
  maxCreditsPerAdd,
}: {
  channels: ChannelOption[];
  defaultChannels: string[];
  maxCreditsPerAdd: number;
}) {
  const [prospects, setProspects] = useState<ProspectRow[] | null>(null);
  const [credits, setCredits] = useState<CreditsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch("/api/ops/prospects", { cache: "no-store" });
        const data = await readJson<{ prospects?: ProspectRow[]; credits?: CreditsView }>(response);
        if (stopped) return;
        if (!response.ok || !data.prospects) {
          setError(data.error ?? COPY.unavailable);
          return;
        }
        setError(null);
        setProspects(data.prospects);
        if (data.credits) setCredits(data.credits);
        if (data.prospects.some((row) => row.state === "making")) {
          timer = setTimeout(load, POLL_MS);
        }
      } catch {
        if (!stopped) setError(COPY.unavailable);
      }
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  return (
    <div className="mx-auto max-w-4xl space-y-6" data-testid="prospects-dashboard">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-950">{COPY.title}</h1>
        <p className="mt-2 max-w-3xl text-sm text-ink-600">{COPY.intro}</p>
      </div>
      <CreditsCard credits={credits} maxCreditsPerAdd={maxCreditsPerAdd} onChange={setCredits} />
      <NewProspectForm channels={channels} defaultChannels={defaultChannels} onCreated={reload} />
      <section aria-labelledby="prospects-list-title" className="space-y-3">
        <h2 id="prospects-list-title" className="text-lg font-semibold text-ink-950">
          {COPY.listTitle}
        </h2>
        {error ? (
          <p className="text-sm text-red-700" role="alert">
            {error}
          </p>
        ) : null}
        {prospects && prospects.length === 0 ? <p className="text-sm text-ink-500">{COPY.empty}</p> : null}
        {prospects && prospects.length > 0 ? (
          <ul className="space-y-3">
            {prospects.map((row) => (
              <ProspectItem key={row.id} row={row} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
