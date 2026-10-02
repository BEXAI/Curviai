import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupManifestSchema, backupReportSchema } from "@/lib/ops/backups";

// docs/phases/PHASE_20.md P20-10: ops/cron/backup.sh run with fake
// pg_dump, pg_restore, age, rclone and curl on PATH. Nothing here reaches a
// database, R2 or the network.

const BACKUP_SH = fileURLToPath(new URL("../../../ops/cron/backup.sh", import.meta.url));
const SECRET = "cron-secret-for-the-backup-test";
const R2_SECRET = "r2-secret-for-the-backup-test";
const DB_URL = "postgresql://postgres.abcdefghijklmnopqrst:db-password-for-test@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const HC = "https://hc-ping.com/1b2c3d4e-0000-4000-8000-000000000000";

const TOC = `;
; Archive created at 2026-10-01 09:15:03 UTC
;     dbname: postgres
;     TOC Entries: 345
;     Compression: gzip
;     Format: CUSTOM
;     Dumped from database version: 17.6
;     Dumped by pg_dump version: 17.6 (Debian 17.6-1.pgdg120+1)
;
`;

// What pg_restore --data-only prints: COPY blocks of tab separated rows,
// \N for null, a backslash escaped tab inside a value.
const PUBLIC_SQL = `--
-- PostgreSQL database dump
--

SET statement_timeout = 0;

COPY drizzle.__drizzle_migrations (id, hash, created_at) FROM stdin;
1\tabc\t1790000000000
2\tdef\t1790000005000
\\.

COPY public.workspaces (id, name, plan) FROM stdin;
w1\tShop one\tfree
w2\tShop two\\twith a tab\tstarter
\\.

COPY public.credit_ledger (id, workspace_id, delta, reason) FROM stdin;
l1\tw1\t50.0\tgrant
l2\tw1\t-2.5\treserve
l3\tw2\t-0.5\tcharge
l4\tw2\t3\ttopup
l5\tw2\t\\N\tgrant
\\.

COPY public.events (id) FROM stdin;
\\.

-- PostgreSQL database dump complete
`;

const AUTH_SQL = `COPY auth.users (instance_id, id, email) FROM stdin;
\\N\tu1\ta@example.com
\\N\tu2\tb@example.com
\\.

COPY auth.identities (id) FROM stdin;
i1
\\.

COPY auth.mfa_factors (id) FROM stdin;
\\.
`;

const FAKES: Record<string, string> = {
  pg_dump: `#!/bin/sh
echo "pg_dump $*" >> "$FAKE_LOG"
[ "\${FAKE_PG_DUMP_EXIT:-0}" = 0 ] || exit "$FAKE_PG_DUMP_EXIT"
for arg in "$@"; do case "$arg" in --file=*) out="\${arg#--file=}";; esac; done
printf 'PGDMP fake %s\\n' "$(basename "$out")" > "$out"
`,
  pg_restore: `#!/bin/sh
echo "pg_restore $*" >> "$FAKE_LOG"
list=0; out=""; src=""
for arg in "$@"; do case "$arg" in --list) list=1;; --file=*) out="\${arg#--file=}";; --*) ;; *) src="$arg";; esac; done
if [ "$list" = 1 ]; then cat "$FAKE_DIR/toc.txt"; exit 0; fi
case "$(basename "$src")" in
  public.dump) cat "$FAKE_DIR/public.sql" > "$out";;
  auth.dump) cat "$FAKE_DIR/auth.sql" > "$out";;
  *) exit 9;;
esac
`,
  age: `#!/bin/sh
echo "age $*" >> "$FAKE_LOG"
out=""; prev=""
for arg in "$@"; do if [ "$prev" = "--output" ]; then out="$arg"; fi; prev="$arg"; done
cat > "$out"
`,
  rclone: `#!/bin/sh
echo "rclone $* endpoint=$RCLONE_CONFIG_CURVIBACKUP_ENDPOINT provider=$RCLONE_CONFIG_CURVIBACKUP_PROVIDER nocheck=$RCLONE_CONFIG_CURVIBACKUP_NO_CHECK_BUCKET" >> "$FAKE_LOG"
[ "\${FAKE_RCLONE_EXIT:-0}" = 0 ] || exit "$FAKE_RCLONE_EXIT"
dest="\${3#curvibackup:}"
mkdir -p "$FAKE_DIR/bucket/$(dirname "$dest")"
cp "$2" "$FAKE_DIR/bucket/$dest"
`,
  curl: `#!/bin/sh
echo "curl $*" >> "$FAKE_LOG"
url=""; prev=""
for arg in "$@"; do
  case "$prev" in
    --data-binary) cp "\${arg#@}" "$FAKE_DIR/report.json";;
    -H) case "$arg" in @*) cp "\${arg#@}" "$FAKE_DIR/report.headers";; esac;;
  esac
  case "$arg" in http*) url="$arg";; esac
  prev="$arg"
done
case "$url" in *backup-report) exit "\${FAKE_REPORT_EXIT:-0}";; esac
exit 0
`,
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "curvi-backup-test-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "tmp"));
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(join(dir, "bin", name), body);
    chmodSync(join(dir, "bin", name), 0o755);
  }
  writeFileSync(join(dir, "toc.txt"), TOC);
  writeFileSync(join(dir, "public.sql"), PUBLIC_SQL);
  writeFileSync(join(dir, "auth.sql"), AUTH_SQL);
  writeFileSync(join(dir, "log"), "");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string> = {
    PATH: `${join(dir, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: dir,
    TMPDIR: join(dir, "tmp"),
    FAKE_DIR: dir,
    FAKE_LOG: join(dir, "log"),
    BACKUP_TIMESTAMP: "20261001T091502Z",
    BACKUP_DATABASE_URL: DB_URL,
    BACKUP_AGE_RECIPIENT: "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3290gq",
    BACKUP_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    BACKUP_R2_BUCKET: "curvi-backups",
    BACKUP_R2_ACCESS_KEY_ID: "r2-key-id",
    BACKUP_R2_SECRET_ACCESS_KEY: R2_SECRET,
    NEXT_PUBLIC_SITE_URL: "https://curvi.example/",
    CRON_SECRET: SECRET,
    HEALTHCHECKS_BACKUP_URL: HC,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  // Only these variables reach the script: nothing from the shell running the tests.
  const result = spawnSync("bash", [BACKUP_SH], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  const log = readFileSync(join(dir, "log"), "utf8").trim().split("\n").filter(Boolean);
  return { status: result.status, stderr: result.stderr, log };
}

function bucketFiles(): string[] {
  const root = join(dir, "bucket");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(path, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}`);
    }
  };
  walk(root, "");
  return out.sort();
}

