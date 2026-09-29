"use client";

import { useEffect, useMemo, useReducer, useRef, useState, type FocusEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Card, CardContent, Input, Label, Select, Textarea, cn } from "@curvi/ui";
import { DEFAULT_BUNDLE, lookPresetFor, type OutputPlanFlags } from "@curvi/pipeline/output-options";
import type { TierKey } from "@curvi/pipeline/seed";
import { OutOfCreditsDialog } from "@/components/app/paywall";
import {
  ANGLE_ROLES,
  MAX_ENDORSEMENTS,
  MAX_SELLER_LINE_CHARS,
  MAX_SELLER_LINES,
  MAX_SKU_CHARS,
  SKU_PATTERN,
  sellerLinesFromText,
  type AngleRole,
} from "@curvi/pipeline/seller-inputs";
import { ComingSoonBadge } from "@/components/marketing/coming-soon-badge";
import { outOfCreditsCopy, type PaywallContext, type PaywallCopy } from "@/lib/billing/paywall";
import { CONCEPT_MODE_AVAILABLE } from "@/lib/features";
import { estimatePackCredits, type EstimateMode } from "@/lib/pack-estimate";
import { intentFor, type SubmitIntent } from "@/lib/submit-intent";
import { track } from "@/lib/track";
import { requestPhotoImport } from "@/lib/url-import/client";
import { IMPORT_TITLE_MAX, sellerNotesFrom, type ImportedImage, type ImportedProduct } from "@/lib/url-import/types";
import {
  KEEP_PHOTOS_INSTEAD_LABEL,
  KEEP_PHOTOS_PAUSED_COPY,
  conflictCopy,
  conflictLines,
  leftOutAfterPauseLine,
  type ConflictLine,
} from "@/lib/output-options-copy";
import {
  KEEP_BACKGROUND_HINT_ACTION,
  PHOTO_BACKGROUND_OPTIONS,
  REMEMBERED_RESET_LABEL,
  RESIZE_ONLY_BADGE,
  addedSpaceSpecIds,
  isPhotoBackground,
  keepBackgroundHint,
  photoBackgroundLabel,
  rememberedFormState,
  rememberedLine,
  uploadBackgroundField,
  usableBrandColors,
  type OutputFormState,
  type PhotoBackground,
  backgroundSummaryLine,
  bundleEstimates,
  conflictContextOf,
  currentBundle,
  effectiveChoices,
  formConflicts,
  formPhotos,
  holdLine,
  initialOutputForm,
  isResizeOnly,
  leaveOut,
  lookDifferenceLine,
  optionsIntentKey,
  outputFormReducer,
  outputOptionsBody,
  packCreatedOutputProps,
  packLookChangedProps,
  PACK_LOOK_CHANGED_EVENT,
  pauseBlocksSubmit,
  photoOutputContext,
  planningPhotos,
  previewFrames,
  resolveFormOutput,
  rowConflicts,
  totalLine,
  withoutWhiteRequired,
  type FormPhoto,
  type OutputFormAction,
} from "@/lib/output-options-form";
import { outputEstimateInputs } from "@/lib/services/output-options";
import {
  chosenItem,
  PREFLIGHT_UNAVAILABLE_NOTICE,
  preflightBlockReason,
  type PhotoOutputContext,
} from "@/lib/preflight/copy";
import type { PreflightBox, PreflightView } from "@/lib/preflight/types";
import { OutputOptionsPanel } from "./output-options-panel";
import { PackBundleCards } from "./pack-bundle-cards";
import { PreflightResult } from "./preflight-result";
import { ProductLinkImport } from "./product-link-import";
import { QuestionStep } from "./question-step";
import type { SellerQuestion } from "@curvi/pipeline/questions";
import {
  channelsAfterAnswer,
  knownKinds,
  QUESTION_STEP_COPY,
  questionSourcePhoto,
  sellerAnswersBody,
  targetPickOf,
  targetValueOf,
  visibleQuestions,
} from "@/lib/question-step";
import { MAX_PACK_PHOTOS } from "@/lib/validation/seller-inputs";

export interface ChannelOption {
  id: string;
  marketplace: boolean;
  /** What createJob would say about this channel on this plan (from the
   * seed entitlements). Only "available" channels can be picked; missing
   * means available. */
  availability?: "available" | "coming_soon" | "upgrade_required";
  /** The cheapest plan that includes an upgrade_required channel. */
  upgradeTo?: TierKey | null;
  /** The registry rule requires white, whatever color is picked ("Stays white"). */
  requiresWhite?: boolean;
  /** Width by height is the only size the spec takes ("Set shape, 1080 by 1920"). */
  exactSize?: { width: number; height: number } | null;
}

function isPickable(channel: ChannelOption): boolean {
  return (channel.availability ?? "available") === "available";
}

function planName(key: TierKey): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export interface ProductOption {
  id: string;
  title: string;
  mode: "listing" | "concept";
  /** Saved seller inputs, prefilled when the product is picked. */
  sku?: string | null;
  boxContents?: string[];
  comparisonFacts?: string[];
  /** Press quotes or awards for the A+ endorsement module. */
  endorsements?: string[];
  /** Photos already stored for the product (capped at MAX_PACK_PHOTOS), for
   * the estimate when the seller adds none. */
  storedPhotoCount?: number;
  /** The last choices a pack of this product carried (products.output_defaults),
   * prefilled when the product is picked (PHASE_15 P1). */
  outputDefaults?: Record<string, unknown> | null;
}

interface NewPackFormProps {
  products: ProductOption[];
  channels: ChannelOption[];
  tier: TierKey;
  creditBalance: number;
  /** Plan, Stripe and role facts for the out of credits dialog. */
  paywall: PaywallContext;
  /** Product to preselect, e.g. from "New pack for this product". Anything
   * not in `products` is ignored. */
  initialProductId?: string | null;
  /** True while the cutout service is unavailable (the new pack preflight).
   * Create pack is disabled for a pack that needs a cutout; with output
   * options on, a pack that keeps its photos can still start. */
  packsPaused?: boolean;
  /** Section 3 "How your images look" (docs/phases/PHASE_15.md): the env
   * flag and the kill switch are both on. Off, the form renders and submits
   * exactly as before PHASE_15, with no outputOptions in the body. */
  outputOptionsEnabled?: boolean;
  /** The workspace's brand kit colors, in kit order. */
  brandColors?: string[];
  /** The plan includes brand kits (seed tierEntitlements). */
  brandKitsAllowed?: boolean;
  /** The brand kit has a logo, so More options offers Logo on graphics. */
  brandHasLogo?: boolean;
  /** Set while scenes are paused: the scenes extra is forced off and shows this. */
  scenesPausedNote?: string | null;
}

/** The form's first options: the preselected product's remembered choices, else Marketplace ready. */
function initialOptionsFor(product: ProductOption | null, enabled: boolean, brandColorCount: number): {
  state: OutputFormState;
  remembered: boolean;
} {
  const remembered = enabled && product ? rememberedFormState(product.outputDefaults, { brandColorCount }) : null;
  return remembered ? { state: remembered, remembered: true } : { state: initialOutputForm(), remembered: false };
}

/** Each photo's own Background Select, by the id the options use; "pack" photos are left out. */
export function photoBackgroundsOf(photos: readonly PhotoItem[]): Record<string, PhotoBackground> {
  const out: Record<string, PhotoBackground> = {};
  for (const photo of photos) {
    if (photo.kind === "image" && photo.phase !== "error" && photo.background && photo.background !== "pack") {
      out[formPhotoId(photo)] = photo.background;
    }
  }
  return out;
}

const DEFAULT_CHANNELS = ["amazon.main", "amazon.secondary", "shopify.product", "meta.feed_1x1"];

/**
 * Whether a failed submit used up its Idempotency-Key, so the next try is a
 * new intent. A 409 means the key belongs to a different request. A 503 the
 * jobs route answered with reason "unavailable" means the server refused
 * before the pack started (a draining server writes nothing, and a job it
 * had to abandon has its key freed), so the retry must create a fresh job.
 * Any other failure keeps the key: the server may have started the pack,
 * and a retry with the same key replays it instead of starting a second one.
 */
