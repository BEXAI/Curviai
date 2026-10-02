import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { storeAudit } from "@curvi/pipeline/seed";
import { JsonLd } from "@/components/json-ld";
import { storeAuditCopy } from "@/components/marketing/search-copy";
import { StoreImageAudit } from "@/components/marketing/store-image-audit";
import { ToolPageShell } from "@/components/marketing/tool-page-shell";
import { breadcrumbJsonLd, jsonLdGraph, pageMetadata, webApplicationJsonLd } from "@/lib/seo";
import { STORE_AUDIT_PATH } from "@/lib/store-audit/paths";
import { storeAuditEnabled } from "@/lib/store-audit/switch";
import { checkerChannels } from "@/lib/tools/checker-rules";

// P18-18. Off until the store_audit_enabled switch is seeded true: the page
// answers 404 meanwhile, like the route.
export const dynamic = "force-dynamic";

function channelNames(): string[] {
  return checkerChannels().map((channel) => channel.name);
}

const seo = {
  title: "Free Shopify store image audit",
  description: `${storeAuditCopy.intro(channelNames())} See how many of your products would fail and which have too few images.`,
  path: STORE_AUDIT_PATH,
};

export const metadata: Metadata = pageMetadata(seo);

export default async function StoreImageAuditPage() {
  if (!(await storeAuditEnabled())) {
    notFound();
  }
  const channels = checkerChannels().map(({ key, name }) => ({ key, name }));
  return (
    <>
      <JsonLd
        data={jsonLdGraph([
          webApplicationJsonLd({ name: storeAuditCopy.title, path: seo.path, description: seo.description }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Store image audit", path: seo.path },
          ]),
        ])}
      />
      <ToolPageShell currentPath={STORE_AUDIT_PATH} title={storeAuditCopy.title} description={storeAuditCopy.intro(channelNames())}>
        <StoreImageAudit
          channels={channels}
          maxProducts={storeAudit.maxProducts}
          thinImageCount={storeAudit.thinImageCount}
        />
      </ToolPageShell>
    </>
  );
}
