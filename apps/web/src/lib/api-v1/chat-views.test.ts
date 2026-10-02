import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CHAT_VIEWS, CHAT_VIEW_FIELDS, PackChat, ProfileChat, chatViewFields } from "./chat-views";

// The chat views (PHASE_19 P19-02 shapes, P19-14 builders): only what the
// seller asked about, and a field list for the privacy policy (P19-23).

describe("chat views", () => {
  it("lists every field, nested ones included", () => {
    expect(chatViewFields(PackChat)).toEqual(
      expect.arrayContaining(["pack_id", "credits", "credits.held", "images", "images[].preview_url", "images[].download_url"]),
    );
    expect(CHAT_VIEW_FIELDS).toEqual(expect.arrayContaining(["quote", "left_out[].reason", "scene_styles[].label", "email"]));
    expect([...CHAT_VIEW_FIELDS]).toEqual([...new Set(CHAT_VIEW_FIELDS)].sort());
  });

  it("carries none of the fields the REST pack body keeps to itself", () => {
    for (const dropped of ["createdAt", "productId", "shots", "links", "background", "upgradeTo", "availability", "id"]) {
      expect(chatViewFields(PackChat), dropped).not.toContain(dropped);
    }
    expect(CHAT_VIEW_FIELDS.some((field) => /created|timestamp|session|trace|request_id/i.test(field))).toBe(false);
  });

  it("makes output schemas with no extra properties, and a profile whose id is required", () => {
    for (const [name, view] of Object.entries(CHAT_VIEWS)) {
      const schema = z.toJSONSchema(view, { io: "output", target: "draft-2020-12" }) as Record<string, unknown>;
      expect(schema.type, name).toBe("object");
      expect(schema.additionalProperties, name).toBe(false);
    }
    expect(ProfileChat.safeParse({ id: "" }).success).toBe(false);
    expect(ProfileChat.safeParse({ id: "p1", name: "Shop", email: "a@b.co" }).success).toBe(true);
    expect(ProfileChat.safeParse({ id: "p1", user_id: "u" }).success).toBe(false);
  });
});
