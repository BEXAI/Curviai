/**
 * OpenAI's prohibited goods, as Curvi screens assistant requests for them
 * (docs/phases/PHASE_19.md, P19-29 and founder decision 16). Plugins "may not
 * be used to sell, promote, facilitate, or meaningfully enable" these goods
 * (OpenAI plugin guidelines, O6, fetched 2026-10-01, docs/verification.md
 * "P19-29"). Making listing images of them from ChatGPT or Codex is a review
 * risk, so a pack an assistant starts for one of them stops at intake with
 * nothing charged. The web app keeps today's behavior.
 *
 * Only the categories a product photo can show are here. The services and
 * digital goods on the same list (pornography and live cam services,
 * gambling, malware and stalkerware, financial fraud and piracy tools) are
 * not physical products, and counterfeit, stolen or replica goods cannot be
 * judged from a photo (brands never set a flag, PHASE_14), so they are left
 * out. Each description uses OpenAI's own examples where it gives them
 * (wildlife contraband has none, so ivory is ours), and the intake prompt
 * (seed/recipes.ts, intake version 8) lists them word for word.
 *
 * Rule 2: the list lives in the seed; the prompt, the intake answer schema
 * and the runner all read it from here.
 */

export const restrictedGoods = [
  {
    key: "tobacco_nicotine",
    description: "tobacco products, or nicotine products such as vapes, e-liquids and nicotine pouches",
  },
  {
    key: "adult_products",
    description: "sex toys, sex dolls, BDSM gear or fetish products",
  },
  {
    key: "cannabis_drugs",
    description:
      "marijuana or THC products, psilocybin, illegal substances, or CBD products over the legal THC limit",
  },
  {
    key: "drug_paraphernalia",
    description: "bongs, dab rigs, drug use scales, or cannabis grow equipment marketed for drugs",
  },
  {
    key: "prescription_drugs",
    description:
      "prescription only drugs (for example insulin, antibiotics, Ozempic or opioids) or age restricted prescription products (for example testosterone, HGH or fertility hormones)",
  },
  {
    key: "firearms",
    description: "firearms, ammunition or firearm parts",
  },
  {
    key: "explosives_fireworks",
    description: "explosives, fireworks or bomb making materials",
  },
  {
    key: "restricted_weapons",
    description: "illegal or age restricted weapons such as switchblades, brass knuckles or crossbows",
  },
  {
    key: "self_defense_weapons",
    description: "self defense weapons such as pepper spray, stun guns or tasers",
  },
  {
    key: "covert_surveillance",
    description: "covert surveillance devices such as spy cameras, IMSI catchers or hidden trackers",
  },
  {
    key: "extremist_merchandise",
    description: "extremist merchandise or propaganda",
  },
  {
    key: "wildlife_contraband",
    description: "wildlife or environmental contraband, such as ivory or parts of protected animals",
  },
] as const;

export type RestrictedGoodsKey = (typeof restrictedGoods)[number]["key"];

/** Every category key, for the intake answer's enum. */
export const RESTRICTED_GOODS_KEYS = restrictedGoods.map((good) => good.key) as unknown as readonly [
  RestrictedGoodsKey,
  ...RestrictedGoodsKey[],
];

/** True for a seeded category key. */
export function isRestrictedGoodsKey(value: unknown): value is RestrictedGoodsKey {
  return typeof value === "string" && restrictedGoods.some((good) => good.key === value);
}
