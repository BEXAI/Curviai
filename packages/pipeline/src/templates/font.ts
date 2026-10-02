/**
 * Bundled fonts for template text. Production hosts (Render Linux, the
 * Trigger worker) do not guarantee system fonts, and Pango on macOS ignores
 * font files registered with fontconfig, so text never goes through a system
 * font stack: glyph outlines are read from TTFs shipped by the
 * @expo-google-fonts packages (fonts under SIL OFL 1.1 or Apache 2.0, see
 * docs/verification.md) with opentype.js and rasterized as SVG paths. The
 * catalog of fonts a brand kit may pick is seed data (seed/fonts.ts); Inter
 * is the default and the fallback. Paths are resolved at runtime so they
 * work from the web app bundle, the Trigger worker and tests.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import opentype from "opentype.js";
import { DEFAULT_TEMPLATE_FONT, isTemplateFontKey, templateFonts, type TemplateFontKey } from "../seed/fonts";

/** Env override for the default font on hosts whose bundler does not ship
 * node_modules files. Brand fonts that cannot be found fall back to it. */
export const TEMPLATE_FONT_ENV = "CURVI_TEMPLATE_FONT_FILE";

const resolvedFiles = new Map<TemplateFontKey, string | null>();
const parsedFonts = new Map<TemplateFontKey, opentype.Font | null>();

/** Parsed default template font, or null when the file cannot be found or parsed. */
export function loadTemplateFont(): opentype.Font | null {
  return loadFontByKey(DEFAULT_TEMPLATE_FONT);
}

/**
 * The template font a brand kit picked, or the default when the key is
 * empty, unknown, or its file cannot be found or parsed on this host. Null
 * only when the default is missing too.
 */
export function loadBrandTemplateFont(key: string | null | undefined): opentype.Font | null {
  if (isTemplateFontKey(key) && key !== DEFAULT_TEMPLATE_FONT) {
    const font = loadFontByKey(key);
    if (font) {
      return font;
    }
  }
  return loadTemplateFont();
}

function loadFontByKey(key: TemplateFontKey): opentype.Font | null {
  if (parsedFonts.has(key)) {
    return parsedFonts.get(key) ?? null;
  }
  const file = resolveFontFile(key);
  let font: opentype.Font | null = null;
  if (file) {
    try {
      const bytes = readFileSync(file);
      font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    } catch {
      font = null;
    }
  }
  parsedFonts.set(key, font);
  return font;
}

/**
 * Absolute path of a catalog font's TTF, or null when it cannot be found. The
 * default font also honors the env override; every font then tries module
 * resolution from this file and a walk up from the working directory through
 * likely node_modules layouts.
 */
export function resolveFontFile(key: TemplateFontKey): string | null {
  if (!resolvedFiles.has(key)) {
    resolvedFiles.set(key, findFontFile(key));
  }
  return resolvedFiles.get(key) ?? null;
}

function findFontFile(key: TemplateFontKey): string | null {
  if (key === DEFAULT_TEMPLATE_FONT) {
    const fromEnv = process.env[TEMPLATE_FONT_ENV];
    if (fromEnv && existsSync(fromEnv)) {
      return fromEnv;
    }
  }
  const { packageName, file } = templateFonts[key];

  // The specifier is assembled at runtime so bundlers do not try to turn the
  // TTF into a module.
  const specifier = [packageName, file].join("/");
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
    path.join("node_modules", packageName, file),
    path.join("node_modules", "@curvi", "pipeline", "node_modules", packageName, file),
    path.join("packages", "pipeline", "node_modules", packageName, file),
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
