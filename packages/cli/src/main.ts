/**
 * The process entry for bin/curvi.js: wires run() to the real terminal,
 * file system, clock and fetch.
 */

import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { run } from "./cli.ts";

/** Reads a key from a pipe, or asks for it on a terminal without echoing it. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write(prompt);
  // Keep the pasted key off the screen: swallow the echo readline would write.
  const output = rl as unknown as { _writeToOutput?: (text: string) => void };
  output._writeToOutput = () => {};
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    process.stderr.write("\n");
  }
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  cwd: process.cwd(),
  fetch: (input, init) => fetch(input, init),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readSecret,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});
process.exitCode = code;
