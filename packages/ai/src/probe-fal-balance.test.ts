/**
 * The fal balance probe (docs/phases/PHASE_18.md P18-03): one GET to the
 * billing endpoint with the admin key, and every failure (refused, no
 * balance, timeout, network) comes back as data. fetch is always a fake.
 */

import { describe, expect, it, vi } from "vitest";
import { FAL_BILLING_URL, parseFalBilling, probeFalBalance } from "./probe";

const ADMIN_KEY = "fal-admin-test-key";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("probeFalBalance", () => {
  it("reads the balance with the admin key on the billing endpoint, once", async () => {
    const { fetchImpl, calls } = fakeFetch(200, { username: "team", credits: { current_balance: 24.5, currency: "USD" } });
    const result = await probeFalBalance({ adminKey: ADMIN_KEY, fetchImpl });
    expect(result).toMatchObject({ ok: true, status: 200, balanceUsd: 24.5, currency: "USD" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.fal.ai/v1/account/billing?expand=credits");
    expect(calls[0].url).toBe(FAL_BILLING_URL);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers).toMatchObject({ Authorization: `Key ${ADMIN_KEY}` });
    expect(calls[0].init.body).toBeUndefined();
  });

  it("reads a zero balance as a balance, not a failure", async () => {
    const { fetchImpl } = fakeFetch(200, { credits: { current_balance: 0, currency: "USD" } });
    expect(await probeFalBalance({ adminKey: ADMIN_KEY, fetchImpl })).toMatchObject({ ok: true, balanceUsd: 0 });
  });

  it("reports 401 and 403 as data with a plain reason, never the key or the body", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fakeFetch(status, { error: { message: `secret-looking body ${ADMIN_KEY}` } });
      const result = await probeFalBalance({ adminKey: ADMIN_KEY, fetchImpl });
      expect(result).toMatchObject({ ok: false, status, balanceUsd: null, currency: null });
      expect(result.error).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain(ADMIN_KEY);
      expect(JSON.stringify(result)).not.toContain("secret-looking");
    }
  });

  it("fails a 200 that carries no numeric balance", async () => {
    const { fetchImpl } = fakeFetch(200, { username: "team" });
    expect(await probeFalBalance({ adminKey: ADMIN_KEY, fetchImpl })).toMatchObject({
      ok: false,
      status: 200,
      balanceUsd: null,
      error: "The provider answered without a credit balance.",
    });
    const notJson = fakeFetch(200, "<html>");
    expect(await probeFalBalance({ adminKey: ADMIN_KEY, fetchImpl: notJson.fetchImpl })).toMatchObject({ ok: false });
  });

  it("gives up after the timeout, without a retry", async () => {
    let calls = 0;
    const hanging = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const result = await probeFalBalance({ adminKey: ADMIN_KEY, fetchImpl: hanging, timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, status: null, balanceUsd: null, error: "No answer within 20 milliseconds." });
    expect(calls).toBe(1);
  });

  it("reports a network error without throwing", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await probeFalBalance({ adminKey: ADMIN_KEY, fetchImpl: failing })).toMatchObject({
      ok: false,
      status: null,
      error: "The call did not reach the provider (TypeError).",
    });
  });
});

describe("parseFalBilling", () => {
  it("keeps a finite balance and a short currency", () => {
    expect(parseFalBilling({ credits: { current_balance: 3.25, currency: "USD" } })).toEqual({ balanceUsd: 3.25, currency: "USD" });
    expect(parseFalBilling({ credits: { current_balance: 3 } })).toEqual({ balanceUsd: 3, currency: null });
  });

  it("refuses anything else", () => {
    for (const body of [null, {}, { credits: null }, { credits: { current_balance: "3" } }, { credits: { current_balance: Number.NaN } }]) {
      expect(parseFalBilling(body)).toBeNull();
    }
  });
});
