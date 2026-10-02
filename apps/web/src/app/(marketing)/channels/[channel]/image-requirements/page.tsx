import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ChannelSpec } from "@curvi/specs";
import { buttonVariants } from "@curvi/ui";
import { JsonLd } from "@/components/json-ld";
import { ChannelCheckerBlock } from "@/components/marketing/channel-checker-block";
import { channelPageCopy } from "@/components/marketing/channel-copy";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { SignupLink } from "@/components/marketing/signup-link";
import { imageSpecs, specDisplayName, specForSlug, specSlug } from "@/components/marketing/spec-slug";
import { specAvailability } from "@/lib/marketing-facts";
import { channelChoiceForSpec } from "@/lib/seller-profile";
import { breadcrumbJsonLd, channelPageSeo, jsonLdGraph, pageMetadata } from "@/lib/seo";
import { MAIN_IMAGE_CHECKER_PATH, checkerChannelForSpec, checkerPagePath } from "@/lib/tools/checker-rules";

export const dynamicParams = false;

export function generateStaticParams(): { channel: string }[] {
  return imageSpecs().map((spec) => ({ channel: specSlug(spec.id) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ channel: string }>;
}): Promise<Metadata> {
  const { channel } = await params;
  const spec = specForSlug(channel);
  if (!spec) {
    return { title: "Image requirements" };
  }
  return pageMetadata({
    ...channelPageSeo(specDisplayName(spec.id), specAvailability(spec.id)),
    path: `/channels/${specSlug(spec.id)}/image-requirements`,
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toLocaleString("en-US")} MB`;
  }
  return `${(bytes / 1_000).toLocaleString("en-US")} KB`;
}

function backgroundText(spec: ChannelSpec): string {
  const bg = spec.background;
  if (!bg) return "No background rule published";
  switch (bg.type) {
    case "solid":
      if (bg.rgb && bg.rgb[0] === 255 && bg.rgb[1] === 255 && bg.rgb[2] === 255) {
        return `Pure white, RGB 255 255 255${bg.tolerance === 0 ? ", zero tolerance" : ""}`;
      }
      return bg.rgb ? `Solid color, RGB ${bg.rgb.join(" ")}` : "Solid color";
    case "white_or_transparent":
      return "White or transparent";
    case "white_preferred":
      return "White preferred";
    case "consistent":
      return "Consistent across your catalog";
    case "any":
      return "Any background allowed";
  }
}

function ruleRows(spec: ChannelSpec): { rule: string; value: string }[] {
  const rows: { rule: string; value: string }[] = [];
  if (spec.width && spec.height) {
    // An exactSize spec accepts only this size (see dimensionBounds in @curvi/specs).
    rows.push({
      rule: spec.exactSize ? "Exact size" : "Recommended size",
      value: `${spec.width} by ${spec.height} px`,
    });
  }
  if (spec.minWidth || spec.minHeight) {
    rows.push({
      rule: "Minimum size",
      value: `${spec.minWidth ?? 1} by ${spec.minHeight ?? 1} px`,
    });
  }
  if (spec.minLongSide) {
    rows.push({ rule: "Longest side, minimum", value: `${spec.minLongSide} px` });
  }
  if (spec.maxLongSide) {
    rows.push({ rule: "Longest side, maximum", value: `${spec.maxLongSide.toLocaleString("en-US")} px` });
  }
  if (spec.maxWidth && spec.maxHeight) {
    rows.push({ rule: "Maximum size", value: `${spec.maxWidth} by ${spec.maxHeight} px` });
  }
  if (spec.maxMegapixels) {
    rows.push({ rule: "Maximum megapixels", value: `${spec.maxMegapixels}` });
  }
  rows.push({ rule: "Background", value: backgroundText(spec) });
  if (spec.fill) {
    rows.push({
      rule: "Product fill",
      value: `${Math.round(spec.fill.min * 100)} to ${Math.round(spec.fill.max * 100)} percent of the frame`,
    });
  }
  if (typeof spec.textAllowed === "boolean") {
    rows.push({
      rule: "Text on the image",
      value: spec.textAllowed ? "Allowed" : "Not allowed",
    });
  }
  if (typeof spec.propsAllowed === "boolean") {
    rows.push({ rule: "Props", value: spec.propsAllowed ? "Allowed" : "Not allowed" });
  }
  if (typeof spec.overlaysAllowed === "boolean") {
    rows.push({ rule: "Overlays", value: spec.overlaysAllowed ? "Allowed" : "Not allowed" });
  }
  if (spec.formats?.length) {
    rows.push({ rule: "Formats", value: spec.formats.join(", ") });
  }
  if (spec.colorSpace) {
    rows.push({ rule: "Color space", value: spec.colorSpace });
  }
  if (spec.maxBytes) {
    rows.push({ rule: "Maximum file size", value: formatBytes(spec.maxBytes) });
  }
  if (spec.maxCount) {
    rows.push({ rule: "Maximum image count", value: `${spec.maxCount}` });
  }
  if (spec.naming) {
    rows.push({ rule: "File naming convention", value: spec.naming });
  }
  if (spec.safeZone) {
    rows.push({
      rule: "Safe zone",
      value:
        spec.safeZone.left !== undefined || spec.safeZone.right !== undefined
          ? `Keep the top ${spec.safeZone.top} px, bottom ${spec.safeZone.bottom} px, left ${spec.safeZone.left ?? 0} px and right ${spec.safeZone.right ?? 0} px clear of critical content`
          : `Keep the top ${spec.safeZone.top} px and bottom ${spec.safeZone.bottom} px clear of critical content`,
    });
  }
  if (spec.iptcDigitalSourceTypeRequiredIfAI) {
    rows.push({
      rule: "AI disclosure metadata",
      value: "IPTC digital source type must be set when the image is AI generated",
    });
  }
  return rows;
}

function plainExplanation(spec: ChannelSpec): string[] {
  const paragraphs: string[] = [];
  const name = specDisplayName(spec.id);
  const bg = spec.background;
  if (bg?.type === "solid" && bg.rgb?.every((v) => v === 255)) {
    paragraphs.push(
      `The background has to be pure white, meaning every background pixel reads exactly 255 255 255. A light gray photo backdrop fails this check even when it looks white to the eye, and a failed background is one of the most common reasons a listing image gets suppressed.`,
    );
  } else if (bg?.type === "white_or_transparent") {
    paragraphs.push(
      `The background should be white or transparent. Busy or dark backgrounds can get the image disapproved, and a clean white sweep also performs better in search results.`,
    );
  } else if (bg?.type === "consistent") {
    paragraphs.push(
      `There is no fixed background color, but backgrounds should stay consistent across your catalog so the store reads as one brand.`,
    );
  } else if (bg?.type === "white_preferred") {
    paragraphs.push(
      `A white background is preferred. It is not a hard rejection rule, but white mains convert better and avoid manual review.`,
    );
  }
  if (spec.fill) {
    paragraphs.push(
      `The product should fill ${Math.round(spec.fill.min * 100)} to ${Math.round(spec.fill.max * 100)} percent of the frame. Too small and the listing looks weak in search, too large and edges get clipped. Measure the longest product dimension against the frame side.`,
    );
  }
  if (spec.minLongSide) {
    paragraphs.push(
      `Resolution matters because zoom is a conversion feature. Keep the longest side at ${spec.minLongSide} px or more so the zoom view stays sharp.`,
    );
  }
  if (spec.textAllowed === false) {
    paragraphs.push(
      `No text, watermarks or badges on this image. Promotional text belongs in secondary images or ad creative, never on the ${name}.`,
    );
  }
  if (paragraphs.length === 0) {
    paragraphs.push(
      `This format is more flexible than a marketplace main image, but sticking to the recommended size keeps the crop sharp and avoids compression artifacts.`,
    );
  }
  return paragraphs;
}

export default async function ChannelRequirementsPage({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel } = await params;
  const spec = specForSlug(channel);
  if (!spec || spec.id.startsWith("video.")) {
    notFound();
  }
  const name = specDisplayName(spec.id);
  const rows = ruleRows(spec);
  const copy = channelPageCopy(spec);
  // The welcome question "Where do you sell?" starts with this channel (P18-20).
  const sellerChannel = channelChoiceForSpec(spec.id);
  const signupExtra = sellerChannel ? { channel: sellerChannel } : undefined;
  const comingSoon = copy.status === "coming_soon";
  const others = imageSpecs().filter((s) => s.id !== spec.id).slice(0, 6);
  // P18-10: a main spec the checker offers opens it with its channel preset.
  const checker = checkerChannelForSpec(spec.id);
  const checkerHref = checker ? checkerPagePath(checker.key) : MAIN_IMAGE_CHECKER_PATH;

  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <JsonLd
        data={jsonLdGraph([
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: `${name} requirements`, path: `/channels/${specSlug(spec.id)}/image-requirements` },
          ]),
        ])}
      />
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-medium text-accent-600">Channel requirements</p>
        {comingSoon ? <ComingSoonBadge /> : null}
      </div>
      <h1 className="mt-2 text-4xl font-bold tracking-tight text-ink-950">{name} requirements</h1>
      <p data-testid="channel-intro" className="mt-4 max-w-2xl text-lg text-ink-600">
        {copy.intro}
      </p>

      <div className="mt-8 overflow-x-auto rounded-xl border border-ink-100">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <thead className="bg-ink-50 text-ink-700">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">Rule</th>
              <th scope="col" className="px-4 py-3 font-semibold">Requirement</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rule} className="border-t border-ink-100">
                <td className="px-4 py-3 font-medium text-ink-900">{row.rule}</td>
                <td className="px-4 py-3 text-ink-700">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-semibold text-ink-950">What this means in practice</h2>
      <div className="mt-4 space-y-4 text-ink-600">
        {plainExplanation(spec).map((paragraph) => (
          <p key={paragraph.slice(0, 40)}>{paragraph}</p>
        ))}
      </div>

      {checker ? <ChannelCheckerBlock href={checkerHref} /> : null}

      <div data-testid="channel-cta" className="mt-10 rounded-xl border border-ink-100 bg-ink-50 p-8 text-center">
        <h2 className="text-xl font-semibold text-ink-950">{copy.ctaTitle}</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-ink-600">{copy.ctaBody}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          {comingSoon ? (
            <>
              <Link
                href={checkerHref}
                className={buttonVariants({ variant: "secondary", size: "lg" })}
              >
                Check your current image free
              </Link>
              <SignupLink source="channel" extra={signupExtra} className={buttonVariants({ variant: "outline", size: "lg" })}>
                Start free
              </SignupLink>
            </>
          ) : (
            <>
              <SignupLink source="channel" extra={signupExtra} className={buttonVariants({ variant: "secondary", size: "lg" })}>
                Start free
              </SignupLink>
              <Link
                href={checkerHref}
                className={buttonVariants({ variant: "outline", size: "lg" })}
              >
                Check your current image free
              </Link>
            </>
          )}
        </div>
      </div>

      <h2 className="mt-12 text-lg font-semibold text-ink-950">Other channel requirements</h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {others.map((other) => (
          <li key={other.id}>
            <Link
              href={`/channels/${specSlug(other.id)}/image-requirements`}
              className="inline-block rounded-full border border-ink-200 px-3 py-1 text-sm text-ink-600 hover:bg-ink-50"
            >
              {specDisplayName(other.id)}
              {specAvailability(other.id) === "coming_soon" ? (
                <>
                  {" "}
                  <span className="text-xs text-amber-700">coming soon</span>
                </>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
