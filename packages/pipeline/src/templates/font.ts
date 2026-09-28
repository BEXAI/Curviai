/**
 * Bundled font for template text. Production hosts (Render Linux, the Trigger
 * worker) do not guarantee system fonts, and Pango on macOS ignores font
 * files registered with fontconfig, so text never goes through a system font
 * stack: glyph outlines are read from the Inter TTF shipped by
 * @expo-google-fonts/inter (font under SIL OFL 1.1, see docs/verification.md)
 * with opentype.js and rasterized as SVG paths. The path is resolved at
 * runtime so it works from the web app bundle, the Trigger worker and tests.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import opentype from "opentype.js";

const FONT_PACKAGE = "@expo-google-fonts/inter";
const FONT_RELATIVE = "600SemiBold/Inter_600SemiBold.ttf";

/** Env override for hosts whose bundler does not ship node_modules files. */
export const TEMPLATE_FONT_ENV = "CURVI_TEMPLATE_FONT_FILE";

let cached: string | null | undefined;
let cachedFont: opentype.Font | null | undefined;

/** Parsed template font, or null when the file cannot be found or parsed. */
export function loadTemplateFont(): opentype.Font | null {
  if (cachedFont !== undefined) {
    return cachedFont;
  }
  const file = resolveTemplateFontFile();
  if (!file) {
    return null;
  }
  try {
    const bytes = readFileSync(file);
    cachedFont = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch {
    cachedFont = null;
  }
  return cachedFont;
}

/**
 * Absolute path of the bundled template font, or null when it cannot be found.
 * Resolution order: the env override, module resolution from this file, then
 * a walk up from the working directory through likely node_modules layouts.
 */
export function resolveTemplateFontFile(): string | null {
  if (cached !== undefined) {
    return cached;
  }
  cached = findFontFile();
  return cached;
}

function findFontFile(): string | null {
  const fromEnv = process.env[TEMPLATE_FONT_ENV];
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }

  // The specifier is assembled at runtime so bundlers do not try to turn the
  // TTF into a module.
  const specifier = [FONT_PACKAGE, FONT_RELATIVE].join("/");
  const bases: string[] = [];
  try {
    bases.push(import.meta.url);
  } catch {
    // import.meta is unavailable in some CommonJS bundles.
  }
  bases.push(path.join(process.cwd(), "package.json"));
  const createRequire = runtimeCreateRequire();
  for (const base of createRequire ? bases : []) {
    try {
      const resolved = createRequire!(base).resolve(specifier);
      if (existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Try the next base.
    }
  }

  const layouts = [
    path.join("node_modules", FONT_PACKAGE, FONT_RELATIVE),
    path.join("node_modules", "@curvi", "pipeline", "node_modules", FONT_PACKAGE, FONT_RELATIVE),
    path.join("packages", "pipeline", "node_modules", FONT_PACKAGE, FONT_RELATIVE),
  ];
  let dir = process.cwd();
  for (;;) {
    for (const layout of layouts) {
      const candidate = path.join(dir, layout);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * node:module createRequire, looked up at runtime. A static import lets
 * webpack see createRequire(base).resolve(specifier) with runtime values and
 * warn "Critical dependency" on every Next.js build; process.getBuiltinModule
 * (Node 20.16 and later) is opaque to the bundler. When it is missing, the
 * directory walk in findFontFile still finds the font.
 */
function runtimeCreateRequire(): ((base: string) => NodeJS.Require) | null {
  const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  const nodeModule = getBuiltinModule?.("node:module") as typeof import("node:module") | undefined;
  return nodeModule?.createRequire ?? null;
}