function untar(file: string): string {
  const target = join(dir, "untar");
  mkdirSync(target, { recursive: true });
  const result = spawnSync("tar", ["-xf", file, "-C", target], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return target;
}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pings = (log: string[]) =>
  log.filter((line) => line.startsWith("curl") && line.includes("hc-ping.com")).map((line) => line.slice(line.lastIndexOf(" ") + 1));

describe("ops/cron/backup.sh", () => {
  it("dumps, encrypts, uploads daily and monthly copies on the 1st, reports and pings", () => {
    const { status, stderr, log } = run();
    expect(stderr).not.toContain(SECRET);
    expect(status).toBe(0);

    const dumps = log.filter((line) => line.startsWith("pg_dump")).map((line) => line.replace(/--file=\S+\//, "--file=WORK/"));
    expect(dumps).toEqual([
      `pg_dump --dbname=${DB_URL} --format=custom --no-owner --no-privileges --schema=public --schema=drizzle --file=WORK/public.dump`,
      `pg_dump --dbname=${DB_URL} --format=custom --data-only --no-owner --no-privileges --table=auth.users --table=auth.identities --table=auth.mfa_factors --file=WORK/auth.dump`,
    ]);
    // Sessions and refresh tokens are never dumped.
    expect(log.join("\n")).not.toMatch(/sessions|refresh_tokens/);
    expect(log.find((line) => line.startsWith("age"))).toContain("--recipient age1");

    const name = "curvi-20261001T091502Z.tar.age";
    expect(bucketFiles()).toEqual([`curvi-backups/daily/2026/10/01/${name}`, `curvi-backups/monthly/2026-10/${name}`]);
    expect(log.filter((line) => line.startsWith("rclone"))[0]).toContain(
      "endpoint=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com provider=Cloudflare nocheck=true",
    );

    const uploaded = join(dir, "bucket", "curvi-backups", "daily", "2026", "10", "01", name);
    const archive = untar(uploaded);
    expect(readdirSync(archive).sort()).toEqual(["auth.dump", "manifest.json", "public.dump"]);
    const manifest = backupManifestSchema.parse(JSON.parse(readFileSync(join(archive, "manifest.json"), "utf8")));
    expect(manifest).toEqual({
      format: 1,
      createdAt: "2026-10-01T09:15:02Z",
      serverVersion: "17.6",
      pgDumpVersion: "17.6 (Debian 17.6-1.pgdg120+1)",
      latestMigration: "1790000005000",
      // 50.0 - 2.5 - 0.5 + 3, in tenths; the null delta is skipped.
      ledgerTotalTenths: 500,
      counts: {
        "drizzle.__drizzle_migrations": 2,
        "public.workspaces": 2,
        "public.credit_ledger": 5,
        "public.events": 0,
        "auth.users": 2,
        "auth.identities": 1,
        "auth.mfa_factors": 0,
      },
      files: {
        "public.dump": { bytes: expect.any(Number), sha256: sha256(join(archive, "public.dump")) },
        "auth.dump": { bytes: expect.any(Number), sha256: sha256(join(archive, "auth.dump")) },
      },
    });

    const report = backupReportSchema.parse(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")));
    expect(report).toMatchObject({
      key: `daily/2026/10/01/${name}`,
      monthlyKey: `monthly/2026-10/${name}`,
      sha256: sha256(uploaded),
      bytes: readFileSync(uploaded).length,
      counts: manifest.counts,
      ledgerTotalTenths: 500,
      latestMigration: "1790000005000",
      startedAt: "2026-10-01T09:15:02Z",
    });
    // The secret travels in a header file, never on a command line.
    expect(readFileSync(join(dir, "report.headers"), "utf8")).toBe(`authorization: Bearer ${SECRET}\n`);
    expect(log.join("\n")).not.toContain(SECRET);
    expect(log.join("\n")).not.toContain(R2_SECRET);
    expect(log.find((line) => line.includes("backup-report"))).toContain("https://curvi.example/api/cron/backup-report");

    expect(pings(log)).toEqual([`${HC}/start`, HC]);
    // Nothing is left behind, decrypted or not.
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("uploads only the daily copy on other days", () => {
    const { status } = run({ BACKUP_TIMESTAMP: "20261002T091500Z" });
    expect(status).toBe(0);
    expect(bucketFiles()).toEqual(["curvi-backups/daily/2026/10/02/curvi-20261002T091500Z.tar.age"]);
    const report = backupReportSchema.parse(JSON.parse(readFileSync(join(dir, "report.json"), "utf8")));
    expect(report.monthlyKey).toBeNull();
  });

  it("runs without healthchecks.io when its URL is unset", () => {
    const { status, log } = run({ HEALTHCHECKS_BACKUP_URL: undefined });
    expect(status).toBe(0);
    expect(pings(log)).toEqual([]);
  });

  it("refuses to start without its variables and pings fail", () => {
    const { status, stderr, log } = run({ BACKUP_AGE_RECIPIENT: undefined, CRON_SECRET: "" });
    expect(status).toBe(2);
    expect(stderr).toContain("missing variables: BACKUP_AGE_RECIPIENT CRON_SECRET");
    expect(log.some((line) => line.startsWith("pg_dump"))).toBe(false);
    expect(pings(log)).toEqual([`${HC}/fail`]);
  });

  it("refuses a recipient that is not an age public key", () => {
    const { status } = run({ BACKUP_AGE_RECIPIENT: "ssh-ed25519 AAAA" });
    expect(status).toBe(2);
  });

  it("fails without uploading or reporting when pg_dump fails, and cleans up", () => {
    const { status, log } = run({ FAKE_PG_DUMP_EXIT: "1" });
    expect(status).toBe(1);
    expect(bucketFiles()).toEqual([]);
    expect(log.some((line) => line.includes("backup-report"))).toBe(false);
    expect(pings(log)).toEqual([`${HC}/start`, `${HC}/fail`]);
    expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  });

  it("fails when the upload fails", () => {
    const { status, log } = run({ FAKE_RCLONE_EXIT: "5" });
    expect(status).toBe(5);
    expect(log.some((line) => line.includes("backup-report"))).toBe(false);
    expect(pings(log)).toEqual([`${HC}/start`, `${HC}/fail`]);
  });

  it("fails when the site refuses the report, so the founder hears about it", () => {
    const { status, log } = run({ FAKE_REPORT_EXIT: "22" });
    expect(status).toBe(22);
    expect(pings(log)).toEqual([`${HC}/start`, `${HC}/fail`]);
  });

  it("fails on a dump whose rows block never ends", () => {
    writeFileSync(join(dir, "auth.sql"), "COPY auth.users (id) FROM stdin;\nu1\n");
    const { status, stderr } = run();
    expect(status).toBe(3);
    expect(stderr).toContain("the dump ended inside the rows of auth.users");
    expect(bucketFiles()).toEqual([]);
  });

  it("fails on an unexpected table name instead of writing it into the JSON", () => {
    writeFileSync(join(dir, "auth.sql"), 'COPY auth."Users" (id) FROM stdin;\n\\.\n');
    const { status } = run();
    expect(status).toBe(3);
    expect(bucketFiles()).toEqual([]);
  });

  it("refuses a malformed test clock", () => {
    const { status } = run({ BACKUP_TIMESTAMP: "2026-10-01" });
    expect(status).toBe(2);
  });
});
