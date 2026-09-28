import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/seo";

/** Web app manifest: the logo mark for Android home screens and installs. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME}.ai`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/brand/curvi-mark-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/curvi-mark-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
