/**
 * The restore drill (docs/phases/PHASE_20.md P20-11, docs/ops/BACKUP_RESTORE.md),
 * run by the founder as pnpm ops:restore-drill (apps/web/scripts/restore-drill.ts).
 *
 * A backup nobody has restored is a guess, and a restored copy holds
 * customer data, password hashes and TOTP secrets. So the drill restores
 * only into an isolated database: a local Supabase stack (supabase start,
 * pinned to the production Postgres major) or, as a fallback, a throwaway
 * Supabase project named on the command line. Never staging, production or
 * any database an app, a cron or an email sender connects to: a booting app
 * instance would pick up every restored live job and run it again on real
 * provider keys.
 *
 * Steps, each timed: guard the target; fetch the newest daily backup (or a
 * local file); decrypt it with the founder's age key and check the dumps
 * against the manifest; refuse a target that is not fresh; pnpm db:migrate
 * (the schema always comes from migrations, never the dump); take the grants
 * baseline (ops/cron/verify-restore.sql); clear the rows migrations wrote;
 * load the auth and public data in one transaction with
 * session_replication_role = replica, failing every live job in the same
 * transaction; run the checks; post the report; then always remove the
 * decrypted files and destroy the drill database.
 *
 * Everything with an effect comes in through RestoreDrillDeps, so the steps
 * are unit tested without Docker, a database or R2.
 */

import { restoreDrill as restoreDrillPolicy } from "@curvi/pipeline/seed";
import {
  DAILY_BACKUP_KEY,
  backupManifestSchema,
  type BackupManifest,
  type RestoreDrillReport,
} from "@/lib/ops/backups";

/** A refusal the drill explains to the founder before doing anything risky. */
export class DrillRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DrillRefusal";
  }
}

// ---------------------------------------------------------------------------
// The target guard.
// ---------------------------------------------------------------------------

/** Databases the drill must never touch, by the variable that names them. */
export const PROTECTED_DATABASE_VARS = ["DATABASE_URL", "BACKUP_DATABASE_URL", "STAGING_DATABASE_URL"] as const;

/** Supabase project URLs (https://<ref>.supabase.co) whose projects are off limits. */
export const PROTECTED_PROJECT_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "STAGING_SUPABASE_URL"] as const;

/** The variables that identify production, one of which a throwaway target needs. */
const PRODUCTION_VARS = ["DATABASE_URL", "BACKUP_DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const;

export interface DatabaseAddress {
  host: string;
  port: number;
  database: string;
  user: string;
  /** The Supabase project ref the address belongs to, when it names one. */
  projectRef: string | null;
  loopback: boolean;
}

/** Query parameters that move the connection elsewhere than the URL's host. */
const REDIRECTING_PARAMS = ["host", "hostaddr", "port", "dbname", "service"];

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(\.\d{1,3}){3}$/.test(host);
}

function supabaseRef(host: string, user: string): string | null {
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (direct) return direct[1];
  const api = /^([a-z0-9]+)\.supabase\.co$/.exec(host);
  if (api) return api[1];
  if (host.endsWith(".pooler.supabase.com")) {
    const pooled = /^[^.]+\.([a-z0-9]+)$/.exec(user);
    if (pooled) return pooled[1];
  }
  return null;
}

/** A postgres:// or postgresql:// URL with a host in the URL itself, or null. */
export function parseDatabaseUrl(value: string): DatabaseAddress | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
  if (REDIRECTING_PARAMS.some((name) => url.searchParams.has(name))) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host.includes(",")) return null;
  const port = url.port ? Number(url.port) : 5432;
  const user = decodeURIComponent(url.username);
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || user || "postgres";
  return { host, port, database, user, projectRef: supabaseRef(host, user), loopback: isLoopback(host) };
}

/** The project ref of a Supabase project URL such as https://abc.supabase.co. */
export function projectRefOfUrl(value: string): string | null {
  try {
    return supabaseRef(new URL(value.trim()).hostname.toLowerCase(), "");
  } catch {
    return null;
  }
}

function sameDatabase(a: DatabaseAddress, b: DatabaseAddress): boolean {
  const sameHost = a.loopback && b.loopback ? true : a.host === b.host;
  return sameHost && a.port === b.port && a.database === b.database;
}

