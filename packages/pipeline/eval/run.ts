/**
 * Golden set eval harness (CURVI_BUILD_PLAN.md sections 4.6 and 5.7).
 *
 * Generates a synthetic golden set at runtime with sharp (no binary fixtures),
 * runs the deterministic main image pipeline plus QC over it, prints a table
 * and writes eval/output/report.json at the repo root. Exits 1 when the main
 * image pass rate is below 100 percent (Phase 4 acceptance) or mean fidelity
 * drops below threshold.
 *
 * Usage: pnpm --filter @curvi/pipeline eval [-- --stage main|stills|aplus|questions]
 *
 * The aplus stage (PHASE_16 workstream 2) renders every A+ module around
 * each golden product with the still template renderer and requires the
 * rule 3 fidelity check to pass on the shipped file.
 *
 * The questions stage (PHASE_16 workstream 4) runs the question step's
 * golden set in eval/questions.ts: no images, no provider.
 *
 * --live (PHASE_17 workstream 4) runs the LLM golden set and the prompt
 * injection fixtures through a real provider instead: see eval/live/cli.ts.
 * It is off unless asked for, refuses to run in CI or without the key, and
 * is never reached by the stages above.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { getSpec } from "@curvi/specs";
import type { Provider, ProviderRequest, ProviderResponse } from "@curvi/ai";
import { makeAmazonMain } from "../src/deterministic/whiten";
import { compositeShot, type HarmonizeInput, type ScenePlateInput } from "../src/composite/index";
import { deriveQcErodePx, fidelityReport } from "../src/qc/fidelity";
import { pixelChecks, QC_THRESHOLDS } from "../src/qc/pixelChecks";
import { decodeToRgba, decodeMask, type RawImage } from "../src/raw";
import { boundingBoxOfMask } from "../src/mask";
import { APLUS_MODULE_SHOT_TYPES, type Shot } from "../src/schemas";
import { qcKindForSpec } from "../src/qc/pixelChecks";
import { stillStyle, templates } from "../src/seed/templates";
import { renderTemplateStill } from "../src/templates/still";
import { runQuestionEval } from "./questions";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const GOLDEN_DIR = path.join(REPO_ROOT, "eval", "golden", "generated");
const OUTPUT_DIR = path.join(REPO_ROOT, "eval", "output");

/** Codec edge transition margin for background checks on decoded JPEG output. */
const JPEG_EDGE_MARGIN_PX = 16;

interface GoldenProduct {
  key: string;
  description: string;
  source: Buffer;
  mask: Buffer;
}

interface EvalRow {
  product: string;
  stage: Stage;
  pass: boolean;
  backgroundWhiteShare: number | null;
  fillRatio: number | null;
  longestSide: number;
  meanDeltaE: number;
  exactByteShare: number;
  failedChecks: string[];
}

