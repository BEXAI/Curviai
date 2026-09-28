import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { OG_IMAGE } from "@/lib/seo";

export const alt = OG_IMAGE.alt;
export const size = { width: OG_IMAGE.width, height: OG_IMAGE.height };
export const contentType = "image/png";

/** The Curvi wordmark as a data URL. The card is rendered at build time from
 * apps/web, so the public folder is next to the working directory; the
 * monorepo root is tried too for builds started from there. */
async function logoDataUrl(): Promise<string> {
  const candidates = [
    join(process.cwd(), "public", "brand", "curvi-wordmark-lg.png"),
    join(process.cwd(), "apps", "web", "public", "brand", "curvi-wordmark-lg.png"),
  ];
  for (const file of candidates) {
    try {
      const bytes = await readFile(file);
      return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      // Try the next location.
    }
  }
  throw new Error("Curvi wordmark not found for the social card");
}

/** Social share card (Open Graph, Twitter and iMessage link previews): the
 * Curvi wordmark above the tagline, in the logo's teal and pink. */
export default async function OpenGraphImage() {
  const logo = await logoDataUrl();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "64px 80px",
          backgroundColor: "#000000",
          backgroundImage:
            "radial-gradient(700px 420px at 90% 0%, rgba(236,72,153,0.22), transparent), radial-gradient(600px 400px at 0% 100%, rgba(45,212,191,0.18), transparent)",
        }}
      >
        <img src={logo} width={648} height={200} alt="" />
        <div style={{ display: "flex", marginTop: 40 }}>
          <span style={{ fontSize: 64, fontWeight: 700, color: "#2dd4bf", textTransform: "uppercase" }}>Shot once.</span>
          <span style={{ fontSize: 64, fontWeight: 700, color: "#ec4899", textTransform: "uppercase", marginLeft: 24 }}>
            Ready everywhere.
          </span>
        </div>
        <span style={{ fontSize: 30, color: "#aeb9cb", marginTop: 24 }}>
          AI e-commerce images for Shopify and Amazon from one photo, product pixels untouched.
        </span>
      </div>
    ),
    size,
  );
}
