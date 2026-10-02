import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "@/components/json-ld";
import {
  CheckerChannelProvider,
  CheckerIntro,
  CheckerRulesLink,
  CheckerTitle,
  MainImageChecker,
} from "@/components/marketing/main-image-checker";
import { orList, storeAuditCopy } from "@/components/marketing/search-copy";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";
import { STORE_AUDIT_PATH } from "@/lib/store-audit/paths";
import { storeAuditEnabled } from "@/lib/store-audit/switch";
import { MAIN_IMAGE_CHECKER_PATH, checkerChannelFor, checkerChannels, defaultCheckerChannel } from "@/lib/tools/checker-rules";
import { breadcrumbJsonLd, jsonLdGraph, pageMetadata, webApplicationJsonLd } from "@/lib/seo";

// Every threshold comes from the picked channel's spec in the registry
// (CLAUDE.md rule 2, lib/tools/checker-rules.ts). Amazon is the default;
// ?channel=<key> presets another (P18-10). The page canonicalizes to the
// plain path: the channel requirement pages are the per channel landings.
const amazon = defaultCheckerChannel();
const others = checkerChannels()
  .filter((channel) => channel.key !== amazon.key)
  .map((channel) => channel.name);

const seo = {
  title: "Free Amazon and marketplace main image checker",
  description: `Check your main image against Amazon's real rules in seconds: white background, ${amazon.rules.fillMinPercent} to ${amazon.rules.fillMaxPercent} percent fill and resolution${others.length > 0 ? `, or pick ${orList(others)}` : ""}. Free, in your browser, no upload.`,
  path: MAIN_IMAGE_CHECKER_PATH,
};

export const metadata: Metadata = pageMetadata(seo);

export default async function MainImageCheckerPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string | string[] }>;
}) {
  const { channel: raw } = await searchParams;
  const initial = checkerChannelFor(Array.isArray(raw) ? raw[0] : raw);
  // P18-18: the store audit is linked only while its switch is on.
  const storeAuditOn = await storeAuditEnabled();
  const channels = checkerChannels().map(({ key, name, requirementsPath, rules }) => ({
    key,
    name,
    requirementsPath,
    rules,
  }));

  return (
    <>
      <JsonLd
        data={jsonLdGraph([
          webApplicationJsonLd({ name: "Main Image Checker", path: seo.path, description: seo.description }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Main image checker", path: seo.path },
          ]),
        ])}
      />
      <CheckerChannelProvider channels={channels} initialKey={initial.key}>
        <ToolPageShell currentPath={MAIN_IMAGE_CHECKER_PATH} title={<CheckerTitle />} description={<CheckerIntro />}>
          <MainImageChecker />
          <CheckerRulesLink />
          {storeAuditOn ? (
            <p data-testid="checker-store-audit" className="mt-3 text-sm text-ink-500">
              {storeAuditCopy.fromCheckerLead}{" "}
              <Link href={STORE_AUDIT_PATH} className="font-medium text-ink-900 underline">
                {storeAuditCopy.fromCheckerLink}
              </Link>
              .
            </p>
          ) : null}
        </ToolPageShell>
      </CheckerChannelProvider>
    </>
  );
}
