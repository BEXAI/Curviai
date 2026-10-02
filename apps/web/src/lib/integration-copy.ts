import type { IntegrationView } from "@/lib/services/types";

/**
 * What the settings page says about an integration that is not connected,
 * shared by the database and demo services so both say the same thing.
 *
 * Shopify (docs/phases/PHASE_20.md P20-08): the app is on the way, so the
 * row sells nothing that does not run and points to help. It links to /help
 * until P20-26 ships the article on Shopify uploads.
 */
export const SHOPIFY_NOT_CONNECTED: Pick<IntegrationView, "detail" | "link"> = {
  detail: "The Shopify app is on the way. Your packs already use Shopify ready file names.",
  link: { href: "/help/upload-images-to-shopify", label: "How to upload your files" },
};

export const AMAZON_NOT_CONNECTED: Pick<IntegrationView, "detail" | "link"> = {
  detail: "Amazon publishing arrives after launch. Packs download to convention names today.",
};
