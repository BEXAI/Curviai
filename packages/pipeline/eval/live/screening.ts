/**
 * The prohibited goods negatives for the live LLM eval (docs/phases/
 * PHASE_19.md P19-29): a nicotine vape, a pepper spray and a firework, drawn
 * at runtime like the rest of the golden set, each with the note a seller
 * would type. An intake recipe that asks for restrictedCategory must put each
 * in its seeded category (harness.ts ScreeningFixture); recipes that do not
 * ask never run them.
 */

import type { RestrictedGoodsKey } from "../../src/seed/restricted-goods";
import type { ScreeningFixture } from "./harness";
import { intakePayload } from "./cases";
import { jpegBlock, svgPhoto } from "./images";

/** The negatives' photos, PNG bytes, by name. */
export async function screeningPhotos(): Promise<Record<"vape" | "pepperSpray" | "firework", Buffer>> {
  return {
    vape: await svgPhoto(
      `<rect x="226" y="80" width="60" height="330" rx="22" fill="rgb(30,30,36)"/>
       <rect x="240" y="40" width="32" height="50" rx="10" fill="rgb(120,200,220)"/>
       <rect x="236" y="300" width="40" height="40" rx="6" fill="rgb(90,200,120)"/>
       <text x="256" y="200" font-size="22" text-anchor="middle" fill="white" font-family="sans-serif" transform="rotate(-90 256 200)">VAPE 5% NICOTINE</text>`,
    ),
    pepperSpray: await svgPhoto(
      `<rect x="206" y="150" width="100" height="280" rx="18" fill="rgb(200,30,40)"/>
       <rect x="226" y="100" width="60" height="56" rx="8" fill="rgb(30,30,30)"/>
       <rect x="276" y="112" width="34" height="14" fill="rgb(30,30,30)"/>
       <text x="256" y="270" font-size="26" text-anchor="middle" fill="white" font-family="sans-serif">PEPPER</text>
       <text x="256" y="304" font-size="26" text-anchor="middle" fill="white" font-family="sans-serif">SPRAY</text>`,
    ),
    firework: await svgPhoto(
      `<polygon points="256,60 296,140 216,140" fill="rgb(230,40,40)"/>
       <rect x="216" y="140" width="80" height="200" fill="rgb(250,190,30)"/>
       <rect x="252" y="340" width="8" height="140" fill="rgb(150,110,60)"/>
       <text x="256" y="250" font-size="20" text-anchor="middle" fill="rgb(40,40,40)" font-family="sans-serif">FIREWORK</text>`,
    ),
  };
}

export async function screeningFixtures(): Promise<ScreeningFixture[]> {
  const photos = await screeningPhotos();
  const cases: Array<[string, keyof typeof photos, string, string, RestrictedGoodsKey]> = [
    ["screen_vape", "vape", "Disposable nicotine vape pen, 5% nicotine, mint", "a disposable nicotine vape", "tobacco_nicotine"],
    ["screen_pepper_spray", "pepperSpray", "Pepper spray for self defense, keychain size", "a pepper spray canister", "self_defense_weapons"],
    ["screen_firework", "firework", "Firework rocket, pack of 12", "a firework rocket", "explosives_fireworks"],
  ];
  const fixtures: ScreeningFixture[] = [];
  for (const [id, photo, note, description, expectCategory] of cases) {
    fixtures.push({
      id,
      stage: "intake",
      description,
      blocks: [await jpegBlock(photos[photo])],
      payload: intakePayload(id, note),
      expectCategory,
    });
  }
  return fixtures;
}
