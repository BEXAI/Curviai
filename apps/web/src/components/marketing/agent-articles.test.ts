import { afterEach, describe, expect, it, vi } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { entitlementsFor, lowestTierWith, tiers } from "@curvi/pipeline/seed";
import { CODEX_KEY_ENV, codexConfigToml, mcpServerUrl } from "@/lib/agent-setup";
import { buildLlmsFullTxt, buildLlmsTxt, chatgptSummary } from "@/lib/llms";
import {
  FEATURES,
  isLive,
  plansWithPhrase,
  tierDisplayName,
  unqualifiedClaims,
  type AssumedStatuses,
} from "@/lib/marketing-facts";
import {
  AGENT_HELP_SLUG,
  CHATGPT_HELP_SLUG,
  agentHelpArticle,
  articleSnippet,
  chatgptHelpArticle,
  currentAgentFlags,
  helpArticles,
  type AgentFlags,
  type HelpArticle,
} from "./help-articles";

// PHASE_19 P19-24: the agent and ChatGPT help articles, llms.txt and the
// flags they are worded from. Every combination of the three flags is
// checked, so each flip (agentApi in wave 4, chatgptPlugin after
// publication, agentSkill when the CLI ships) needs no copy change.

const FLAG_SETS: AgentFlags[] = [false, true].flatMap((agentApi) =>
  [false, true].flatMap((agentSkill) =>
    [false, true].map((chatgptPlugin) => ({ agentApi, agentSkill, chatgptPlugin })),
  ),
);

function assumed(flags: AgentFlags): AssumedStatuses {
  const status = (live: boolean) => (live ? "live" : "coming_soon");
  return {
    agentApi: status(flags.agentApi),
    agentSkill: status(flags.agentSkill),
    chatgptPlugin: status(flags.chatgptPlugin),
  };
}

function articleText(article: HelpArticle): string {
  return [article.title, ...article.body].join(" ");
}

const LISTING = "https://chatgpt.com/apps/curvi";

describe("agent and ChatGPT help articles", () => {
  for (const flags of FLAG_SETS) {
    const label = JSON.stringify(flags);
    const articles = [agentHelpArticle(flags), chatgptHelpArticle(flags)];

    it(`never sell what is not live, ${label}`, () => {
      for (const article of articles) {
        const soon = article.status === "coming_soon";
        expect(article.structured, article.slug).toBe(soon ? "never" : "always");
        if (soon) {
          expect(article.body.join(" "), article.slug).toMatch(/coming soon/i);
        }
        // A live article claims nothing that is not live, title included. A
        // coming soon ChatGPT article says coming soon wherever its body
        // names a feature; the old agent article keeps its wording while the
        // API is coming soon.
        if (!soon) {
          expect(unqualifiedClaims(articleText(article), assumed(flags)), article.slug).toEqual([]);
        } else if (article.slug === CHATGPT_HELP_SLUG) {
          expect(unqualifiedClaims(article.body.join(" "), assumed(flags)), article.slug).toEqual([]);
        }
        for (const text of [...article.body, article.title, articleSnippet(article) ?? ""]) {
          expect(rule9Problems(text), text).toEqual([]);
        }
      }
    });

    it(`follow the flags, ${label}`, () => {
      const [agent, chatgpt] = articles;
      expect(agent.status === "coming_soon").toBe(!flags.agentApi);
      expect(chatgpt.status === "coming_soon").toBe(!flags.chatgptPlugin);
      // The Codex snippet needs an API key, so it shows once the API is live.
      expect(articleSnippet(chatgpt) !== null).toBe(flags.agentApi);
      expect(articleSnippet(agent)).toBeNull();
      if (flags.agentApi) {
        expect(/command line/.test(agent.title)).toBe(flags.agentSkill);
        expect(agent.body.join(" ")).toContain(plansWithPhrase("apiAccess"));
      }
      expect(chatgpt.body.join(" ")).toContain(plansWithPhrase("assistantAccess"));
    });
  }

  it("link the listing only once the plugin is live", () => {
    const live = { agentApi: true, agentSkill: false, chatgptPlugin: true };
    expect(articleText(chatgptHelpArticle(live, LISTING))).toContain(LISTING);
    expect(articleText(agentHelpArticle(live, LISTING))).toContain(LISTING);
    const soon = { ...live, chatgptPlugin: false };
    expect(articleText(chatgptHelpArticle(soon, LISTING))).not.toContain(LISTING);
    expect(articleText(agentHelpArticle(soon, LISTING))).not.toContain(LISTING);
    expect(chatgptSummary(true, LISTING)).toContain(LISTING);
    expect(chatgptSummary(false, LISTING)).not.toContain(LISTING);
  });

  it("sit in the help center from the current flags", () => {
    const slugs = helpArticles.map((article) => article.slug);
    expect(slugs.indexOf(CHATGPT_HELP_SLUG)).toBe(slugs.indexOf(AGENT_HELP_SLUG) + 1);
    // PHASE_19 names this anchor as the MCP server's resource_documentation.
    expect(CHATGPT_HELP_SLUG).toBe("use-curvi-in-chatgpt");
    const flags = currentAgentFlags();
    expect(helpArticles.find((article) => article.slug === CHATGPT_HELP_SLUG)).toEqual(chatgptHelpArticle(flags));
    expect(helpArticles.find((article) => article.slug === AGENT_HELP_SLUG)).toEqual(agentHelpArticle(flags));
  });
});