export function submitFailureSpendsKey(status: number, reason?: string): boolean {
  return status === 409 || (status === 503 && reason === "unavailable");
}

/** The credit line under the estimate. A balance below zero is explained,
 * never shown as a bare negative number. */
export function creditBalanceLine(creditBalance: number): string {
  if (creditBalance < 0) {
    const owed = -creditBalance;
    return `Your balance is ${owed.toLocaleString("en-US")} ${owed === 1 ? "credit" : "credits"} below zero because a move to a smaller plan took credits back. New packs start again once a top up or your next renewal covers it.`;
  }
  return `You have ${creditBalance.toLocaleString("en-US")} credits. Only assets that pass QC are charged.`;
}

/**
 * Whether a refused submit is the balance falling short of a pack that plans
 * billable shots: the moment for the out of credits dialog instead of an
 * error line. createJob answers "plans no billable shots" with the same
 * reason, so an estimate of zero keeps the plain message.
 */
export function isOutOfCreditsRefusal(status: number, reason: string | undefined, estimate: number): boolean {
  return status === 402 && reason === "insufficient_credits" && estimate > 0;
}

/** The pack summary warning when the estimate is more than the balance. */
export function estimateOverBalanceLine(estimate: number, creditBalance: number): string | null {
  if (estimate <= 0 || creditBalance < 0 || estimate <= creditBalance) {
    return null;
  }
  return `This pack needs about ${estimate.toLocaleString("en-US")} credits, more than you have. Pick fewer channels or add credits.`;
}

export function channelLabel(id: string): string {
  const pretty = id.replaceAll(".", " ").replaceAll("_", " ");
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** Plain labels for the photo roles, in ANGLE_ROLES order. */
export const ANGLE_LABELS: Record<AngleRole, string> = {
  front: "Front",
  back: "Back",
  side: "Side",
  detail: "Close up detail",
  in_the_box: "In the box",
  scale: "Scale, in a hand or next to something",
};

/** The role a newly added photo starts with: the first one no photo has
 * yet, so one photo per angle needs no changes, and detail after that. */
export function nextAngle(taken: readonly AngleRole[]): AngleRole {
  return ANGLE_ROLES.find((role) => !taken.includes(role)) ?? "detail";
}

/**
 * The first problem with the optional details, in plain words, or null when
 * they can be sent. Mirrors the API's checks so a seller sees the fix here
 * instead of a refused pack.
 */
export function sellerDetailsProblem(
  sku: string,
  boxContents: string[],
  comparisonFacts: string[],
  endorsements: string[] = [],
): string | null {
  const trimmedSku = sku.trim();
  if (trimmedSku.length > MAX_SKU_CHARS) {
    return `Keep the SKU to ${MAX_SKU_CHARS} characters.`;
  }
  if (trimmedSku.length > 0 && !SKU_PATTERN.test(trimmedSku)) {
    return "Use letters, digits, dots, hyphens or underscores in the SKU.";
  }
  for (const [label, lines] of [
    ["what is in the box", boxContents],
    ["how it compares", comparisonFacts],
  ] as const) {
    if (lines.length > MAX_SELLER_LINES) {
      return `List at most ${MAX_SELLER_LINES} lines for ${label}.`;
    }
    const long = lines.find((line) => line.length > MAX_SELLER_LINE_CHARS);
    if (long) {
      return `Keep each line of ${label} to ${MAX_SELLER_LINE_CHARS} characters so it prints whole. This one is too long: ${long}`;
    }
  }
  if (endorsements.length > MAX_ENDORSEMENTS) {
    return `List at most ${MAX_ENDORSEMENTS} quotes or awards.`;
  }
  const longEndorsement = endorsements.find((line) => line.length > MAX_SELLER_LINE_CHARS);
  if (longEndorsement) {
    return `Keep each quote or award to ${MAX_SELLER_LINE_CHARS} characters so it prints whole. This one is too long: ${longEndorsement}`;
  }
  return null;
}

export interface PhotoItem {
  /** Local id, stable while the photo is in the form. */
  id: number;
  name: string;
  phase: "uploading" | "uploaded" | "error";
  kind: "image" | "video";
  angle: AngleRole;
  key?: string;
  sha256?: string;
  message?: string;
  /** The preflight at upload (docs/phases/PHASE_14.md workstream 4). */
  preflightPhase?: "checking" | "done" | "failed";
  preflight?: PreflightView | null;
  /** The note the preflight read, so a changed note asks again. */
  preflightNote?: string;
  preflightFailure?: string;
  /** The product the seller tapped in the chooser. */
  chosen?: number | null;
  /** The seller answered the question step's "Which product" with every
   * item (PHASE_16 workstream 4): the photo needs no single pick. */
  targetAll?: boolean;
  /** Object URL of the picked file, for the thumbnail and the preview strip.
   * Revoked when the photo is removed and when the form unmounts. */
  previewUrl?: string;
  /** This photo's own background (PHASE_15 P1); "pack" or missing follows the switch. */
  background?: PhotoBackground;
}

/** Why this photo cannot start a pack right now, or null (a photo whose
 * check could not run never blocks: the pack checks it again). */
export function photoBlockReason(
  photo: PhotoItem,
  selected: readonly string[],
  output?: PhotoOutputContext,
): string | null {
  if (photo.kind !== "image" || photo.phase !== "uploaded" || !photo.preflight) {
    return null;
  }
  return preflightBlockReason(photo.preflight, selected, photo.chosen, {
    multiItem: photo.angle === "in_the_box" || photo.targetAll === true,
    ...(output ? { output } : {}),
  });
}

/** The id the options use for a form photo: its R2 key once uploaded. */
export function formPhotoId(photo: Pick<PhotoItem, "id" | "key">): string {
  return photo.key ?? `local_photo_${photo.id}`;
}

/** The form's image photos as the options see them, in pack order. */
export function optionPhotosOf(photos: readonly PhotoItem[]): FormPhoto[] {
  return photos
    .filter((p) => p.kind === "image" && p.phase !== "error")
    .map((p) => ({
      id: formPhotoId(p),
      angle: p.angle,
      ...(p.preflight?.photo ? { width: p.preflight.photo.width, height: p.preflight.photo.height } : {}),
      ...(p.preflight?.status === "choose" && p.angle !== "in_the_box" ? { otherItems: true } : {}),
    }));
}

/** The gray chip under a channel row: "Stays white" or "Set shape, 1080 by 1920". */
export function channelChip(channel: Pick<ChannelOption, "requiresWhite" | "exactSize">): string | null {
  if (channel.requiresWhite) return "Stays white";
  if (channel.exactSize) return `Set shape, ${channel.exactSize.width} by ${channel.exactSize.height}`;
  return null;
}

/** True while focus is in a field that brings up a phone keyboard, so the
 * sticky bar never covers what is being typed. */
function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["checkbox", "radio", "file", "color", "button", "submit", "range"].includes(target.type);
}

/** The product box the pack is for, from the chooser: the seller's tap or
 * the note's preselected pick. None for a photo that shows several items on
 * purpose (in the box) or had nothing to choose. */
