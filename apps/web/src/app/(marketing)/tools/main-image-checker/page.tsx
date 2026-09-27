import type { Metadata } from "next";
import Link from "next/link";
import { MainImageChecker } from "@/components/marketing/main-image-checker";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";

export const metadata: Metadata = {
  title: "Free Amazon Main Image Checker",
  description:
    "Check your Amazon main image against the real rules in seconds: pure white background, 85 percent fill and minimum resolution. Runs in your browser, nothing is uploaded.",
};

export default function MainImageCheckerPage() {
  return (
    <ToolPageShell
      currentPath="/tools/main-image-checker"
      title="Amazon Main Image Checker"
      description="Drop in your current main image and get measured results against the rules that suppress listings: pure white background, product fill of at least 85 percent and a longest side of at least 1600 px. Everything runs in your browser."
    >
      <MainImageChecker />
      <p className="mt-6 text-sm text-ink-500">
        Want the rules themselves? Read the{" "}
        <Link href="/channels/amazon-main/image-requirements" className="font-medium text-ink-900 underline">
          Amazon main image requirements
        </Link>{" "}
        page for the full spec in plain language.
      </p>
    </ToolPageShell>
  );
}
