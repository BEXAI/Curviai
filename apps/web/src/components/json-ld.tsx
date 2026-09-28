import { serializeJsonLd } from "@/lib/seo";

/** Structured data for search and answer engines. Rendered on the server. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
