import type { Metadata } from "next";
import { aiProductImagesPage } from "@/components/marketing/pillar-copy";
import { PillarPageView, pillarMetadata } from "@/components/marketing/pillar-page";

export const metadata: Metadata = pillarMetadata(aiProductImagesPage, ["AI product images", "AI product photos", "AI product photography", "AI images for online stores", "AI e-commerce images", "AI product images for Amazon", "AI images for Shopify"]);

export default function AiProductImagesPage() {
  return <PillarPageView page={aiProductImagesPage} />;
}
