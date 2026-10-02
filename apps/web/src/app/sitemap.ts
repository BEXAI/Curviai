import { liveHelpArticles } from "@/components/marketing/help-articles";
import type { MetadataRoute } from "next";
import { categories } from "@/components/marketing/categories";
import { pillarPages } from "@/components/marketing/pillar-copy";
import { imageSpecs, specSlug } from "@/components/marketing/spec-slug";
import { getShareStore } from "@/lib/shares";
import { gallerySitemapRows } from "@/lib/shares/sitemap";

const BASE_URL = "https://curvi.ai";

// Gallery share pages join the sitemap as owners list them (P18-14), so it
// is built per request from a per process cache (lib/shares/sitemap.ts)
// instead of once at build time, when no database is reachable.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE_URL}/pricing`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE_URL}/tools/main-image-checker`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/tools/white-background-fixer`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/tools/marketplace-resizer`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/gallery`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE_URL}/help`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE_URL}/support`, changeFrequency: "yearly", priority: 0.4 },
    { url: `${BASE_URL}/signup`, changeFrequency: "yearly", priority: 0.5 },
    { url: `${BASE_URL}/login`, changeFrequency: "yearly", priority: 0.3 },
  ];

  const guideRoutes: MetadataRoute.Sitemap = pillarPages.map((page) => ({
    url: `${BASE_URL}${page.path}`,
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  const channelRoutes: MetadataRoute.Sitemap = imageSpecs().map((spec) => ({
    url: `${BASE_URL}/channels/${specSlug(spec.id)}/image-requirements`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const categoryRoutes: MetadataRoute.Sitemap = categories.map((category) => ({
    url: `${BASE_URL}/for/${category.slug}`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  // Only gallery listed, real share pages; never one shared by link only.
  const shareRoutes = await gallerySitemapRows(BASE_URL, (limit) => getShareStore().listGallery(limit));

  const helpRoutes: MetadataRoute.Sitemap = liveHelpArticles().map((article) => ({ url: `${BASE_URL}/help/${article.slug}`, changeFrequency: "monthly", priority: 0.5 }));
  staticRoutes.push({ url: `${BASE_URL}/status`, changeFrequency: "daily", priority: 0.4 }, { url: `${BASE_URL}/changelog`, changeFrequency: "weekly", priority: 0.4 });
  return [...helpRoutes, ...staticRoutes, ...guideRoutes, ...channelRoutes, ...categoryRoutes, ...shareRoutes];
}