function svgProduct(size: number, bg: string, body: string, maskBody: string): { sourceSvg: string; maskSvg: string } {
  return {
    sourceSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${bg}"/>${body}</svg>`,
    maskSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="black"/>${maskBody}</svg>`,
  };
}

async function renderProduct(
  key: string,
  description: string,
  size: number,
  bg: string,
  body: string,
  maskBody: string,
  opts: { blurMask?: number } = {},
): Promise<GoldenProduct> {
  const { sourceSvg, maskSvg } = svgProduct(size, bg, body, maskBody);
  const source = await sharp(Buffer.from(sourceSvg)).png().toBuffer();
  let maskPipeline = sharp(Buffer.from(maskSvg)).flatten({ background: "#000000" }).greyscale();
  if (opts.blurMask) {
    maskPipeline = maskPipeline.blur(opts.blurMask);
  }
  const mask = await maskPipeline.png().toBuffer();
  return { key, description, source, mask };
}

/** Ten products across categories, per the plan's golden set intent. */
async function generateGoldenSet(): Promise<GoldenProduct[]> {
  const products: GoldenProduct[] = [];

  // 1. Matte box with a text label.
  products.push(
    await renderProduct(
      "matte_box_label",
      "matte box with text label",
      512,
      "rgb(235,235,235)",
      `<rect x="140" y="120" width="230" height="280" fill="rgb(70,90,120)"/>
       <rect x="165" y="200" width="180" height="90" fill="rgb(245,245,240)"/>
       <text x="255" y="255" font-size="36" text-anchor="middle" fill="rgb(40,40,40)" font-family="sans-serif">CURVI</text>`,
      `<rect x="140" y="120" width="230" height="280" fill="white"/>`,
    ),
  );

  // 2. Glossy gradient bottle shape.
  products.push(
    await renderProduct(
      "glossy_bottle",
      "glossy gradient bottle shape",
      512,
      "rgb(228,232,236)",
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="rgb(30,140,180)"/><stop offset="1" stop-color="rgb(10,60,110)"/>
       </linearGradient></defs>
       <path d="M230 90 h60 v50 q40 30 40 110 v150 q0 40 -70 40 q-70 0 -70 -40 v-150 q0 -80 40 -110 z" fill="url(#g)"/>
       <ellipse cx="235" cy="200" rx="14" ry="60" fill="rgba(255,255,255,0.55)"/>`,
      `<path d="M230 90 h60 v50 q40 30 40 110 v150 q0 40 -70 40 q-70 0 -70 -40 v-150 q0 -80 40 -110 z" fill="white"/>`,
    ),
  );

  // 3. Thin ring.
  products.push(
    await renderProduct(
      "thin_ring",
      "thin ring",
      512,
      "rgb(242,240,238)",
      `<circle cx="256" cy="256" r="120" fill="none" stroke="rgb(190,160,90)" stroke-width="14"/>`,
      `<circle cx="256" cy="256" r="120" fill="none" stroke="white" stroke-width="14"/>`,
    ),
  );

  // 4. Dark product on a dark background.
  products.push(
    await renderProduct(
      "dark_on_dark",
      "dark product on dark",
      512,
      "rgb(28,28,32)",
      `<rect x="150" y="140" width="210" height="240" rx="24" fill="rgb(48,44,56)"/>
       <rect x="180" y="180" width="150" height="30" fill="rgb(70,66,80)"/>`,
      `<rect x="150" y="140" width="210" height="240" rx="24" fill="white"/>`,
    ),
  );

  // 5. Tiny product on a large frame.
  products.push(
    await renderProduct(
      "tiny_product",
      "tiny product",
      512,
      "rgb(238,238,238)",
      `<circle cx="256" cy="256" r="22" fill="rgb(160,40,60)"/>`,
      `<circle cx="256" cy="256" r="22" fill="white"/>`,
    ),
  );

  // 6. Wide product.
  products.push(
    await renderProduct(
      "wide_product",
      "wide product",
      512,
      "rgb(236,238,240)",
      `<rect x="40" y="220" width="430" height="80" rx="16" fill="rgb(60,110,70)"/>`,
      `<rect x="40" y="220" width="430" height="80" rx="16" fill="white"/>`,
    ),
  );

  // 7. Transparent-ish alpha edges: soft blurred mask boundary.
  products.push(
    await renderProduct(
      "soft_alpha_edges",
      "transparent-ish alpha edges",
      512,
      "rgb(230,234,238)",
      `<circle cx="256" cy="256" r="130" fill="rgb(120,170,200)" opacity="0.9"/>`,
      `<circle cx="256" cy="256" r="130" fill="white"/>`,
      { blurMask: 2 },
    ),
  );

  // 8. Red and white product: pure white pixels INSIDE the mask must survive.
  products.push(
    await renderProduct(
      "red_white",
      "red white product",
      512,
      "rgb(226,226,226)",
      `<rect x="150" y="130" width="210" height="260" fill="rgb(200,30,40)"/>
       <rect x="150" y="230" width="210" height="60" fill="rgb(255,255,255)"/>`,
      `<rect x="150" y="130" width="210" height="260" fill="white"/>`,
    ),
  );

  // 9. Textured product (checker pattern).
  products.push(
    await renderProduct(
      "textured",
      "textured",
      512,
      "rgb(240,238,236)",
      `<defs><pattern id="t" width="16" height="16" patternUnits="userSpaceOnUse">
         <rect width="16" height="16" fill="rgb(120,90,60)"/><rect width="8" height="8" fill="rgb(150,120,90)"/>
         <rect x="8" y="8" width="8" height="8" fill="rgb(150,120,90)"/>
       </pattern></defs>
       <rect x="140" y="140" width="230" height="230" fill="url(#t)"/>`,
      `<rect x="140" y="140" width="230" height="230" fill="white"/>`,
    ),
  );

  // 10. Multi color product.
  products.push(
    await renderProduct(
      "multi_color",
      "multi color",
      512,
      "rgb(232,232,236)",
      `<rect x="160" y="120" width="190" height="70" fill="rgb(220,60,50)"/>
       <rect x="160" y="190" width="190" height="70" fill="rgb(240,180,40)"/>
       <rect x="160" y="260" width="190" height="70" fill="rgb(60,160,90)"/>
       <rect x="160" y="330" width="190" height="70" fill="rgb(50,90,200)"/>`,
      `<rect x="160" y="120" width="190" height="280" fill="white"/>`,
    ),
  );

  await mkdir(GOLDEN_DIR, { recursive: true });
  for (const p of products) {
    await writeFile(path.join(GOLDEN_DIR, `${p.key}.png`), p.source);
    await writeFile(path.join(GOLDEN_DIR, `${p.key}.mask.png`), p.mask);
  }
  return products;
}

