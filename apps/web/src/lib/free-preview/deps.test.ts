import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FreePreviewBox } from "@/components/marketing/free-preview-box";
import { freePreviewOn } from "./copy";
import { claimSignupPreview, freePreviewDepsOrNull } from "./deps";

// The free preview ships switched off (docs/phases/PHASE_18.md P18-12):
// without NEXT_PUBLIC_FREE_PREVIEW=1 and its services nothing renders, the
// routes get no deps and the auth callback claims nothing.

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("free preview switched off", () => {
  it("is off in a build without the flag", () => {
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "");
    expect(freePreviewOn()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "1");
    expect(freePreviewOn()).toBe(true);
  });

  it("renders no box on the home page until the server says previews are open", () => {
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "");
    expect(renderToStaticMarkup(React.createElement(FreePreviewBox))).toBe("");
    // With the flag the first render still waits for GET /api/preview.
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "1");
    expect(renderToStaticMarkup(React.createElement(FreePreviewBox))).toBe("");
  });

  it("builds no deps, so no database or storage is touched, while not set up", () => {
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "1");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    expect(freePreviewDepsOrNull()).toBeNull();
  });

  it("claims nothing at signup without a preview id, the flag or a database", async () => {
    const user = "7e6d5c4b-3a29-4817-a6f5-e4d3c2b1a090";
    const preview = "3c1f0e2d-4b5a-4c6d-8e7f-90a1b2c3d4e5";
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "1");
    expect(await claimSignupPreview(undefined, user)).toBeNull();
    expect(await claimSignupPreview(preview, null)).toBeNull();
    vi.stubEnv("DATABASE_URL", "");
    expect(await claimSignupPreview(preview, user)).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_FREE_PREVIEW", "");
    vi.stubEnv("DATABASE_URL", "postgres://localhost/curvi");
    expect(await claimSignupPreview(preview, user)).toBeNull();
  });
});
