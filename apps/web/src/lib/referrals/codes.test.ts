import { describe, expect, it } from "vitest";
import { referralCodePolicy } from "@curvi/pipeline/seed";
import { readLandingParams } from "@/lib/attribution";
import { cleanReferralCode, generateReferralCode, referralLandingPath, referralLink } from "./codes";

// Invite codes (P18-24): the seeded length of lower case base32, which the
// ref landing parameter carries unchanged to signup.

describe("generateReferralCode", () => {
  it("makes the seeded number of lower case base32 characters", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(new RegExp(`^[a-z2-7]{${referralCodePolicy.length}}$`));
      expect(cleanReferralCode(code)).toBe(code);
    }
  });

  it("maps every byte value onto the alphabet evenly", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const code = generateReferralCode(256, () => bytes);
    const counts = new Map<string, number>();
    for (const char of code) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    expect(new Set(counts.values())).toEqual(new Set([8]));
  });
});

describe("invite links", () => {
  it("sends /r/<code> to the home page with the code and the referral tags, which signup links read back", () => {
    const path = referralLandingPath("abcd2345");
    expect(path).toBe("/?ref=abcd2345&utm_source=referral&utm_medium=referral");
    expect(readLandingParams(path)).toEqual({ ref: "abcd2345", utm_source: "referral", utm_medium: "referral" });
    expect(referralLink("https://curvi.ai/", "abcd2345")).toBe("https://curvi.ai/r/abcd2345");
  });

  it("cleans a code to the ref format and refuses anything else", () => {
    expect(cleanReferralCode(" ABCD2345 ")).toBe("abcd2345");
    for (const bad of ["ab", "abc/def", "<script>", "a".repeat(33), null, 7]) {
      expect(cleanReferralCode(bad)).toBeNull();
    }
  });
});
