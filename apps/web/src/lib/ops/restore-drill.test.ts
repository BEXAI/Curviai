import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@curvi/db";
import { createTestDb } from "@curvi/db/testing";
import { restoreDrill } from "@curvi/pipeline/seed";
import { RESTORE_DRILL_LAST_KEY, recordRestoreDrillReport, restoreDrillReportSchema, type BackupManifest } from "./backups";
import {
  DrillRefusal,
  checkDrillTarget,
  dumpProblems,
  majorOfVersionNum,
  isFutureBackupKey,
  majorVersion,
  newestBackupKey,
  pgRestoreProblem,
  parseDatabaseUrl,
  reportUrl,
  runRestoreDrill,
  type DrillCheck,
  type DrillDatabase,
  type RestoreDrillDeps,
  type RestoreDrillOptions,
} from "./restore-drill";

// docs/phases/PHASE_20.md P20-11. The drill's guard and steps run against
// fakes: no Docker, no database, no R2 and no network.

const LOCAL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PROD_REF = "prodrefabcdefghijklm";
const STAGING_REF = "stagingrefabcdefghij";
const THROWAWAY_REF = "drillrefabcdefghijkl";
const PROD_POOLER = `postgresql://postgres.${PROD_REF}:prod-password@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;
const PROD_SESSION = `postgresql://postgres.${PROD_REF}:prod-password@aws-0-us-west-1.pooler.supabase.com:5432/postgres`;

describe("parseDatabaseUrl", () => {
  it("reads host, port, database and the Supabase project ref", () => {
    expect(parseDatabaseUrl(LOCAL)).toEqual({
      host: "127.0.0.1",
      port: 54322,
      database: "postgres",
      user: "postgres",
      projectRef: null,
      loopback: true,
    });
    expect(parseDatabaseUrl(PROD_SESSION)?.projectRef).toBe(PROD_REF);
    expect(parseDatabaseUrl(`postgres://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`)).toMatchObject({
      projectRef: PROD_REF,
      loopback: false,
      port: 5432,
    });
    expect(parseDatabaseUrl("postgresql://postgres@[::1]/postgres")).toMatchObject({ host: "::1", port: 5432, loopback: true });
  });

  it("refuses anything whose real host could hide elsewhere", () => {
    expect(parseDatabaseUrl("not a url")).toBeNull();
    expect(parseDatabaseUrl("mysql://root@127.0.0.1/db")).toBeNull();
    expect(parseDatabaseUrl("postgresql:///postgres?host=db.example.supabase.co")).toBeNull();
    expect(parseDatabaseUrl(`postgresql://postgres@127.0.0.1/postgres?host=db.${PROD_REF}.supabase.co`)).toBeNull();
    expect(parseDatabaseUrl("postgresql://postgres@127.0.0.1/postgres?service=prod")).toBeNull();
  });
});

