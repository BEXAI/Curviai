import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";
import { WhiteBackgroundFixer } from "@/components/marketing/white-background-fixer";
import { breadcrumbJsonLd, jsonLdGraph, pageMetadata, webApplicationJsonLd } from "@/lib/seo";

const seo = {
  title: "Free white background fixer for product photos",
  description:
    "Turn an off white product photo background into pure 255 white for Amazon and Shopify, right in your browser. Preview quality, free, no upload.",
  path: "/tools/white-background-fixer",
};

export const metadata: Metadata = pageMetadata(seo);

export default function WhiteBackgroundFixerPage() {
  return (
    <>
      <JsonLd
        data={jsonLdGraph([
          webApplicationJsonLd({ name: "White Background Fixer", path: seo.path, description: seo.description }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "White background fixer", path: seo.path },
          ]),
        ])}
      />
      <ToolPageShell
        currentPath="/tools/white-background-fixer"
        title="White Background Fixer"
        description="Marketplaces want pure white, RGB 255 255 255, not the light gray your camera produces. This tool whitens the background with a simple threshold so you can see the difference. It is preview quality. The full pipeline in the app masks your product first so edges and labels stay perfect."
      >
        <WhiteBackgroundFixer />
      </ToolPageShell>
    </>
  );
}
