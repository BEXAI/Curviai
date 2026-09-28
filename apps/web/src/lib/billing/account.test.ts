import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { members, subscriptions, workspaces, type MemberRole } from "@curvi/db/schema";
import { createTestDb, type TestDb } from "@curvi/db/testing";

// The past due banner in the app layout (money-dunning), read from a real
// Postgres (PGlite) with every migration applied.

const holder = vi.hoisted(() => ({ db: null as unknown, dbMode: true }));

vi.mock("@/lib/services", () => ({ isDbMode: () => holder.dbMode }));
vi.mock("@/lib/services/db", () => ({ getDb: () => holder.db }));

const { loadPastDueNotice } = await import("./account");

let client: Awaited<ReturnType<typeof createTestDb>>["client"];
let db: TestDb;
let counter = 0;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  holder.db = db;
});

afterAll(async () => {
  await client.close();
});

async function memberWithSubscription(
  status: string | null,
  role: MemberRole = "owner",
  tier = "growth",
): Promise<string> {
  counter += 1;
  const userId = `00000000-0000-4000-9000-${String(counter).padStart(12, "0")}`;
  const [workspace] = await db.insert(workspaces).values({ name: `Dunning ${counter}`, plan: tier }).returning();
  await db.insert(members).values({ workspaceId: workspace.id, userId, role });
  if (status) {
    await db.insert(subscriptions).values({
      workspaceId: workspace.id,
      provider: "stripe",
      externalId: `sub_dunning_${counter}`,
      tier,
      status,
    });
  }
  return userId;
}

describe("loadPastDueNotice", () => {
  it("tells the owner to update the card while a renewal is failing", async () => {
    const user = await memberWithSubscription("past_due");
    expect(await loadPastDueNotice(user)).toBe(
      "Stripe will try the card again over the next few days. Update the card to keep the Growth plan.",
    );
  });

  it("tells a client seat to ask the owner", async () => {
    const user = await memberWithSubscription("past_due", "client", "pro");
    expect(await loadPastDueNotice(user)).toContain("Ask the workspace owner to update the card to keep the Pro plan.");
  });

  it("explains that retries stopped once the subscription is unpaid", async () => {
    const user = await memberWithSubscription("unpaid");
    expect(await loadPastDueNotice(user)).toMatch(/^Stripe has stopped retrying\./);
  });

  it("shows nothing for a healthy, canceled or missing subscription", async () => {
    expect(await loadPastDueNotice(await memberWithSubscription("active"))).toBeNull();
    expect(await loadPastDueNotice(await memberWithSubscription("canceled"))).toBeNull();
    expect(await loadPastDueNotice(await memberWithSubscription(null))).toBeNull();
    expect(await loadPastDueNotice("00000000-0000-4000-9000-999999999999")).toBeNull();
  });

  it("shows nothing in demo mode and never throws when the read fails", async () => {
    const user = await memberWithSubscription("past_due");
    holder.dbMode = false;
    expect(await loadPastDueNotice(user)).toBeNull();
    holder.dbMode = true;

    const broken = vi.spyOn(console, "error").mockImplementation(() => undefined);
    holder.db = {
      query: {
        members: {
          findFirst: async () => {
            throw new Error("connection lost");
          },
        },
      },
    };
    expect(await loadPastDueNotice(user)).toBeNull();
    holder.db = db;
    broken.mockRestore();
  });
});
