/**
 * Demo mode must never switch on by accident in production. Without
 * DATABASE_URL and the Supabase env vars getServices() would serve the in
 * memory DemoService, where every visitor is the owner of one shared
 * workspace. In production (NODE_ENV=production) that fails closed with
 * DemoModeRefusedError unless ALLOW_DEMO_MODE=1 says it is on purpose (the
 * e2e server runs the demo build that way). Kept apart from ./index, which
 * pulls in the database layer, so routes and tests can share the error.
 */

/** Plain copy for the 503 routes answer while the server is misconfigured. */
export const DEMO_MODE_REFUSED_MESSAGE = "Curvi is not available right now. We are on it, so try again in a few minutes.";

export class DemoModeRefusedError extends Error {
  constructor() {
    super("Demo mode is refused in production: DATABASE_URL or the Supabase env vars are missing.");
    this.name = "DemoModeRefusedError";
  }
}

type Env = Record<string, string | undefined>;

/** True outside production, or in production with ALLOW_DEMO_MODE=1. */
export function demoModeAllowed(env: Env = process.env): boolean {
  return env.NODE_ENV !== "production" || env.ALLOW_DEMO_MODE === "1";
}

export function assertDemoModeAllowed(env: Env = process.env): void {
  if (!demoModeAllowed(env)) {
    throw new DemoModeRefusedError();
  }
}
