export interface CategoryPage {
  slug: string;
  name: string;
  headline: string;
  intro: string;
  painPoints: string[];
  packContents: string[];
  proofLine: string;
}

export const categories: CategoryPage[] = [
  {
    slug: "apparel",
    name: "Apparel",
    headline: "Product photos for apparel brands, from one photo",
    intro:
      "Clothing listings live or die on clean main images and consistent lifestyle shots. Curvi takes one photo of your garment and returns a compliant white background main image, on model style lifestyle scenes and social crops, without repainting the fabric, the stitching or the print.",
    painPoints: [
      "Prints and logos warp when generic AI tools regenerate the whole image",
      "Amazon suppresses apparel listings with off white backgrounds",
      "Reshooting every colorway in a studio costs hundreds per SKU",
    ],
    packContents: [
      "Pure white main image sized for Amazon and Walmart",
      "Flat lay and hanger style secondary shots",
      "Square and portrait crops for Meta and Pinterest",
      "A short looping video for the listing gallery",
    ],
    proofLine: "Fabric texture and printed graphics stay pixel for pixel identical to your photo.",
  },
  {
    slug: "jewelry",
    name: "Jewelry",
    headline: "Jewelry photos that keep every facet honest",
    intro:
      "Jewelry is the hardest category to photograph and the easiest to ruin with AI. Curvi masks your piece and only rebuilds the background and lighting sweep, so stones, engravings and metal grain never change. You get a compliant main image plus editorial style scenes from a single phone photo.",
    painPoints: [
      "Generative tools invent extra prongs, links and reflections",
      "Tiny products fail the Amazon 85 percent fill rule by default",
      "Macro studio photography runs 50 dollars or more per piece",
    ],
    packContents: [
      "White background main image with the fill ratio corrected",
      "Soft shadow and velvet surface scene shots",
      "Close crop detail images for the gallery",
      "A slow rotation style video loop",
    ],
    proofLine: "We never regenerate product pixels, so a customer receives exactly what the photo shows.",
  },
  {
    slug: "beauty",
    name: "Beauty",
    headline: "Beauty and skincare packs with labels that never warp",
    intro:
      "Ingredient lists, claims and brand marks on beauty packaging are legally sensitive. Curvi keeps your real label pixels and builds the studio set around them, so the INCI list on the output matches the bottle in your hand. One photo becomes a full marketplace and social pack.",
    painPoints: [
      "AI rewrites label text into gibberish that can trigger takedowns",
      "Bathroom counter photos read as amateur next to studio competitors",
      "Seasonal campaign shots need new creative every month",
    ],
    packContents: [
      "Compliant white main image for Amazon and Google",
      "Bathroom shelf, stone slab and botanical scene shots",
      "Story and feed crops with safe zones respected",
      "A templated video with your brand colors",
    ],
    proofLine: "Label text is untouched because label pixels are never regenerated.",
  },
  {
    slug: "food",
    name: "Food",
    headline: "Food and beverage photos that stay true to the package",
    intro:
      "Nutrition panels and net weight statements must match the physical product. Curvi builds appetizing kitchen and tabletop scenes around your real package photo, keeping every panel readable, and delivers marketplace ready images plus social creative from one upload.",
    painPoints: [
      "Regenerated packaging misstates weights and ingredients",
      "Marketplace rules reject busy home kitchen backgrounds",
      "Food photographers book out weeks ahead of seasonal pushes",
    ],
    packContents: [
      "Pure white main image at marketplace resolution",
      "Kitchen counter and picnic table lifestyle scenes",
      "Ingredient flat lay style creative for social",
      "A short appetite appeal video",
    ],
    proofLine: "The package in the output is your package, down to the barcode.",
  },
  {
    slug: "electronics",
    name: "Electronics",
    headline: "Electronics listings with ports, buttons and logos intact",
    intro:
      "Electronics buyers zoom in on ports and controls before they buy. Curvi preserves your device pixels exactly and swaps only the environment, producing a compliant main image, desk and hand scale scenes, and channel sized crops from a single photo.",
    painPoints: [
      "AI tools hallucinate extra ports and misprint logos",
      "Certification marks must stay legible for compliance",
      "Renders from CAD look sterile and skip the real finish",
    ],
    packContents: [
      "White main image with correct fill for Amazon",
      "Desk setup and in hand scale scenes",
      "Detail crops of ports and controls",
      "A feature highlight templated video",
    ],
    proofLine: "Every port, button and printed mark comes straight from your photo.",
  },
  {
    slug: "home",
    name: "Home and kitchen",
    headline: "Home goods staged in rooms that sell the lifestyle",
    intro:
      "Home and kitchen products need context to sell, but the product itself must stay honest. Curvi places your real product photo into styled interior scenes, generates the compliant white main image, and sizes everything for each marketplace and ad channel.",
    painPoints: [
      "Staging a real room for one product shot is slow and expensive",
      "Scale is hard to judge without a scene around the product",
      "Each marketplace wants a different crop and file name",
    ],
    packContents: [
      "White background main image, correctly filled",
      "Living room, kitchen and shelf styled scenes",
      "Banner crops for Shopify hero sections",
      "A room reveal style video",
    ],
    proofLine: "The scene is generated. Your product inside it is not.",
  },
  {
    slug: "pet",
    name: "Pet supplies",
    headline: "Pet product packs without the studio wrangling",
    intro:
      "Pet products sell on warmth and trust. Curvi turns one photo of your toy, treat bag or accessory into a compliant main image plus cozy home scenes and playful social creative, while the packaging and product stay exactly as photographed.",
    painPoints: [
      "Live animal shoots are unpredictable and pricey",
      "Treat packaging carries feeding guidelines that must stay accurate",
      "Amazon suppresses listings when mains are not pure white",
    ],
    packContents: [
      "Pure white main image for marketplaces",
      "Living room floor and pet bed scene shots",
      "Bright social crops for Meta and TikTok Shop",
      "A short playful templated video",
    ],
    proofLine: "Feeding guides and safety text remain pixel identical to your upload.",
  },
  {
    slug: "sports",
    name: "Sports and outdoors",
    headline: "Gear photos that perform on every marketplace",
    intro:
      "Outdoor gear gets bought on durability signals, so materials and hardware must look real. Curvi keeps your gear pixels locked, builds trail, gym and field scenes around them, and exports the exact sizes and file names each channel expects.",
    painPoints: [
      "Location shoots for one product cost more than a month of software",
      "Technical fabrics look fake when AI repaints them",
      "Every channel wants different dimensions and naming",
    ],
    packContents: [
      "Compliant white main image",
      "Trail, gym and field lifestyle scenes",
      "Vertical story creative with safe zones",
      "A motion teaser video for ads",
    ],
    proofLine: "Stitching, straps and buckles are your real product, untouched.",
  },
];

export function categoryForSlug(slug: string): CategoryPage | undefined {
  return categories.find((c) => c.slug === slug);
}
