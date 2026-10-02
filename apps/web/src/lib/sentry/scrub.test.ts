import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it } from "vitest";
import { TOKEN_PATH_PREFIXES } from "@/lib/token-paths";
import { KEPT_REQUEST_HEADERS, REDACTED, createScrubber, secretEnvValues, scrubUrl } from "./scrub";

// docs/phases/PHASE_20.md P20-13: nothing secret leaves the server in an
// error report.

const ENV = {
  CRON_SECRET: "cron-secret-value-0123456789",
  STRIPE_WEBHOOK_SECRET: "whsec_live_value_abcdefghij",
  FAL_KEY: "fal-key-value-abcdefghijkl",
  DATABASE_URL: "postgres://postgres.ref:db-password-value@aws-0-us.pooler.supabase.com:6543/postgres",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key-value-123456",
  NODE_ENV: "production",
  SHORT_TOKEN: "abc",
};

function event(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return { type: undefined, ...overrides } as ErrorEvent;
}

/** A sample token segment for a prefix, and what it must scrub to. */
function tokenSample(prefix: string): { raw: string; scrubbed: string } {
  return prefix.endsWith("/")
    ? { raw: `${prefix}tok_9f8e7d6c5b4a/rest?sig=secret`, scrubbed: `${prefix}[token]/rest` }
    : { raw: `${prefix}?t=secret-token-value`, scrubbed: prefix };
}

