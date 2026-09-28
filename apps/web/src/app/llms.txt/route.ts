import { buildLlmsTxt } from "@/lib/llms";

// Rebuilt hourly rather than once at build time: the file says whether paid
// plans can be bought, which changes when Stripe keys are added.
export const revalidate = 3600;

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
