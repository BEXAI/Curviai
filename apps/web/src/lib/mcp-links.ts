/**
 * Lasting preview and download links for the files an assistant shares
 * (docs/phases/PHASE_19.md, P19-17 and decision 7). get_pack gives every
 * delivered file a link on curvi.ai that works for 24 hours, so a link
 * copied into a long chat still works the next day:
 *
 * - /api/mcp/preview/{token}: a bounded JPEG with no metadata (images only).
 * - /api/mcp/files/{token}: a redirect to a freshly signed 15 minute storage
 *   link that saves the file under its name (zips and the report too).
 *
 * A token is `<kid>.<iv>.<sealed>`: the JSON claims (the connection or API
 * key that made it, the workspace, job, file, link kind and expiry) sealed
 * with AES-256-GCM under a key derived from the MCP_LINK_KEYS ring
 * (lib/mcp-signing, purpose "link", so a quote can never pass as a link).
 * Only the kid can be read: the ids and the expiry stay out of the chat
 * (OpenAI O6, R12), and the tag fails on any change, the kid included. The
 * newest key seals and every key opens; an old key is kept 24 hours after a
 * rotation so its links run out first.
 *
 * Every click checks again, before anything is served: the signature and
 * expiry, the connection still live (or the key not revoked) and its member
 * still in the workspace (one read cached for 60 seconds), and the file
 * still in that job and workspace. Query parameters are never read, because
 * ChatGPT may append ?redirectUrl= (O2). Tokens and links are never logged.
 */

import { NextResponse } from "next/server";
import type { ApiCaller } from "@/lib/api-keys/auth";
import { MCP_COPY } from "@/lib/api-v1/mcp-copy";
import { isR2Configured, optionalEnv, siteUrl } from "@/lib/env";
import { mcpOAuthEnabled } from "@/lib/mcp-auth/config";
import {
  SigningKeyConfigError,
  openPayload,
  parseSigningKeys,
  sealPayload,
  type SigningKey,
} from "@/lib/mcp-signing";
import { limitByIp, limitByUser } from "@/lib/rate-limit";
import { DemoModeRefusedError } from "@/lib/services/demo-mode";
import type { JobFileView } from "@/lib/services/types";
import { isUuid } from "@/lib/validation/ids";

/** How long a shared link works (decision 7). */
export const MCP_LINK_TTL_SECONDS = 86_400;
export const MCP_LINK_TTL_HOURS = MCP_LINK_TTL_SECONDS / 3600;

/** Longest token a link route reads; real tokens are about 300 characters. */
export const MCP_LINK_MAX_TOKEN_CHARS = 1024;

/** Longest side of a preview image, in pixels. */
export const MCP_PREVIEW_MAX_SIDE = 1024;

/** How long one liveness answer for a connection or key is reused. */
export const MCP_LINK_LIVE_CACHE_MS = 60_000;

export type McpLinkKind = "preview" | "file";

/** What made the link: an OAuth connection (mcp_connections) or an API key. */
export type LinkSubject = { kind: "connection"; id: string } | { kind: "key"; id: string };

