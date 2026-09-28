import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  actAs,
  actAsAnon,
  actAsAuthenticated,
  actAsServiceRole,
  actAsSuperuser,
  createAppUserRole,
  createTestDb,
  type TestDb,
} from "./test-helpers";
import { galleryItems, leads, shareLinks, workspaces } from "./schema";

// Migration 0016 (Phase 11, b2/growth): share pages tied to a job, one
// gallery entry per share, and the leads platform table.

const OWNER_A = "00000000-0000-4000-8000-0000000016a1";
const OWNER_B = "00000000-0000-4000-8000-0000000016b1";

let client: PGlite;
let db: TestDb;
let wsA: string;
let wsB: string;
let jobA: string;

beforeAll(async () => {
  const created = await createTestDb();
  client = created.client;
  db = created.db;
  await createAppUserRole(client);
  const [a] = await db.insert(workspaces).values({ name: "A" }).returning();
  const [b] = await db.insert(workspaces).values({ name: "B" }).returning();
  wsA = a.id;
  wsB = b.id;
  await client.query("insert into members (workspace_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [
    wsA,
    OWNER_A,
    wsB,
    OWNER_B,
  ]);
  const product = await client.query<{ id: string }>(
    "insert into products (workspace_id, title, mode) values ($1, 'Mug', 'listing') returning id",
    [wsA],
  );
  const job = await client.query<{ id: string }>(
    "insert into generation_jobs (workspace_id, product_id, status) values ($1, $2, 'done') returning id",
    [wsA, product.rows[0].id],
  );
  jobA = job.rows[0].id;
});

afterEach(async () => {
  await actAsSuperuser(client);
});

afterAll(async () => {
  await actAsSuperuser(client);
  await client.close();
});

describe("leads (platform table)", () => {
  it("has row level security on", async () => {
    const result = await client.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'leads' and relnamespace = 'public'::regnamespace",
    );
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  it("is invisible and unwritable to anon, signed in users and members", async () => {
    await db.insert(leads).values({ email: "seller@example.com", source: "main-image-checker" });
    for (const become of [
      () => actAsAnon(client),
      () => actAsAuthenticated(client, OWNER_A),
      () => actAs(client, OWNER_A),
    ]) {
      await become();
      const visible = await client
        .query("select * from leads")
        .then((r) => r.rows.length)
        .catch(() => 0);
      expect(visible).toBe(0);
      await expect(
        client.query("insert into leads (email, source) values ('spam@example.com', 'x')"),
      ).rejects.toThrow(/permission denied|row-level security/);
    }
  });

  it("keeps one row per email and lets the server bump it on a repeat visit", async () => {
    await actAsServiceRole(client);
    await client.query(
      `insert into leads (email, source) values ('repeat@example.com', 'white-background-fixer')
       on conflict (email) do update set hits = leads.hits + 1, last_source = excluded.source, last_seen_at = now()`,
    );
    await client.query(
      `insert into leads (email, source) values ('repeat@example.com', 'marketplace-resizer')
       on conflict (email) do update set hits = leads.hits + 1, last_source = excluded.source, last_seen_at = now()`,
    );
    const rows = await client.query<{ source: string; last_source: string; hits: number }>(
      "select source, last_source, hits from leads where email = 'repeat@example.com'",
    );
    expect(rows.rows).toEqual([{ source: "white-background-fixer", last_source: "marketplace-resizer", hits: 2 }]);
  });
});

describe("share_links after 0016", () => {
  it("never lists a public share link to anon, so unlisted slugs stay private", async () => {
    await db.insert(shareLinks).values({ slug: "unlisted1", workspaceId: wsA, jobId: jobA, isPublic: true });
    await actAsAnon(client);
    const rows = await client.query("select slug from share_links");
    expect(rows.rows).toHaveLength(0);
  });

  it("shows members their own share links only, and still denies member writes", async () => {
    await actAs(client, OWNER_A);
    const own = await db.select().from(shareLinks);
    expect(own.map((row) => row.slug)).toContain("unlisted1");
    await actAs(client, OWNER_B);
    const other = await db.select().from(shareLinks);
    expect(other).toHaveLength(0);
    await expect(
      client.query("insert into share_links (slug, workspace_id, public) values ('mine', $1, true)", [wsB]),
    ).rejects.toThrow(/row-level security/);
  });

  it("allows one share link per job and defaults to a before and after", async () => {
    await expect(
      client.query("insert into share_links (slug, workspace_id, job_id) values ('second1', $1, $2)", [wsA, jobA]),
    ).rejects.toThrow(/share_links_job_id_uq/);
    const [row] = await db.select().from(shareLinks);
    expect(row.kind).toBe("before_after");
  });

  it("allows one gallery entry per share link", async () => {
    await db.insert(galleryItems).values({ workspaceId: wsA, shareSlug: "unlisted1", consentAt: new Date() });
    await expect(
      client.query("insert into gallery_items (workspace_id, share_slug, consent_at) values ($1, 'unlisted1', now())", [
        wsA,
      ]),
    ).rejects.toThrow(/gallery_items_share_slug_uq/);
  });

  it("removes the share link when its job is deleted", async () => {
    await client.query("delete from generation_jobs where id = $1", [jobA]);
    const rows = await client.query("select slug from share_links where slug = 'unlisted1'");
    expect(rows.rows).toHaveLength(0);
    const gallery = await client.query<{ share_slug: string | null }>("select share_slug from gallery_items");
    expect(gallery.rows.every((row) => row.share_slug === null)).toBe(true);
  });
});
