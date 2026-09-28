/**
 * GET /api/health/providers
 * Key probe for every live provider this instance would use, so a bad,
 * revoked or out of credit key shows up before a customer pack and not
 * during one. Each configured provider gets the cheapest authenticated call
 * it offers, a free metadata read through its @curvi/ai adapter (model
 * resource for Anthropic, Gemini and OpenAI, credit balance for BFL,
 * account details for Photoroom; docs/verification.md). Nothing is
 * generated and nothing is spent. Each probe times out after 10 seconds and
 * a failure is reported as data, so the route itself always answers.
 *
 * The provider list comes from trigger/src/provider-probes.ts, which reads
 * the same env and seed rows as the live wiring. Keys are reported by env
 * var name and presence only.
 *
 * Protected: 404 while CRON_SECRET is unset (the route does not exist to the
 * world), 401 without `Authorization: Bearer <CRON_SECRET>` (or
 * x-cron-secret), compared in constant time (lib/cron-auth.ts).
 */

import { NextResponse } from "next/server";
import { probeProviders, PROBE_TIMEOUT_MS, type ProbeResult } from "@curvi/ai";
import { liveProviderTargets } from "@curvi/trigger/provider-probes";
import { checkCronAuth } from "@/lib/cron-auth";
import { optionalEnv } from "@/lib/env";
import { getHealthRegistry } from "@/lib/health";
import { isDbMode } from "@/lib/services";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

interface ProviderProbeEntry {
  name: string;
  kind: string;
  envVar: string;
  stages: string[];
  configured: boolean;
  /** null when the key is unset and nothing was called. */
  probe: ProbeResult | null;
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = checkCronAuth(request.headers);
  if (auth === "unconfigured") {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  }
  if (auth === "denied") {
    return NextResponse.json({ error: "Not authorized." }, { status: 401, headers: NO_STORE });
  }

  const targets = liveProviderTargets(optionalEnv);
  const probed = await probeProviders(
    targets.flatMap((target) => (target.provider ? [{ name: target.name, provider: target.provider }] : [])),
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  const byName = new Map(probed.map(({ name, ...result }) => [name, result]));
  const providers: ProviderProbeEntry[] = targets.map((target) => ({
    name: target.name,
    kind: target.kind,
    envVar: target.envVar,
    stages: target.stages,
    configured: target.configured,
    probe: byName.get(target.name) ?? null,
  }));

  const mode = isDbMode() ? "db" : "demo";
  const { services } = await getHealthRegistry().report(mode);
  const configured = providers.filter((provider) => provider.configured);
  return NextResponse.json(
    {
      /** True when every configured key was accepted. */
      ok: configured.every((provider) => provider.probe?.ok === true),
      mode,
      providers,
      services,
      checkedAt: new Date().toISOString(),
    },
    { headers: NO_STORE },
  );
}
