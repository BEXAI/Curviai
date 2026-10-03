import { optionalEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Official IndexNow keyLocation proof at the site root. Disabled until the
 * approved key is securely configured; never generates a key or submits. */
export async function GET(_request: Request, context: { params: Promise<{ indexnowKeyFile: string }> }): Promise<Response> {
  const key = optionalEnv("INDEXNOW_KEY");
  const { indexnowKeyFile } = await context.params;
  const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" };
  if (!key || !/^[A-Za-z0-9-]{8,128}$/.test(key) || indexnowKeyFile !== `${key}.txt`) return new Response("Not found", { status: 404, headers });
  return new Response(key, { status: 200, headers });
}
