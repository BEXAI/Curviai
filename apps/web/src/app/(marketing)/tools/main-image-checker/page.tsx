import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import { MainImageChecker } from "@/components/marketing/main-image-checker";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";
import { amazonMainRules } from "@/lib/marketing-facts";
import { breadcrumbJsonLd, jsonLdGraph, pageMetadata, webApplicationJsonLd } from "@/lib/seo";

// Thresholds come from the amazon.main spec in the registry (CLAUDE.md rule 2).
const rules = amazonMainRules();

const seo = {
  title: "Free Amazon main image checker for sellers",
  description: `Check your Amazon main image against the real rules in seconds: pure white background, ${rules.fillMinPercent} percent fill and resolution. Free, runs in your browser, no upload.`,
  path: "/tools/main-image-checker",
};

export const metadata: Metadata = pageMetadata(seo);

export default function MainImageCheckerPage() {
  return (
    <>
      <JsonLd
        data={jsonLdGraph([
          webApplicationJsonLd({ name: "Amazon Main Image Checker", path: seo.path, description: seo.description }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Amazon main image checker", path: seo.path },
          ]),
        ])}
      />
      <ToolPageShell
        currentPath="/tools/main-image-checker"
        title="Amazon Main Image Checker"
        description={`Drop in your current main image and get measured results against the rules that suppress listings: pure white background, product fill of at least ${rules.fillMinPercent} percent and a longest side of at least ${rules.minLongSide} px. Everything runs in your browser.`}
      >
        <MainImageChecker rules={{ minLongSide: rules.minLongSide, fillMinPercent: rules.fillMinPercent }} />
        <p className="mt-6 text-sm text-ink-500">
          Want the rules themselves? Read the{" "}
          <Link href="/channels/amazon-main/image-requirements" className="font-medium text-ink-900 underline">
            Amazon main image requirements
          </Link>{" "}
          page for the full spec in plain language.
        </p>
      </ToolPageShell>
    </>
  );
}