describe("checkDrillTarget", () => {
  it("allows a fresh local stack", () => {
    expect(checkDrillTarget(LOCAL, {})).toMatchObject({ ok: true, kind: "local" });
    expect(checkDrillTarget("postgresql://postgres:postgres@localhost:54322/postgres", { DATABASE_URL: PROD_POOLER })).toMatchObject({
      ok: true,
      kind: "local",
    });
  });

  it("refuses the database DATABASE_URL points at, even spelled another way", () => {
    const result = checkDrillTarget(LOCAL, { DATABASE_URL: "postgres://postgres:other@localhost:54322/postgres" });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("the database DATABASE_URL points at");
  });

  it("refuses the staging database and any database of the staging or production project", () => {
    expect(checkDrillTarget(LOCAL, { STAGING_DATABASE_URL: LOCAL })).toMatchObject({ ok: false });
    const staging = `postgresql://postgres:pw@db.${STAGING_REF}.supabase.co:5432/postgres`;
    const viaRef = checkDrillTarget(staging, { STAGING_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`, DATABASE_URL: PROD_POOLER }, STAGING_REF);
    expect(viaRef).toMatchObject({ ok: false });
    expect(!viaRef.ok && viaRef.reason).toContain("STAGING_SUPABASE_URL");
    // Production's session pooler, while DATABASE_URL names the transaction pooler.
    const prod = checkDrillTarget(PROD_SESSION, { DATABASE_URL: PROD_POOLER }, PROD_REF);
    expect(prod).toMatchObject({ ok: false });
    expect(!prod.ok && prod.reason).toContain("never restores into production or staging");
    expect(
      checkDrillTarget(`postgresql://postgres:pw@db.${PROD_REF}.supabase.co:5432/postgres`, {
        NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co`,
      }),
    ).toMatchObject({ ok: false });
  });

  it("refuses any other remote database unless it is the named throwaway project", () => {
    const remote = `postgresql://postgres:pw@db.${THROWAWAY_REF}.supabase.co:5432/postgres`;
    expect(checkDrillTarget(remote, { DATABASE_URL: PROD_POOLER })).toMatchObject({ ok: false });
    expect(checkDrillTarget("postgresql://u:p@db.example.com:5432/app", { DATABASE_URL: PROD_POOLER }, THROWAWAY_REF)).toMatchObject({
      ok: false,
    });
    expect(checkDrillTarget(remote, { DATABASE_URL: PROD_POOLER }, THROWAWAY_REF)).toMatchObject({ ok: true, kind: "throwaway" });
  });

  it("needs production named in the shell before it trusts a throwaway project", () => {
    const remote = `postgresql://postgres:pw@db.${THROWAWAY_REF}.supabase.co:5432/postgres`;
    const result = checkDrillTarget(remote, {}, THROWAWAY_REF);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("tell the throwaway project from production");
    expect(checkDrillTarget(LOCAL, {}, THROWAWAY_REF)).toMatchObject({ ok: false });
  });

  it("refuses a URL it cannot read", () => {
    expect(checkDrillTarget("127.0.0.1:54322", {})).toMatchObject({ ok: false });
  });
});

describe("helpers", () => {
  it("picks the newest daily backup", () => {
    expect(
      newestBackupKey([
        "daily/2026/09/30/curvi-20260930T091500Z.tar.age",
        "monthly/2026-10/curvi-20261001T091502Z.tar.age",
        "daily/2026/10/01/curvi-20261001T091502Z.tar.age",
        "daily/2026/10/01/notes.txt",
      ]),
    ).toBe("daily/2026/10/01/curvi-20261001T091502Z.tar.age");
    expect(newestBackupKey([])).toBeNull();
  });

  it("leaves out daily keys dated in the future", () => {
    const now = new Date("2026-10-02T15:00:00Z");
    const keys = [
      "daily/2026/10/01/curvi-20261001T091502Z.tar.age",
      "daily/2099/01/01/curvi-20990101T000000Z.tar.age",
    ];
    expect(newestBackupKey(keys)).toBe("daily/2099/01/01/curvi-20990101T000000Z.tar.age");
    expect(newestBackupKey(keys, now)).toBe("daily/2026/10/01/curvi-20261001T091502Z.tar.age");
    expect(isFutureBackupKey("daily/2026/10/02/curvi-20261002T155900Z.tar.age", now)).toBe(false);
    expect(isFutureBackupKey("daily/2026/10/02/curvi-20261002T170000Z.tar.age", now)).toBe(true);
  });

  it("requires a pg_restore with the CVE-2025-8714 fix", () => {
    expect(pgRestoreProblem("pg_restore (PostgreSQL) 17.6")).toBeNull();
    expect(pgRestoreProblem("pg_restore (PostgreSQL) 18.0")).toBeNull();
    expect(pgRestoreProblem("pg_restore (PostgreSQL) 16.10")).toBeNull();
    expect(pgRestoreProblem("pg_restore (PostgreSQL) 17.5")).toMatch(/CVE-2025-8714.*17\.6 or later/);
    expect(pgRestoreProblem("pg_restore (PostgreSQL) 15.13")).toMatch(/15\.14 or later/);
    expect(pgRestoreProblem("pg_restore (PostgreSQL) 12.20")).toMatch(/17\.6 or later/);
  });

  it("reads major versions", () => {
    expect(majorVersion("pg_restore (PostgreSQL) 17.6")).toBe(17);
    expect(majorVersion("17.6 (Debian 17.6-1.pgdg120+1)")).toBe(17);
    expect(majorVersion("15.8")).toBe(15);
    expect(majorVersion("17")).toBe(17);
    expect(majorVersion("unknown")).toBeNull();
    expect(majorOfVersionNum("170006")).toBe(17);
    expect(majorOfVersionNum("x")).toBeNull();
  });

  it("builds the report URL over https, or http on this machine", () => {
    expect(reportUrl("https://curvi.ai/")).toBe("https://curvi.ai/api/cron/restore-drill-report");
    expect(reportUrl("http://localhost:3000")).toBe("http://localhost:3000/api/cron/restore-drill-report");
    expect(reportUrl("http://curvi.ai")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The drill with fakes.
// ---------------------------------------------------------------------------

const MANIFEST: BackupManifest = {
  format: 1,
  createdAt: "2026-10-01T09:15:02Z",
  serverVersion: "17.6",
  pgDumpVersion: "17.6 (Debian 17.6-1.pgdg120+1)",
  latestMigration: "1790000000000",
  ledgerTotalTenths: 565,
  counts: { "drizzle.__drizzle_migrations": 28, "public.workspaces": 2, "public.credit_ledger": 5, "auth.users": 2 },
  files: {
    "public.dump": { bytes: 100, sha256: "a".repeat(64) },
    "auth.dump": { bytes: 50, sha256: "b".repeat(64) },
  },
};

/** The encrypted file backup.sh reported, as backup:last holds it. */
const RECORDED_FILE = { bytes: 4096, sha256: "c".repeat(64) };
const RECORDED = { key: "daily/2026/10/01/curvi-20261001T091502Z.tar.age", ...RECORDED_FILE };

const PASSING: DrillCheck[] = [
  { check_name: "row_counts", ok: true, detail: "Every row count matches the backup across 3 tables." },
  { check_name: "acl_unchanged", ok: true, detail: "120 grants, RLS switches and policies match the fresh migrate." },
];

interface Harness {
  deps: RestoreDrillDeps;
  effects: string[];
  out: string[];
  err: string[];
  db: { exec: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  postReport: ReturnType<typeof vi.fn>;
}

function harness(options: {
  env?: Record<string, string>;
  checks?: DrillCheck[];
  fresh?: { public_tables: number; auth_users: boolean };
  users?: number;
  versionNum?: string;
  facts?: Partial<Record<"public.dump" | "auth.dump", { bytes: number; sha256: string }>>;
  failCommand?: string;
  bucket?: boolean;
  pgRestoreVersion?: string;
  recorded?: { key: string; bytes: number; sha256: string } | null;
  downloaded?: { bytes: number; sha256: string };
  keys?: string[];
} = {}): Harness {
  const effects: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let clock = Date.parse("2026-10-02T15:00:00Z");
  const db = {
    exec: vi.fn(async (text: string) => {
      effects.push(`exec ${text}`);
    }),
    query: vi.fn(async (text: string) => {
      effects.push(`query ${text.slice(0, 40)}`);
      if (text.includes("server_version_num")) return [{ version_num: options.versionNum ?? "170006" }];
      if (text.includes("as public_tables")) return [options.fresh ?? { public_tables: 0, auth_users: true }];
      if (text.includes("from auth.users")) return [{ n: options.users ?? 0 }];
      if (text.includes("format('%I.%I'")) return [{ name: "public.workspaces" }, { name: "public.credit_ledger" }];
      if (text.includes("drill_check.verify()")) return options.checks ?? PASSING;
      return [];
    }),
    close: vi.fn(async () => undefined),
  };
  const postReport = vi.fn(async () => undefined);
  const deps: RestoreDrillDeps = {
    env: { CRON_SECRET: "drill-secret", ...options.env },
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    now: () => {
      clock += 60_000;
      return new Date(clock);
    },
    run: async (command, args, runOptions) => {
      const line = [command, ...args].join(" ");
      effects.push(`run ${line}${runOptions?.env ? ` env=${JSON.stringify(runOptions.env)}` : ""}${runOptions?.cwd ? ` cwd=${runOptions.cwd}` : ""}`);
      if (options.failCommand && line.startsWith(options.failCommand)) throw new Error(`${command} exited with code 1`);
      if (line === "pg_restore --version") return { stdout: options.pgRestoreVersion ?? "pg_restore (PostgreSQL) 17.6\n" };
      if (command === "psql" && args.includes("--single-transaction")) return { stdout: "\n0\nlive_jobs_failed=2\n" };
      return { stdout: "" };
    },
    makeTempDir: async () => {
      effects.push("mkdtemp");
      return "/tmp/curvi-drill-x";
    },
    removeDir: async (path) => {
      effects.push(`rm ${path}`);
    },
    readText: async (path) => {
      if (path.endsWith("ops/cron/verify-restore.sql")) return "-- verify";
      if (path.endsWith("manifest.json")) return JSON.stringify(MANIFEST);
      throw new Error(`unexpected read ${path}`);
    },
    fileFacts: async (path) => {
      if (path.endsWith(".tar.age")) return options.downloaded ?? RECORDED_FILE;
      const name = path.endsWith("public.dump") ? "public.dump" : "auth.dump";
      return options.facts?.[name] ?? MANIFEST.files[name];
    },
    fetchRecordedBackup: async () => (options.recorded === undefined ? RECORDED : options.recorded),
    bucket:
      options.bucket === false
        ? null
        : {
            listKeys: async (prefix) => {
              effects.push(`list ${prefix}`);
              return options.keys ?? ["daily/2026/09/30/curvi-20260930T091500Z.tar.age", "daily/2026/10/01/curvi-20261001T091502Z.tar.age"];
            },
            download: async (key, path) => {
              effects.push(`download ${key} ${path}`);
            },
          },
    connect: (url) => {
      effects.push(`connect ${url}`);
      return db as unknown as DrillDatabase;
    },
    postReport,
    repoRoot: "/repo",
  };
  return { deps, effects, out, err, db, postReport };
}

const OPTIONS: RestoreDrillOptions = {
  target: LOCAL,
  identityFile: "/keys/curvi-backup.key",
  supabaseWorkdir: "/drill",
  report: "https://curvi.ai",
};

describe("runRestoreDrill", () => {
  it("refuses a target equal to DATABASE_URL before fetching, decrypting or connecting", async () => {
    const h = harness({ env: { DATABASE_URL: LOCAL } });
    await expect(runRestoreDrill(OPTIONS, h.deps)).rejects.toBeInstanceOf(DrillRefusal);
    expect(h.effects).toEqual([]);
  });

  it("refuses the staging project's database before anything else", async () => {
    const h = harness({ env: { STAGING_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`, DATABASE_URL: PROD_POOLER } });
    await expect(
      runRestoreDrill(
        { ...OPTIONS, target: `postgresql://postgres:pw@db.${STAGING_REF}.supabase.co:5432/postgres`, throwawayProject: STAGING_REF },
        h.deps,
      ),
    ).rejects.toThrow(/STAGING_SUPABASE_URL/);
    expect(h.effects).toEqual([]);
  });

  it("refuses to report without CRON_SECRET, and to start without a backup source", async () => {
    const noSecret = harness({ env: { CRON_SECRET: "" } });
    await expect(runRestoreDrill(OPTIONS, noSecret.deps)).rejects.toThrow(/CRON_SECRET/);
    const noReportTarget = harness();
    await expect(runRestoreDrill({ ...OPTIONS, report: undefined }, noReportTarget.deps)).rejects.toThrow(/--report-to/);
    const noBucket = harness({ bucket: false });
    await expect(runRestoreDrill(OPTIONS, noBucket.deps)).rejects.toThrow(/--backup <file>/);
    for (const h of [noSecret, noReportTarget, noBucket]) expect(h.effects).toEqual([]);
  });

  it("restores only the backup the site recorded, with the bytes the cron reported (security review 7)", async () => {
    const tampered = harness({ downloaded: { bytes: 4096, sha256: "d".repeat(64) } });
    await expect(runRestoreDrill(OPTIONS, tampered.deps)).rejects.toThrow(/does not match the size and sha256/);
    expect(tampered.effects.some((effect) => effect.startsWith("run age --decrypt"))).toBe(false);

    const none = harness({ recorded: null });
    await expect(runRestoreDrill(OPTIONS, none.deps)).rejects.toThrow(/no backup recorded/);

    const missing = harness({ recorded: { ...RECORDED, key: "daily/2026/09/29/curvi-20260929T091500Z.tar.age" } });
    await expect(runRestoreDrill(OPTIONS, missing.deps)).rejects.toThrow(/is not in the bucket/);

    const future = harness({ recorded: { ...RECORDED, key: "daily/2099/01/01/curvi-20990101T000000Z.tar.age" } });
    await expect(runRestoreDrill(OPTIONS, future.deps)).rejects.toThrow(/dated in the future/);

    // A newer object the site never recorded is not restored.
    const planted = harness({
      keys: [RECORDED.key, "daily/2026/10/02/curvi-20261002T091500Z.tar.age"],
    });
    const result = await runRestoreDrill(OPTIONS, planted.deps);
    expect(result.passed).toBe(true);
    expect(planted.effects).toContain(`download ${RECORDED.key} /tmp/curvi-drill-x/backup.tar.age`);
    expect(planted.err.join(" ")).toContain("is not the backup the site recorded");
  });

  it("refuses a pg_restore without the CVE-2025-8714 fix before fetching anything", async () => {
    const h = harness({ pgRestoreVersion: "pg_restore (PostgreSQL) 17.5\n" });
    await expect(runRestoreDrill(OPTIONS, h.deps)).rejects.toThrow(/CVE-2025-8714/);
    expect(h.effects.some((effect) => effect.startsWith("download"))).toBe(false);
  });

  it("needs the site and CRON_SECRET to fetch from the bucket even with --no-report", async () => {
    const h = harness();
    await expect(runRestoreDrill({ ...OPTIONS, report: false }, h.deps)).rejects.toThrow(/backup the site recorded/);
    expect(h.effects).toEqual([]);
    const withSite = harness();
    const result = await runRestoreDrill({ ...OPTIONS, report: false, recordFrom: "https://curvi.ai" }, withSite.deps);
    expect(result.passed).toBe(true);
  });

  it("restores the newest backup into the local stack, checks it, reports it and destroys the stack", async () => {
    const h = harness();
    const result = await runRestoreDrill(OPTIONS, h.deps);
    expect(result.passed).toBe(true);

    const order = h.effects.map((effect) => effect.split(" ").slice(0, 2).join(" "));
    expect(order).toEqual([
      "run pg_restore",
      "run psql",
      "run age",
      "mkdtemp",
      "list daily/",
      "download daily/2026/10/01/curvi-20261001T091502Z.tar.age",
      "run age",
      "run tar",
      `connect ${LOCAL}`,
      "query select",
      "query select",
      "query select",
      "run pnpm",
      "exec --",
      "query select",
      "query select",
      "exec truncate",
      "run pg_restore",
      "run pg_restore",
      "run psql",
      "exec delete",
      "exec insert",
      "exec insert",
      "query select",
      "rm /tmp/curvi-drill-x",
      "run supabase",
    ]);
    // The schema comes from the migrations, run against the drill database only.
    expect(h.effects).toContain(`run pnpm --filter @curvi/db db:migrate env=${JSON.stringify({ DATABASE_URL: LOCAL })} cwd=/repo`);
    expect(h.effects).toContain("run age --decrypt --identity /keys/curvi-backup.key --output /tmp/curvi-drill-x/backup.tar /tmp/curvi-drill-x/backup.tar.age");
    expect(h.effects).toContain("run tar -xf /tmp/curvi-drill-x/backup.tar -C /tmp/curvi-drill-x manifest.json public.dump auth.dump");
    expect(h.effects).toContain("exec truncate table public.workspaces, public.credit_ledger restart identity cascade");
    // The manifest the checks compare against.
    expect(h.effects).toContain(
      "exec insert into drill_check.manifest_counts (table_name, expected) values ('drizzle.__drizzle_migrations', 28), ('public.workspaces', 2), ('public.credit_ledger', 5), ('auth.users', 2)",
    );
    expect(h.effects).toContain(
      "exec insert into drill_check.expected (key, value) values ('ledger_total_tenths', '565'), ('latest_migration', '1790000000000')",
    );
    expect(h.effects).toContain(
      "run pg_restore --data-only --no-owner --no-privileges --schema=public --file=/tmp/curvi-drill-x/public.sql /tmp/curvi-drill-x/public.dump",
    );
    // One transaction, triggers off, live jobs failed before it commits.
    expect(h.effects).toContain(
      `run psql --no-psqlrc --quiet --tuples-only --no-align --single-transaction --variable=ON_ERROR_STOP=1 --dbname=${LOCAL} --command=SET session_replication_role = replica --file=/tmp/curvi-drill-x/auth.sql --file=/tmp/curvi-drill-x/public.sql --command=SELECT 'live_jobs_failed=' || drill_check.fail_live_jobs()`,
    );
    expect(h.out).toContain("Failed 2 jobs that were live when the backup was taken.");
    expect(h.effects[h.effects.length - 1]).toBe("run supabase stop --no-backup --workdir /drill");
    expect(h.db.close).toHaveBeenCalledOnce();

    // The report the site stores.
    expect(h.postReport).toHaveBeenCalledOnce();
    const [url, secret, body] = h.postReport.mock.calls[0] as unknown as [string, string, unknown];
    expect(url).toBe("https://curvi.ai/api/cron/restore-drill-report");
    expect(secret).toBe("drill-secret");
    expect(restoreDrillReportSchema.parse(body)).toEqual({
      backupKey: "daily/2026/10/01/curvi-20261001T091502Z.tar.age",
      backupCreatedAt: MANIFEST.createdAt,
      target: "local",
      // The fake clock moves a minute on every read.
      startedAt: "2026-10-02T15:01:00.000Z",
      finishedAt: "2026-10-02T15:06:00.000Z",
      durationSeconds: 300,
      stepSeconds: { fetch: 60, decrypt: 60, migrate: 60, restore: 60, verify: 60 },
      checksPassed: 2,
      rowsRestored: 9,
      latestMigration: MANIFEST.latestMigration,
      rtoTargetMinutes: restoreDrill.rtoTargetMinutes,
      withinRto: true,
    });
    expect(h.out).toContain(`The drill took 5 min 0 s, inside the ${restoreDrill.rtoTargetMinutes} minute recovery target.`);
  });

  it("records nothing when a check fails, and still removes the files and destroys the stack", async () => {
    const h = harness({ checks: [...PASSING, { check_name: "ledger_total", ok: false, detail: "Ledger total 50.0 credits, the backup 56.5." }] });
    const result = await runRestoreDrill(OPTIONS, h.deps);
    expect(result).toMatchObject({ passed: false, report: null });
    expect(h.postReport).not.toHaveBeenCalled();
    expect(h.out).toContain("FAIL  ledger_total: Ledger total 50.0 credits, the backup 56.5.");
    expect(h.effects).toContain("rm /tmp/curvi-drill-x");
    expect(h.effects[h.effects.length - 1]).toBe("run supabase stop --no-backup --workdir /drill");
  });

  it("refuses a target that is not fresh without migrating, clearing or destroying it", async () => {
    for (const h of [harness({ fresh: { public_tables: 12, auth_users: true } }), harness({ users: 3 })]) {
      await expect(runRestoreDrill(OPTIONS, h.deps)).rejects.toThrow(/not fresh/);
      expect(h.effects.some((effect) => effect.startsWith("run pnpm") || effect.startsWith("exec") || effect.startsWith("run supabase"))).toBe(false);
      expect(h.effects).toContain("rm /tmp/curvi-drill-x");
    }
    const plain = harness({ fresh: { public_tables: 0, auth_users: false } });
    await expect(runRestoreDrill(OPTIONS, plain.deps)).rejects.toThrow(/no auth.users table/);
  });

  it("refuses a damaged backup before connecting", async () => {
    const h = harness({ facts: { "public.dump": { bytes: 100, sha256: "c".repeat(64) } } });
    await expect(runRestoreDrill(OPTIONS, h.deps)).rejects.toThrow("The backup is damaged: public.dump does not match its manifest entry.");
    expect(h.effects.some((effect) => effect.startsWith("connect"))).toBe(false);
    expect(h.effects).toContain("rm /tmp/curvi-drill-x");
  });

  it("refuses before any work when a tool is missing", async () => {
    const h = harness({ failCommand: "age --version" });
    await expect(runRestoreDrill(OPTIONS, h.deps)).rejects.toThrow(/brew install age postgresql@17/);
    expect(h.effects.some((effect) => effect === "mkdtemp" || effect.startsWith("connect"))).toBe(false);
  });

  it("refuses a drill database on another Postgres major", async () => {
    const h = harness({ versionNum: "150008" });
    await expect(runRestoreDrill(OPTIONS, h.deps)).rejects.toThrow(/runs Postgres 15 and production 17/);
  });

  it("uses a local backup file, and for a throwaway project asks the founder to delete it", async () => {
    const h = harness({ env: { DATABASE_URL: PROD_POOLER } });
    const target = `postgresql://postgres:pw@db.${THROWAWAY_REF}.supabase.co:5432/postgres`;
    const result = await runRestoreDrill(
      { ...OPTIONS, target, throwawayProject: THROWAWAY_REF, backupFile: "/downloads/curvi-20261001T091502Z.tar.age", report: false },
      h.deps,
    );
    expect(result.passed).toBe(true);
    expect(result.report).toMatchObject({ backupKey: "file:curvi-20261001T091502Z.tar.age", target: "throwaway" });
    expect(h.effects.some((effect) => effect.startsWith("list") || effect.startsWith("download"))).toBe(false);
    expect(h.effects.some((effect) => effect.startsWith("run supabase"))).toBe(false);
    expect(h.postReport).not.toHaveBeenCalled();
    expect(h.err.join("\n")).toContain(`Delete the throwaway project ${THROWAWAY_REF} now`);
  });

  it("names a downloaded file in a form the report accepts", async () => {
    const h = harness();
    const result = await runRestoreDrill({ ...OPTIONS, backupFile: "/Users/me/Downloads/curvi-20261001T091502Z (1).tar.age" }, h.deps);
    expect(result.report?.backupKey).toBe("file:curvi-20261001T091502Z__1_.tar.age");
    expect(() => restoreDrillReportSchema.parse(result.report)).not.toThrow();
  });

  it("still removes the files and destroys the stack when a step fails midway", async () => {
    const h = harness({ failCommand: "pnpm" });
    await expect(runRestoreDrill(OPTIONS, h.deps)).rejects.toThrow("pnpm exited with code 1");
    expect(h.effects.slice(-2)).toEqual(["rm /tmp/curvi-drill-x", "run supabase stop --no-backup --workdir /drill"]);
  });
});

describe("dumpProblems", () => {
  it("names each dump that differs from the manifest", () => {
    expect(dumpProblems(MANIFEST, MANIFEST.files)).toEqual([]);
    expect(dumpProblems(MANIFEST, { ...MANIFEST.files, "auth.dump": { bytes: 49, sha256: "b".repeat(64) } })).toEqual([
      "auth.dump does not match its manifest entry",
    ]);
  });
});

describe("recordRestoreDrillReport", () => {
  let client: Awaited<ReturnType<typeof createTestDb>>["client"];
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeAll(async () => {
    ({ client, db } = await createTestDb());
  });

  afterAll(async () => {
    await client.close();
  });

  it("keeps one restore_drill:last row with the newest drill", async () => {
    const report = restoreDrillReportSchema.parse({
      backupKey: "daily/2026/10/01/curvi-20261001T091502Z.tar.age",
      backupCreatedAt: "2026-10-01T09:15:02Z",
      target: "local",
      startedAt: "2026-10-02T15:00:00.000Z",
      finishedAt: "2026-10-02T15:11:40.000Z",
      durationSeconds: 700,
      stepSeconds: { fetch: 20, decrypt: 5, migrate: 95, restore: 540, verify: 40 },
      checksPassed: 9,
      rowsRestored: 12_840,
      latestMigration: "1790000000000",
      rtoTargetMinutes: 120,
      withinRto: true,
    });
    await recordRestoreDrillReport(db as unknown as Db, report, new Date("2026-10-02T15:11:41Z"));
    await recordRestoreDrillReport(db as unknown as Db, { ...report, durationSeconds: 650 }, new Date("2026-11-02T15:11:41Z"));
    const rows = await client.query<{ value: Record<string, unknown> }>("select value from platform_settings where key = $1", [
      RESTORE_DRILL_LAST_KEY,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].value).toMatchObject({ durationSeconds: 650, recordedAt: "2026-11-02T15:11:41.000Z" });
  });
});
