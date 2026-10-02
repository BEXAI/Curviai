import { describe, expect, it } from "vitest";
import { SigningKeyConfigError, parseSigningKeys, signPayload, verifyPayload } from "./mcp-signing";

// The MCP_LINK_KEYS ring shared by link tokens (P19-17) and quotes (P19-16).

const OLD = `k1:${"a".repeat(32)}`;
const NEW = `k2:${"b".repeat(40)}`;

describe("parseSigningKeys", () => {
  it("reads kid:secret pairs newest first, and nothing when unset", () => {
    expect(parseSigningKeys(undefined)).toBeNull();
    expect(parseSigningKeys("  ")).toBeNull();
    expect(parseSigningKeys(`${NEW}, ${OLD}`)?.map((key) => key.kid)).toEqual(["k2", "k1"]);
  });

  it("refuses malformed pairs, short secrets and repeated kids without echoing a secret", () => {
    for (const raw of ["nocolon", `:${"a".repeat(32)}`, "k1:short", `${OLD},${OLD}`, `bad kid:${"a".repeat(32)}`]) {
      let error: unknown;
      try {
        parseSigningKeys(raw);
      } catch (err) {
        error = err;
      }
      expect(error, raw).toBeInstanceOf(SigningKeyConfigError);
      expect((error as Error).message).not.toContain("a".repeat(32));
    }
  });
});

describe("signPayload and verifyPayload", () => {
  it("signs with the newest key, verifies with any key in the ring, and keeps purposes apart", () => {
    const rotated = parseSigningKeys(`${NEW},${OLD}`)!;
    const before = parseSigningKeys(OLD)!;
    const signed = signPayload(before, "link", "job:1|file:2");
    expect(signed.kid).toBe("k1");
    expect(verifyPayload(rotated, "link", signed.kid, "job:1|file:2", signed.signature)).toBe(true);
    expect(signPayload(rotated, "link", "x").kid).toBe("k2");

    expect(verifyPayload(rotated, "quote", signed.kid, "job:1|file:2", signed.signature)).toBe(false);
    expect(verifyPayload(rotated, "link", signed.kid, "job:1|file:3", signed.signature)).toBe(false);
    expect(verifyPayload(rotated, "link", "k9", "job:1|file:2", signed.signature)).toBe(false);
    expect(verifyPayload(rotated, "link", signed.kid, "job:1|file:2", `${signed.signature}AA`)).toBe(false);
    expect(verifyPayload(parseSigningKeys(NEW)!, "link", signed.kid, "job:1|file:2", signed.signature)).toBe(false);
  });
});
