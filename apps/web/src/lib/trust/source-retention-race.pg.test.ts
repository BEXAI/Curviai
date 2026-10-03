import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, generationJobs, sql, type Db } from "@curvi/db";
import { createRaceDatabase, type RaceDatabase } from "@curvi/db/race";
import { assertRegisteredSources, assertSourceKeysAvailable, SourceUnavailableError } from "./source-retention";
import { purgeStaleSourceMedia } from "./purge";
import { MemoryTrustStorage } from "./storage";

const url = process.env.TEST_DATABASE_URL;
const now = new Date();
const old = new Date(now.getTime() - 60 * 86400000);
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!url)("source retention coordination on real Postgres", () => {
  let race: RaceDatabase, db: Db;
  beforeAll(async () => { race = await createRaceDatabase(url!, 5); db = createDb(race.url, { max: 5 }); }, 120_000);
  afterAll(async () => { await (db as unknown as { $client?: { end(): Promise<void> } } | undefined)?.$client?.end(); await race?.drop(); });
  async function fixture() {
    const [workspace] = await race.sql<{ id: string }[]>`insert into workspaces(name) values('Purge race') returning id`;
    const ws = workspace!.id;
    const [product] = await race.sql<{ id: string }[]>`insert into products(workspace_id,title,mode) values(${ws},'Mug','listing') returning id`;
    const key = `ws/${ws}/src/photo`;
    await race.sql`insert into source_media(workspace_id,product_id,r2_key,kind,sha256,created_at) values(${ws},${product!.id},${key},'image',${"a".repeat(64)},${old})`;
    const storage = new MemoryTrustStorage(); storage.seed(key, Buffer.from("photo"), old);
    return { ws, productId: product!.id, key, storage };
  }

  it("waits for the reference writer's workspace lock and rechecks the stale candidate after its commit", async () => {
    const f = await fixture(), locked = signal(), release = signal(), purgeAttemptedLock = signal();
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from workspaces where id=${f.ws}::uuid for update`);
      await assertRegisteredSources(tx, f.ws, f.productId, [f.key]);
      locked.resolve(); await release.promise;
      await tx.insert(generationJobs).values({ workspaceId: f.ws, productId: f.productId, status: "queued" });
    });
    await locked.promise;
    const observed = new Proxy(db, { get(target, prop, receiver) {
      if (prop === "transaction") return (callback: Parameters<Db["transaction"]>[0]) => target.transaction((tx) => callback(new Proxy(tx, { get(transaction, name, proxy) {
        if (name === "execute") return (query: Parameters<typeof tx.execute>[0]) => { purgeAttemptedLock.resolve(); return transaction.execute(query); };
        return Reflect.get(transaction, name, proxy);
      } })));
      return Reflect.get(target, prop, receiver);
    } });
    const purge = purgeStaleSourceMedia({ db: observed, storage: f.storage, now, maxOrphanObjects: 0 });
    try { await purgeAttemptedLock.promise; } finally { release.resolve(); }
    await writer; const report = await purge;
    expect(report.rowsMatched).toBeGreaterThan(0);
    expect(f.storage.objects.has(f.key)).toBe(true);
    expect(await race.sql`select r2_key from retired_source_objects where workspace_id=${f.ws}`).toHaveLength(0);
    expect(await race.sql`select id from source_media where workspace_id=${f.ws}`).toHaveLength(1);
  });

  it("commits retirement before an ambiguous remote delete and refuses references while the object still exists", async () => {
    const f = await fixture(), deleting = signal(), finishDelete = signal();
    const remove = f.storage.deleteMany.bind(f.storage);
    f.storage.deleteMany = async (keys) => { deleting.resolve(); await finishDelete.promise; return remove(keys); };
    const purge = purgeStaleSourceMedia({ db, storage: f.storage, now, maxOrphanObjects: 0 });
    await deleting.promise;
    try {
      expect(f.storage.objects.has(f.key)).toBe(true);
      expect(await race.sql`select r2_key from retired_source_objects where workspace_id=${f.ws}`).toHaveLength(1);
      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from workspaces where id=${f.ws}::uuid for update`);
        await assertRegisteredSources(tx, f.ws, f.productId, [f.key]);
        await tx.insert(generationJobs).values({ workspaceId: f.ws, productId: f.productId });
      })).rejects.toBeInstanceOf(SourceUnavailableError);
    } finally { finishDelete.resolve(); await purge; }
    expect(await race.sql`select id from generation_jobs where workspace_id=${f.ws}`).toHaveLength(0);
    expect(f.storage.objects.has(f.key)).toBe(false);
  });

  it("keeps retirement across a failed delete and later copied object, never accepting the stale key again", async () => {
    const f = await fixture(); f.storage.failDeletes.add(f.key);
    await purgeStaleSourceMedia({ db, storage: f.storage, now, maxOrphanObjects: 0 });
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`select 1 from workspaces where id=${f.ws}::uuid for update`);
      await assertSourceKeysAvailable(tx, f.ws, [f.key]);
    })).rejects.toBeInstanceOf(SourceUnavailableError);
    f.storage.failDeletes.clear();
    await purgeStaleSourceMedia({ db, storage: f.storage, now, maxOrphanObjects: 0 });
    f.storage.seed(f.key, Buffer.from("late copy"), now);
    await purgeStaleSourceMedia({ db, storage: f.storage, now });
    expect(f.storage.objects.has(f.key)).toBe(false);
    expect(await race.sql`select r2_key from retired_source_objects where workspace_id=${f.ws}`).toHaveLength(1);
  });
});
