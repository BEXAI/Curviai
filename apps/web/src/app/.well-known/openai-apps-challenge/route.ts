import { optionalEnv } from "@/lib/env";

/**
 * GET /.well-known/openai-apps-challenge (PHASE_19 P19-22): OpenAI's domain
 * proof for the plugin submission. The submission page shows a token; the
 * founder sets it as OPENAI_APPS_CHALLENGE_TOKEN on Render and presses
 * Verify Domain (runbook E3). OpenAI asks for "the exact challenge token as
 * plain text", "not JSON or a list of tokens" (docs/verification.md,
 * PHASE_19, O3 and O4), so the body is the token and nothing else. Without
 * the variable the path is a plain 404, as it was before this route.
 *
 * Next.js serves route handlers under app/.well-known (only folders that
 * start with an underscore are private), checked on Next.js 15.5.
 */

export const dynamic = "force-dynamic";

const HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } as const;

export function GET(): Response {
  // A value pasted into Render can pick up a trailing newline or space.
  const token = optionalEnv("OPENAI_APPS_CHALLENGE_TOKEN")?.trim();
  if (!token) {
    return new Response("Not found", { status: 404, headers: HEADERS });
  }
  return new Response(token, { status: 200, headers: HEADERS });
}
