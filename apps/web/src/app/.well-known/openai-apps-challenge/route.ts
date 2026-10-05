import { optionalEnv } from "@/lib/env";

/**
 * GET /.well-known/openai-apps-challenge (PHASE_19 P19-22): OpenAI's domain
 * proof for the plugin submission. The approved public challenge below
 * proves ownership of curvi.ai. OPENAI_APPS_CHALLENGE_TOKEN can override it
 * for a future submission. OpenAI asks for "the exact challenge token as
 * plain text", "not JSON or a list of tokens" (docs/verification.md,
 * PHASE_19, O3 and O4), so the body is the token and nothing else.
 *
 * Next.js serves route handlers under app/.well-known (only folders that
 * start with an underscore are private), checked on Next.js 15.5.
 */

export const dynamic = "force-dynamic";

const HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } as const;
// Public domain-ownership proof, not an API key or authentication credential.
const APPROVED_CHALLENGE = "hZMc0Qeyiu5Imj78qB94XYFxpKUlFhV5FRD2y8Hld3A";

export function GET(): Response {
  // A value pasted into Render can pick up a trailing newline or space.
  const token = optionalEnv("OPENAI_APPS_CHALLENGE_TOKEN")?.trim() || APPROVED_CHALLENGE;
  return new Response(token, { status: 200, headers: HEADERS });
}