describe("the chatgptPlugin flag", () => {
  it("polices copy that says Curvi works in ChatGPT", () => {
    expect(FEATURES.chatgptPlugin.mentions.test(FEATURES.chatgptPlugin.label)).toBe(true);
    expect(unqualifiedClaims("Use Curvi in ChatGPT.", { chatgptPlugin: "coming_soon" })).toHaveLength(1);
    expect(unqualifiedClaims("The Curvi ChatGPT app makes packs.", { chatgptPlugin: "coming_soon" })).toHaveLength(1);
    expect(unqualifiedClaims("Curvi in ChatGPT is coming soon.", { chatgptPlugin: "coming_soon" })).toEqual([]);
    expect(unqualifiedClaims("Use Curvi in ChatGPT.", { chatgptPlugin: "live" })).toEqual([]);
    expect(unqualifiedClaims("Connect ChatGPT with your Curvi account.", { chatgptPlugin: "coming_soon" })).toEqual([]);
  });
});

describe("which plans", () => {
  it("come from the seed", () => {
    // PHASE_19 decision 3: every plan, Free included.
    expect(tiers.every((tier) => entitlementsFor(tier.key).features.includes("assistantAccess"))).toBe(true);
    expect(plansWithPhrase("assistantAccess")).toBe("every Curvi plan, the free plan included");
    const lowest = lowestTierWith("apiAccess");
    expect(lowest).not.toBeNull();
    expect(plansWithPhrase("apiAccess")).toBe(`the ${tierDisplayName(lowest?.key ?? "")} plan and up`);
  });
});

describe("Codex setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("matches the documented config.toml keys and this site's MCP URL", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://curvi.ai");
    expect(mcpServerUrl()).toBe("https://curvi.ai/api/mcp");
    expect(codexConfigToml()).toBe(
      ['[mcp_servers.curvi]', 'url = "https://curvi.ai/api/mcp"', `bearer_token_env_var = "${CODEX_KEY_ENV}"`].join("\n"),
    );
    expect(CODEX_KEY_ENV).toBe("CURVI_API_KEY");
  });
});

describe("llms.txt", () => {
  it("links the ChatGPT article only once its public URL is live", () => {
    const line = buildLlmsTxt()
      .split("\n")
      .find((entry) => entry.includes(`/help/${CHATGPT_HELP_SLUG}`));
    expect(Boolean(line)).toBe(isLive("chatgptPlugin"));
    if (line) expect(line).toContain("no API key");
    expect(chatgptSummary(false)).toMatch(/coming soon/);
    expect(chatgptSummary(true)).not.toMatch(/coming soon/);
    if (!isLive("chatgptPlugin")) {
      expect(buildLlmsTxt()).toContain(`- ${FEATURES.chatgptPlugin.label}`);
    }
  });

  it("carries the Codex snippet in the full text once the ChatGPT article is live", () => {
    const full = buildLlmsFullTxt();
    const structured = chatgptHelpArticle(currentAgentFlags());
    expect(full.includes("[mcp_servers.curvi]")).toBe(
      structured.structured === "always" && articleSnippet(structured) !== null,
    );
  });
});
