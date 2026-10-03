import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INDEXNOW_SITE, type IndexNowState } from "./model";
import { withStateDirectory } from "./state";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const MAX_STATE_BYTES = 5 * 1024 * 1024;
let root: string;
let directory: string;
const posix = process.platform !== "win32";

function state(): IndexNowState {
  return {
    version: 1, site: INDEXNOW_SITE, initializedAt: "2026-10-03T00:00:00.000Z",
    lastScanAt: "2026-10-03T00:00:00.000Z", entries: [],
    budget: { day: "2026-10-03", urlAttempts: 0 }, history: [],
  };
}

async function writeState(value: string | Buffer, mode = 0o600): Promise<void> {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(join(directory, "state.json"), value, { mode });
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "curvi-indexnow-state-test-"));
  directory = join(root, "private-state");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.open).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementation(actual.rename);
  vi.mocked(fs.open).mockImplementation(actual.open);
  await fs.rm(root, { recursive: true, force: true });
});

describe("IndexNow durable state directory", () => {
  it("creates private state, holds a PID-only lock and persists round trips", async () => {
    const result = await withStateDirectory(directory, async (store) => {
      expect(await store.read()).toBeNull();
      expect(await fs.readFile(join(directory, ".lock"), "utf8")).toBe(`${process.pid}\n`);
      if (posix) {
        expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(join(directory, ".lock"))).mode & 0o777).toBe(0o600);
      }
      await store.save(state());
      expect(await store.read()).toEqual(state());
      return "callback result";
    });
    expect(result).toBe("callback result");
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
    if (posix) expect((await fs.stat(join(directory, "state.json"))).mode & 0o777).toBe(0o600);
    await withStateDirectory(directory, async (store) => {
      expect(await store.read()).toEqual(state());
      const next = { ...state(), lastScanAt: "2026-10-03T01:00:00.000Z" };
      await store.save(next);
      expect(await store.read()).toEqual(next);
    });
  });

  it("rejects a concurrent callback without taking over its lock", async () => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const first = withStateDirectory(directory, async () => { enter(); await released; });
    await entered;
    const secondCallback = vi.fn();
    try {
      await expect(withStateDirectory(directory, secondCallback)).rejects.toThrow("directory is locked");
      expect(secondCallback).not.toHaveBeenCalled();
      expect(await fs.readFile(join(directory, ".lock"), "utf8")).toBe(`${process.pid}\n`);
    } finally { release(); await first; }
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("never takes over an existing lock even when its PID is absent", async () => {
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(join(directory, ".lock"), "999999999\n", { mode: 0o600 });
    await expect(withStateDirectory(directory, vi.fn())).rejects.toThrow("directory is locked");
    expect(await fs.readFile(join(directory, ".lock"), "utf8")).toBe("999999999\n");
  });

  it("releases its own lock after callback failure", async () => {
    const failure = new Error("Controlled callback failure");
    await expect(withStateDirectory(directory, async () => { throw failure; })).rejects.toBe(failure);
    expect(await fs.readdir(directory)).toEqual([]);
    await withStateDirectory(directory, async (store) => { await store.save(state()); });
  });

  it("refuses use after the callback releases its lock", async () => {
    const store = await withStateDirectory(directory, async (store) => store);
    await expect(store.read()).rejects.toThrow("store is closed");
    await expect(store.save(state())).rejects.toThrow("store is closed");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("serializes concurrent saves and keeps the last complete state", async () => {
    const next = { ...state(), lastScanAt: "2026-10-03T02:00:00.000Z" };
    await withStateDirectory(directory, async (store) => {
      await Promise.all([store.save(state()), store.save(next)]);
      expect(await store.read()).toEqual(next);
    });
    expect(JSON.parse(await fs.readFile(join(directory, "state.json"), "utf8"))).toEqual(next);
  });

  it("rejects relative paths and does not create missing parents", async () => {
    await expect(withStateDirectory("relative", vi.fn())).rejects.toThrow("must be absolute");
    await expect(withStateDirectory(join(root, "missing", "state"), vi.fn())).rejects.toThrow("parent must already exist");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(["plain", "trailing"])("rejects a %s symlink to the state directory", async (suffix) => {
    const target = join(root, "target");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, directory);
    await expect(withStateDirectory(`${directory}${suffix === "trailing" ? "/" : ""}`, vi.fn())).rejects.toThrow("without symlinks");
    expect(await fs.readdir(target)).toEqual([]);
  });

  it("rejects a regular file as the state directory", async () => {
    await fs.writeFile(directory, "preserve", { mode: 0o600 });
    await expect(withStateDirectory(directory, vi.fn())).rejects.toThrow("private directory");
    expect(await fs.readFile(directory, "utf8")).toBe("preserve");
  });

  it.skipIf(!posix).each([0o755, 0o710, 0o701])("rejects insecure directory mode %i", async (mode) => {
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chmod(directory, mode);
    await expect(withStateDirectory(directory, vi.fn())).rejects.toThrow("group/world permissions");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.skipIf(!posix)("rejects a directory reported as owned by another user", async () => {
    await fs.mkdir(directory, { mode: 0o700 });
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    await expect(withStateDirectory(directory, vi.fn())).rejects.toThrow("owned by the current user");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.each(["{", "", "secret-content-is-not-json", '{"version":1}']) (
    "preserves corrupt or truncated state without exposing contents: %j", async (contents) => {
      await writeState(contents);
      await expect(withStateDirectory(directory, async (store) => store.read())).rejects.toThrow(/corrupt|invalid/);
      await expect(withStateDirectory(directory, async (store) => store.save(state()))).rejects.toThrow(/corrupt|invalid/);
      expect(await fs.readFile(join(directory, "state.json"), "utf8")).toBe(contents);
      expect(await fs.readdir(directory)).toEqual(["state.json"]);
    },
  );

  it("rejects invalid UTF-8 instead of silently repairing state", async () => {
    await writeState(Buffer.from([0xc3, 0x28]));
    await expect(withStateDirectory(directory, async (store) => store.read())).rejects.toThrow("corrupt or truncated");
    expect(await fs.readFile(join(directory, "state.json"))).toEqual(Buffer.from([0xc3, 0x28]));
  });

  it("rejects oversized state before reading or replacing it", async () => {
    await writeState(Buffer.alloc(MAX_STATE_BYTES + 1, 0x20));
    await expect(withStateDirectory(directory, async (store) => store.read())).rejects.toThrow("5 MiB limit");
    await expect(withStateDirectory(directory, async (store) => store.save(state()))).rejects.toThrow("5 MiB limit");
    expect((await fs.stat(join(directory, "state.json"))).size).toBe(MAX_STATE_BYTES + 1);
  });

  it.each(["symlink", "directory", "hardlink"])("rejects a state file that is a %s", async (kind) => {
    await fs.mkdir(directory, { mode: 0o700 });
    const target = join(root, "target.json");
    const contents = JSON.stringify(state());
    await fs.writeFile(target, contents, { mode: 0o600 });
    const file = join(directory, "state.json");
    if (kind === "directory") await fs.mkdir(file, { mode: 0o700 });
    else if (kind === "symlink") await fs.symlink(target, file);
    else await fs.link(target, file);
    await expect(withStateDirectory(directory, async (store) => store.read())).rejects.toThrow("regular");
    await expect(withStateDirectory(directory, async (store) => store.save(state()))).rejects.toThrow("regular");
    expect(await fs.readFile(target, "utf8")).toBe(contents);
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  });

  it.skipIf(!posix).each([0o644, 0o640, 0o400])("rejects incorrect file mode %i", async (mode) => {
    await writeState(JSON.stringify(state()));
    await fs.chmod(join(directory, "state.json"), mode);
    await expect(withStateDirectory(directory, async (store) => store.read())).rejects.toThrow("mode 0600");
    await expect(withStateDirectory(directory, async (store) => store.save(state()))).rejects.toThrow("mode 0600");
  });

  it("rejects invalid proposed state before creating any state file", async () => {
    await expect(withStateDirectory(directory, async (store) => store.save({ ...state(), version: 2 } as unknown as IndexNowState)))
      .rejects.toThrow("state is invalid");
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.skipIf(!posix)("rejects a state file whose opened descriptor has a foreign owner", async () => {
    await writeState(JSON.stringify(state()));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === join(directory, "state.json")) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async () => {
          const result = await stat();
          result.uid += 1;
          return result;
        });
      }
      return handle;
    });
    await expect(withStateDirectory(directory, async (store) => store.read())).rejects.toThrow("owned by the current user");
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  });

  it("preserves prior state and removes its temporary file when file sync fails", async () => {
    const previous = JSON.stringify(state());
    await writeState(previous);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith(".tmp")) vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("private path failed"));
      return handle;
    });
    await expect(withStateDirectory(directory, async (store) => store.save({ ...state(), lastScanAt: "2026-10-03T03:00:00.000Z" })))
      .rejects.toThrow("could not flush the temporary file");
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.readFile(join(directory, "state.json"), "utf8")).toBe(previous);
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  });

  it("preserves prior state and cleans its temporary file when atomic replacement fails", async () => {
    const previous = JSON.stringify(state());
    await writeState(previous);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("ENOSPC private-secret-path/secret-content"));
    const next = { ...state(), lastScanAt: "2026-10-03T03:00:00.000Z" };
    const result = withStateDirectory(directory, async (store) => { await store.save(next); });
    await expect(result).rejects.toThrow("could not replace the state file atomically");
    await expect(result).rejects.not.toThrow("private-secret");
    expect(await fs.readFile(join(directory, "state.json"), "utf8")).toBe(previous);
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  });

  it("does not continue persistence after a failure even if the callback catches it", async () => {
    await writeState(JSON.stringify(state()));
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("controlled failure"));
    await expect(withStateDirectory(directory, async (store) => {
      await expect(store.save(state())).rejects.toThrow("atomically");
      await expect(store.save(state())).rejects.toThrow("atomically");
    })).rejects.toThrow("atomically");
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  });

  it("flushes the temporary file before rename and the directory after rename", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const events: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      const kind = String(args[0]).endsWith(".tmp") ? "temporary" : args[0] === directory ? "directory" : args[0] === root ? "parent" : "lock";
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { events.push(`${kind}:sync`); await sync(); });
      return handle;
    });
    vi.mocked(fs.rename).mockImplementation(async (...args) => { events.push("rename"); await actual.rename(...args); });
    await withStateDirectory(directory, async (store) => { await store.save(state()); });
    expect(events).toEqual(["lock:sync", "directory:sync", "parent:sync", "temporary:sync", "rename", "directory:sync", "directory:sync"]);
  });

  it("refuses the callback when the private directory cannot be durably linked in its parent", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const callback = vi.fn();
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === root) vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("private parent path failed"));
      return handle;
    });
    await expect(withStateDirectory(directory, callback)).rejects.toThrow("could not persist the private directory in its parent");
    expect(callback).not.toHaveBeenCalled();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("fails closed when directory sync fails after rename, leaving the complete new state for review", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (args[0] === directory && args[1] === (constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementationOnce(sync).mockRejectedValueOnce(new Error("private path failed")).mockImplementation(sync);
      }
      return handle;
    });
    await expect(withStateDirectory(directory, async (store) => { await store.save(state()); }))
      .rejects.toThrow("durability could not be confirmed");
    expect(JSON.parse(await fs.readFile(join(directory, "state.json"), "utf8"))).toEqual(state());
    expect(await fs.readdir(directory)).toEqual(["state.json"]);
  });

  it("does not delete a replacement lock owned by a different run", async () => {
    await expect(withStateDirectory(directory, async () => {
      await fs.rename(join(directory, ".lock"), join(directory, "original-lock"));
      await fs.writeFile(join(directory, ".lock"), "replacement\n", { mode: 0o600 });
    })).rejects.toThrow("lock changed");
    expect(await fs.readFile(join(directory, ".lock"), "utf8")).toBe("replacement\n");
    expect(await fs.readFile(join(directory, "original-lock"), "utf8")).toBe(`${process.pid}\n`);
  });

  it("rejects a directory replaced while the callback is running", async () => {
    await expect(withStateDirectory(directory, async (store) => {
      await fs.rename(directory, join(root, "original-directory"));
      await fs.mkdir(directory, { mode: 0o700 });
      await store.save(state());
    })).rejects.toThrow("directory changed");
    expect(await fs.readdir(directory)).toEqual([]);
    expect(await fs.readFile(join(root, "original-directory", ".lock"), "utf8")).toBe(`${process.pid}\n`);
  });
});
