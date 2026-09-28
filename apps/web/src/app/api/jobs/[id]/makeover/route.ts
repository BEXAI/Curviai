/**
 * GET /api/jobs/:id/makeover?shot=<shotId>
 * Downloads the "Share this makeover" image: the seller's original photo next
 * to one finished shot, rendered by @curvi/pipeline/reveal. Re-checks that
 * the job belongs to the caller's workspace and is done, and that the shot is
 * a finished one with a preview. The two pictures are read from the urls the
 * service itself signed for the board (or its inline demo drawings), never
 * from anything the request supplies. Rate limited by IP and by user, since
 * every call fetches two pictures and renders a new one.
 */

import { NextResponse } from "next/server";
import { renderSideBySide } from "@curvi/pipeline/reveal";
import { ILLUSTRATION_LABEL, isIllustrationSrc } from "@/components/marketing/demo-images";
import { makeoverFilename, revealShots } from "@/lib/makeover";
import { readImageUrl } from "@/lib/makeover-image";
import { attachmentDisposition } from "@/lib/r2";
import { limitByIp, limitByUser, userRateLimitSubject } from "@/lib/rate-limit";
import { getServices } from "@/lib/services";
import { resolveWorkspace } from "@/lib/services/workspace-response";
import { isUuid } from "@/lib/validation/ids";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NOT_FOUND = "This pack does not exist in your workspace.";
const NO_REVEAL = "This shot has no before and after to download.";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const ipLimited = await limitByIp(request, "jobs.makeover");
  if (ipLimited) {
    return ipLimited;
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  const shotId = new URL(request.url).searchParams.get("shot") ?? "";
  if (!shotId || shotId.length > 200) {
    return NextResponse.json({ error: NO_REVEAL }, { status: 400 });
  }

  const services = getServices();
  const resolved = await resolveWorkspace(services, "Sign in to download your makeover.");
  if ("response" in resolved) {
    return resolved.response;
  }
  const { workspace } = resolved;
  const userLimited = await limitByUser("jobs.makeover", await userRateLimitSubject(workspace.id));
  if (userLimited) {
    return userLimited;
  }

  const job = await services.getJob(workspace.id, id);
  if (!job) {
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }
  if (job.status !== "done") {
    return NextResponse.json({ error: "The before and after is ready once the pack finishes." }, { status: 409 });
  }
  const shot = revealShots(job.shots).find((s) => s.shotId === shotId);
  if (!shot || !job.sourceImageUrl) {
    return NextResponse.json({ error: NO_REVEAL }, { status: 404 });
  }

  let image: Buffer;
  try {
    const [before, after] = await Promise.all([readImageUrl(job.sourceImageUrl), readImageUrl(shot.imageUrl)]);
    // A drawing made in code (demo mode) is labeled as one on the image too,
    // so a shared download never passes it off as a real photo.
    const illustration = isIllustrationSrc(job.sourceImageUrl);
    const rendered = await renderSideBySide({
      before,
      after,
      beforeLabel: illustration ? `Before, ${ILLUSTRATION_LABEL.toLowerCase()}` : "Before",
      afterLabel: isIllustrationSrc(shot.imageUrl) ? `After, ${ILLUSTRATION_LABEL.toLowerCase()}` : "After",
    });
    image = rendered.buffer;
  } catch (err) {
    console.warn(`[makeover] could not render the side by side image for job ${job.id}`, err);
    return NextResponse.json(
      { error: "We could not make that image right now. Try again in a moment." },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }

  return new NextResponse(new Uint8Array(image), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(image.length),
      "Content-Disposition": attachmentDisposition(makeoverFilename(job.productTitle, shot.shotType)),
      "Cache-Control": "private, no-store",
    },
  });
}