export interface LinkClaims {
  subject: LinkSubject;
  workspaceId: string;
  jobId: string;
  /** A JobFileView id: v_<asset variant id> or p_<pack file id>. */
  fileId: string;
  kind: McpLinkKind;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export type LinkVerifyResult =
  | { ok: true; claims: LinkClaims; kid: string }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

const FILE_ID_PATTERN = /^[vp]_([0-9a-f-]{36})$/i;

/** True for a JobFileView id of a stored file. */
export function isLinkFileId(fileId: string): boolean {
  const match = FILE_ID_PATTERN.exec(fileId);
  return match !== null && isUuid(match[1]);
}

interface WireClaims {
  /** 2: sealed (AES-256-GCM). 1 was the readable HMAC form, never shipped. */
  v: 2;
  /** "c:<connection id>" or "k:<key id>". */
  s: string;
  w: string;
  j: string;
  f: string;
  /** "p" preview or "f" file. */
  k: "p" | "f";
  e: number;
}

function toWire(claims: LinkClaims): WireClaims {
  return {
    v: 2,
    s: `${claims.subject.kind === "connection" ? "c" : "k"}:${claims.subject.id}`,
    w: claims.workspaceId,
    j: claims.jobId,
    f: claims.fileId,
    k: claims.kind === "preview" ? "p" : "f",
    e: claims.exp,
  };
}

function fromWire(raw: unknown): LinkClaims | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const wire = raw as Partial<WireClaims>;
  const subject = typeof wire.s === "string" ? /^([ck]):(.+)$/.exec(wire.s) : null;
  if (
    wire.v !== 2 ||
    !subject ||
    !isUuid(subject[2]) ||
    typeof wire.w !== "string" ||
    !isUuid(wire.w) ||
    typeof wire.j !== "string" ||
    !isUuid(wire.j) ||
    typeof wire.f !== "string" ||
    !isLinkFileId(wire.f) ||
    (wire.k !== "p" && wire.k !== "f") ||
    typeof wire.e !== "number" ||
    !Number.isSafeInteger(wire.e)
  ) {
    return null;
  }
  return {
    subject: { kind: subject[1] === "c" ? "connection" : "key", id: subject[2] as string },
    workspaceId: wire.w,
    jobId: wire.j,
    fileId: wire.f,
    kind: wire.k === "p" ? "preview" : "file",
    exp: wire.e,
  };
}

/** A link token for the claims, sealed with the newest key of the ring. */
export function signLinkToken(claims: LinkClaims, keys: readonly SigningKey[]): string {
  if (!keys[0]) {
    throw new SigningKeyConfigError("MCP_LINK_KEYS has no key to sign with.");
  }
  const { kid, iv, sealed } = sealPayload(keys, "link", JSON.stringify(toWire(claims)));
  return `${kid}.${iv}.${sealed}`;
}

/** The claims of a token sealed by any key of the ring that has not expired
 * at nowSeconds. The tag is checked before the claims are read. */
export function verifyLinkToken(token: string, keys: readonly SigningKey[], nowSeconds: number): LinkVerifyResult {
  if (token.length === 0 || token.length > MCP_LINK_MAX_TOKEN_CHARS) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return { ok: false, reason: "malformed" };
  }
  const [kid, iv, sealed] = parts as [string, string, string];
  const opened = openPayload(keys, "link", kid, iv, sealed);
  if (opened === null) {
    return { ok: false, reason: "signature" };
  }
  let claims: LinkClaims | null;
  try {
    claims = fromWire(JSON.parse(opened));
  } catch {
    claims = null;
  }
  if (!claims) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims, kid };
}

let warnedKeys = false;

/** The MCP_LINK_KEYS ring, or null when it is unset or malformed (then no
 * link is made and every link answers as expired). Never logs a secret. */
export function linkSigningKeys(): SigningKey[] | null {
  try {
    return parseSigningKeys(optionalEnv("MCP_LINK_KEYS"));
  } catch (err) {
    if (err instanceof SigningKeyConfigError) {
      if (!warnedKeys) {
        warnedKeys = true;
        console.warn(`[mcp-links] ${err.message} Shared links are off until it is fixed.`);
      }
      return null;
    }
    throw err;
  }
}

/** The connection or key a caller's links are tied to, or null when it has
 * neither (then its files get no lasting links). */
export function linkSubjectOf(caller: Pick<ApiCaller, "kind" | "keyId" | "connectionId">): LinkSubject | null {
  if (caller.kind === "oauth") {
    return caller.connectionId ? { kind: "connection", id: caller.connectionId } : null;
  }
  return caller.keyId ? { kind: "key", id: caller.keyId } : null;
}

/** The rate limit subject of a link's maker (mcp.links, "user" rule). */
export function linkRateSubject(subject: LinkSubject): string {
  return `${subject.kind === "connection" ? "conn" : "key"}:${subject.id}`;
}

/** The absolute curvi.ai URL of a link. */
export function mcpLinkUrl(kind: McpLinkKind, token: string, origin: string = siteUrl()): string {
  return `${origin.replace(/\/+$/, "")}/api/mcp/${kind === "preview" ? "preview" : "files"}/${token}`;
}

