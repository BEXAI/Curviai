import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptIo } from "./cli";

const state = vi.hoisted(() => ({
  main: undefined as ((argv: string[], io: ScriptIo) => Promise<number | void>) | undefined,
  connect: vi.fn(), execute: vi.fn(), select: vi.fn(), close: vi.fn(), command: vi.fn(), request: vi.fn(),
}));
vi.mock("./cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli")>();
  return { ...actual, runScript: (main: typeof state.main) => { state.main = main; return Promise.resolve(0); } };
});
vi.mock("@curvi/db", async (importOriginal) => ({ ...await importOriginal<typeof import("@curvi/db")>(), createDb: state.connect }));
vi.mock("./ops-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./ops-client")>(), command: state.command, jsonRequest: state.request,
}));
vi.mock("../src/lib/recipe-drift", () => ({ readRecipeRows: vi.fn(async () => []), compareRecipes: vi.fn(() => []) }));
import { latestMigration, repositoryRoot } from "./ops-client";
import "./ops-migrate";

const prod = { database: "postgres://synthetic:synthetic@db.example.test/production", origin: "https://production.example.test", cron: "fake-production-cron" };
const staging = { database: "postgres://synthetic:synthetic@db.example.test/staging", origin: "https://staging.example.test", cron: "fake-staging-cron" };
const root = repositoryRoot();
const latest = latestMigration(root);
const { runScript } = await vi.importActual<typeof import("./cli")>("./cli");
async function run(argv: string[]) {
  const lines: string[] = [];
  if (!state.main) throw new Error("Migration script did not register its entry point.");
  const code = await runScript(state.main, { argv, io: { out: (line) => lines.push(line), err: (line) => lines.push(line) }, setExitCode: () => {} });
  return { code, lines };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", prod.database);
  vi.stubEnv("OPS_SITE_URL", prod.origin);
  vi.stubEnv("CRON_SECRET", prod.cron);
  vi.stubEnv("STAGING_DATABASE_URL", staging.database);
  vi.stubEnv("STAGING_OPS_SITE_URL", staging.origin);
  vi.stubEnv("STAGING_CRON_SECRET", staging.cron);
  for (const key of ["RENDER_API_KEY", "RENDER_BACKUP_CRON_ID", "BACKUP_AGE_RECIPIENT", "BACKUP_R2_BUCKET"]) {
    vi.stubEnv(key, ""); vi.stubEnv(`STAGING_${key}`, "");
  }
  state.connect.mockReturnValue({ execute: state.execute, select: state.select, $client: { end: state.close } });
  state.execute.mockResolvedValue([{ created_at: String(latest.when) }]);
  state.select.mockImplementation(() => { throw new Error("Unexpected platform setting read."); });
  state.close.mockResolvedValue(undefined);
  state.command.mockResolvedValue("");
  state.request.mockResolvedValue({ checks: { schema: "current" } });
});
afterEach(() => vi.unstubAllEnvs());

describe("ops:migrate CLI", () => {
  it.each(["prod", "staging"] as const)("migrates %s without backup configuration, report reads or external backup calls", async (target) => {
    const config = target === "prod" ? prod : staging;
    const result = await run(["--env", target]);
    expect(result).toEqual({ code: 0, lines: ["Migration verified. Application schema is current."] });
    expect(state.connect).toHaveBeenCalledExactlyOnceWith(config.database, { max: 1, prepare: false });
    expect(state.command).toHaveBeenCalledExactlyOnceWith("pnpm", ["--filter", "@curvi/db", "db:migrate"], root, expect.objectContaining({ DATABASE_URL: config.database }));
    expect(state.select).not.toHaveBeenCalled();
    expect(state.execute).toHaveBeenCalledOnce();
    expect(state.request).toHaveBeenCalledExactlyOnceWith(`${config.origin}/api/health`, config.cron);
    expect(state.close).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
  it.each([
    ["--env", "prod", "--backup-now"],
    ["--env", "prod", "--force"],
    ["--env", "prod", "unexpected"],
    ["--env", "preview"],
    [],
  ])("refuses retired or invalid arguments before connecting: %j", async (...argv) => {
    expect((await run(argv)).code).toBe(1);
    expect(state.connect).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
    expect(state.request).not.toHaveBeenCalled();
  });
  it.each(["DATABASE_URL", "OPS_SITE_URL"])("refuses staging when %s is shared with production", async (key) => {
    vi.stubEnv(`STAGING_${key}`, key === "DATABASE_URL" ? prod.database : prod.origin);
    expect(await run(["--env", "staging"])).toEqual({ code: 1, lines: ["Staging must use a separate database and site."] });
    expect(state.connect).not.toHaveBeenCalled();
    expect(state.command).not.toHaveBeenCalled();
  });
  it.each([undefined, "invalid", String(latest.when - 1), String(latest.when + 1)])("refuses a missing or mismatched exact journal timestamp: %s", async (createdAt) => {
    state.execute.mockResolvedValue(createdAt === undefined ? [] : [{ created_at: createdAt }]);
    const result = await run(["--env", "prod"]);
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("Drizzle did not record the expected migration");
    expect(state.command).toHaveBeenCalledOnce();
    expect(state.request).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("seeds only on request after verified migration and redacts operator flag metadata", async () => {
    state.select.mockReturnValue({ from: () => ({ where: async () => [
      { key: "ops:packs_paused", value: { on: true, actor: "private-operator@example.test", note: "private operator note" } },
    ] }) });
    const result = await run(["--env", "prod", "--seed"]);
    expect(result.code).toBe(0);
    expect(state.command.mock.calls.map((call) => call[1])).toEqual([["--filter", "@curvi/db", "db:migrate"], ["db:seed"]]);
    expect(state.command.mock.invocationCallOrder[0]).toBeLessThan(state.execute.mock.invocationCallOrder[0]!);
    expect(state.execute.mock.invocationCallOrder[0]).toBeLessThan(state.command.mock.invocationCallOrder[1]!);
    expect(result.lines.join("\n")).toContain('"preserved": true');
    expect(result.lines.join("\n")).not.toContain("private-operator");
    expect(result.lines.join("\n")).not.toContain("private operator note");
    expect(state.request).toHaveBeenCalledExactlyOnceWith(`${prod.origin}/api/health`, prod.cron);
  });
  it("closes the connection and preserves command refusal without downstream work", async () => {
    const { ScriptRefusal } = await vi.importActual<typeof import("./cli")>("./cli");
    state.command.mockRejectedValueOnce(new ScriptRefusal("pnpm failed. Review that command locally with credentials kept private."));
    const result = await run(["--env", "prod"]);
    expect(result).toEqual({ code: 1, lines: ["pnpm failed. Review that command locally with credentials kept private."] });
    expect(result.lines.join("\n")).not.toContain(prod.database);
    expect(result.lines.join("\n")).not.toContain(prod.cron);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.request).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledOnce();
  });
});
