/**
 * What OpenAI's plugin submission checks, as the build checks it before an
 * upload (docs/phases/PHASE_19.md, P19-25; docs/verification.md, "PHASE_19",
 * "p19/integration wave 4" rows). Sources, read 2026-10-01:
 *
 * - O3 https://developers.openai.com/plugins/deploy/submission: the manifest
 *   shape, `test_credentials` and `reviewer_instructions` refused in the ZIP,
 *   five positive and three negative test cases, `[]` countries meaning no
 *   restriction, `demo_recording_url` required for MCP review.
 * - O4 https://developers.openai.com/plugins/deploy/submission-errors: the
 *   field limits at final submission, categories, URL rules, brand color
 *   contrast, image and archive limits, screenshots only with a UI template.
 * - O10 https://developers.openai.com/plugins/build/plugins: the folder
 *   layout, `./` relative asset paths, `apps` and `hooks` under
 *   `extensions["com.openai"]`.
 */

export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** The MCP URL, permanently, path included (founder decision 9). */
export const MCP_URL = "https://curvi.ai/api/mcp";

/** Field limits at final submission (O4), in characters. */
export const LIMITS = {
  name: 64,
  version: 64,
  rootDescription: 1_024,
  authorName: 120,
  authorEmail: 320,
  displayName: 30,
  shortDescription: 30,
  longDescription: 4_000,
  developerName: 80,
  capabilityCount: 20,
  capability: 120,
  promptCount: 3,
  prompt: 128,
  url: 1_024,
} as const;

/** Test cases a remote MCP submission carries (O3, O4). */
export const TEST_CASES = { positive: 5, negative: 3 } as const;

/** Directory categories (O4). */
export const CATEGORIES = [
  "Productivity",
  "Creativity",
  "Developer Tools",
  "Business & Operations",
  "Data & Analytics",
  "Communication",
  "Education & Research",
  "Security",
  "Finance",
  "Healthcare",
  "Travel",
  "Entertainment",
  "Other",
] as const;

/** Brand colors need at least 2:1 contrast against these (O4). */
export const BRAND_CONTRAST = { minimum: 2, light: "#ffffff", dark: "#212121" } as const;

/** Logo and composer icon (O4): square, 48 to 4,096 px, at most 5 MiB. */
export const ASSET_LIMITS = {
  extensions: [".png", ".jpg", ".jpeg", ".webp", ".svg"],
  maxBytes: 5 * 1024 * 1024,
  minPx: 48,
  maxPx: 4_096,
} as const;

/** Screenshot dimensions from submission-errors, checked 2026-10-02.
 * The 5 MiB file bound is Curvi's local package policy, not a portal claim. */
export const SCREENSHOT_LIMITS = { width: 706, minHeight: 400, maxHeight: 860, maxBytes: 5 * 1024 * 1024 } as const;

/** Archive limits (O4). */
export const ARCHIVE_LIMITS = {
  maxCompressedBytes: 100 * 1000 * 1000,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxEntries: 5_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxPathSegments: 20,
} as const;

/** Keys the ZIP may not carry: reviewer access goes in the dashboard (O3). */
export const FORBIDDEN_KEYS = ["test_credentials", "reviewer_instructions"] as const;

/**
 * Words no listing field may use (R16, O6: listings may not advertise
 * pricing, subscriptions, free trials, discounts or promotions), beside the
 * MCP word list (apps/web/src/lib/api-v1/mcp-copy.ts).
 */
export const LISTING_PRICE_WORDS = ["credit", "free", "price", "trial", "discount"] as const;

/** Words a display name may not add to the product name (O6). */
export const NAME_SUFFIX_WORDS = ["mcp", "plugin"] as const;

/** The placeholder the developer name holds until the founder's identity
 * verification gives the real one (decision 8, runbook A4). */
export const DEVELOPER_NAME_PLACEHOLDER = "SET TO THE VERIFIED DEVELOPER NAME";