async function evalMain(products: GoldenProduct[]): Promise<EvalRow[]> {
  const spec = getSpec("amazon.main");
  const rows: EvalRow[] = [];
  for (const product of products) {
    const result = await makeAmazonMain(product.source, product.mask, spec);
    await writeFile(path.join(GOLDEN_DIR, `${product.key}.main.jpg`), result.jpeg);

    // Honest check: measure the delivered JPEG, not the pre encode raw.
    const delivered = await decodeToRgba(result.jpeg);
    const checkReport = await pixelChecks(delivered, result.mask, spec, {
      encoded: { bytes: result.jpeg.length, format: "jpg" },
      edgeMarginPx: JPEG_EDGE_MARGIN_PX,
    });
    const fidelity = await fidelityReport(result.raw, delivered, result.mask, {
      erodePx: 3,
      kind: "main",
    });
    rows.push({
      product: product.key,
      stage: "main",
      pass: checkReport.pass && fidelity.pass,
      backgroundWhiteShare: checkReport.backgroundWhiteShare,
      fillRatio: checkReport.fillRatio,
      longestSide: checkReport.longestSide,
      meanDeltaE: fidelity.meanDeltaE,
      exactByteShare: fidelity.exactByteShare,
      failedChecks: checkReport.checks.filter((c) => !c.pass).map((c) => c.name),
    });
  }
  return rows;
}

/** Well behaved mock provider for the stills stage: paints a plate and mildly
 * relights the whole frame in the harmonize pass. */
class MockImageProvider implements Provider {
  readonly name = "mock-image";
  readonly kind = "image" as const;
  supports(task: string): boolean {
    return task === "scene_plate" || task === "harmonize";
  }
  async invoke<TIn = unknown, TOut = unknown>(req: ProviderRequest<TIn>): Promise<ProviderResponse<TOut>> {
    if (req.task === "scene_plate") {
      const { width, height } = req.input as ScenePlateInput;
      const png = await sharp({
        create: { width, height, channels: 3, background: { r: 168, g: 158, b: 142 } },
      })
        .png()
        .toBuffer();
      return { output: { png } as TOut, costMicros: 1000 };
    }
    const { png } = req.input as HarmonizeInput;
    // Global warm cast over everything, product included. Paste back must undo
    // the product portion.
    const out = await sharp(png).modulate({ brightness: 1.06, saturation: 1.08 }).png().toBuffer();
    return { output: { png: out } as TOut, costMicros: 800 };
  }
}

