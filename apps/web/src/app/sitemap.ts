import type { MetadataRoute } from "next";
import { categories } from "@/components/marketing/categories";
import { imageSpecs, specSlug } from "@/components/marketing/spec-slug";

const BASE_URL = "https://curvi.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE_URL}/pricing`, changeFrequency: "monthly", priority: 0.9 },
    { url: `${BASE_URL}/tools/main-image-checker`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/tools/white-background-fixer`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/tools/marketplace-resizer`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${BASE_URL}/gallery`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE_URL}/help`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${BASE_URL}/signup`, changeFrequency: "yearly", priority: 0.5 },
    { url: `${BASE_URL}/login`, changeFrequency: "yearly", priority: 0.3 },
  ];

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

  return [...staticRoutes, ...channelRoutes, ...categoryRoutes];
}