/** The links of one delivered file in a chat view (PackChat images). */
export interface PackFileLinks {
  preview_url: string | null;
  download_url: string | null;
}

export interface PackFileLinkOptions {
  /** The key ring; defaults to MCP_LINK_KEYS. */
  keys?: readonly SigningKey[] | null;
  now?: Date;
  /** The site origin; defaults to NEXT_PUBLIC_SITE_URL. */
  origin?: string;
}

/**
 * The lasting links for each delivered file of a pack, by JobFileView id,
 * for get_pack's chat view (P19-14 builds PackChat; this fills preview_url
 * and download_url). A file gets links only when it is stored (downloadUrl
 * is set, which demo files never are), MCP_LINK_KEYS is set and the caller
 * has a connection or key to tie them to; only images get a preview. Every
 * other file maps to null links.
 */
export function packFileLinks(
  caller: Pick<ApiCaller, "kind" | "keyId" | "connectionId" | "principal">,
  jobId: string,
  files: ReadonlyArray<Pick<JobFileView, "id" | "kind" | "downloadUrl">>,
  options: PackFileLinkOptions = {},
): Map<string, PackFileLinks> {
  const keys = options.keys === undefined ? linkSigningKeys() : options.keys;
  const subject = linkSubjectOf(caller);
  const exp = Math.floor((options.now ?? new Date()).getTime() / 1000) + MCP_LINK_TTL_SECONDS;
  const links = new Map<string, PackFileLinks>();
  for (const file of files) {
    if (!keys || keys.length === 0 || !subject || file.downloadUrl === null || !isUuid(jobId) || !isLinkFileId(file.id)) {
      links.set(file.id, { preview_url: null, download_url: null });
      continue;
    }
    const claims = { subject, workspaceId: caller.principal.workspaceId, jobId, fileId: file.id, exp };
    links.set(file.id, {
      preview_url:
        file.kind === "image" ? mcpLinkUrl("preview", signLinkToken({ ...claims, kind: "preview" }, keys), options.origin) : null,
      download_url: mcpLinkUrl("file", signLinkToken({ ...claims, kind: "file" }, keys), options.origin),
    });
  }
  return links;
}

// Checking a click

/** A delivered file a link points at: its storage key and name. */
export interface LinkedFile {
  key: string;
  filename: string;
  kind: "image" | "zip" | "report";
  /** Fresh selected report bytes, read only after link authorization. */
  reportBody?: string;
}

/** Reads the link routes need (lib/mcp-links-backend: the database, or the
 * demo, which stores no files). */
export interface McpLinkBackend {
  /** True while the connection is live (or the key is not revoked), it
   * belongs to the workspace, and its member is still in the workspace. */
  subjectLive(subject: LinkSubject, workspaceId: string): Promise<boolean>;
  /** The stored file, when it still belongs to that job in that workspace
   * and the job serves files; else null. */
  fileOf(workspaceId: string, jobId: string, fileId: string): Promise<LinkedFile | null>;
}

const LIVE_CACHE_MAX = 10_000;
const liveCache = new Map<string, { live: boolean; until: number }>();

/** subjectLive, with each answer reused for MCP_LINK_LIVE_CACHE_MS, so a
 * page of previews costs one read. A revoked connection or a removed member
 * stops working within that minute. */
export async function linkSubjectLive(
  backend: McpLinkBackend,
  subject: LinkSubject,
  workspaceId: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const cacheKey = `${subject.kind}:${subject.id}:${workspaceId}`;
  const cached = liveCache.get(cacheKey);
  if (cached && cached.until > nowMs) {
    return cached.live;
  }
  const live = await backend.subjectLive(subject, workspaceId);
  if (liveCache.size >= LIVE_CACHE_MAX) {
    for (const [key, entry] of liveCache) {
      if (entry.until <= nowMs) {
        liveCache.delete(key);
      }
    }
    // Still full: drop the oldest tenth (a Map keeps insertion order).
    for (const key of [...liveCache.keys()].slice(0, Math.max(0, liveCache.size - LIVE_CACHE_MAX * 0.9))) {
      liveCache.delete(key);
    }
  }
  liveCache.set(cacheKey, { live, until: nowMs + MCP_LINK_LIVE_CACHE_MS });
  return live;
}

