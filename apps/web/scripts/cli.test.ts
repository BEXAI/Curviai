import { describe, expect, it } from "vitest";
import { ScriptRefusal, parseScriptArgs, runScript, type ScriptIo } from "./cli";

// docs/phases/PHASE_20.md: the shared runner for apps/web/scripts.

function capture(): ScriptIo & { lines: string[] } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(`out: ${line}`), err: (line) => lines.push(`err: ${line}`) };
}

describe("runScript", () => {
  it("passes the arguments and exits 0 when main returns nothing", async () => {
    const io = capture();
    const codes: number[] = [];
    const code = await runScript(
      async (argv, out) => {
        out.out(`args ${argv.join(" ")}`);
      },
      { argv: ["--days", "30"], io, setExitCode: (c) => codes.push(c) },
    );
    expect(code).toBe(0);
    expect(codes).toEqual([0]);
    expect(io.lines).toEqual(["out: args --days 30"]);
  });

  it("uses the code main returns", async () => {
    expect(await runScript(async () => 3, { argv: [], io: capture(), setExitCode: () => {} })).toBe(3);
  });

  it("prints a refusal without a stack and exits 1", async () => {
    const io = capture();
    const code = await runScript(
      async () => {
        throw new ScriptRefusal("OPS_OPERATOR_EMAIL is not in OPS_EMAILS.");
      },
      { argv: [], io, setExitCode: () => {} },
    );
    expect(code).toBe(1);
    expect(io.lines).toEqual(["err: OPS_OPERATOR_EMAIL is not in OPS_EMAILS."]);
  });

  it("prints any other error and exits 1", async () => {
    const io = capture();
    const code = await runScript(
      async () => {
        throw new Error("connection refused");
      },
      { argv: [], io, setExitCode: () => {} },
    );
    expect(code).toBe(1);
    expect(io.lines[0]).toMatch(/^err: Failed: Error: connection refused/);
  });
});

describe("parseScriptArgs", () => {
  const options = { workspace: { type: "string" }, days: { type: "string" }, "dry-run": { type: "boolean" } } as const;

  it("reads known flags", () => {
    expect(parseScriptArgs(["--workspace", "w1", "--dry-run"], options)).toEqual({ workspace: "w1", "dry-run": true });
  });

  it("refuses an unknown flag or a stray argument", () => {
    expect(() => parseScriptArgs(["--workspce", "w1"], options)).toThrow(ScriptRefusal);
    expect(() => parseScriptArgs(["w1"], options)).toThrow(ScriptRefusal);
  });
});