export type DrillTarget = { kind: "local" | "throwaway"; address: DatabaseAddress };

export type DrillTargetCheck = ({ ok: true } & DrillTarget) | { ok: false; reason: string };

/**
 * Decides whether `target` may receive a restore. Allowed: a database on
 * this machine (a local Supabase stack), or the throwaway Supabase project
 * the founder named. Refused: anything that DATABASE_URL,
 * BACKUP_DATABASE_URL or STAGING_DATABASE_URL points at, any database of the
 * production or staging Supabase project, any other remote database, and
 * any URL whose real host hides in its query string.
 */
export function checkDrillTarget(
  target: string,
  env: Readonly<Record<string, string | undefined>>,
  throwawayProject?: string,
): DrillTargetCheck {
  const address = parseDatabaseUrl(target);
  if (!address) {
    return {
      ok: false,
      reason: "The drill target must be a postgres:// or postgresql:// URL with its host in the URL, such as postgresql://postgres:postgres@127.0.0.1:54322/postgres for a local Supabase stack.",
    };
  }

  for (const name of PROTECTED_DATABASE_VARS) {
    const value = env[name]?.trim();
    const other = value ? parseDatabaseUrl(value) : null;
    if (other && sameDatabase(address, other)) {
      return {
        ok: false,
        reason: `The drill target is the database ${name} points at. A restored copy holds customer data, password hashes and TOTP secrets, and anything that connects to ${name} could act on it. Use a separate local stack, or unset ${name} in this shell if it only points at a stack you are about to throw away.`,
      };
    }
  }

  const protectedRefs = new Map<string, string>();
  for (const name of PROTECTED_DATABASE_VARS) {
    const value = env[name]?.trim();
    const ref = value ? parseDatabaseUrl(value)?.projectRef : null;
    if (ref && !protectedRefs.has(ref)) protectedRefs.set(ref, name);
  }
  for (const name of PROTECTED_PROJECT_VARS) {
    const value = env[name]?.trim();
    const ref = value ? projectRefOfUrl(value) : null;
    if (ref && !protectedRefs.has(ref)) protectedRefs.set(ref, name);
  }
  if (address.projectRef && protectedRefs.has(address.projectRef)) {
    return {
      ok: false,
      reason: `The drill target belongs to the Supabase project ${protectedRefs.get(address.projectRef)} names. The drill never restores into production or staging.`,
    };
  }

  if (address.loopback) {
    if (throwawayProject) {
      return { ok: false, reason: "--throwaway-project names a Supabase project, but the target is on this machine. Leave it out for a local stack." };
    }
    return { ok: true, kind: "local", address };
  }

  if (!throwawayProject) {
    return {
      ok: false,
      reason: "Only a local Supabase stack (127.0.0.1 or localhost) may receive a restore, or a throwaway Supabase project named with --throwaway-project <ref>. Staging and production never may.",
    };
  }
  if (address.projectRef !== throwawayProject.trim().toLowerCase()) {
    return { ok: false, reason: `The target is not a database of the throwaway project ${throwawayProject}.` };
  }
  const productionKnown = PRODUCTION_VARS.some((name) => {
    const value = env[name]?.trim();
    if (!value) return false;
    return name === "NEXT_PUBLIC_SUPABASE_URL" ? projectRefOfUrl(value) !== null : parseDatabaseUrl(value)?.projectRef != null;
  });
  if (!productionKnown) {
    return {
      ok: false,
      reason: "Set NEXT_PUBLIC_SUPABASE_URL or BACKUP_DATABASE_URL to production's value in this shell, so the drill can tell the throwaway project from production.",
    };
  }
  return { ok: true, kind: "throwaway", address };
}

// ---------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------

