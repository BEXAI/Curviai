/**
 * pnpm ops:restore-drill (docs/phases/PHASE_20.md P20-11): restores the
 * newest nightly backup into an isolated database, checks it and records
 * how long it took. The runbook is docs/ops/BACKUP_RESTORE.md, "The restore
 * drill"; the steps and the target guard are in
 * apps/web/src/lib/ops/restore-drill.ts.
 *
 *   pnpm ops:restore-drill --target postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     --identity ~/curvi-backup.key --supabase-workdir ~/curvi-drill --report-to https://curvi.ai
 *
 * Flags:
 *   --target <url>              the drill database (a local Supabase stack, or the fallback below)
 *   --identity <file>           the founder's age key file (the private key)
 *   --backup <file>             an encrypted backup on disk instead of the newest in the bucket
 *   --throwaway-project <ref>   allow a throwaway Supabase project with this ref as the target
 *   --supabase-workdir <dir>    where `supabase start` ran, so the drill can stop it
 *   --report-to <origin>        the site to record the drill on (default NEXT_PUBLIC_SITE_URL)
 *   --no-report                 run without recording
 *
 * From the shell: CRON_SECRET (the site's value) to record the drill and,
 * when fetching from the bucket, to read the backup the site recorded (the
 * drill restores that file and refuses one whose size or sha256 differs);
 * BACKUP_R2_ACCOUNT_ID, BACKUP_R2_BUCKET, BACKUP_R2_ACCESS_KEY_ID and
 * BACKUP_R2_SECRET_ACCESS_KEY (a read only token) to fetch from the bucket.
 * DATABASE_URL, BACKUP_DATABASE_URL, STAGING_DATABASE_URL,
 * NEXT_PUBLIC_SUPABASE_URL and STAGING_SUPABASE_URL, when set, name
 * databases the drill refuses to touch. Needs Docker with the Supabase CLI,
 * age, and PostgreSQL client tools of the production major (psql and
 * pg_restore), with the CVE-2025-8714 fix (17.6 or later on 17).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { createDb } from "@curvi/db";
import { DrillRefusal, runRestoreDrill, type DrillDatabase, type RestoreDrillDeps } from "@/lib/ops/restore-drill";
import { ScriptRefusal, parseScriptArgs, runScript, type ScriptIo } from "./cli";

const USAGE =
  "Usage: pnpm ops:restore-drill --target <drill database url> --identity <age key file> [--backup <file>] [--throwaway-project <ref>] [--supabase-workdir <dir>] [--report-to <origin> | --no-report]. See docs/ops/BACKUP_RESTORE.md.";

/** The folder holding pnpm-workspace.yaml, from wherever pnpm started the script. */
function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new ScriptRefusal("Run this from inside the Curvi repository.");
    dir = parent;
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(new Error(`${command} could not start: ${err.message}. Is it installed?`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout });
        return;
      }
      // The arguments can hold the drill database's password; only the
      // program's own last lines are shown.
      const tail = stderr.trim().split("\n").slice(-5).join("\n");
      reject(new Error(`${command} exited with code ${code}${tail ? `:\n${tail}` : ""}`));
    });
  });
}

function sha256File(path: string): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    createReadStream(path)
      .on("data", (chunk: string | Buffer) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytes += buffer.length;
        hash.update(buffer);
      })
      .on("error", reject)
      .on("end", () => resolvePromise({ bytes, sha256: hash.digest("hex") }));
  });
}

function backupBucket(env: NodeJS.ProcessEnv): RestoreDrillDeps["bucket"] {
  const accountId = env.BACKUP_R2_ACCOUNT_ID?.trim();
  const bucket = env.BACKUP_R2_BUCKET?.trim();
  const accessKeyId = env.BACKUP_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.BACKUP_R2_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    async listKeys(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async download(key, path) {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!(object.Body instanceof Readable)) throw new Error(`The bucket returned no body for ${key}.`);
      await pipeline(object.Body, createWriteStream(path, { mode: 0o600 }));
    },
  };
}

function drillDatabase(url: string): DrillDatabase {
  // One connection, so the session the checks run in is the one that
  // loaded them; prepare off, like the app's pooled connection.
  const sql = createDb(url, { max: 1, prepare: false }).$client;
  return {
    async exec(text) {
      await sql.unsafe(text).simple();
    },
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params as never[])) as unknown as T[];
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}

async function postReport(url: string, secret: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`The site answered ${res.status} to the drill report. The drill passed; run it again once the site accepts reports.`);
  }
}

/** GET /api/cron/backup-report: the backup the site recorded. */
async function fetchRecordedBackup(url: string, secret: string): Promise<{ key: string; bytes: number; sha256: string } | null> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`The site answered ${res.status} when asked for the recorded backup. Check CRON_SECRET and --report-to.`);
  }
  const body = (await res.json()) as { key?: unknown; bytes?: unknown; sha256?: unknown };
  if (typeof body.key !== "string" || typeof body.bytes !== "number" || typeof body.sha256 !== "string") {
    throw new Error("The site's recorded backup has an unexpected shape.");
  }
  return { key: body.key, bytes: body.bytes, sha256: body.sha256 };
}

function realDeps(io: ScriptIo): RestoreDrillDeps {
  return {
    env: process.env,
    io,
    now: () => new Date(),
    run: runCommand,
    makeTempDir: () => mkdtemp(join(tmpdir(), "curvi-drill-")),
    removeDir: (path) => rm(path, { recursive: true, force: true }),
    readText: (path) => readFile(path, "utf8"),
    fileFacts: sha256File,
    bucket: backupBucket(process.env),
    fetchRecordedBackup,
    connect: drillDatabase,
    postReport,
    repoRoot: findRepoRoot(process.cwd()),
  };
}

void runScript(async (argv, io) => {
  const args = parseScriptArgs(argv, {
    target: { type: "string" },
    identity: { type: "string" },
    backup: { type: "string" },
    "throwaway-project": { type: "string" },
    "supabase-workdir": { type: "string" },
    "report-to": { type: "string" },
    "no-report": { type: "boolean" },
  });
  if (!args.target || !args.identity) {
    throw new ScriptRefusal(USAGE);
  }
  // pnpm runs package scripts in apps/web; paths are relative to where the
  // founder typed the command (INIT_CWD).
  const from = process.env.INIT_CWD ?? process.cwd();
  try {
    const result = await runRestoreDrill(
      {
        target: args.target,
        identityFile: resolve(from, args.identity),
        backupFile: args.backup ? resolve(from, args.backup) : undefined,
        throwawayProject: args["throwaway-project"],
        supabaseWorkdir: args["supabase-workdir"] ? resolve(from, args["supabase-workdir"]) : undefined,
        report: args["no-report"] ? false : (args["report-to"] ?? process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? undefined) || undefined,
        recordFrom: (args["report-to"] ?? process.env.NEXT_PUBLIC_SITE_URL?.trim() ?? undefined) || undefined,
      },
      realDeps(io),
    );
    return result.passed ? 0 : 1;
  } catch (err) {
    if (err instanceof DrillRefusal) throw new ScriptRefusal(err.message);
    throw err;
  }
});
