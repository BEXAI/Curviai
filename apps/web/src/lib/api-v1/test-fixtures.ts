/**
 * Fixtures for the API v1 and MCP tests: a demo backend over a fresh
 * DemoService and key store, and photos built with the pipeline's sharp.
 * Test only; nothing in the app imports it.
 */

import { createRequire } from "node:module";
import { DEMO_API_KEY, demoApiKeyBackend, DEMO_OWNER_ID, type ApiKeyBackend } from "@/lib/api-keys/backend";
import { API_SCOPES, DEMO_KEY_TAG, hashApiKey } from "@/lib/api-keys/format";
import { MemoryApiKeyStore } from "@/lib/api-keys/store";
import { DEMO_WORKSPACE_ID, DemoService, DemoStore } from "@/lib/services/demo";

// sharp is a dependency of @curvi/pipeline, not of the web app; the tests
// borrow it from there to build fixtures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp = createRequire(new URL("../../../../../packages/pipeline/package.json", import.meta.url))("sharp") as any;

export const DEMO_KEY_ID = "00000000-0000-4000-8000-0000000003a1";

export interface DemoApiFixture {
  backend: ApiKeyBackend;
  store: MemoryApiKeyStore;
  service: DemoService;
  key: string;
}

/** A demo backend with the fixed demo key over a fresh demo store. */
export function demoApiFixture(): DemoApiFixture {
  const store = new MemoryApiKeyStore([
    {
      id: DEMO_KEY_ID,
      workspaceId: DEMO_WORKSPACE_ID,
      name: "Demo key",
      prefix: `${DEMO_KEY_TAG}000000000000`,
      keyHash: hashApiKey(DEMO_API_KEY),
      scopes: [...API_SCOPES],
      lastUsedAt: null,
      revokedAt: null,
      createdBy: DEMO_OWNER_ID,
      createdAt: new Date("2026-09-29T00:00:00.000Z"),
    },
  ]);
  const service = new DemoService(new DemoStore());
  return { backend: demoApiKeyBackend(store, () => service), store, service, key: DEMO_API_KEY };
}

/** A square PNG: white, with a dark product square filling `fill` of it. */
export async function mainImagePng(size: number, fill: number): Promise<Buffer> {
  const side = Math.round(size * fill);
  const product = await sharp({ create: { width: side, height: side, channels: 3, background: "#223344" } })
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
    .composite([{ input: product, gravity: "centre" }])
    .png()
    .toBuffer();
}
