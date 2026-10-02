/**
 * Entry for pnpm --filter @curvi/trigger smoke:iptc <object key>
 * (P18-09 part 2). See smoke-iptc.ts. Read only: it never writes to R2 or
 * the database.
 */

import { endExiftool, readDigitalSourceTypeValue } from "@curvi/pipeline";
import { buildR2Handoff } from "./r2";
import { checkDeliveredFile, parseSmokeIptcArgs, SMOKE_IPTC_USAGE } from "./smoke-iptc";

async function main(): Promise<void> {
  const args = parseSmokeIptcArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.message);
    process.exitCode = 1;
    return;
  }
  const r2 = buildR2Handoff();
  if (!r2) {
    console.error(`R2 is not configured in this shell.\n\n${SMOKE_IPTC_USAGE}`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await checkDeliveredFile(args, { get: (key) => r2.get(key), readValue: readDigitalSourceTypeValue });
    for (const line of result.lines) {
      (result.ok ? console.log : console.error)(line);
    }
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await endExiftool();
  }
}

void main();
