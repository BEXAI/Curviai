/**
 * Color math: sRGB to linear to XYZ (D65) to CIELAB, plus the CIEDE2000 color
 * difference (Sharma, Wu and Dalal 2005). Used by the fidelity QC checks.
 */

export interface Lab {
  L: number;
  a: number;
  b: number;
}

const D65 = { x: 0.95047, y: 1.0, z: 1.08883 };
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const POW25_7 = Math.pow(25, 7);

/** sRGB channel in 0..1 to linear light in 0..1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light in 0..1 back to sRGB in 0..1. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Precomputed lookup for 8 bit sRGB to linear. Speeds up per pixel loops. */
export const SRGB_TO_LINEAR_8BIT: Float64Array = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = srgbToLinear(i / 255);
  }
  return table;
})();

/** 8 bit sRGB to CIE XYZ with the D65 white point (values scaled so Y of white is 1). */
export function rgbToXyz(r8: number, g8: number, b8: number): { x: number; y: number; z: number } {
  const r = SRGB_TO_LINEAR_8BIT[r8];
  const g = SRGB_TO_LINEAR_8BIT[g8];
  const b = SRGB_TO_LINEAR_8BIT[b8];
  return {
    x: 0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    y: 0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    z: 0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  };
}

const LAB_EPS = Math.pow(6 / 29, 3);
const LAB_KAPPA_DIV = 3 * Math.pow(6 / 29, 2);

function labF(t: number): number {
  return t > LAB_EPS ? Math.cbrt(t) : t / LAB_KAPPA_DIV + 4 / 29;
}

export function xyzToLab(x: number, y: number, z: number): Lab {
  const fx = labF(x / D65.x);
  const fy = labF(y / D65.y);
  const fz = labF(z / D65.z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/** 8 bit sRGB straight to CIELAB (D65). */
export function rgbToLab(r8: number, g8: number, b8: number): Lab {
  const { x, y, z } = rgbToXyz(r8, g8, b8);
  return xyzToLab(x, y, z);
}

/**
 * CIEDE2000 color difference with kL = kC = kH = 1, following the reference
 * implementation notes in Sharma, Wu and Dalal (2005).
 */
export function ciede2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = hueAngleDeg(a1p, b1);
  const h2p = hueAngleDeg(a2p, b2);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else if (Math.abs(h2p - h1p) <= 180) {
    dhp = h2p - h1p;
  } else if (h2p - h1p > 180) {
    dhp = h2p - h1p - 360;
  } else {
    dhp = h2p - h1p + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG2RAD);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;

  let hbp: number;
  if (C1p * C2p === 0) {
    hbp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbp = (h1p + h2p + 360) / 2;
  } else {
    hbp = (h1p + h2p - 360) / 2;
  }

  const T =
    1 -
    0.17 * Math.cos((hbp - 30) * DEG2RAD) +
    0.24 * Math.cos(2 * hbp * DEG2RAD) +
    0.32 * Math.cos((3 * hbp + 6) * DEG2RAD) -
    0.2 * Math.cos((4 * hbp - 63) * DEG2RAD);

  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + POW25_7));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * DEG2RAD) * Rc;

  const dL = dLp / Sl;
  const dC = dCp / Sc;
  const dH = dHp / Sh;
  return Math.sqrt(dL * dL + dC * dC + dH * dH + Rt * dC * dH);
}

/** CIEDE2000 between two 8 bit sRGB pixels. */
export function ciede2000Rgb(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  return ciede2000(rgbToLab(r1, g1, b1), rgbToLab(r2, g2, b2));
}

function hueAngleDeg(ap: number, b: number): number {
  if (ap === 0 && b === 0) {
    return 0;
  }
  let h = Math.atan2(b, ap) * RAD2DEG;
  if (h < 0) {
    h += 360;
  }
  return h;
}

/** A six digit hex color, like #1F2A44. */
export const HEX = /^#[0-9A-Fa-f]{6}$/;

/** Parse a #RRGGBB hex string into 8 bit channels. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  if (!HEX.test(hex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const value = parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}
