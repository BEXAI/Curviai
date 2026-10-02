import { optionalEnv } from "@/lib/env";

/** P19-28: public proof for the ai.curvi Registry namespace. The founder
 * generates an Ed25519 key separately; only its base64 raw PUBLIC key goes
 * in MCP_REGISTRY_AUTH. The private key is never needed by the web app.
 * https://modelcontextprotocol.io/registry/authentication (2026-10-02).
 * This route does not register, publish or enable the MCP server. */
export const dynamic = "force-dynamic";

const HEADERS = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } as const;
const PROOF = /^v=MCPv1; k=ed25519; p=([A-Za-z0-9+/]{43}=)$/;

export function GET(): Response {
  const proof = optionalEnv("MCP_REGISTRY_AUTH")?.trim();
  const encodedKey = proof && PROOF.exec(proof)?.[1];
  // Fail closed for malformed configuration, including a PEM or a hex
  // private key pasted in place of the public proof. Canonical base64 for
  // an Ed25519 raw public key is exactly 32 bytes, ending in one '='.
  if (!encodedKey || Buffer.from(encodedKey, "base64").toString("base64") !== encodedKey) {
    return new Response("Not found", { status: 404, headers: HEADERS });
  }
  return new Response(proof, { status: 200, headers: HEADERS });
}
