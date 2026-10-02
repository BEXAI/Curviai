import { describe, expect, it } from "vitest";
import { rule9Problems } from "@curvi/pipeline";
import { CHAT_VIEW_FIELDS } from "@/lib/api-v1/chat-views";
import { unqualifiedClaims } from "@/lib/marketing-facts";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { retentionRows } from "@/lib/legal/retention";
import { SOURCE_RETENTION_DAYS } from "@/lib/trust/purge";
import { ASSISTANT_FIELDS } from "./assistant-fields";
import {
  REQUEST_LOG_RETENTION_DAYS,
  assistantPrivacy,
  assistantPrivacyText,
  collectAssistants,
  sharingAssistants,
} from "./privacy-copy";

// PHASE_19 P19-23: the privacy policy names every field the MCP tools can
// return to an assistant (OpenAI O5 and O6), the hints ChatGPT sends (O2),
// OpenAI as a recipient, and retention timelines for outputs and logs.

describe("privacy policy and the MCP chat views", () => {
  it("lists every chat view field, nested ones included, and nothing else", () => {
    const missing = CHAT_VIEW_FIELDS.filter((field) => !(field in ASSISTANT_FIELDS));
    expect(missing, "add these to assistant-fields.ts and the privacy copy").toEqual([]);
    const stale = Object.keys(ASSISTANT_FIELDS).filter((field) => !CHAT_VIEW_FIELDS.includes(field));
    expect(stale, "these fields left the chat views").toEqual([]);
  });

  it("uses words for each field that appear in the policy", () => {
    const text = assistantPrivacyText();
    for (const [field, phrase] of Object.entries(ASSISTANT_FIELDS)) {
      expect(text, `${field}: "${phrase}"`).toContain(phrase);
    }
  });

  it("names the sign in details, the client hints and the recipient", () => {
    const text = assistantPrivacyText();
    // OIDC: openid gives a private id, email the address; other scopes are
    // listed on the connect page.
    expect(text).toContain("a private id for your Curvi account and your email address");
    expect(text).toContain("which the connect page lists");
    // OpenAI's client _meta hints: locale, userLocation, userAgent, subject,
    // session, organization.
    for (const hint of [
      "your language",
      "city, region, country, time zone and rough coordinates",
      "the app or browser in use",
      "anonymous ids for you, the conversation and your organization",
    ]) {
      expect(text).toContain(hint);
    }
    expect(text).toContain("We do not store these hints.");
    expect(text).toContain("We do not receive your conversations.");
    expect(text).toContain("OpenAI for ChatGPT and Codex");
    expect(sharingAssistants).toContain("OpenAI receives them");
    expect(text).toContain("Settings, Connected apps");
  });

  it("states retention timelines for connections, logs and outputs", () => {
    expect(assistantPrivacy.retention).toContain(`kept for up to ${REQUEST_LOG_RETENTION_DAYS} days`);
    expect(assistantPrivacy.retention).toContain("stay until you close your account");
    // The privacy policy's retention table (lib/legal/retention.ts, P20-23)
    // replaced PHASE_19's retention paragraphs: the same timelines, one
    // source.
    expect(REQUEST_LOG_RETENTION_DAYS).toBe(LEGAL_FACTS.retention.logDays);
    const rows = Object.fromEntries(retentionRows(LEGAL_FACTS).map((row) => [row.key, row.howLong]));
    expect(rows.pack_files).toBe("We keep them while your account is open.");
    expect(rows.source_uploads).toContain(`once they are ${SOURCE_RETENTION_DAYS} days old`);
    expect(rows.source_uploads).toContain(`the last ${SOURCE_RETENTION_DAYS} days`);
    expect(rows.logs).toBe(`We keep them for up to ${REQUEST_LOG_RETENTION_DAYS} days.`);
    expect(rows.assistant_connections).toContain("until you close your account, including after you disconnect");
  });

  it("follows the copy rules and claims nothing that is not live", () => {
    for (const text of [assistantPrivacyText(), collectAssistants, sharingAssistants]) {
      expect(rule9Problems(text), text).toEqual([]);
      expect(unqualifiedClaims(text), text).toEqual([]);
    }
  });
});
