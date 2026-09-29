import type { Metadata } from "next";
import { compareGeneratorsPage } from "@/components/marketing/pillar-copy";
import { PillarPageView, pillarMetadata } from "@/components/marketing/pillar-page";

export const metadata: Metadata = pillarMetadata(compareGeneratorsPage, ["Curvi vs Midjourney", "Midjourney product photos", "DALL-E product photos", "Flux product photos", "Stable Diffusion product photos", "AI image generator for products", "AI product photo that does not change my product"]);

export default function CompareGeneratorsPage() {
  return <PillarPageView page={compareGeneratorsPage} />;
}
