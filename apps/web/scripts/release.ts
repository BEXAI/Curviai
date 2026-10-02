import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { runRelease, assertReleaseHealth, type ReleaseHealth, type RenderDeploy } from "../src/lib/ops/release";
import { parseScriptArgs, runScript, ScriptRefusal } from "./cli";
import { command, jsonRequest, latestMigration, lightSmoke, repositoryRoot, siteOrigin, targetEnvironment, targetValue } from "./ops-client";

void runScript(async (argv, io) => {
  const args = parseScriptArgs(argv, { env: { type: "string" }, "staging-smoke": { type: "boolean", default: false }, "disable-auto-deploy": { type: "boolean", default: false } });
  const target = targetEnvironment(args.env);
  const root = repositoryRoot();
  const origin = siteOrigin(targetValue(target, "OPS_SITE_URL"));
  const cron = targetValue(target, "CRON_SECRET");
  const releaseToken = targetValue(target, "OPS_RELEASE_TOKEN");
  const operator = targetValue(target, "OPS_RELEASE_EMAIL");
  const renderKey = targetValue(target, "RENDER_API_KEY");
  const service = targetValue(target, "RENDER_SERVICE_ID");
  if (!/^srv-[a-z0-9]+$/.test(service)) throw new ScriptRefusal("RENDER_SERVICE_ID must identify a Render web service.");
  const stagingOrigin = args["staging-smoke"] ? siteOrigin(targetValue("staging", "OPS_SITE_URL")) : null;
  const stagingCron = stagingOrigin ? targetValue("staging", "CRON_SECRET") : null;
  if (stagingOrigin === origin) throw new ScriptRefusal("The staging smoke target must differ from the release target.");
  const base = `https://api.render.com/v1/services/${service}`;
  const abort = new AbortController();
  const stop = () => abort.abort(new ScriptRefusal("Release interrupted; clearing the deploy pause."));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await runRelease(latestMigration(root), {
      now: Date.now, wait: (ms) => delay(ms, undefined, { signal: abort.signal }), log: io.out,
      async preflight() {
        const sha = await command("git", ["rev-parse", "HEAD"], root);
        const clean = !(await command("git", ["status", "--porcelain"], root));
        const branch = await command("git", ["symbolic-ref", "--short", "HEAD"], root);
        const remote = await command("git", ["config", `branch.${branch}.remote`], root);
        const merge = await command("git", ["config", `branch.${branch}.merge`], root);
        if (!remote || remote === "." || !merge.startsWith("refs/heads/")) throw new ScriptRefusal("The branch needs a pushed remote upstream.");
        const pushedSha = (await command("git", ["ls-remote", "--exit-code", remote, merge], root)).split(/\s+/)[0];
        const runs = JSON.parse(await command("gh", ["run", "list", "--workflow", "ci.yml", "--commit", sha, "--limit", "20", "--json", "headSha,status,conclusion,event"], root)) as { headSha: string; status: string; conclusion: string; event: string }[];
        const latest = runs.find((run) => run.headSha === sha && run.event === "push");
        return { sha, clean, pushed: pushedSha === sha, ciPassed: latest?.status === "completed" && latest.conclusion === "success" };
      },
      health: () => jsonRequest<ReleaseHealth>(`${origin}/api/health`, cron),
      ...(stagingOrigin && stagingCron ? { stagingSmoke: async (sha: string) => { assertReleaseHealth(await jsonRequest<ReleaseHealth>(`${stagingOrigin}/api/health`, stagingCron), sha); await lightSmoke(stagingOrigin); } } : {}),
      setPending: async (on) => { const result = await jsonRequest<{ ok: boolean; on: boolean }>(`${origin}/api/ops/deploy-pending`, releaseToken, "POST", { on, setBy: operator }); if (result.ok !== true || result.on !== on) throw new ScriptRefusal("Deploy pause write was not confirmed."); },
      async currentDeploy() { const rows = await jsonRequest<{ deploy: RenderDeploy }[]>(`${base}/deploys?status=live&limit=1`, renderKey); if (!rows[0]?.deploy) throw new ScriptRefusal("No live Render deploy found."); return rows[0].deploy; },
      ...(args["disable-auto-deploy"] ? { disableAutoDeploy: async () => { const current = await jsonRequest<{ autoDeployTrigger?: string }>(base, renderKey); if (current.autoDeployTrigger !== "off") await jsonRequest(base, renderKey, "PATCH", { autoDeployTrigger: "off" }); } } : {}),
      createDeploy: (sha) => jsonRequest<RenderDeploy>(`${base}/deploys`, renderKey, "POST", { commitId: sha }),
      readDeploy: (id) => jsonRequest<RenderDeploy>(`${base}/deploys/${encodeURIComponent(id)}`, renderKey),
      probeProviders: async () => (await jsonRequest<{ ok: boolean }>(`${origin}/api/health/providers`, cron)).ok === true,
      smoke: () => lightSmoke(origin),
      async confirm(_reason, question) {
        if (!process.stdin.isTTY || abort.signal.aborted) return false;
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { return (await input.question(`${question} Type yes to continue: `, { signal: abort.signal })).trim().toLowerCase() === "yes"; } finally { input.close(); }
      },
      rollback: (id) => jsonRequest<RenderDeploy>(`${base}/rollback`, renderKey, "POST", { deployId: id }),
      tag: async (name, sha) => { await command("git", ["tag", name, sha], root); },
    }, abort.signal);
    io.out(`Verified ${result.sha} live (${result.deployId}); created local tag ${result.tag}. ${args["disable-auto-deploy"] ? "Auto deploy remains off." : "The existing auto-deploy policy was preserved."}`);
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
});