/** Test hook: forget every cached liveness answer. */
export function clearMcpLinkCacheForTests(): void {
  liveCache.clear();
  warnedKeys = false;
}

export interface McpLinkDeps {
  /** The backend, or a function that returns it (called only once the token
   * holds, so a bad link costs no database work). */
  backend?: McpLinkBackend | (() => McpLinkBackend);
  keys?: readonly SigningKey[] | null;
  nowMs?: number;
}

function linkAnswer(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** 410 for a link that ran out or whose connection ended, 404 for anything
 * else that cannot be served; the same plain line either way. */
export function linkGone(status: 404 | 410): Response {
  return linkAnswer(status, MCP_COPY.linkExpired);
}

export function linkUnavailable(): Response {
  const response = linkAnswer(503, MCP_COPY.linkUnavailable);
  response.headers.set("Retry-After", "60");
  return response;
}

export type McpLinkCheck = { ok: true; claims: LinkClaims; file: LinkedFile } | { ok: false; response: Response };

/**
 * Every check a click on a link passes before anything is served, in order:
 * the per IP limit, the signature, expiry and link kind, the per connection
 * or key limit, storage being configured, the connection or key being live
 * with its member still in the workspace, and the file still in that job
 * and workspace. Only the path's token is read, never the query.
 */
export async function checkMcpLink(
  request: Request,
  token: string,
  kind: McpLinkKind,
  deps: McpLinkDeps = {},
): Promise<McpLinkCheck> {
  const byIp = await limitByIp(request, "mcp.links");
  if (byIp) {
    return { ok: false, response: byIp };
  }
  const keys = deps.keys === undefined ? linkSigningKeys() : deps.keys;
  if (!keys || keys.length === 0) {
    return { ok: false, response: linkGone(404) };
  }
  const nowMs = deps.nowMs ?? Date.now();
  const verified = verifyLinkToken(token, keys, Math.floor(nowMs / 1000));
  if (!verified.ok) {
    return { ok: false, response: linkGone(verified.reason === "expired" ? 410 : 404) };
  }
  const { claims } = verified;
  if (claims.kind !== kind) {
    return { ok: false, response: linkGone(404) };
  }
  // The kill switch covers links too: with MCP_OAUTH_ENABLED off, a link an
  // OAuth connection made serves nothing, as if the connection had ended.
  // API key links keep working, as the endpoint does.
  if (claims.subject.kind === "connection" && !mcpOAuthEnabled()) {
    return { ok: false, response: linkGone(410) };
  }
  const bySubject = await limitByUser("mcp.links", linkRateSubject(claims.subject));
  if (bySubject) {
    return { ok: false, response: bySubject };
  }
  if (!isR2Configured()) {
    return { ok: false, response: linkGone(404) };
  }
  if (!deps.backend) {
    return { ok: false, response: linkGone(404) };
  }
  try {
    const backend = typeof deps.backend === "function" ? deps.backend() : deps.backend;
    if (!(await linkSubjectLive(backend, claims.subject, claims.workspaceId, nowMs))) {
      return { ok: false, response: linkGone(410) };
    }
    const file = await backend.fileOf(claims.workspaceId, claims.jobId, claims.fileId);
    if (!file || (kind === "preview" && file.kind !== "image")) {
      return { ok: false, response: linkGone(404) };
    }
    return { ok: true, claims, file };
  } catch (err) {
    if (!(err instanceof DemoModeRefusedError)) {
      console.warn(`[mcp-links] a link check failed: ${err instanceof Error ? err.name : "unknown"}`);
    }
    return { ok: false, response: linkUnavailable() };
  }
}

/** A redirect to the freshly signed storage link, never cached. */
export function linkRedirect(location: string): Response {
  const response = NextResponse.redirect(location, 302);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