async function evalStills(products: GoldenProduct[]): Promise<EvalRow[]> {
  const provider = new MockImageProvider();
  const rows: EvalRow[] = [];
  for (const product of products) {
    const productRgba: RawImage = await decodeToRgba(product.source);
    const mask = await decodeMask(product.mask);
    const shot: Shot = {
      id: `eval_${product.key}`,
      type: "lifestyle",
      sourceMediaId: product.key,
      method: "composite_generate",
      channels: ["shopify.product"],
      stylePreset: "minimal_studio",
      scene: "studio table",
      credits: 1,
      priority: 4,
    };
    const result = await compositeShot({
      productRgba,
      mask,
      provider,
      shot,
      template: {
        width: 512,
        height: 512,
        scenePrompt: templates.lifestyle_plate_flux2({ scene: "studio table", preset: "minimal_studio" }),
        harmonizePrompt: templates.harmonize_nano_banana2(),
        placement: { fill: 0.6 },
      },
    });
    await writeFile(path.join(GOLDEN_DIR, `${product.key}.still.png`), result.png);
    // QC erosion derived from the paste parameters: strictly inside the pure
    // paste region, where byte identity is the contract.
    const fidelity = await fidelityReport(result.productReference, result.finalRaw, result.canvasMask, {
      erodePx: deriveQcErodePx(),
      kind: "other",
    });
    rows.push({
      product: product.key,
      stage: "stills",
      pass: fidelity.exactByteShare === 1 && fidelity.pass,
      backgroundWhiteShare: null,
      fillRatio: null,
      longestSide: result.finalRaw.width,
      meanDeltaE: fidelity.meanDeltaE,
      exactByteShare: fidelity.exactByteShare,
      failedChecks: fidelity.exactByteShare === 1 ? [] : ["productBytesChanged"],
    });
  }
  return rows;
}

/** Fixed module copy for the aplus stage: the copy step's output shape. */
const APLUS_EVAL_COPY: Record<(typeof APLUS_MODULE_SHOT_TYPES)[number], { headline?: string; lines: string[] }> = {
  aplus_features: { headline: "Built for everyday use", lines: ["Leak proof lid", "Dishwasher safe", "Fits cup holders"] },
  aplus_pain_points: { headline: "No more spills", lines: ["Stays shut in a bag", "Easy to hold", "Quick to clean"] },
  aplus_ingredients: { headline: "What it is made of", lines: ["Stainless steel", "Bamboo lid"] },
  aplus_results: { headline: "Every day, sorted", lines: ["Cold water at your desk", "Fewer bottles to buy", "A lid that stays shut"] },
  aplus_how_to: { headline: "How to use it", lines: ["Fill with water", "Twist the lid shut", "Rinse after use"] },
  aplus_endorsement: { lines: ["Loved by hikers", "Gift Guide pick 2026"] },
};

async function evalAplus(products: GoldenProduct[]): Promise<EvalRow[]> {
  const spec = getSpec("amazon.aplus.basic_header");
  const rows: EvalRow[] = [];
  for (const product of products) {
    // The renderer takes a cutout: the source with the mask as its alpha.
    const rgba = await decodeToRgba(product.source);
    const mask = await decodeMask(product.mask);
    for (let i = 0; i < mask.data.length; i++) {
      rgba.data[i * 4 + 3] = mask.data[i];
    }
    const productPng = await sharp(rgba.data, { raw: { width: rgba.width, height: rgba.height, channels: 4 } })
      .png()
      .toBuffer();
    for (const type of APLUS_MODULE_SHOT_TYPES) {
      const copy = APLUS_EVAL_COPY[type];
      const render = await renderTemplateStill({
        type,
        spec,
        productPng,
        maskPng: product.mask,
        callouts: copy.lines,
        ...(copy.headline ? { headline: copy.headline } : {}),
        backgroundHex: stillStyle.defaultBackgroundHex,
        textHex: stillStyle.textHex,
        accentHex: stillStyle.accentHex,
      });
      const shipped = await decodeToRgba(render.encoded.buffer);
      // The runner's still erosion (trigger stillQcErosion): an upscaled
      // product blends with the card within the resize kernel's reach
      // (3 source pixels) times the scale, so that band is not compared.
      const placed = boundingBoxOfMask(render.mask);
      const source = boundingBoxOfMask(mask);
      const up = placed && source ? Math.max(1, placed.width / source.width) : 1;
      const erodePx = Math.max(deriveQcErodePx(), Math.ceil(3 * up) + 1);
      const fidelity = await fidelityReport(render.productReference, shipped, render.mask, {
        kind: qcKindForSpec(spec),
        erodePx,
      });
      rows.push({
        product: `${product.key}:${type}`,
        stage: "aplus",
        pass: fidelity.pass,
        backgroundWhiteShare: null,
        fillRatio: null,
        longestSide: Math.max(shipped.width, shipped.height),
        meanDeltaE: fidelity.meanDeltaE,
        exactByteShare: fidelity.exactByteShare,
        failedChecks: fidelity.pass ? [] : fidelity.issues.map(String),
      });
    }
  }
  return rows;
}

