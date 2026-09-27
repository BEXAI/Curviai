import type { Metadata } from "next";
import { MarketplaceResizer } from "@/components/marketing/marketplace-resizer";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";

export const metadata: Metadata = {
  title: "Free Marketplace Image Resizer",
  description:
    "Resize one product photo for Amazon, Shopify, Google, Meta and more, with white padding and correct file names. Free and fully in your browser.",
};

export default function MarketplaceResizerPage() {
  return (
    <ToolPageShell
      currentPath="/tools/marketplace-resizer"
      title="Marketplace Resizer"
      description="Pick your channels and get one photo resized to each spec with clean white padding, exported as jpg with the file name each marketplace expects. Everything runs in your browser."
    >
      <MarketplaceResizer />
    </ToolPageShell>
  );
}
