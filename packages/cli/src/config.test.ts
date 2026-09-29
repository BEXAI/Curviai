import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL } from "./client.ts";
import {
  assertKeyTarget,
  checkApiUrl,
  configDir,
  configPath,
  maskKey,
  readConfig,
  resolveAuth,
  writeConfig,
  type ConfigEnv,
} from "./config.ts";

describe("configDir", () => {
  const home = "/home/sam";

  it("follows CURVI_CONFIG_DIR first", () => {
    expect(configDir({ env: { CURVI_CONFIG_DIR: "/tmp/c" }, platform: "linux", homedir: home })).toBe("/tmp/c");
  });

  it("uses the platform's user config folder", () => {
    expect(configDir({ env: {}, platform: "linux", homedir: home })).toBe("/home/sam/.config/curvi");
    expect(configDir({ env: { XDG_CONFIG_HOME: "/x" }, platform: "linux", homedir: home })).toBe("/x/curvi");
    expect(configDir({ env: {}, platform: "darwin", homedir: home })).toBe(
      "/home/sam/Library/Application Support/curvi",
    );
    expect(configDir({ env: { APPDATA: "C:/Users/sam/AppData/Roaming" }, platform: "win32", homedir: home })).toBe(
      join("C:/Users/sam/AppData/Roaming", "curvi"),
    );
  });
});

describe("the config file", () => {
  let dir: string;
  let where: ConfigEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "curvi-config-"));
    where = { env: { CURVI_CONFIG_DIR: join(dir, "nested") }, platform: process.platform, homedir: dir };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads as empty when missing or broken", async () => {
    expect(await readConfig(where)).toEqual({});
    await writeConfig(where, {});
    await writeFile(configPath(where), "{not json");
    expect(await readConfig(where)).toEqual({});
  });

  it("round trips the key, readable by the owner only", async () => {
    const path = await writeConfig(where, { apiKey: "curvi_test_abc", apiUrl: "http://localhost:3000/api/v1" });
    expect(await readConfig(where)).toEqual({ apiKey: "curvi_test_abc", apiUrl: "http://localhost:3000/api/v1" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      apiKey: "curvi_test_abc",
      apiUrl: "http://localhost:3000/api/v1",
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("drops fields of the wrong type", async () => {
    await writeConfig(where, {});
    await writeFile(configPath(where), JSON.stringify({ apiKey: 42, apiUrl: "http://x" }));
    expect(await readConfig(where)).toEqual({ apiUrl: "http://x" });
  });
});

describe("resolveAuth", () => {
  it("lets the environment win over the saved settings, and a flag win over both for the URL", () => {
    const stored = { apiKey: "saved", apiUrl: "http://saved" };
    expect(resolveAuth({}, stored)).toEqual({ apiKey: "saved", apiUrl: "http://saved", keySource: "config" });
    expect(resolveAuth({ CURVI_API_KEY: "env", CURVI_API_URL: "http://env" }, stored)).toEqual({
      apiKey: "env",
      apiUrl: "http://env",
      keySource: "env",
    });
    expect(resolveAuth({ CURVI_API_URL: "http://env" }, stored, "http://flag").apiUrl).toBe("http://flag");
    expect(resolveAuth({ CURVI_API_KEY: "  " }, {})).toEqual({ apiKey: null, apiUrl: DEFAULT_BASE_URL, keySource: null });
  });
});

describe("checkApiUrl and assertKeyTarget", () => {
  it("allows https anywhere and plain http on this machine only", () => {
    expect(checkApiUrl("https://curvi.ai/api/v1").origin).toBe("https://curvi.ai");
    for (const local of ["http://localhost:3000/api/v1", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(() => checkApiUrl(local)).not.toThrow();
    }
    for (const bad of ["http://evil.example", "http://localhost.evil.example", "ftp://curvi.ai", "curvi.ai", "javascript:alert(1)"]) {
      expect(() => checkApiUrl(bad)).toThrow();
    }
  });

  it("binds a saved key to the origin it was saved for", () => {
    const stored = { apiKey: "saved" };
    expect(() => assertKeyTarget(resolveAuth({}, stored), stored)).not.toThrow();
    expect(() => assertKeyTarget(resolveAuth({}, stored, "https://curvi.ai/other"), stored)).not.toThrow();
    expect(() => assertKeyTarget(resolveAuth({}, stored, "https://evil.example/api/v1"), stored)).toThrow(
      /saved key is for https:\/\/curvi.ai/,
    );
    expect(() => assertKeyTarget(resolveAuth({ CURVI_API_URL: "https://evil.example" }, stored), stored)).toThrow();
    const env = { CURVI_API_KEY: "env", CURVI_API_URL: "https://staging.example" };
    expect(() => assertKeyTarget(resolveAuth(env, stored), stored)).not.toThrow();
    expect(() => assertKeyTarget(resolveAuth({ ...env, CURVI_API_URL: "http://staging.example" }, stored), stored)).toThrow();
  });
});

describe("maskKey", () => {
  it("never shows the whole key", () => {
    const key = "curvi_live_abcdefghijklmnopqrstuvwxyz";
    expect(maskKey(key)).toBe("curvi_live...wxyz");
    expect(maskKey("short")).toBe("sh...");
  });
});
