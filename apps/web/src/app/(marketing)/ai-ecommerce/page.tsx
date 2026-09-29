import type { Metadata } from "next";
import { aiEcommercePage } from "@/components/marketing/pillar-copy";
import { PillarPageView, pillarMetadata } from "@/components/marketing/pillar-page";

export const metadata: Metadata = pillarMetadata(aiEcommercePage, ["AI e-commerce", "e-commerce", "AI for e-commerce", "AI products", "AI tools for product listings", "AI e-commerce image compiler"]);

export default function AiEcommercePage() {
  return <PillarPageView page={aiEcommercePage} />;
}
