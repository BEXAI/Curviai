import { NextResponse } from "next/server";
import { emailConfigFromEnv, sendEmail, type EmailTemplate } from "@curvi/email";
import { events } from "@curvi/db";
import { optionalEnv } from "@/lib/env";
import { readJsonCapped } from "@/lib/http/json-body";
import { publicOrigin } from "@/lib/http/public-origin";
import { sameOriginOrRefuse } from "@/lib/http/same-origin";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { clientIp, limitByIp, limitByUser } from "@/lib/rate-limit";
import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { getSessionUser } from "@/lib/supabase/server";
import { submitSupport, supportInput, SUPPORT_FAILURE, SUPPORT_SUCCESS } from "@/lib/support";
import { getCaseStore } from "@/lib/cases";
import { caseError } from "@/lib/cases/http";
import { turnstileMode, verifyTurnstile, TURNSTILE_MESSAGE } from "@/lib/turnstile";

export const dynamic = "force-dynamic";
const requestTemplate: EmailTemplate<{ topic: string; message: string; job: string | null }> = {
  key: "support_request", kind: "transactional", audience: "account",
  render: (data, ctx) => ({ subject: `Curvi support: ${data.topic}`, paragraphs: [data.message, ...(data.job ? [`Pack: ${ctx.siteUrl}/app/jobs/${data.job}`] : [])] }),
};
const replyTemplate: EmailTemplate<Record<string, never>> = {
  key: "support_acknowledgment", kind: "transactional", audience: "account",
  render: () => ({ subject: "We got your Curvi message", paragraphs: [SUPPORT_SUCCESS] }),
};
export async function POST(request: Request) {
  const refused = sameOriginOrRefuse(request) ?? await limitByIp(request, "support.contact");
  if (refused) return refused;
  const body = await readJsonCapped(request);
  if (!body.ok) return body.response;
  const parsed = supportInput.safeParse(body.data);
  if (!parsed.success) return NextResponse.json({ error: "Pick a topic, enter your email and write a message of 10 to 2,000 characters." }, { status: 400 });
  if (parsed.data.website) return NextResponse.json({ notice: SUPPORT_SUCCESS });
  const user = isDbMode() ? await getSessionUser() : null;
  if (user) {
    const limited = await limitByUser("support.contact", user.id);
    if (limited) return limited;
  }
  let humanVerified = false;
  if (!user?.email_confirmed_at && turnstileMode() !== "fallback") {
    humanVerified = await verifyTurnstile(parsed.data.captchaToken, { action: "support", hostname: new URL(publicOrigin(request)).hostname, ip: clientIp(request.headers) });
    if (!humanVerified) return NextResponse.json({ error: TURNSTILE_MESSAGE }, { status: 400 });
  }
  if (!isDbMode()) return NextResponse.json({ notice: "Demo mode. Your message was checked, but no email was sent." });
  const services = getServices();
  const workspace = user ? await services.getCurrentWorkspace() : null;
  const actor = user?.email && user.email_confirmed_at ? { userId: user.id, email: user.email, workspaceId: workspace?.id ?? null } : null;
  // A signed-in pack report is one durable case intake. Do this before the
  // email path so a retry or existing open case never sends duplicate mail.
  if (actor?.workspaceId && parsed.data.topic === "pack" && parsed.data.job) {
    try {
      const result = await getCaseStore().create({ workspaceId: actor.workspaceId, userId: actor.userId }, parsed.data.job, {
        category: "other", description: parsed.data.message, requestId: parsed.data.requestId,
      }, parsed.data.requestId);
      return NextResponse.json({ notice: result.created ? "Your pack report was received. You can follow its progress in Pack help." : "There is already an open case for this pack. Continue the conversation in Pack help.", casePath: `/app/jobs/${parsed.data.job}/cases#case-${result.case.id}` }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { return caseError(error); }
  }
  const db = getDb();
  const config = emailConfigFromEnv();
  const inbox = optionalEnv("SUPPORT_INBOX") ?? LEGAL_FACTS.support.email;
  const sender = config.from ?? optionalEnv("BILLING_EMAIL_FROM") ?? null;
  try {
    const sent = await submitSupport(parsed.data, actor, humanVerified, {
      ownsJob: async (workspaceId, jobId) => Boolean(await services.getJob(workspaceId, jobId)),
      deliver: async (input) => {
        const result = await sendEmail({ db, config: { ...config, from: sender, replyTo: input.email }, enabled: async () => true }, { to: inbox, template: requestTemplate, data: input, dedupeKey: input.key, workspaceId: input.workspaceId });
        return result.status === "sent" || result.status === "duplicate";
      },
      acknowledge: async (input) => { await sendEmail({ db, config: { ...config, from: sender, replyTo: inbox }, enabled: async () => true }, { to: input.email, template: replyTemplate, data: {}, dedupeKey: input.key, workspaceId: input.workspaceId }); },
      record: async (input) => { await db.insert(events).values({ workspaceId: input.workspaceId, name: "support_request", props: { topic: input.topic, job: input.job } }); },
    });
    return NextResponse.json(sent ? { notice: SUPPORT_SUCCESS } : { error: SUPPORT_FAILURE }, { status: sent ? 200 : 503 });
  } catch { return NextResponse.json({ error: SUPPORT_FAILURE }, { status: 503 }); }
}
