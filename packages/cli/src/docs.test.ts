/**
 * Guards for the words around the CLI: the skill (skills/curvi/SKILL.md) and
 * the help text. The CLI sends bundle, look and channel values through
 * untouched, so the examples it and the skill print are checked here
 * against the seed and the registry (CLAUDE.md rule 2), and their prose
 * against the copy rules (rule 9).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUNDLE_KEYS, LOOK_KEYS } from "@curvi/pipeline/output-options";
import { hasSpec } from "@curvi/specs";
import { describe, expect, it } from "vitest";
import { CLI_VERSION, HELP } from "./cli.ts";

const SKILL_PATH = fileURLToPath(new URL("../../../skills/curvi/SKILL.md", import.meta.url));
const LICENSE_PATH = fileURLToPath(new URL("../../../skills/curvi/LICENSE", import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

const skill = readFileSync(SKILL_PATH, "utf8");

/** Rule 9: no emoji, no arrows, no en or em dashes, no " - " or "--" in prose. */
const FORBIDDEN_COPY = /[‒-―←-⇿⟵-⟿]|\s-\s|--|->|=>|\p{Extended_Pictographic}/u;

/** The skill's prose: front matter values, headings and text, without code. */
function skillProse(markdown: string): string[] {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*(#+|\d+\.|-(?=\s)|\|)\s*/, "").trim())
    .filter((line) => line.length > 0 && line !== "---" && !/^\|?[\s|:-]+\|?$/.test(line));
}

function codeSpans(markdown: string): string[] {
  const blocks = [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  const inline = [...markdown.replace(/```[\s\S]*?```/g, " ").matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
  return [...blocks, ...inline];
}

function flagValues(text: string, flag: string): string[] {
  return [...text.matchAll(new RegExp(`--${flag}[ =]([^\\s\`]+)`, "g"))]
    .map((m) => m[1] as string)
    .filter((value) => !value.startsWith("<"));
}

describe("skills/curvi", () => {
  it("names the skill curvi under the MIT license", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(front).toMatch(/^name: curvi$/m);
    expect(front).toMatch(/^license: MIT$/m);
    expect(front).toMatch(/^description: .{40,1024}$/m);
    expect(readFileSync(LICENSE_PATH, "utf8")).toMatch(/^MIT License/);
  });

  it("says the API and the CLI are coming soon while they are not live", () => {
    expect(skill).toMatch(/coming soon/i);
  });

  it("follows the copy rules in its prose", () => {
    for (const line of skillProse(skill)) {
      expect(line, line).not.toMatch(FORBIDDEN_COPY);
    }
  });

  it("only runs commands the CLI has", () => {
    const commands = codeSpans(skill)
      .flatMap((code) => code.split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("curvi "));
    expect(commands.length).toBeGreaterThan(3);
    const known = [/^curvi --version$/, /^curvi help$/, /^curvi auth (login|status|logout)\b/, /^curvi pack (create|get)\b/, /^curvi check\b/];
    for (const command of commands) {
      expect(known.some((pattern) => pattern.test(command)), command).toBe(true);
    }
  });

  it("uses real channel, bundle and look keys", () => {
    // Every --channels value, and the Channels column of the table.
    const tableCells = skill
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .flatMap((line) => [...line.matchAll(/`([a-z0-9_.,]+\.[a-z0-9_.,]+)`/g)].map((m) => m[1] as string));
    const channels = [...codeSpans(skill).flatMap((code) => flagValues(code, "channels")), ...tableCells].flatMap(
      (list) => list.split(","),
    );
    expect(channels.length).toBeGreaterThan(5);
    for (const channel of channels) expect(hasSpec(channel), channel).toBe(true);

    const paragraph = (start: string) => skill.split("\n").find((line) => line.startsWith(start)) ?? "";
    const keysIn = (line: string) => [...line.matchAll(/`(\w+)`/g)].map((m) => m[1] as string);

    const bundles = [...flagValues(skill, "bundle"), ...keysIn(paragraph("The bundle sets"))];
    expect(bundles.length).toBeGreaterThan(3);
    for (const bundle of bundles) expect(BUNDLE_KEYS as readonly string[], bundle).toContain(bundle);

    const looks = [...flagValues(skill, "look"), ...keysIn(paragraph("The look sets"))];
    expect(looks.length).toBeGreaterThan(1);
    for (const look of looks) expect(LOOK_KEYS as readonly string[], look).toContain(look);
  });
});

describe("the help text", () => {
  it("names real example keys", () => {
    const channels = /for example ([a-z0-9_.,]+)\./.exec(HELP)?.[1]?.split(",") ?? [];
    expect(channels.length).toBeGreaterThan(0);
    for (const channel of channels) expect(hasSpec(channel), channel).toBe(true);
    const bundle = /how much the pack makes, for example (\w+); the default is (\w+)\./.exec(HELP);
    expect(BUNDLE_KEYS as readonly string[]).toContain(bundle?.[1]);
    expect(BUNDLE_KEYS as readonly string[]).toContain(bundle?.[2]);
    const look = /starting style, for example (\w+)\./.exec(HELP)?.[1];
    expect(LOOK_KEYS as readonly string[]).toContain(look);
  });

  it("follows the copy rules outside the option names", () => {
    const prose = HELP.replace(/--[a-z-]+/g, "").replace(/\[|\]/g, "");
    expect(prose).not.toMatch(/[‒-―←-⇿⟵-⟿]|\s-\s|\p{Extended_Pictographic}/u);
  });

  it("reports the package version", () => {
    expect(JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).version).toBe(CLI_VERSION);
  });
});
