import { ImageResponse } from "next/og";
import { OG_IMAGE } from "@/lib/seo";

export const alt = OG_IMAGE.alt;
export const size = { width: OG_IMAGE.width, height: OG_IMAGE.height };
export const contentType = "image/png";

/** Social share card matching the dark cinematic marketing theme. */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#0b0d14",
          backgroundImage: "radial-gradient(800px 400px at 80% 0%, rgba(253,127,17,0.25), transparent)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline" }}>
          <span style={{ fontSize: 72, fontWeight: 700, color: "#ffffff" }}>Curvi</span>
          <div
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              marginLeft: 8,
              backgroundColor: "#fd7f11",
            }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", marginTop: 48 }}>
          <span style={{ fontSize: 96, fontWeight: 700, color: "#ffffff", textTransform: "uppercase" }}>
            Shot once.
          </span>
          <span style={{ fontSize: 96, fontWeight: 700, color: "#fd7f11", textTransform: "uppercase" }}>
            Ready everywhere.
          </span>
        </div>
        <span style={{ fontSize: 32, color: "#aeb9cb", marginTop: 40 }}>
          AI e-commerce images for Shopify and Amazon from one photo, product pixels untouched.
        </span>
      </div>
    ),
    size,
  );
}
