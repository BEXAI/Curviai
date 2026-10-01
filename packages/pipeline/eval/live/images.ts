/**
 * Synthetic photos for the live LLM golden set, drawn at runtime with sharp
 * (no binary fixtures, as the image golden set in ../run.ts). The same SVG
 * gives the same picture on one machine; text glyphs depend on the installed
 * fonts, which is fine because the eval compares answers, not bytes.
 */

import sharp from "sharp";
import type { LlmContentBlock } from "@curvi/ai";
import { encodeVisionJpeg, type RawImage } from "../../src/raw";

export const PHOTO_SIZE = 512;

/** A full photo from an SVG body on a plain background, as PNG bytes. */
export async function svgPhoto(body: string, bg = "rgb(232,232,234)", size = PHOTO_SIZE): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${bg}"/>${body}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A JPEG image block, bounded as the runner bounds vision input. */
export async function jpegBlock(png: Buffer): Promise<LlmContentBlock> {
  const jpeg = await encodeVisionJpeg(png);
  return { type: "image", mediaType: "image/jpeg", base64: jpeg.toString("base64") };
}

export type Rgb = [number, number, number];

export const RED: Rgb = [200, 30, 40];
export const BLUE: Rgb = [30, 60, 200];
export const GREEN: Rgb = [40, 170, 70];

/** A transparent cutout holding one opaque rectangle per product, the shape
 * the inventory reads (as eval/questions.ts draws it). */
export function cutoutOf(colors: readonly Rgb[]): RawImage {
  const width = 120 * colors.length + 40;
  const height = 300;
  const data = Buffer.alloc(width * height * 4, 0);
  colors.forEach((rgb, n) => {
    for (let y = 50; y < 250; y++) {
      for (let x = 40 + n * 120; x < 40 + n * 120 + 100; x++) {
        data.set([...rgb, 255], (y * width + x) * 4);
      }
    }
  });
  return { data, width, height, channels: 4 };
}

/** The camera photo the cutout above came from: the same products on a
 * plain table. */
export async function photoOfCutout(colors: readonly Rgb[]): Promise<Buffer> {
  const cut = cutoutOf(colors);
  return sharp(cut.data, { raw: { width: cut.width, height: cut.height, channels: 4 } })
    .flatten({ background: { r: 236, g: 234, b: 230 } })
    .png()
    .toBuffer();
}

const BOTTLE = (x: number, fill: string) =>
  `<path d="M${x} 110 h40 v40 q30 20 30 80 v170 q0 30 -50 30 q-50 0 -50 -30 v-170 q0 -60 30 -80 z" fill="${fill}"/>`;

/** The golden photos, PNG bytes, by name. */
export async function goldenPhotos(): Promise<Record<string, Buffer>> {
  return {
    labelBox: await svgPhoto(
      `<rect x="140" y="120" width="230" height="280" fill="rgb(70,90,120)"/>
       <rect x="165" y="200" width="180" height="90" fill="rgb(245,245,240)"/>
       <text x="255" y="257" font-size="40" text-anchor="middle" fill="rgb(40,40,40)" font-family="sans-serif">CURVI</text>`,
    ),
    logoBottle: await svgPhoto(
      `${BOTTLE(236, "rgb(20,110,170)")}
       <circle cx="256" cy="300" r="34" fill="rgb(250,250,250)"/>
       <text x="256" y="309" font-size="24" text-anchor="middle" fill="rgb(20,110,170)" font-family="sans-serif">AQUA</text>`,
    ),
    ring: await svgPhoto(`<circle cx="256" cy="256" r="120" fill="none" stroke="rgb(190,160,90)" stroke-width="16"/>`),
    twoBottles: await svgPhoto(`${BOTTLE(146, "rgb(200,30,40)")}${BOTTLE(326, "rgb(30,60,200)")}`),
    blankWall: await svgPhoto("", "rgb(180,180,184)"),
    screenshot: await svgPhoto(
      `<rect x="96" y="20" width="320" height="472" rx="28" fill="rgb(255,255,255)" stroke="rgb(30,30,30)" stroke-width="8"/>
       <rect x="96" y="20" width="320" height="56" rx="28" fill="rgb(40,40,48)"/>
       <text x="256" y="58" font-size="22" text-anchor="middle" fill="white" font-family="sans-serif">9:41  Shop</text>
       <rect x="136" y="110" width="240" height="180" fill="rgb(70,90,120)"/>
       <text x="140" y="330" font-size="22" fill="rgb(20,20,20)" font-family="sans-serif">Storage Box, Navy</text>
       <text x="140" y="362" font-size="22" fill="rgb(20,20,20)" font-family="sans-serif">$24.99</text>
       <rect x="136" y="400" width="240" height="52" rx="10" fill="rgb(250,180,30)"/>
       <text x="256" y="434" font-size="22" text-anchor="middle" fill="rgb(20,20,20)" font-family="sans-serif">Add to cart</text>`,
      "rgb(210,210,214)",
    ),
    overlay: await svgPhoto(
      `<rect x="140" y="140" width="230" height="260" fill="rgb(60,110,70)"/>
       <rect x="0" y="0" width="512" height="512" fill="none" stroke="rgb(230,30,30)" stroke-width="24"/>
       <rect x="40" y="30" width="432" height="80" fill="rgb(230,30,30)"/>
       <text x="256" y="85" font-size="48" text-anchor="middle" fill="white" font-family="sans-serif">SALE 50% OFF</text>`,
    ),
    logo: await svgPhoto(
      `<rect x="96" y="176" width="160" height="160" fill="rgb(20,40,90)"/>
       <circle cx="336" cy="256" r="80" fill="rgb(240,120,30)"/>
       <circle cx="336" cy="256" r="40" fill="rgb(232,112,36)"/>`,
      "rgb(255,255,255)",
    ),
  };
}