describe("secretEnvValues", () => {
  it("collects the values of secret looking server variables only", () => {
    const values = secretEnvValues(ENV);
    expect(values).toContain(ENV.CRON_SECRET);
    expect(values).toContain(ENV.STRIPE_WEBHOOK_SECRET);
    expect(values).toContain(ENV.FAL_KEY);
    expect(values).toContain(ENV.DATABASE_URL);
    // Public by design, or too short to replace safely.
    expect(values).not.toContain(ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    expect(values).not.toContain("abc");
    expect(values).not.toContain("production");
  });
});

describe("scrubEvent request", () => {
  const scrubber = createScrubber(ENV);

  it("drops every header outside the allowlist, credentials included", () => {
    const out = scrubber.scrubEvent(
      event({
        request: {
          method: "POST",
          url: "https://curvi.ai/api/cron/stale-jobs?force=1",
          headers: {
            authorization: `Bearer ${ENV.CRON_SECRET}`,
            Authorization: "Bearer other",
            cookie: "sb-access-token=eyJabc",
            "set-cookie": "a=b",
            "x-cron-secret": ENV.CRON_SECRET,
            "stripe-signature": "t=1,v1=abc",
            "x-api-key": "curvi_live_key",
            "proxy-authorization": "Basic abc",
            "user-agent": "Render/1.0",
            "content-type": "application/json",
            referer: "https://curvi.ai/s/abcd2345ef?claim=0123456789abcdef",
          },
          data: { password: "hunter2", card: "4242" },
          cookies: { session: "abc" },
          query_string: "force=1&token=secret",
          env: { REMOTE_ADDR: "203.0.113.9" },
        },
      }),
    );
    expect(out.request).toEqual({
      method: "POST",
      url: "https://curvi.ai/api/cron/stale-jobs",
      headers: {
        "user-agent": "Render/1.0",
        "content-type": "application/json",
        referer: "https://curvi.ai/s/[token]",
      },
    });
    const text = JSON.stringify(out);
    for (const secret of [ENV.CRON_SECRET, "hunter2", "sb-access-token", "203.0.113.9", "0123456789abcdef"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("keeps only allowlisted header names", () => {
    for (const name of KEPT_REQUEST_HEADERS) {
      expect(name).not.toMatch(/auth|cookie|secret|token|signature|key/i);
    }
  });

  it.each(TOKEN_PATH_PREFIXES.map((prefix) => [prefix]))("redacts the token after %s in the request URL", (prefix) => {
    const sample = tokenSample(prefix);
    const out = scrubber.scrubEvent(event({ request: { url: `https://curvi.ai${sample.raw}` } }));
    expect(out.request?.url).toBe(`https://curvi.ai${sample.scrubbed}`);
  });

  it("redacts the claim token of a share link (P18-04)", () => {
    const out = scrubber.scrubEvent(event({ request: { url: "https://curvi.ai/api/claims/0123abcd4567/takedown" } }));
    expect(out.request?.url).toBe("https://curvi.ai/api/claims/[token]/takedown");
  });
});

describe("scrubText", () => {
  const { scrubText } = createScrubber(ENV);

  it.each(TOKEN_PATH_PREFIXES.map((prefix) => [prefix]))("redacts a token path after %s inside text", (prefix) => {
    const sample = tokenSample(prefix);
    expect(scrubText(`request to ${sample.raw} failed`)).toBe(`request to ${sample.scrubbed} failed`);
    expect(scrubText(`"${sample.raw}"`)).toBe(`"${sample.scrubbed}"`);
    expect(scrubText(`GET https://curvi.ai${sample.raw} 500`)).toBe(`GET https://curvi.ai${sample.scrubbed} 500`);
  });

  it("leaves route patterns and look alike paths alone", () => {
    expect(scrubText("/api/claims/[token]/takedown")).toBe("/api/claims/[token]/takedown");
    expect(scrubText("/docs/s/intro and /app/jobs/123")).toBe("/docs/s/intro and /app/jobs/123");
    expect(scrubText("see /email/unsubscribed")).toBe("see /email/unsubscribed");
  });

  it("drops query strings from URLs and paths", () => {
    expect(scrubText("redirect to https://curvi.ai/auth/confirm?token_hash=abc&type=email now")).toBe(
      "redirect to https://curvi.ai/auth/confirm now",
    );
    expect(scrubText("callback /auth/callback?code=secret-code failed")).toBe("callback /auth/callback failed");
    expect(scrubText("next=/app/billing?checkout=growth")).toBe("next=/app/billing");
  });

  it("removes secret values and secret shaped strings", () => {
    const text = [
      `cron ${ENV.CRON_SECRET}`,
      `key ${ENV.FAL_KEY}`,
      "auth Bearer abcdefghijklmnop",
      "stripe sk_live_abcdefghijkl and rk_test_abcdefghijkl and whsec_abcdefghijkl",
      "openai sk-proj-abcdefghijklmnopqrstuv and anthropic sk-ant-api03-abcdefghijklmnop",
      "resend re_abcdefghijklmnopqrst",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl",
      "db postgres://user:p4ssw0rd@db.example.com:5432/postgres",
    ].join("; ");
    const out = scrubText(text);
    for (const secret of [
      ENV.CRON_SECRET,
      ENV.FAL_KEY,
      "abcdefghijklmnop",
      "sk_live_",
      "rk_test_",
      "whsec_",
      "sk-proj-",
      "sk-ant-",
      "re_abcdefghijklmnopqrst",
      "eyJhbGciOiJIUzI1NiJ9",
      "p4ssw0rd",
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain(REDACTED);
    expect(out).toContain("db.example.com");
  });

  it("replaces email addresses in third party error text (security review 3)", () => {
    expect(scrubText("No such customer: buyer.name+shop@example.co.uk (resource_missing)")).toBe(
      "No such customer: [email] (resource_missing)",
    );
    expect(scrubText('duplicate key value (email)=(Owner@Example.com) violates "users_email_key"')).toBe(
      'duplicate key value (email)=([email]) violates "users_email_key"',
    );
    // A connection string keeps its host after the credentials go.
    expect(scrubText("db postgres://user:p4ssw0rd@db.example.com:5432/postgres")).toContain("@db.example.com");
  });

  it("removes the whole connection string value of DATABASE_URL", () => {
    expect(scrubText(`connect ${ENV.DATABASE_URL} timed out`)).toBe(`connect ${REDACTED} timed out`);
  });
});

describe("scrubEvent body", () => {
  const scrubber = createScrubber(ENV);

  it("scrubs messages, exception values, breadcrumbs, extra, contexts and tags but not stack frames", () => {
    const frames = [{ filename: "app:///_next/server/app/api/claims/[token]/route.js", function: "POST", lineno: 10 }];
    const out = scrubber.scrubEvent(
      event({
        message: `failed with Bearer ${ENV.CRON_SECRET}`,
        exception: {
          values: [{ type: "Error", value: "GET /api/mcp/files/tok_abcdef failed", stacktrace: { frames } }],
        },
        breadcrumbs: [
          { category: "console", message: "loading /s/abcd2345ef?claim=0123", data: { arguments: ["x", ENV.FAL_KEY] } },
          { category: "http", data: { url: "https://api.fal.ai/v1/x?key=abc", method: "GET" } },
        ],
        extra: { arguments: ["fetch https://curvi.ai/invite/abc123", { nested: { secret: ENV.CRON_SECRET } }] },
        contexts: { nextjs: { request_path: "/api/preview/0b7a4d1e/full", route_type: "route" } },
        tags: { url: "https://curvi.ai/feedback/tok?x=1" },
        user: { id: "user-1", email: "seller@example.com", ip_address: "203.0.113.9" },
      }),
    );

    expect(out.message).toBe(`failed with Bearer ${REDACTED}`);
    expect(out.exception?.values?.[0].value).toBe("GET /api/mcp/files/[token] failed");
    expect(out.exception?.values?.[0].stacktrace?.frames).toEqual(frames);
    expect(out.breadcrumbs?.[0].message).toBe("loading /s/[token]");
    expect(out.breadcrumbs?.[0].data).toEqual({ arguments: ["x", REDACTED] });
    expect(out.breadcrumbs?.[1].data).toEqual({ url: "https://api.fal.ai/v1/x", method: "GET" });
    expect(out.extra).toEqual({ arguments: ["fetch https://curvi.ai/invite/[token]", { nested: { secret: REDACTED } }] });
    expect(out.contexts).toEqual({ nextjs: { request_path: "/api/preview/[token]/full", route_type: "route" } });
    expect(out.tags).toEqual({ url: "https://curvi.ai/feedback/[token]" });
    expect(out.user).toEqual({ id: "user-1" });
  });

  it("keeps the event's other fields and does not change the input", () => {
    const input = event({ level: "error", fingerprint: ["a", "b"], release: "abc123", message: "/s/x?claim=y" });
    const out = scrubber.scrubEvent(input);
    expect(out).toMatchObject({ level: "error", fingerprint: ["a", "b"], release: "abc123", message: "/s/[token]" });
    expect(input.message).toBe("/s/x?claim=y");
  });
});

describe("scrubUrl", () => {
  it("drops the query string and the fragment and redacts a token segment", () => {
    expect(scrubUrl("https://curvi.ai/pricing?plan=pro#top")).toBe("https://curvi.ai/pricing");
    expect(scrubUrl("https://curvi.ai/api/claims/abc/takedown?x=1")).toBe("https://curvi.ai/api/claims/[token]/takedown");
  });
});
