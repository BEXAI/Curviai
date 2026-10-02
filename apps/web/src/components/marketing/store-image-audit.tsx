"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, buttonVariants } from "@curvi/ui";
import type { StoreAuditProduct, StoreAuditReport } from "@/lib/store-audit/types";
import { track } from "@/lib/track";
import { EmailGate } from "./email-gate";
import { storeAuditCopy } from "./search-copy";
import { SignupLink } from "./signup-link";
import { Turnstile, turnstileEnabled } from "./turnstile";

type AuditState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; report: StoreAuditReport }
  | { phase: "error"; message: string };

function resultCell(product: StoreAuditProduct): string {
  const result = product.result;
  switch (result.status) {
    case "checked":
      return result.pass
        ? storeAuditCopy.passCell
        : storeAuditCopy.failCell(result.rows.filter((row) => !row.pass).map((row) => row.label));
    case "no_image":
      return storeAuditCopy.noImage;
    case "not_checked":
      return storeAuditCopy.notChecked;
  }
}

/**
 * The store image audit form and report (P18-18). The summary is free; the
 * per product table sits behind the email gate (lead source store-audit).
 */
export function StoreImageAudit({
  channels,
  maxProducts,
  thinImageCount,
}: {
  channels: readonly { key: string; name: string }[];
  maxProducts: number;
  thinImageCount: number;
}) {
  const [store, setStore] = useState("");
  const [channel, setChannel] = useState(channels[0]?.key ?? "");
  const [state, setState] = useState<AuditState>({ phase: "idle" });
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!store.trim() || state.phase === "loading" || (turnstileEnabled && !captchaToken)) {
      return;
    }
    setState({ phase: "loading" });
    try {
      const response = await fetch("/api/tools/store-audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ store: store.trim(), channel, captchaToken }),
      });
      const payload = (await response.json().catch(() => null)) as { audit?: StoreAuditReport; error?: string } | null;
      if (!response.ok || !payload?.audit) {
        setState({ phase: "error", message: payload?.error ?? "We could not audit that store just now. Try again in a minute." });
        return;
      }
      const report = payload.audit;
      setState({ phase: "done", report });
      track("store_audit_run", {
        channel: report.channel.key,
        checked: report.summary.checked,
        failing: report.summary.failing,
        thin: report.summary.thin,
      });
    } catch {
      setState({ phase: "error", message: "We could not reach Curvi. Check your connection and try again." });
    } finally {
      setCaptchaToken("");
      setCaptchaReset((value) => value + 1);
    }
  }

  const report = state.phase === "done" ? state.report : null;

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6">
          <form onSubmit={(event) => void submit(event)} className="space-y-4">
            <div>
              <Label htmlFor="store-address">{storeAuditCopy.storeLabel}</Label>
              <Input
                id="store-address"
                // Text, not url, so an address typed without https:// still submits.
                type="text"
                inputMode="url"
                autoComplete="off"
                maxLength={2048}
                value={store}
                onChange={(event) => setStore(event.target.value)}
                placeholder={storeAuditCopy.storePlaceholder}
                className="mt-1"
              />
            </div>
            {channels.length > 1 ? (
              <div>
                <label htmlFor="store-audit-channel" className="block text-sm font-medium text-ink-900">
                  {storeAuditCopy.channelLabel}
                </label>
                <select
                  id="store-audit-channel"
                  value={channel}
                  onChange={(event) => setChannel(event.target.value)}
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
            <Turnstile action="store-audit" resetKey={captchaReset} onToken={setCaptchaToken} />
            <Button type="submit" disabled={state.phase === "loading" || !store.trim() || (turnstileEnabled && !captchaToken)}>
              {state.phase === "loading" ? storeAuditCopy.busy : storeAuditCopy.submit}
            </Button>
            <p className="text-xs text-ink-500">{storeAuditCopy.how(maxProducts)}</p>
          </form>
          <div aria-live="polite">
            {state.phase === "error" ? (
              <p className="mt-3 text-sm text-red-600" role="alert" data-testid="store-audit-error">
                {state.message}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {report ? (
        <Card data-testid="store-audit-report">
          <CardHeader>
            <CardTitle>{report.store}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p data-testid="store-audit-summary" className="text-sm font-semibold text-ink-900">
              {storeAuditCopy.summary(
                report.summary.failing,
                report.summary.checked,
                report.channel.name,
                report.summary.thin,
                thinImageCount,
              )}
            </p>
            {report.summary.notChecked > 0 ? (
              <p className="text-sm text-ink-600">{storeAuditCopy.partial(report.summary.notChecked)}</p>
            ) : null}
            <EmailGate source="store-audit" title={storeAuditCopy.gateTitle} body={storeAuditCopy.gateBody}>
              <div className="overflow-x-auto rounded-xl border border-ink-100">
                <table data-testid="store-audit-table" className="w-full min-w-[28rem] text-left text-sm">
                  <thead className="bg-ink-50 text-ink-700">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-semibold">{storeAuditCopy.tableProduct}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{storeAuditCopy.tableImages}</th>
                      <th scope="col" className="px-4 py-3 font-semibold">{storeAuditCopy.tableResult}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.products.map((product) => (
                      <tr key={product.url} className="border-t border-ink-100 align-top">
                        <td className="px-4 py-3 font-medium text-ink-900">
                          <a href={product.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                            {product.title}
                          </a>
                        </td>
                        <td className="px-4 py-3 text-ink-700">{product.imageCount}</td>
                        <td className="px-4 py-3 text-ink-700">{resultCell(product)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </EmailGate>
            <div className="rounded-lg bg-accent-50 p-4 text-sm text-ink-700">
              <p>{storeAuditCopy.pack}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <SignupLink
                  source="store_audit"
                  data-testid="store-audit-signup"
                  className={buttonVariants({ variant: "secondary" })}
                >
                  {storeAuditCopy.packCta}
                </SignupLink>
                <Link
                  href={`/tools/main-image-checker?channel=${encodeURIComponent(report.channel.key)}`}
                  className={buttonVariants({ variant: "outline" })}
                >
                  {storeAuditCopy.checkerLink}
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