export function photoTargetBox(photo: PhotoItem): PreflightBox | undefined {
  if (
    photo.kind !== "image" ||
    photo.angle === "in_the_box" ||
    photo.targetAll === true ||
    photo.preflight?.status !== "choose"
  ) {
    return undefined;
  }
  return chosenItem(photo.preflight, photo.chosen)?.box;
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function NewPackForm({
  products,
  channels,
  tier,
  creditBalance,
  paywall,
  initialProductId,
  packsPaused = false,
  outputOptionsEnabled = false,
  brandColors,
  brandKitsAllowed = false,
  brandHasLogo = false,
  scenesPausedNote = null,
}: NewPackFormProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Thumbnail object URLs by local photo id, revoked on remove and unmount.
  const previewUrls = useRef(new Map<number, string>());
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls.values()) {
        URL.revokeObjectURL(url);
      }
      urls.clear();
    };
  }, []);
  // One Idempotency-Key per submission intent (Update.md 6.1): a retry of the
  // same contents reuses it, any change to the contents gets a new one.
  const intentRef = useRef<SubmitIntent | null>(null);
  // Local ids for photos; each upload updates only its own photo, so a slow
  // upload never touches another one.
  const photoSeq = useRef(0);
  const [dragOver, setDragOver] = useState(false);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  // A new photo is a new product unless the seller picks an existing one
  // and confirms the photo shows it, so photos of two items never mix.
  const [productId, setProductId] = useState(() =>
    initialProductId && products.some((p) => p.id === initialProductId) ? initialProductId : "new",
  );
  const [confirmedAttach, setConfirmedAttach] = useState<string | null>(null);
  const [newProductTitle, setNewProductTitle] = useState("");
  const [description, setDescription] = useState("");
  // The note as typed right now, for checks that finish after a keystroke.
  const descriptionRef = useRef("");
  descriptionRef.current = description;
  // Seller inputs, prefilled from the picked product and saved on it.
  const initialProduct = products.find((p) => p.id === productId) ?? null;
  const [sku, setSku] = useState(initialProduct?.sku ?? "");
  const [boxText, setBoxText] = useState((initialProduct?.boxContents ?? []).join("\n"));
  const [comparisonText, setComparisonText] = useState((initialProduct?.comparisonFacts ?? []).join("\n"));
  const [endorsementText, setEndorsementText] = useState((initialProduct?.endorsements ?? []).join("\n"));
  const [selected, setSelected] = useState<string[]>(
    DEFAULT_CHANNELS.filter((id) => channels.some((c) => c.id === id && isPickable(c))),
  );
  const [mode, setMode] = useState<EstimateMode>("listing");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outOfCredits, setOutOfCredits] = useState<PaywallCopy | null>(null);

  // Channels that can be picked first; coming soon and upgrade ones after.
  const ordered = [...channels].sort((a, b) => Number(!isPickable(a)) - Number(!isPickable(b)));
  const marketplaceChannels = ordered.filter((c) => c.marketplace);
  const socialChannels = ordered.filter((c) => !c.marketplace);
  const effectiveMode: EstimateMode = CONCEPT_MODE_AVAILABLE ? mode : "listing";
  const boxContents = useMemo(() => sellerLinesFromText(boxText), [boxText]);
  const comparisonFacts = useMemo(() => sellerLinesFromText(comparisonText), [comparisonText]);
  const endorsements = useMemo(() => sellerLinesFromText(endorsementText), [endorsementText]);
  const photoAngles = photos.filter((p) => p.kind === "image" && p.phase !== "error").map((p) => p.angle);
  const anglesKey = photoAngles.join(",");
  const selectedProduct = products.find((p) => p.id === productId) ?? null;

  // Section 3 "How your images look" (PHASE_15). The seller's choices stay
  // as picked; the pack is sent and estimated with the effective ones, which
  // apply the scenes pause and concept mode.
  const optionsOn = outputOptionsEnabled;
  // Brand colors a remembered choice may still use: the kit's, on a plan with kits.
  const brandColorCount = brandKitsAllowed ? usableBrandColors(brandColors).length : 0;
  const [initialOptions] = useState(() => initialOptionsFor(initialProduct, optionsOn, brandColorCount));
  const [outputForm, dispatchOutput] = useReducer(outputFormReducer, initialOptions.state);
  // The title whose remembered choices filled the options, for the notice.
  const [rememberedTitle, setRememberedTitle] = useState<string | null>(
    initialOptions.remembered ? (initialProduct?.title ?? null) : null,
  );
  const [colorProblem, setColorProblem] = useState<string | null>(null);
  const [pauseLeftOut, setPauseLeftOut] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  // The question step (PHASE_16 workstream 4): taps by question id, and
  // whether the seller chose "Skip, use my note".
  const [questionPicks, setQuestionPicks] = useState<Record<string, string>>({});
  const [questionsSkipped, setQuestionsSkipped] = useState(false);
  const choices = useMemo(
    () =>
      effectiveChoices(outputForm.choices, {
        conceptMode: effectiveMode === "concept",
        scenesPaused: scenesPausedNote !== null,
      }),
    [outputForm.choices, effectiveMode, scenesPausedNote],
  );
  const optionsKey = optionsIntentKey(choices, outputForm.more);
  const usableBrand = useMemo(() => brandColors ?? [], [brandColors]);
  const storedPhotoCount = selectedProduct?.storedPhotoCount ?? 0;
  const output = useMemo(() => {
    // The pack's photos in pack order (uploads, else the stored ones), and
    // the same list with a front placeholder while there is none yet.
    const parsed: FormPhoto[] = formPhotos(optionPhotosOf(photos), storedPhotoCount, MAX_PACK_PHOTOS);
    const planned = planningPhotos(parsed);
    const current = resolveFormOutput({
      choices,
      lookBase: outputForm.lookBase,
      brandColors: usableBrand,
      brandKitsAllowed,
      photos: planned,
      more: outputForm.more,
      photoBackgrounds: photoBackgroundsOf(photos),
    });
    const estimateInputs = outputEstimateInputs(current.resolved, parsed);
    const keptCount = parsed.filter((photo) => current.resolved.keepMediaIds.includes(photo.id)).length;
    return { planned, parsed, current, estimateInputs, keptCount };
  }, [photos, storedPhotoCount, choices, outputForm.lookBase, outputForm.more, usableBrand, brandKitsAllowed]);
  const flags: OutputPlanFlags | null = optionsOn ? output.current.flags : null;

  const estimate = useMemo(
    () =>
      estimatePackCredits(selected, effectiveMode, tier, {
        angles: anglesKey ? (anglesKey.split(",") as AngleRole[]) : [],
        hasBoxContents: boxContents.length > 0,
        hasComparisonFacts: comparisonFacts.length > 0,
        hasEndorsements: endorsements.length > 0,
        ...(optionsOn ? output.estimateInputs : {}),
      }),
    [selected, effectiveMode, tier, anglesKey, boxContents, comparisonFacts, endorsements, optionsOn, output],
  );
  // The difference between looks, for the summary: this pack as Keep my
  // photo and as Marketplace ready, both with the pack's bundle (PHASE_16).
  const bundle = currentBundle(outputForm);
  const lookTotals = useMemo(() => {
    if (!optionsOn) return null;
    const base = {
      angles: anglesKey ? (anglesKey.split(",") as AngleRole[]) : [],
      hasBoxContents: boxContents.length > 0,
      hasComparisonFacts: comparisonFacts.length > 0,
      hasEndorsements: endorsements.length > 0,
    };
    const totalFor = (look: "keep_photo" | "marketplace") => {
      const resolved = resolveFormOutput({
        choices: effectiveChoices(lookPresetFor(look, bundle), { scenesPaused: scenesPausedNote !== null }),
        brandColors: usableBrand,
        brandKitsAllowed,
        photos: output.planned,
      });
      return estimatePackCredits(selected, effectiveMode, tier, {
        ...base,
        ...outputEstimateInputs(resolved.resolved, output.parsed),
      }).total;
    };
    return {
      keep: totalFor("keep_photo"),
      marketplace:
        bundle === DEFAULT_BUNDLE
          ? estimatePackCredits(selected, effectiveMode, tier, base).total
          : totalFor("marketplace"),
    };
  }, [optionsOn, bundle, anglesKey, boxContents, comparisonFacts, endorsements, scenesPausedNote, usableBrand, brandKitsAllowed, output, selected, effectiveMode, tier]);
  // Each bundle card's figure for this pack (PHASE_16 workstream 1).
  const bundleTotals = useMemo(
    () =>
      optionsOn && effectiveMode === "listing"
        ? bundleEstimates({
            channels: selected,
            mode: effectiveMode,
            tier,
            seller: {
              angles: anglesKey ? (anglesKey.split(",") as AngleRole[]) : [],
              hasBoxContents: boxContents.length > 0,
              hasComparisonFacts: comparisonFacts.length > 0,
              hasEndorsements: endorsements.length > 0,
            },
            state: outputForm,
            brandColors: usableBrand,
            brandKitsAllowed,
            photos: output.parsed,
            planned: output.planned,
            photoBackgrounds: photoBackgroundsOf(photos),
            context: { scenesPaused: scenesPausedNote !== null },
          })
        : null,
    [optionsOn, effectiveMode, selected, tier, anglesKey, boxContents, comparisonFacts, endorsements, outputForm, usableBrand, brandKitsAllowed, output, photos, scenesPausedNote],
  );

  const conflicts = optionsOn && effectiveMode !== "concept" ? formConflicts(selected, output.current.resolved, output.planned) : [];
  const conflictContext = conflictContextOf(choices.background, output.planned, output.current.resolved);
  const headsUp: ConflictLine[] = conflictLines(conflicts, conflictContext);
  const photoOutput = (photo: PhotoItem): PhotoOutputContext | undefined =>
    flags && effectiveMode !== "concept" ? photoOutputContext(formPhotoId(photo), selected, flags) : undefined;
  // With options on, the cutout pause stops only a pack that needs a cutout.
  const pauseBlocks = optionsOn && flags ? pauseBlocksSubmit(packsPaused, selected, flags) : packsPaused;
  // Concept packs are normalized to today's pack by the server, so they send none.
  const sendsOptions = optionsOn && effectiveMode === "listing";

  const detailsProblem = sellerDetailsProblem(sku, boxContents, comparisonFacts, endorsements);
  const uploading = photos.some((p) => p.phase === "uploading");
  const checking = photos.some((p) => p.phase === "uploaded" && p.preflightPhase === "checking");
  const blockReason =
    photos.map((p) => photoBlockReason(p, selected, photoOutput(p))).find((reason) => reason !== null) ?? null;
  const uploaded = photos.filter((p) => p.phase === "uploaded" && p.key && p.sha256);
  // The question step: the front photo's questions, less what the form knows.
  const questionPhoto = questionSourcePhoto(photos);
  const questions = questionPhoto
    ? visibleQuestions(
        questionPhoto.preflight,
        knownKinds({
          photoAngle: questionPhoto.angle,
          optionsOn: optionsOn && effectiveMode !== "concept",
          scenesOn: choices.extras.scenes,
          scenePreset: outputForm.more.scenePreset,
        }),
      )
    : [];
  const questionsShown = questions.length > 0 && !questionsSkipped;
  // The target question replaces the chooser of its own photo while shown.
  const chooserInStep = questionsShown && questions.some((q) => q.kind === "target") ? questionPhoto?.id : undefined;
  const questionValues: Record<string, string | null> = Object.fromEntries(
    questions.map((q) => [q.id, q.kind === "target" && questionPhoto ? targetValueOf(questionPhoto) : (questionPicks[q.id] ?? null)]),
  );
  const answersBody = sellerAnswersBody({ photo: questionPhoto, questions, picks: questionPicks, skipped: questionsSkipped });

  function pickAnswer(question: SellerQuestion, value: string) {
    setSubmitError(null);
    if (question.kind === "target") {
      const pick = targetPickOf(value);
      if (pick && questionPhoto) updatePhoto(questionPhoto.id, pick);
      return;
    }
    setQuestionPicks((current) => ({ ...current, [question.id]: value }));
    if (question.kind === "channels") {
      setSelected((current) =>
        channelsAfterAnswer(current, value, question, (id) => {
          const channel = channels.find((c) => c.id === id);
          return channel ? { pickable: isPickable(channel), marketplace: channel.marketplace } : null;
        }),
      );
    }
  }
  const attachKey =
    uploaded.length > 0 && selectedProduct ? `${uploaded.map((p) => p.key).join("|")}:${selectedProduct.id}` : null;
  const needsAttachConfirm = attachKey !== null && confirmedAttach !== attachKey;

  function pickProduct(id: string) {
    setProductId(id);
    // An existing product brings its saved details; a new one starts empty.
    const product = products.find((p) => p.id === id) ?? null;
    setSku(product?.sku ?? "");
    setBoxText((product?.boxContents ?? []).join("\n"));
    setComparisonText((product?.comparisonFacts ?? []).join("\n"));
    setEndorsementText((product?.endorsements ?? []).join("\n"));
    // Its remembered choices prefill the options, like the SKU (PHASE_15
    // P1). A product without them, after one with them, starts over from
    // Marketplace ready so one product's choices never carry to another.
    // While cutouts are paused and the seller chose "Keep my photos
    // instead", a product pick never undoes that choice: its remembered
    // choices or a reset to Marketplace ready would need a cutout again.
    if (pauseLeftOut !== null) return;
    const remembered =
      optionsOn && product ? rememberedFormState(product.outputDefaults, { brandColorCount }) : null;
    if (remembered && product) {
      dispatchOutput({ type: "prefill", state: remembered });
      setRememberedTitle(product.title);
    } else if (rememberedTitle !== null) {
      dispatchOutput({ type: "look", look: "marketplace" });
      setRememberedTitle(null);
    }
  }

  /** "Start from Marketplace ready": drops the remembered choices. */
  function startFromMarketplace() {
    applyOutput({ type: "look", look: "marketplace" });
    setRememberedTitle(null);
  }

  function updatePhoto(id: number, patch: Partial<PhotoItem>) {
    setPhotos((current) => current.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  function toggleChannel(id: string) {
    // A channel the server would refuse is never added to the pack.
    if (!channels.some((c) => c.id === id && isPickable(c))) {
      return;
    }
    setSelected((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  /** Leave it out: untick these channels, visibly, from a heads up line. */
  function leaveChannelsOut(specIds: readonly string[]) {
    setSelected((current) => leaveOut(current, specIds));
  }

  function applyOutput(action: OutputFormAction) {
    if (action.type === "look") {
      const changed = packLookChangedProps(outputForm.lookBase, action.look);
      if (changed) track(PACK_LOOK_CHANGED_EVENT, changed);
    }
    dispatchOutput(action);
    setSubmitError(null);
  }

  /** "Keep my photos instead" while cutouts are paused: the Keep look, every
   * extra off, the white required channels unticked and named. */
  function keepPhotosInstead() {
    applyOutput({ type: "keep_instead" });
    const next = withoutWhiteRequired(selected);
    setSelected(next.selected);
    setPauseLeftOut(leftOutAfterPauseLine(next.leftOut));
  }

  function renderChannel(channel: ChannelOption) {
    const pickable = isPickable(channel);
    const label = channelLabel(channel.id);
    const chip = optionsOn && pickable ? channelChip(channel) : null;
    const lines =
      optionsOn && selected.includes(channel.id)
        ? rowConflicts(conflicts, channel.id).map((c) => conflictCopy(c, conflictContext))
        : [];
    return (
      <div
        key={channel.id}
        className={cn("rounded-lg px-2 py-1.5 text-sm", pickable ? "text-ink-700 hover:bg-ink-50" : "text-ink-400")}
        data-testid={`channel-${channel.id}`}
      >
        <div className="flex items-center justify-between gap-2">
          <label
            className={cn(
              "flex min-w-0 items-center gap-2",
              optionsOn && "min-h-11",
              pickable ? "cursor-pointer" : "cursor-not-allowed",
            )}
          >
            <input
              type="checkbox"
              checked={pickable && selected.includes(channel.id)}
              disabled={!pickable}
              onChange={() => toggleChannel(channel.id)}
              className={cn("rounded border-ink-300 accent-ink-900", optionsOn ? "h-5 w-5" : "h-4 w-4")}
            />
            {label}
          </label>
          {chip ? (
            <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-600" data-testid="row-chip">
              {chip}
            </span>
          ) : null}
          {channel.availability === "coming_soon" ? <ComingSoonBadge /> : null}
          {channel.availability === "upgrade_required" ? (
            <Link
              href="/app/billing"
              className="shrink-0 text-xs font-medium text-ink-900 underline"
              data-testid="channel-upgrade"
            >
              {channel.upgradeTo ? `${planName(channel.upgradeTo)} plan` : "Upgrade"}
            </Link>
          ) : null}
        </div>
        {lines.map((line) => (
          <p key={line.text} className="mt-1 pl-7 text-xs text-amber-700" data-testid="row-heads-up">
            {line.text}
            {line.leaveOutLabel && line.specIds.length > 0 ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => leaveChannelsOut(line.specIds)}
                  className="inline-flex min-h-11 items-center font-medium underline"
                >
                  {line.leaveOutLabel}
                </button>
              </>
            ) : null}
          </p>
        ))}
      </div>
    );
  }

  function addFiles(files: File[]) {
    setSubmitError(null);
    setUploadNotice(null);
    const room = MAX_PACK_PHOTOS - photos.length;
    if (room <= 0) {
      setUploadNotice(`One pack takes up to ${MAX_PACK_PHOTOS} photos. Remove one to add another.`);
    } else if (files.length > room) {
      setUploadNotice(`One pack takes up to ${MAX_PACK_PHOTOS} photos, so only the first ${room} of these were added.`);
    }
    const taken = photos.filter((p) => p.kind === "image").map((p) => p.angle);
    const added: Array<{ item: PhotoItem; file: File }> = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      const kind = file.type.startsWith("video/") ? "video" : "image";
      const angle = nextAngle(taken);
      if (kind === "image") {
        taken.push(angle);
      }
      const id = ++photoSeq.current;
      const previewUrl = optionsOn && kind === "image" ? objectUrlFor(id, file) : undefined;
      added.push({
        item: { id, name: file.name, phase: "uploading", kind, angle, ...(previewUrl ? { previewUrl } : {}) },
        file,
      });
    }
    if (added.length === 0) {
      return;
    }
    setPhotos((current) => [...current, ...added.map((a) => a.item)]);
    for (const { item, file } of added) {
      void handleFile(file, item.id);
    }
  }

  /** A thumbnail URL for a picked file, remembered so it can be revoked. */
  function objectUrlFor(id: number, file: File): string | undefined {
    try {
      const url = URL.createObjectURL(file);
      previewUrls.current.set(id, url);
      return url;
    } catch {
      return undefined;
    }
  }

  function removePhoto(id: number) {
    const url = previewUrls.current.get(id);
    if (url) {
      URL.revokeObjectURL(url);
      previewUrls.current.delete(id);
    }
    setPhotos((current) => current.filter((p) => p.id !== id));
  }

  async function handleFile(file: File, id: number) {
    const update = (patch: Partial<PhotoItem>) => updatePhoto(id, patch);
    try {
      const response = await fetch("/api/uploads/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: file.type.startsWith("video/") ? "video" : "image",
          contentType: file.type,
          bytes: file.size,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        url?: string;
        key?: string;
        error?: string;
        reason?: string;
      };
      if (response.status === 503 && data.reason === "uploads_not_configured") {
        // Uploads are off on this server (demo mode): the photo is dropped and
        // the pack uses the demo photo.
        removePhoto(id);
        setUploadNotice(data.error ?? "Uploads are not configured yet. The pack will use the demo photo instead.");
        return;
      }
      if (!response.ok || !data.url || !data.key) {
        update({ phase: "error", message: data.error ?? "The upload could not be signed." });
        return;
      }
      const put = await fetch(data.url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) {
        update({ phase: "error", message: "The upload failed. Try again." });
        return;
      }
      update({ phase: "uploaded", key: data.key, sha256: await sha256Hex(file) });
      if (!file.type.startsWith("video/")) {
        void runPreflight(id, data.key);
      }
    } catch {
      update({ phase: "error", message: "The upload failed. Check your connection and try again." });
    }
  }

  // The preflight at upload: intake, moderation, the products in the photo
  // and the size gate, before any pack or credit hold. A check that cannot
  // run never blocks the pack; the pack checks the photo again.
  async function runPreflight(id: number, key: string) {
    const note = descriptionRef.current.trim();
    updatePhoto(id, { preflightPhase: "checking", preflightFailure: undefined });
    try {
      const response = await fetch("/api/uploads/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, ...(note ? { note } : {}) }),
      });
      const data = (await response.json().catch(() => ({}))) as { preflight?: PreflightView; error?: string };
      if (!response.ok || !data.preflight) {
        updatePhoto(id, { preflightPhase: "failed", preflight: null, preflightFailure: data.error ?? PREFLIGHT_UNAVAILABLE_NOTICE });
        return;
      }
      const view = data.preflight;
      setPhotos((current) =>
        current.map((p) => {
          if (p.id !== id || p.key !== key) return p;
          // A tap survives a second check when that product is still there,
          // and "every item" while the photo still holds several.
          const keep = p.chosen != null && view.items.some((item) => item.number === p.chosen) ? p.chosen : null;
          const targetAll = p.targetAll === true && view.status === "choose";
          return { ...p, preflightPhase: "done", preflight: view, preflightNote: note, chosen: keep, targetAll };
        }),
      );
    } catch {
      updatePhoto(id, { preflightPhase: "failed", preflight: null, preflightFailure: PREFLIGHT_UNAVAILABLE_NOTICE });
    }
  }

  // A changed note can change which product it names, so every checked
  // photo is asked again (the cutout is cached, so only the cheap intake
  // call runs again).
  function recheckForNote() {
    const note = description.trim();
    for (const photo of photos) {
      if (photo.kind === "image" && photo.key && photo.preflightPhase === "done" && photo.preflightNote !== note) {
        void runPreflight(photo.id, photo.key);
      }
    }
  }

  // A product link fills the name and notes of a new product.
  function applyImportedProduct(product: ImportedProduct) {
    setProductId("new");
    setConfirmedAttach(null);
    if (product.title) {
      setNewProductTitle(product.title.slice(0, IMPORT_TITLE_MAX));
    }
    const notes = sellerNotesFrom(product);
    if (notes) {
      setDescription(notes);
    }
  }

  // A photo picked from the imported listing is copied into this
  // workspace's uploads by the server, then used like an upload.
  async function handleImportedPhoto(image: ImportedImage, index: number) {
    setSubmitError(null);
    setUploadNotice(null);
    if (photos.length >= MAX_PACK_PHOTOS) {
      setUploadNotice(`One pack takes up to ${MAX_PACK_PHOTOS} photos. Remove one to add another.`);
      return;
    }
    const id = ++photoSeq.current;
    const name = `photo ${index + 1} from your listing`;
    const angle = nextAngle(photos.filter((p) => p.kind === "image").map((p) => p.angle));
    setPhotos((current) => [...current, { id, name, phase: "uploading", kind: "image", angle }]);
    const outcome = await requestPhotoImport(image.url, name);
    if (outcome.phase === "uploaded") {
      updatePhoto(id, { phase: "uploaded", key: outcome.key, sha256: outcome.sha256 });
      void runPreflight(id, outcome.key);
    } else if (outcome.phase === "notice") {
      // Imports are off on this server (demo mode), like uploads.
      removePhoto(id);
      setUploadNotice(outcome.message);
    } else {
      updatePhoto(id, { phase: "error", message: outcome.message });
    }
  }

  async function submit() {
    if (pauseBlocks) return;
    setSubmitError(null);
    if (uploading || submitting || checking) {
      return;
    }
    if (blockReason) {
      setSubmitError(blockReason);
      return;
    }
    if (selected.length === 0) {
      setSubmitError("Pick at least one channel.");
      return;
    }
    if (needsAttachConfirm && selectedProduct) {
      setSubmitError(`Confirm whether these photos show ${selectedProduct.title}.`);
      return;
    }
    if (detailsProblem) {
      setSubmitError(detailsProblem);
      return;
    }
    if (sendsOptions && colorProblem) {
      setSubmitError(colorProblem);
      return;
    }
    const uploads = uploaded.map((p) => {
      const targetBox = photoTargetBox(p);
      return {
        key: p.key!,
        sha256: p.sha256!,
        kind: p.kind,
        ...(p.kind === "image" ? { angle: p.angle } : {}),
        ...(targetBox ? { targetBox } : {}),
        // A photo's own background (PHASE_15 P1), sent only when it has one.
        ...(sendsOptions && p.kind === "image" ? uploadBackgroundField(p.background) : {}),
      };
    });
    const details = { sku: sku.trim(), boxContents, comparisonFacts, endorsements };
    const intent = intentFor(
      intentRef.current,
      {
        productId,
        channels: selected,
        mode: effectiveMode,
        uploadKey: uploads.length > 0 ? uploads.map((u) => u.key).join("|") : null,
        newProductTitle,
        description,
        details: JSON.stringify({
          angles: uploads.map((u) => u.angle ?? ""),
          targets: uploads.map((u) => u.targetBox ?? null),
          ...details,
          // Any change to the image choices is a new intent (PHASE_15).
          ...(sendsOptions ? { options: optionsKey } : {}),
          ...(uploads.some((u) => u.background) ? { backgrounds: uploads.map((u) => u.background ?? "") } : {}),
          // Any change to the answers is a new intent (PHASE_16).
          ...(answersBody ? { answers: answersBody } : {}),
        }),
      },
      () => crypto.randomUUID(),
    );
    intentRef.current = intent;
    setSubmitting(true);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": intent.key,
        },
        body: JSON.stringify({
          productId,
          channels: selected,
          mode: effectiveMode,
          uploads: uploads.length > 0 ? uploads : undefined,
          newProductTitle: productId === "new" && newProductTitle.trim() ? newProductTitle.trim() : undefined,
          userDescription: description.trim() ? description.trim() : undefined,
          ...details,
          ...(sendsOptions ? { outputOptions: outputOptionsBody(outputForm.lookBase, choices, outputForm.more) } : {}),
          ...(answersBody ? { sellerAnswers: answersBody } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        job?: { id: string };
        error?: string;
        reason?: string;
        replayed?: boolean;
      };
      if (!response.ok || !data.job) {
        if (submitFailureSpendsKey(response.status, data.reason)) {
          // The next try is a new intent with a new key, so it creates a
          // fresh job instead of replaying this refusal.
          intentRef.current = null;
        }
        if (isOutOfCreditsRefusal(response.status, data.reason, estimate.total)) {
          setOutOfCredits(outOfCreditsCopy(paywall, estimate.total));
        } else {
          // An invalid_upload refusal means the server removed the file, so
          // the message asks the seller to remove it and pick another.
          setSubmitError(data.error ?? "The pack could not be started. Try again in a moment.");
        }
        setSubmitting(false);
        return;
      }
      track("pack_created", {
        product_is_new: productId === "new",
        photo_count: uploads.filter((u) => u.kind === "image").length,
        replayed: data.replayed === true,
        ...(sendsOptions
          ? packCreatedOutputProps(outputForm.lookBase, choices, output.keptCount, outputForm.more)
          : {}),
      });
      intentRef.current = null;
      // Stay in the submitting state until the job page takes over, so a
      // second click cannot start a second pack. The refresh after the push
      // rerenders the shared app layout, so the header balance shows the hold.
      router.push(`/app/jobs/${data.job.id}`);
      router.refresh();
    } catch {
      // The same intent keeps its key, so trying again replays this request
      // if the server already started the pack.
      setSubmitError("The pack could not be started. Check your connection and try again.");
      setSubmitting(false);
    }
  }

  const overBalance = estimateOverBalanceLine(estimate.total, creditBalance);
  const createDisabled = submitting || uploading || checking || blockReason !== null || pauseBlocks;
  const hold = optionsOn ? holdLine(estimate.total) : null;
  const lookDifference = lookTotals ? lookDifferenceLine(lookTotals.keep, lookTotals.marketplace) : null;
  const backgroundLine =
    optionsOn && effectiveMode !== "concept" ? backgroundSummaryLine(choices, output.current.resolved.colorHex) : null;
  const resizeOnly = optionsOn && effectiveMode !== "concept" && isResizeOnly(choices);
  const frontPreview =
    photos.find((p) => p.kind === "image" && p.phase !== "error" && p.angle === "front" && p.previewUrl)?.previewUrl ??
    photos.find((p) => p.kind === "image" && p.phase !== "error" && p.previewUrl)?.previewUrl ??
    null;
  // The cutout preview the preflight made, front photo first (PHASE_15 P1).
  const cutoutPreview =
    photos.find((p) => p.kind === "image" && p.phase === "uploaded" && p.angle === "front" && p.preflight?.previewUrl)
      ?.preflight?.previewUrl ??
    photos.find((p) => p.kind === "image" && p.phase === "uploaded" && p.preflight?.previewUrl)?.preflight?.previewUrl ??
    null;
  const keepHint =
    optionsOn && effectiveMode !== "concept" ? keepBackgroundHint(description, outputForm.choices.background) : null;
  const buttonLabel = uploading
    ? "Uploading photo"
    : checking
      ? "Checking photo"
      : submitting
        ? "Starting"
        : "Create pack";

  // The phone bar hides while a field that raises the keyboard has focus.
  const focusProps = optionsOn
    ? {
        onFocusCapture: (event: FocusEvent<HTMLDivElement>) => setTyping(isTextEntry(event.target)),
        onBlurCapture: () => setTyping(false),
      }
    : {};

  return (
    <div className={cn("grid gap-8 lg:grid-cols-[1fr_20rem]", optionsOn && "pb-28 lg:pb-0")} {...focusProps}>
      <div className="min-w-0 space-y-8">
        {optionsOn && packsPaused ? (
          <div
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
            data-testid="preflight-banner"
            data-verdict="packs_paused"
          >
            <p>{KEEP_PHOTOS_PAUSED_COPY}</p>
            {pauseBlocks ? (
              <Button variant="outline" className="mt-3 min-h-11" onClick={keepPhotosInstead} data-testid="keep-photos-instead">
                {KEEP_PHOTOS_INSTEAD_LABEL}
              </Button>
            ) : null}
            {pauseLeftOut ? (
              <p className="mt-2" data-testid="pause-left-out">
                {pauseLeftOut}
              </p>
            ) : null}
          </div>
        ) : null}
        <section>
          <h2 className="text-lg font-semibold text-ink-950">1. Add your product</h2>
          <ProductLinkImport
            onProduct={applyImportedProduct}
            onPickPhoto={(image, index) => void handleImportedPhoto(image, index)}
            busy={uploading}
          />
          <div
            className={cn(
              "mt-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
              dragOver ? "border-accent-500 bg-accent-50" : "border-ink-200 bg-white",
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              addFiles([...event.dataTransfer.files]);
            }}
          >
            <p className="text-sm font-medium text-ink-900">Drop your product photos here</p>
            <p className="mt-1 text-xs text-ink-500">
              Up to {MAX_PACK_PHOTOS} photos, one per angle works best. JPEG, PNG, WEBP, GIF or TIFF up to 25 MB.
              Video up to 200 MB.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,image/tiff,video/mp4,video/quicktime"
              className="sr-only"
              aria-label="Upload a product photo"
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                // Picking the same file again after removing it still fires.
                event.target.value = "";
              }}
            />
            <Button
              variant="outline"
              className="mt-4"
              disabled={photos.length >= MAX_PACK_PHOTOS}
              onClick={() => fileInputRef.current?.click()}
            >
              {photos.length > 0 ? "Add more photos" : "Choose photos"}
            </Button>
            <div aria-live="polite">
              {uploadNotice ? (
                <p className="mt-3 text-sm text-amber-700" data-testid="upload-notice">
                  {uploadNotice}
                </p>
              ) : null}
            </div>
          </div>

          {photos.length > 0 ? (
            <div className="mt-3">
              <p className="text-xs text-ink-500">
                Tell us what each photo shows, so every angle is made from the photo that really shows it.
              </p>
              <ul className="mt-2 space-y-2" data-testid="photo-list">
                {photos.map((photo, index) => (
                  <li
                    key={photo.id}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-200 bg-white px-3 py-2"
                    data-testid="photo-item"
                  >
                    {optionsOn && photo.previewUrl ? (
                      <img
                        src={photo.previewUrl}
                        alt=""
                        decoding="async"
                        className="size-12 shrink-0 rounded-md bg-ink-50 object-cover"
                        data-testid="photo-thumb"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1" aria-live="polite">
                      <p className="truncate text-sm font-medium text-ink-900">{photo.name}</p>
                      {photo.phase === "uploading" ? (
                        <p className="text-xs text-ink-500" data-testid="upload-progress">
                          Uploading {photo.name}
                        </p>
                      ) : null}
                      {photo.phase === "uploaded" ? (
                        <p className="text-xs text-emerald-700" data-testid="upload-done">
                          Uploaded {photo.name}
                        </p>
                      ) : null}
                      {photo.phase === "uploaded" && photo.kind === "image" && photo.preflightPhase ? (
                        <PreflightResult
                          view={photo.preflight ?? null}
                          checking={photo.preflightPhase === "checking"}
                          failure={photo.preflightFailure ?? null}
                          selected={selected}
                          chosen={photo.chosen ?? null}
                          onChoose={(number) => {
                            updatePhoto(photo.id, { chosen: number, targetAll: false });
                            setSubmitError(null);
                          }}
                          multiItem={photo.angle === "in_the_box" || photo.targetAll === true}
                          hideChooser={photo.id === chooserInStep}
                          photoLabel={`photo ${index + 1}`}
                          output={photoOutput(photo)}
                        />
                      ) : null}
                      {photo.phase === "error" ? (
                        <p className="text-xs text-red-600" role="alert">
                          {photo.message}
                        </p>
                      ) : null}
                    </div>
                    {photo.kind === "image" ? (
                      <div>
                        <Label htmlFor={`photo-angle-${photo.id}`} className="sr-only">
                          What photo {index + 1} shows
                        </Label>
                        <Select
                          id={`photo-angle-${photo.id}`}
                          className="[&_select]:h-11"
                          value={photo.angle}
                          onChange={(event) => updatePhoto(photo.id, { angle: event.target.value as AngleRole })}
                          data-testid="photo-angle"
                        >
                          {ANGLE_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {ANGLE_LABELS[role]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ) : null}
                    {photo.kind === "image" && optionsOn && effectiveMode !== "concept" ? (
                      <div>
                        <Label htmlFor={`photo-background-${photo.id}`} className="sr-only">
                          {photoBackgroundLabel(index + 1)}
                        </Label>
                        <Select
                          id={`photo-background-${photo.id}`}
                          className="[&_select]:h-11"
                          value={photo.background ?? "pack"}
                          onChange={(event) => {
                            const value = event.target.value;
                            if (isPhotoBackground(value)) {
                              updatePhoto(photo.id, { background: value });
                              setSubmitError(null);
                            }
                          }}
                          data-testid="photo-background"
                        >
                          {PHOTO_BACKGROUND_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ) : null}
                    {photo.kind === "image" ? null : (
                      <span className="text-xs text-ink-500">Video</span>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => removePhoto(photo.id)}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="product-select">Product</Label>
              <Select
                id="product-select"
                value={productId}
                onChange={(event) => pickProduct(event.target.value)}
                className="mt-1"
              >
                <option value="new">New product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.title}
                  </option>
                ))}
              </Select>
              {productId === "new" ? (
                <div className="mt-3">
                  <Label htmlFor="new-product-title">Product name</Label>
                  <Input
                    id="new-product-title"
                    value={newProductTitle}
                    maxLength={120}
                    onChange={(event) => setNewProductTitle(event.target.value)}
                    placeholder="Ceramic pour over mug"
                    className="mt-1"
                  />
                </div>
              ) : null}
              <p className="mt-1 text-xs text-ink-400">
                {productId === "new"
                  ? "A new photo starts a new product."
                  : "Leave the photo empty to use the photos already saved for this product."}
              </p>
              {optionsOn && rememberedTitle ? (
                <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-ink-600" data-testid="remembered-choices">
                  <span>{rememberedLine(rememberedTitle)}</span>
                  <button
                    type="button"
                    onClick={startFromMarketplace}
                    className="inline-flex min-h-11 items-center font-medium text-accent-700 underline"
                    data-testid="remembered-reset"
                  >
                    {REMEMBERED_RESET_LABEL}
                  </button>
                </p>
              ) : null}
              {needsAttachConfirm && selectedProduct ? (
                <div
                  className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3"
                  role="group"
                  aria-labelledby="attach-question"
                  data-testid="attach-confirm"
                >
                  <p id="attach-question" className="text-sm text-ink-800">
                    Do these photos show {selectedProduct.title}? Photos of different items in one pack give mixed
                    results.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => attachKey && setConfirmedAttach(attachKey)}>
                      Add them to {selectedProduct.title}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => pickProduct("new")}>
                      It is a new product
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div>
              <Label htmlFor="product-description">Anything we should know</Label>
              <Textarea
                id="product-description"
                value={description}
                maxLength={2000}
                onChange={(event) => setDescription(event.target.value)}
                onBlur={recheckForNote}
                placeholder="Materials, sizes, claims you can back up."
                className="mt-1"
              />
              <p className="mt-1 text-xs text-ink-400">
                Optional. The analyzer reads this as seller notes when planning your shots.
              </p>
              {questionsShown ? (
                <QuestionStep
                  questions={questions}
                  items={questionPhoto?.preflight?.items ?? []}
                  values={questionValues}
                  onPick={pickAnswer}
                  onSkip={() => setQuestionsSkipped(true)}
                />
              ) : questions.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setQuestionsSkipped(false)}
                  className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-ink-700 underline"
                  data-testid="question-reopen"
                >
                  {QUESTION_STEP_COPY.reopen}
                </button>
              ) : null}
              {keepHint ? (
                <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-amber-800" data-testid="keep-background-hint">
                  <span>{keepHint}</span>
                  <button
                    type="button"
                    onClick={() => applyOutput({ type: "background", background: "keep" })}
                    className="inline-flex min-h-11 items-center font-medium underline"
                  >
                    {KEEP_BACKGROUND_HINT_ACTION}
                  </button>
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-6 rounded-xl border border-ink-200 bg-white p-4" data-testid="seller-details">
            <h3 className="text-sm font-semibold text-ink-900">Details for more images</h3>
            <p className="mt-1 text-xs text-ink-500">
              Optional, and saved with the product. What is in the box adds an In the box image. Comparison facts
              add a Comparison image. Press quotes or awards add an A+ module for Amazon. Each prints exactly what you
              type, one line each, up to {MAX_SELLER_LINES} lines of {MAX_SELLER_LINE_CHARS} characters.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="product-sku">SKU</Label>
                <Input
                  id="product-sku"
                  value={sku}
                  maxLength={MAX_SKU_CHARS}
                  onChange={(event) => setSku(event.target.value)}
                  placeholder="MUG-12-CREAM"
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-ink-400">Names your files, for example MUG-12-CREAM.MAIN.jpg.</p>
              </div>
              <div>
                <Label htmlFor="box-contents">What is in the box</Label>
                <Textarea
                  id="box-contents"
                  value={boxText}
                  onChange={(event) => setBoxText(event.target.value)}
                  placeholder={"Mug\nPour over cone\nTwo paper filters"}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="comparison-facts">How it compares</Label>
                <Textarea
                  id="comparison-facts"
                  value={comparisonText}
                  onChange={(event) => setComparisonText(event.target.value)}
                  placeholder={"Holds 12 oz, most hold 8 oz\nDishwasher safe glaze"}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-ink-400">Only facts you can back up.</p>
              </div>
              <div>
                <Label htmlFor="endorsements">Press quotes or awards</Label>
                <Textarea
                  id="endorsements"
                  value={endorsementText}
                  onChange={(event) => setEndorsementText(event.target.value)}
                  placeholder={"Great for the trail, Outdoor Weekly\nGift Guide pick, Home Journal 2026"}
                  className="mt-1"
                />
                <p className="mt-1 text-xs text-ink-400">
                  Amazon takes quotes from a known publication or public figure with the source, and awards from
                  the last 2 years with who gave them and when. Customer reviews are not allowed. Up to{" "}
                  {MAX_ENDORSEMENTS}, printed as you type them; we never write one for you.
                </p>
              </div>
            </div>
            {detailsProblem ? (
              <p className="mt-3 text-sm text-amber-700" data-testid="seller-details-problem">
                {detailsProblem}
              </p>
            ) : null}
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-950">2. Pick your channels</h2>
          {bundleTotals ? (
            <PackBundleCards
              bundle={bundle}
              onPick={(next) => applyOutput({ type: "bundle", bundle: next })}
              estimates={bundleTotals}
            />
          ) : null}
          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-ink-700">Marketplaces</h3>
              <div className="mt-2 space-y-1">{marketplaceChannels.map(renderChannel)}</div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-ink-700">Social and video</h3>
              <div className="mt-2 space-y-1">{socialChannels.map(renderChannel)}</div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-ink-950">
            {optionsOn ? "3. How your images look" : "3. How it is made"}
          </h2>
          {CONCEPT_MODE_AVAILABLE ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2" role="group" aria-label="Pack mode">
              <button
                type="button"
                aria-pressed={mode === "listing"}
                onClick={() => setMode("listing")}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  mode === "listing" ? "border-ink-900 bg-white" : "border-ink-200 bg-white hover:border-ink-400",
                )}
              >
                <p className="font-medium text-ink-900">Listing Mode</p>
                <p className="mt-1 text-xs text-ink-500">
                  The default. Needs at least one real photo. Your product pixels are never regenerated, and any
                  angle you did not photograph is marked Needs photo instead of being invented.
                </p>
              </button>
              <button
                type="button"
                aria-pressed={mode === "concept"}
                onClick={() => setMode("concept")}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  mode === "concept" ? "border-ink-900 bg-white" : "border-ink-200 bg-white hover:border-ink-400",
                )}
              >
                <p className="font-medium text-ink-900">Concept Mode</p>
                <p className="mt-1 text-xs text-ink-500">
                  Text only, for prelaunch pitches, crowdfunding and supplier briefs. Outputs carry a visible
                  Concept render label and are excluded from marketplace packs and publishing.
                </p>
              </button>
            </div>
          ) : optionsOn ? null : (
            <div className="mt-3 rounded-xl border border-ink-200 bg-white p-4" data-testid="listing-mode">
              <p className="font-medium text-ink-900">Listing Mode</p>
              <p className="mt-1 text-xs text-ink-500">
                Built from your real photo. Your product pixels are never regenerated, and any angle you did not
                photograph is marked Needs photo instead of being invented.
              </p>
            </div>
          )}
          {optionsOn ? (
            <OutputOptionsPanel
              state={outputForm}
              onAction={applyOutput}
              tier={tier}
              brandColors={usableBrand}
              brandKitsAllowed={brandKitsAllowed}
              colorHex={output.current.resolved.colorHex}
              headsUp={headsUp}
              onLeaveOut={leaveChannelsOut}
              addedSpace={addedSpaceSpecIds(selected, choices).length > 0}
              frames={previewFrames(selected)}
              photoUrl={frontPreview}
              cutoutUrl={cutoutPreview}
              hasPhoto={output.parsed.length > 0}
              hasLogo={brandHasLogo}
              scenesPausedNote={scenesPausedNote}
              conceptMode={effectiveMode === "concept"}
              onColorProblem={setColorProblem}
            />
          ) : null}
        </section>
      </div>

      <div className={cn(optionsOn && "hidden lg:block")}>
        <Card className="sticky top-6">
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold text-ink-950">Pack summary</h2>
            {backgroundLine ? (
              <p className="mt-2 text-sm text-ink-700" data-testid="summary-background">
                {backgroundLine}
                {resizeOnly ? (
                  <span className="ml-2 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-600">
                    {RESIZE_ONLY_BADGE}
                  </span>
                ) : null}
              </p>
            ) : null}
            <ul className="mt-4 space-y-2 text-sm text-ink-600">
              {estimate.lines.map((line) => (
                <li key={line.label} className="flex items-baseline justify-between gap-3">
                  <span>{line.label}</span>
                  <span className="font-medium text-ink-900">{line.credits}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-ink-100 pt-4">
              <p className="flex items-baseline justify-between text-sm">
                <span className="font-semibold text-ink-900">Estimated credits</span>
                <span
                  className="text-2xl font-bold text-ink-950"
                  data-testid="credit-estimate"
                  {...(optionsOn ? { "aria-live": "polite" as const } : {})}
                >
                  {estimate.total}
                </span>
              </p>
              {hold ? (
                <p className="mt-1 text-xs text-ink-500" data-testid="hold-line">
                  {hold}
                </p>
              ) : null}
              {lookDifference ? (
                <p className="mt-1 text-xs text-ink-500" data-testid="look-difference">
                  {lookDifference}
                </p>
              ) : null}
              <p
                className={cn("mt-1 text-xs", creditBalance < 0 ? "text-amber-700" : "text-ink-400")}
                data-testid="credit-balance-line"
              >
                {creditBalanceLine(creditBalance)}
              </p>
              {overBalance ? (
                <p className="mt-1 text-xs text-amber-700" data-testid="estimate-over-balance">
                  {overBalance}
                </p>
              ) : null}
            </div>
            <Button
              variant="secondary"
              size="lg"
              className="mt-5 w-full"
              disabled={createDisabled}
              aria-disabled={createDisabled}
              onClick={() => void submit()}
              data-testid="create-pack"
            >
              {buttonLabel}
            </Button>
            {blockReason && !submitError ? (
              <p className="mt-3 text-sm text-amber-700" data-testid="preflight-block">
                {blockReason}
              </p>
            ) : null}
            {submitError ? (
              <p className="mt-3 text-sm text-red-600" role="alert">
                {submitError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {optionsOn ? (
        <div
          className={cn(
            "fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white px-4 pt-3 lg:hidden",
            "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
            typing && "hidden",
          )}
          data-testid="summary-bar"
        >
          {summaryOpen ? (
            <div id="summary-bar-details" className="max-h-[50vh] overflow-y-auto pb-3 text-sm text-ink-600">
              {backgroundLine ? <p className="text-ink-700">{backgroundLine}</p> : null}
              <ul className="mt-2 space-y-1.5">
                {estimate.lines.map((line) => (
                  <li key={line.label} className="flex items-baseline justify-between gap-3">
                    <span>{line.label}</span>
                    <span className="font-medium text-ink-900">{line.credits}</span>
                  </li>
                ))}
              </ul>
              {hold ? <p className="mt-2 text-xs">{hold}</p> : null}
              {lookDifference ? <p className="mt-1 text-xs">{lookDifference}</p> : null}
              <p className={cn("mt-1 text-xs", creditBalance < 0 && "text-amber-700")}>
                {creditBalanceLine(creditBalance)}
              </p>
              {overBalance ? <p className="mt-1 text-xs text-amber-700">{overBalance}</p> : null}
            </div>
          ) : null}
          <button
            type="button"
            aria-expanded={summaryOpen}
            aria-controls="summary-bar-details"
            onClick={() => setSummaryOpen((open) => !open)}
            className="flex min-h-11 w-full items-center justify-between gap-3 text-left"
          >
            <span className="text-base font-semibold text-ink-950" aria-live="polite" data-testid="bar-total">
              {totalLine(estimate.total)}
            </span>
            <span className="text-xs text-ink-500">{summaryOpen ? "Hide details" : "Show details"}</span>
          </button>
          {blockReason && !submitError ? <p className="mb-2 text-xs text-amber-700">{blockReason}</p> : null}
          {submitError ? (
            <p className="mb-2 text-xs text-red-600" role="alert">
              {submitError}
            </p>
          ) : null}
          <Button
            variant="secondary"
            size="lg"
            className="mt-1 w-full"
            disabled={createDisabled}
            aria-disabled={createDisabled}
            onClick={() => void submit()}
            data-testid="create-pack-bar"
          >
            {buttonLabel}
          </Button>
        </div>
      ) : null}
      <OutOfCreditsDialog copy={outOfCredits} onClose={() => setOutOfCredits(null)} />
    </div>
  );
}
