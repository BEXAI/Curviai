import { optionalEnv } from "../../src/lib/env";
import { runScript, ScriptRefusal } from "../cli";
import { runIndexNow } from "./command";

void runScript(async (argv, io) => {
  try { return await runIndexNow(argv, io.out); }
  catch (error) {
    const key = optionalEnv("INDEXNOW_KEY");
    const message = error instanceof Error ? error.message : "IndexNow run failed; preserve local state and review before retrying.";
    // No stack, response body, key or public proof filename in CLI errors.
    throw new ScriptRefusal(key ? message.replaceAll(key, "[redacted]") : message);
  }
});
