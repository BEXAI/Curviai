/**
 * Copy for the brand kit page and form in the app. Packs use the brand
 * colors (the brand color background takes the first one), the fonts on
 * infographic and dimensions images, the logo on infographic and social
 * images, and the style preset for scenes, banners and social images. The
 * claims test scans this copy. Kept free of imports because the client side
 * form uses it.
 */
export const brandKitCopy = {
  intro:
    "Your next packs use this kit: your first brand color for the brand color background, your fonts and logo on infographic and social images, and your style preset for lifestyle scenes.",
  colorsHint: "Your first brand color is used for the brand color background and for Brand look.",
  fontsHint:
    "The heading font sets the size label on dimensions images. The body font sets the callouts on infographics.",
  logoHint:
    "PNG, JPG or WebP. Placed in a free corner of infographic and social images, never on your product. Main images and channels that do not allow text on images never carry it.",
  presetHint:
    "Sets the surface for lifestyle scenes and the backdrop for banners and social images. Automatic picks one from the product. Shiny or clear products always get soft even studio light.",
  autoPresetLabel: "Automatic, matched to the product",
  defaultFontLabel: "Inter (default)",
  // Brand kit from a logo (PHASE_16 workstream 7). Suggestions only: the
  // kit changes when the seller confirms and saves.
  paletteButton: "Suggest colors from my logo",
  paletteReading: "Reading your logo",
  paletteTitle: "Colors from your logo",
  paletteIntro:
    "Pick the colors you want in your kit. Nothing changes until you press Use these colors and then save the brand kit.",
  paletteNamedNote: "This logo has soft shading, so we asked our color reader to name the main colors.",
  paletteBackgroundLabel: "Also add a light background color",
  paletteBackgroundHint: "A pale shade of your main color. Pick it as the background when you start a pack.",
  paletteUse: "Use these colors",
  paletteDismiss: "Not now",
  paletteApplied: "Colors added to the form. Save the brand kit to keep them.",
  paletteReadable: "Text reads clearly on this color.",
  paletteHardToRead: "Text is hard to read on this color. Use it for accents rather than behind text.",
  paletteMissing: "That logo upload could not be found. Upload it again.",
  paletteUnreadable: "We could not read that file as an image. Try a PNG, JPG or WebP logo.",
  paletteNoColors: "We could not find colors in this logo. It may be white or very light. Add your colors by hand.",
  paletteUnavailable: "We could not read your logo right now. Add your colors by hand or try again later.",
  paletteNeedsLogo: "Upload a logo first.",
};