function printTable(rows: EvalRow[]): void {
  const headers = ["product", "pass", "bgWhite", "fill", "longSide", "meanDeltaE", "exactBytes", "failed"];
  const cells = rows.map((r) => [
    r.product,
    r.pass ? "pass" : "FAIL",
    r.backgroundWhiteShare === null ? "-" : r.backgroundWhiteShare.toFixed(4),
    r.fillRatio === null ? "-" : r.fillRatio.toFixed(3),
    String(r.longestSide),
    r.meanDeltaE.toFixed(4),
    r.exactByteShare.toFixed(4),
    r.failedChecks.join(",") || "-",
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(headers));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const c of cells) {
    console.log(line(c));
  }
}

type Stage = "main" | "stills" | "aplus" | "questions";

function parseStage(argv: string[]): Stage {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--stage" && argv[i + 1]) {
      return assertStage(argv[i + 1]);
    }
    if (argv[i].startsWith("--stage=")) {
      return assertStage(argv[i].slice("--stage=".length));
    }
  }
  return "main";
}

function assertStage(value: string): Stage {
  if (value !== "main" && value !== "stills" && value !== "aplus" && value !== "questions") {
    console.error(`Unknown stage "${value}". Use --stage main, --stage stills, --stage aplus or --stage questions.`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes("--live")) {
    const { liveMain } = await import("./live/cli");
    process.exit(await liveMain(process.argv.slice(2)));
  }
  const stage = parseStage(process.argv.slice(2));
  console.log(`Curvi pipeline eval, stage: ${stage}`);
  if (stage === "questions") {
    await questionsMain();
    return;
  }
  console.log(`Golden set: ${GOLDEN_DIR}`);

  const products = await generateGoldenSet();
  const rows =
    stage === "main" ? await evalMain(products) : stage === "stills" ? await evalStills(products) : await evalAplus(products);
  printTable(rows);

  const passCount = rows.filter((r) => r.pass).length;
  const passRate = passCount / rows.length;
  const meanDeltaE = rows.reduce((s, r) => s + r.meanDeltaE, 0) / rows.length;
  const deltaEThreshold =
    stage === "main" ? QC_THRESHOLDS.main.maxMeanDeltaE : QC_THRESHOLDS.other.maxMeanDeltaE;

  const report = {
    generatedAt: new Date().toISOString(),
    stage,
    products: rows.length,
    passCount,
    passRate,
    meanDeltaE,
    deltaEThreshold,
    rows,
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log("");
  console.log(`Pass rate: ${passCount}/${rows.length}`);
  console.log(`Mean CIEDE2000 over product masks: ${meanDeltaE.toFixed(4)} (threshold ${deltaEThreshold})`);
  console.log(`Report: ${reportPath}`);

  if (passRate < 1 || meanDeltaE > deltaEThreshold) {
    console.error("Eval failed: pass rate below 100 percent or fidelity dropped.");
    process.exit(1);
  }
}

async function questionsMain(): Promise<void> {
  const rows = runQuestionEval();
  for (const row of rows) {
    console.log(`${row.pass ? "pass" : "FAIL"}  ${row.scenario}  [${row.asked || "nothing asked"}]`);
    for (const failure of row.failed) console.log(`      ${failure}`);
  }
  const passCount = rows.filter((r) => r.pass).length;
  await mkdir(OUTPUT_DIR, { recursive: true });
  const reportPath = path.join(OUTPUT_DIR, "questions-report.json");
  await writeFile(
    reportPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), stage: "questions", passCount, rows }, null, 2),
  );
  console.log("");
  console.log(`Pass rate: ${passCount}/${rows.length}`);
  console.log(`Report: ${reportPath}`);
  if (passCount < rows.length) {
    console.error("Eval failed: a question step scenario regressed.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
