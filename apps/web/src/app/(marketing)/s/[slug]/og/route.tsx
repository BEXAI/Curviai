/**
 * GET /s/[slug]/og
 * The social card of a published share page: the original photo and the
 * result side by side (or the result alone), under the product title. The
 * images go through the same metadata free re-encode as the page, at card
 * size, so nothing from the seller's file reaches a link preview.
 */

import { ImageResponse } from "next/og";
import { NextResponse } from "next/server";
import { shareImageJpeg } from "@curvi/pipeline/share-image";
import { isR2Configured } from "@/lib/env";
import { getObjectBytes } from "@/lib/r2";
import { getShareStore } from "@/lib/shares";

export const dynamic = "force-dynamic";

const WIDTH = 1200;
const HEIGHT = 630;
const PANEL = 440;

async function panelDataUrl(slug: string, ref: string): Promise<string | null> {
  const key = await getShareStore().imageKey(slug, ref);
  const bytes = key ? await getObjectBytes(key) : null;
  if (!bytes) {
    return null;
  }
  try {
    return `data:image/jpeg;base64,${(await shareImageJpeg(bytes, PANEL)).toString("base64")}`;
  } catch {
    return null;
  }
}

function Panel({ src, label }: { src: string; label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div
        style={{
          display: "flex",
          width: PANEL,
          height: PANEL,
          borderRadius: 24,
          overflow: "hidden",
          backgroundColor: "#ffffff",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <img src={src} alt="" style={{ maxWidth: PANEL, maxHeight: PANEL, objectFit: "contain" }} />
      </div>
      <span style={{ marginTop: 14, fontSize: 26, color: "#aeb9cb" }}>{label}</span>
    </div>
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  const share = await getShareStore().getPublic(slug);
  if (!share?.after || share.illustration || !isR2Configured()) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const [before, after] = await Promise.all([
    share.before ? panelDataUrl(slug, share.before.ref) : Promise.resolve(null),
    panelDataUrl(slug, share.after.ref),
  ]);
  if (!after) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const title = share.title.length > 60 ? `${share.title.slice(0, 57).trimEnd()}...` : share.title;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#000000",
          backgroundImage:
            "radial-gradient(700px 420px at 90% 0%, rgba(236,72,153,0.22), transparent), radial-gradient(600px 400px at 0% 100%, rgba(45,212,191,0.18), transparent)",
        }}
      >
        <span style={{ fontSize: 34, fontWeight: 700, color: "#ffffff" }}>{title}</span>
        <div style={{ display: "flex", marginTop: 24 }}>
          {before ? <Panel src={before} label="Before" /> : null}
          {before ? <div style={{ display: "flex", width: 48 }} /> : null}
          <Panel src={after} label={before ? "After" : "Made with Curvi"} />
        </div>
        {before ? <span style={{ marginTop: 8, fontSize: 22, color: "#2dd4bf" }}>Made with Curvi</span> : null}
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: { "Cache-Control": "private, max-age=300" },
    },
  );
}
