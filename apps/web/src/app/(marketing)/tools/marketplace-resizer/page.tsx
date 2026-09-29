import type { Metadata } from "next";
import { JsonLd } from "@/components/json-ld";
import { MarketplaceResizer } from "@/components/marketing/marketplace-resizer";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";
import { breadcrumbJsonLd, jsonLdGraph, pageMetadata, webApplicationJsonLd } from "@/lib/seo";

const seo = {
  title: "Free product image resizer for Shopify and Amazon",
  description:
    "Resize one product photo for Amazon, Shopify, Google, Meta and more, keeping its shape where each channel allows it and with the file names each marketplace expects. Free, in your browser.",
  path: "/tools/marketplace-resizer",
};

export const metadata: Metadata = pageMetadata(seo);

export default function MarketplaceResizerPage() {
  return (
    <>
      <JsonLd
        data={jsonLdGraph([
          webApplicationJsonLd({ name: "Marketplace Image Resizer", path: seo.path, description: seo.description }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Marketplace image resizer", path: seo.path },
          ]),
        ])}
      />
      <ToolPageShell
        currentPath="/tools/marketplace-resizer"
        title="Marketplace Resizer"
        description="Pick your channels and get one photo resized to each spec, with white space added only where a channel needs a set shape, exported as jpg with the file name each marketplace expects. Everything runs in your browser."
      >
        <MarketplaceResizer />
      </ToolPageShell>
    </>
  );
}