/** When a backup key says it was made: the UTC stamp in its file name. */
export function backupKeyTime(key: string): Date | null {
  const match = /curvi-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.tar\.age$/.exec(key);
  if (!match) return null;
  const [, y, mo, d, h, mi, se] = match;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** A key dated more than this past the drill's clock is refused: nothing
 * honest writes a backup from the future (security review 7). */
const FUTURE_KEY_SKEW_MS = 60 * 60_000;

/** True when the key is dated past now (with an hour of clock skew). */
export function isFutureBackupKey(key: string, now: Date): boolean {
  const at = backupKeyTime(key);
  return at === null || at.getTime() > now.getTime() + FUTURE_KEY_SKEW_MS;
}

/** The newest daily backup key; keys sort by date because every part is
 * zero padded. Keys dated in the future are left out when `now` is given. */
export function newestBackupKey(keys: readonly string[], now?: Date): string | null {
  const daily = keys
    .filter((key) => DAILY_BACKUP_KEY.test(key))
    .filter((key) => !now || !isFutureBackupKey(key, now))
    .sort();
  return daily.length > 0 ? daily[daily.length - 1] : null;
}

/** The major version in "17.6", "17.6 (Debian 17.6-1.pgdg120+1)" or "pg_restore (PostgreSQL) 17.6". */
export function majorVersion(text: string): number | null {
  const match = /(\d{1,3})\.\d+/.exec(text) ?? /^\s*(\d{1,3})\s*$/.exec(text);
  return match ? Number(match[1]) : null;
}

/** "17.6" in any of the texts majorVersion reads; null without a minor. */
export function majorMinorVersion(text: string): { major: number; minor: number } | null {
  const match = /(\d{1,3})\.(\d{1,3})/.exec(text);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

/**
 * The first pg_restore release of each major that is safe to turn a dump
 * into plain SQL for psql: CVE-2025-8714 let the origin server's superuser
 * put psql meta commands into a dump, and "pg_restore is affected when used
 * to generate a plain-format dump", as the drill does (postgresql.org,
 * fixed 2025-08-14; docs/verification.md). Majors after 17 have the fix.
 */
export const PG_RESTORE_FIXED_MINOR: Readonly<Record<number, number>> = { 13: 22, 14: 19, 15: 14, 16: 10, 17: 6 };

/** Null when this pg_restore is safe for the drill, else why not. */
export function pgRestoreProblem(versionText: string): string | null {
  const version = majorMinorVersion(versionText);
  if (!version) return "pg_restore --version did not print a version.";
  const fixed = PG_RESTORE_FIXED_MINOR[version.major];
  if (version.major > 17 || (fixed !== undefined && version.minor >= fixed)) return null;
  const need = fixed !== undefined ? `${version.major}.${fixed}` : "17.6";
  return `pg_restore ${version.major}.${version.minor} lacks the CVE-2025-8714 fix, so a dump could run commands on this laptop. Install ${need} or later (brew upgrade postgresql@${version.major > 17 || fixed === undefined ? 17 : version.major}).`;
}

/** The major of server_version_num, such as 170006. */
export function majorOfVersionNum(value: string | number): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100000 ? Math.floor(n / 10000) : null;
}

/** Problems with the extracted dumps against the manifest; empty when they match. */
export function dumpProblems(
  manifest: BackupManifest,
  facts: Record<"public.dump" | "auth.dump", { bytes: number; sha256: string }>,
): string[] {
  const problems: string[] = [];
  for (const name of ["public.dump", "auth.dump"] as const) {
    const want = manifest.files[name];
    const have = facts[name];
    if (want.bytes !== have.bytes || want.sha256 !== have.sha256) {
      problems.push(`${name} does not match its manifest entry`);
    }
  }
  return problems;
}

export interface DrillCheck {
  check_name: string;
  ok: boolean;
  detail: string;
}

/** Rows the backup restored, without drizzle's bookkeeping (it comes from the migrate). */
export function rowsInBackup(manifest: BackupManifest): number {
  return Object.entries(manifest.counts)
    .filter(([table]) => !table.startsWith("drizzle."))
    .reduce((sum, [, count]) => sum + count, 0);
}

function seconds(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

function minutesText(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}

/** The report origin: https, or http on this machine (a local dev site). */
export function reportUrl(origin: string): string | null {
  try {
    const url = new URL(origin.trim());
    const local = url.protocol === "http:" && isLoopback(url.hostname.replace(/^\[|\]$/g, ""));
    if (url.protocol !== "https:" && !local) return null;
    return `${url.origin}/api/cron/restore-drill-report`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The drill.
// ---------------------------------------------------------------------------

/** The drill database: one connection, SQL text in, rows out. */
export interface DrillDatabase {
  /** Runs SQL text with one or more statements and no parameters. */
  exec(text: string): Promise<void>;
  /** Runs one statement and returns its rows. */
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface DrillIo {
  out(line: string): void;
  err(line: string): void;
}

export interface RestoreDrillDeps {
  env: Readonly<Record<string, string | undefined>>;
  io: DrillIo;
  now(): Date;
  /** Runs a program to completion and resolves with its standard output;
   * rejects when it cannot start or exits non zero. `env` is added to this
   * process's environment. */
  run(command: string, args: readonly string[], options?: { env?: Record<string, string>; cwd?: string }): Promise<{ stdout: string }>;
  /** A new private folder (mode 0700) for the decrypted files. */
  makeTempDir(): Promise<string>;
  removeDir(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  fileFacts(path: string): Promise<{ bytes: number; sha256: string }>;
  /** The backup bucket through a read only token, or null when the
   * BACKUP_R2_* variables are not in the shell. */
  bucket: { listKeys(prefix: string): Promise<string[]>; download(key: string, path: string): Promise<void> } | null;
  /** GET /api/cron/backup-report on the site: the backup the server
   * recorded (key, size, sha256), or null when none is. */
  fetchRecordedBackup(url: string, secret: string): Promise<{ key: string; bytes: number; sha256: string } | null>;
  connect(url: string): DrillDatabase;
  postReport(url: string, secret: string, body: RestoreDrillReport): Promise<void>;
  /** The repository root: pnpm db:migrate runs there and
   * ops/cron/verify-restore.sql is read from there. */
  repoRoot: string;
}

export interface RestoreDrillOptions {
  /** The drill database URL. */
  target: string;
  /** The founder's age identity file (the private key). */
  identityFile: string;
  /** A local encrypted backup instead of the newest one in the bucket. */
  backupFile?: string;
  /** The ref of a throwaway Supabase project, for the fallback target. */
  throwawayProject?: string;
  /** Where `supabase start` ran, for `supabase stop --no-backup`. */
  supabaseWorkdir?: string;
  /** The site origin to report to, false for --no-report, undefined when neither was given. */
  report: string | false | undefined;
  /** The site origin the recorded backup is read from when report is
   * false (--report-to or NEXT_PUBLIC_SITE_URL). */
  recordFrom?: string;
}

export interface RestoreDrillResult {
  passed: boolean;
  checks: DrillCheck[];
  report: RestoreDrillReport | null;
}

function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** SQL text literal. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function runRestoreDrill(options: RestoreDrillOptions, deps: RestoreDrillDeps): Promise<RestoreDrillResult> {
  const { io, env } = deps;

  // 1. Refuse before anything is fetched, decrypted or written.
  const guard = checkDrillTarget(options.target, env, options.throwawayProject);
  if (!guard.ok) throw new DrillRefusal(guard.reason);

  let report: { url: string; secret: string } | null = null;
  if (options.report !== false) {
    if (!options.report) {
      throw new DrillRefusal("Pass --report-to https://curvi.ai (or set NEXT_PUBLIC_SITE_URL) to record the drill, or --no-report to skip it.");
    }
    const url = reportUrl(options.report);
    if (!url) throw new DrillRefusal("The report goes to the site over https, such as --report-to https://curvi.ai.");
    const secret = env.CRON_SECRET?.trim();
    if (!secret) throw new DrillRefusal("Set CRON_SECRET (the site's value) in this shell to record the drill, or pass --no-report.");
    report = { url, secret };
  }
  if (!options.backupFile && !deps.bucket) {
    throw new DrillRefusal(
      "Pass --backup <file>, or set BACKUP_R2_ACCOUNT_ID, BACKUP_R2_BUCKET, BACKUP_R2_ACCESS_KEY_ID and BACKUP_R2_SECRET_ACCESS_KEY (a read only token) to fetch the newest backup.",
    );
  }
  // From the bucket, the drill restores the backup the site recorded and
  // checks its bytes against that record: the nightly cron's token can
  // write to the bucket, so the bucket alone is not trusted (security
  // review 7).
  let recordUrl: string | null = null;
  if (!options.backupFile) {
    const origin = typeof options.report === "string" ? options.report : options.recordFrom;
    const drillReport = origin ? reportUrl(origin) : null;
    recordUrl = drillReport ? drillReport.replace(/\/api\/cron\/restore-drill-report$/, "/api/cron/backup-report") : null;
    if (!recordUrl || !env.CRON_SECRET?.trim()) {
      throw new DrillRefusal(
        "Fetching from the bucket checks the file against the backup the site recorded: set CRON_SECRET and pass --report-to https://curvi.ai (or set NEXT_PUBLIC_SITE_URL), or pass --backup <file>.",
      );
    }
  }

  let pgRestoreMajor: number | null;
  let pgRestoreVersion: string;
  try {
    pgRestoreVersion = (await deps.run("pg_restore", ["--version"])).stdout;
    pgRestoreMajor = majorVersion(pgRestoreVersion);
    await deps.run("psql", ["--version"]);
    await deps.run("age", ["--version"]);
  } catch {
    throw new DrillRefusal(
      "The drill needs age and the PostgreSQL client tools (pg_restore and psql) of the production major: brew install age postgresql@17.",
    );
  }
  if (pgRestoreMajor === null) throw new DrillRefusal("pg_restore --version did not print a version.");
  const unsafe = pgRestoreProblem(pgRestoreVersion);
  if (unsafe) throw new DrillRefusal(unsafe);

  const verifySql = await deps.readText(joinPath(deps.repoRoot, "ops/cron/verify-restore.sql"));
  const work = await deps.makeTempDir();
  let db: DrillDatabase | null = null;
  let wroteToTarget = false;
  try {
    // 2. Fetch.
    const startedAt = deps.now();
    let backupKey: string;
    let encrypted: string;
    if (options.backupFile) {
      // The report allows letters, digits, dot, underscore and hyphen only.
      backupKey = `file:${baseName(options.backupFile).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "backup"}`;
      encrypted = options.backupFile;
      io.out(`Using the backup file ${baseName(options.backupFile)}.`);
    } else {
      const recorded = await deps.fetchRecordedBackup(recordUrl!, env.CRON_SECRET!.trim());
      if (!recorded) throw new DrillRefusal("The site has no backup recorded yet, so there is nothing to check a download against.");
      if (isFutureBackupKey(recorded.key, startedAt)) {
        throw new DrillRefusal(`The recorded backup ${recorded.key} is dated in the future. Check the backup cron and the bucket before restoring anything.`);
      }
      const keys = await deps.bucket!.listKeys("daily/");
      if (!keys.includes(recorded.key)) {
        throw new DrillRefusal(`The recorded backup ${recorded.key} is not in the bucket.`);
      }
      const newest = newestBackupKey(keys, startedAt);
      if (newest && newest !== recorded.key) {
        io.err(`The bucket's newest key ${newest} is not the backup the site recorded. The drill restores the recorded one, ${recorded.key}.`);
      }
      const key = recorded.key;
      backupKey = key;
      encrypted = joinPath(work, "backup.tar.age");
      io.out(`Fetching ${key}.`);
      await deps.bucket!.download(key, encrypted);
      const downloaded = await deps.fileFacts(encrypted);
      if (downloaded.bytes !== recorded.bytes || downloaded.sha256 !== recorded.sha256) {
        throw new DrillRefusal(
          `The downloaded ${key} does not match the size and sha256 the backup cron reported. Do not restore it; check who wrote to the bucket.`,
        );
      }
    }
    const fetched = deps.now();

    // 3. Decrypt and check the dumps against the manifest.
    io.out("Decrypting.");
    const tarPath = joinPath(work, "backup.tar");
    const archive = work;
    await deps.run("age", ["--decrypt", "--identity", options.identityFile, "--output", tarPath, encrypted]);
    await deps.run("tar", ["-xf", tarPath, "-C", archive, "manifest.json", "public.dump", "auth.dump"]);
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(await deps.readText(joinPath(archive, "manifest.json")));
    } catch {
      manifestJson = null;
    }
    const parsed = backupManifestSchema.safeParse(manifestJson);
    if (!parsed.success) throw new DrillRefusal("manifest.json in the backup is missing or not a format 1 manifest.");
    const manifest = parsed.data;
    const publicDump = joinPath(archive, "public.dump");
    const authDump = joinPath(archive, "auth.dump");
    const problems = dumpProblems(manifest, {
      "public.dump": await deps.fileFacts(publicDump),
      "auth.dump": await deps.fileFacts(authDump),
    });
    if (problems.length > 0) throw new DrillRefusal(`The backup is damaged: ${problems.join("; ")}.`);
    const dumpMajor = majorVersion(manifest.pgDumpVersion);
    if (dumpMajor !== null && pgRestoreMajor < dumpMajor) {
      throw new DrillRefusal(`pg_restore ${pgRestoreMajor} cannot read a pg_dump ${dumpMajor} archive. Install PostgreSQL ${dumpMajor} client tools (brew install postgresql@${dumpMajor}).`);
    }
    const decrypted = deps.now();

    // 4. The target must be the right major and fresh: no tables of ours
    // and no users yet, so nothing that was there before is ever cleared.
    db = deps.connect(options.target);
    const [server] = await db.query<{ version_num: string }>("select current_setting('server_version_num') as version_num");
    const targetMajor = majorOfVersionNum(server?.version_num ?? "");
    const sourceMajor = majorVersion(manifest.serverVersion);
    if (targetMajor === null || sourceMajor === null || targetMajor !== sourceMajor) {
      throw new DrillRefusal(
        `The drill database runs Postgres ${targetMajor ?? "unknown"} and production ${sourceMajor ?? "unknown"}. Set [db] major_version = ${sourceMajor ?? "the production major"} in the stack's supabase/config.toml and start it again.`,
      );
    }
    const [fresh] = await db.query<{ public_tables: number; auth_users: boolean }>(
      "select (select count(*)::int from pg_tables where schemaname = 'public') as public_tables, to_regclass('auth.users') is not null as auth_users",
    );
    if (!fresh?.auth_users) {
      throw new DrillRefusal("The drill database has no auth.users table. Restore into a Supabase stack (supabase start), not plain Postgres.");
    }
    const [users] = await db.query<{ n: number }>("select count(*)::int as n from auth.users");
    if ((fresh.public_tables ?? 0) > 0 || (users?.n ?? 0) > 0) {
      throw new DrillRefusal("The drill database is not fresh: it already has tables or users. Start a fresh stack (supabase stop --no-backup, then supabase start) and run the drill again.");
    }

    // 5. Schema from the migrations, never from the dump.
    wroteToTarget = true;
    io.out("Migrating the drill database (pnpm db:migrate).");
    await deps.run("pnpm", ["--filter", "@curvi/db", "db:migrate"], { cwd: deps.repoRoot, env: { DATABASE_URL: options.target } });
    await db.exec(verifySql);
    await db.query("select drill_check.snapshot_acl_baseline()");
    const migrated = deps.now();

    // 6. Clear what the migrations wrote, then load the data in one
    // transaction with triggers and foreign key checks off, failing every
    // live job before the transaction commits.
    io.out("Loading the data.");
    const tables = await db.query<{ name: string }>(
      "select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname = 'public' order by tablename",
    );
    if (tables.length > 0) {
      await db.exec(`truncate table ${tables.map((t) => t.name).join(", ")} restart identity cascade`);
    }
    const authSql = joinPath(work, "auth.sql");
    const publicSql = joinPath(work, "public.sql");
    await deps.run("pg_restore", ["--data-only", "--no-owner", "--no-privileges", `--file=${authSql}`, authDump]);
    await deps.run("pg_restore", ["--data-only", "--no-owner", "--no-privileges", "--schema=public", `--file=${publicSql}`, publicDump]);
    const loaded = await deps.run("psql", [
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--single-transaction",
      "--variable=ON_ERROR_STOP=1",
      `--dbname=${options.target}`,
      "--command=SET session_replication_role = replica",
      `--file=${authSql}`,
      `--file=${publicSql}`,
      "--command=SELECT 'live_jobs_failed=' || drill_check.fail_live_jobs()",
    ]);
    const failedJobs = /live_jobs_failed=(\d+)/.exec(loaded.stdout)?.[1] ?? "unknown";
    io.out(`Failed ${failedJobs} jobs that were live when the backup was taken.`);
    const restored = deps.now();

    // 7. Checks.
    io.out("Checking.");
    await db.exec("delete from drill_check.manifest_counts; delete from drill_check.expected;");
    const counts = Object.entries(manifest.counts);
    if (counts.length > 0) {
      await db.exec(
        `insert into drill_check.manifest_counts (table_name, expected) values ${counts
          .map(([table, count]) => `(${literal(table)}, ${Math.trunc(count)})`)
          .join(", ")}`,
      );
    }
    await db.exec(
      `insert into drill_check.expected (key, value) values ('ledger_total_tenths', ${literal(String(manifest.ledgerTotalTenths))}), ('latest_migration', ${
        manifest.latestMigration === null ? "null" : literal(manifest.latestMigration)
      })`,
    );
    const checks = await db.query<DrillCheck>("select check_name, ok, detail from drill_check.verify()");
    const finishedAt = deps.now();

    for (const check of checks) {
      io.out(`${check.ok ? "ok  " : "FAIL"}  ${check.check_name}: ${check.detail}`);
    }
    const passed = checks.length > 0 && checks.every((check) => check.ok);
    const durationSeconds = seconds(startedAt, finishedAt);
    const rto = restoreDrillPolicy.rtoTargetMinutes;
    const withinRto = durationSeconds <= rto * 60;
    io.out(
      `The drill took ${minutesText(durationSeconds)}, ${withinRto ? "inside" : "over"} the ${rto} minute recovery target.`,
    );
    if (!passed) {
      io.err("The drill failed: the backup did not restore cleanly. Nothing was recorded. See docs/ops/BACKUP_RESTORE.md, \"When the drill fails\".");
      return { passed: false, checks, report: null };
    }

    const body: RestoreDrillReport = {
      backupKey,
      backupCreatedAt: manifest.createdAt,
      target: guard.kind,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationSeconds,
      stepSeconds: {
        fetch: seconds(startedAt, fetched),
        decrypt: seconds(fetched, decrypted),
        migrate: seconds(decrypted, migrated),
        restore: seconds(migrated, restored),
        verify: seconds(restored, finishedAt),
      },
      checksPassed: checks.length,
      rowsRestored: rowsInBackup(manifest),
      latestMigration: manifest.latestMigration,
      rtoTargetMinutes: rto,
      withinRto,
    };
    if (report) {
      await deps.postReport(report.url, report.secret, body);
      io.out("Recorded on the site as restore_drill:last.");
    } else {
      io.out("Not recorded (--no-report).");
    }
    io.out(`Add a dated row to docs/verification.md: drill of ${backupKey}, ${minutesText(durationSeconds)}, ${checks.length} checks passed.`);
    return { passed: true, checks, report: body };
  } finally {
    // 8. Always: close, remove every decrypted file, destroy the drill database.
    if (db) {
      await db.close().catch(() => undefined);
    }
    await deps.removeDir(work).catch((err: unknown) => {
      io.err(`Could not remove ${work}: ${err instanceof Error ? err.message : String(err)}. Delete it by hand; it holds decrypted data.`);
    });
    if (wroteToTarget) {
      if (guard.kind === "local") {
        const args = ["stop", "--no-backup", ...(options.supabaseWorkdir ? ["--workdir", options.supabaseWorkdir] : [])];
        try {
          await deps.run("supabase", args);
          io.out("Destroyed the local stack (supabase stop --no-backup).");
        } catch {
          io.err(`Could not stop the local stack. Run supabase ${args.join(" ")} yourself now; it holds customer data.`);
        }
      } else {
        io.err(
          `Delete the throwaway project ${options.throwawayProject} now (Supabase dashboard, Project settings, Delete project); it holds customer data.`,
        );
      }
    }
  }
}
