import type { Metadata } from "next";
import { comparePhotoToolsPage } from "@/components/marketing/pillar-copy";
import { PillarPageView, pillarMetadata } from "@/components/marketing/pillar-page";

export const metadata: Metadata = pillarMetadata(comparePhotoToolsPage, ["Photoroom alternative", "Flair.ai alternative", "Claid.ai alternative", "Pebblely alternative", "AI product photo tools", "AI product photography tools", "Amazon main image white background AI"]);

export default function ComparePhotoToolsPage() {
  return <PillarPageView page={comparePhotoToolsPage} />;
}
