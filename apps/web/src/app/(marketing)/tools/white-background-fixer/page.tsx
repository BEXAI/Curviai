import type { Metadata } from "next";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";
import { WhiteBackgroundFixer } from "@/components/marketing/white-background-fixer";

export const metadata: Metadata = {
  title: "Free White Background Fixer",
  description:
    "Turn an off white product photo background into pure 255 white, right in your browser. Preview quality, free, no upload.",
};

export default function WhiteBackgroundFixerPage() {
  return (
    <ToolPageShell
      currentPath="/tools/white-background-fixer"
      title="White Background Fixer"
      description="Marketplaces want pure white, RGB 255 255 255, not the light gray your camera produces. This tool whitens the background with a simple threshold so you can see the difference. It is preview quality. The full pipeline in the app masks your product first so edges and labels stay perfect."
    >
      <WhiteBackgroundFixer />
    </ToolPageShell>
  );
}
