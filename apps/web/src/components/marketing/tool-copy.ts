/**
 * Copy the free tool pages use to point at the full pack. It names only what
 * a pack makes today (video is coming soon), and the claims test scans it.
 * Kept free of imports so the client side checker stays small.
 */
export const toolPackCta = {
  title: "Want the whole pack, not just one fix?",
  body: "Curvi turns one photo into a compliant main image, lifestyle scenes and channel crops, with your product never redrawn. Leave your email to start free.",
};

/** The email gates in front of each tool's full results (POST /api/leads). */
export const checkerGateCopy = {
  title: "See the measured values and how to fix them",
  body: "The summary above is free. Leave your email to see every measurement and what to change, for this image and the next.",
};

export const fixerGateCopy = {
  title: "Download the whitened image",
  body: "The preview is free. Leave your email to download the file.",
};

export const resizerGateCopy = {
  title: "Download your resized images",
  body: "The previews are free. Leave your email to download every file with the name each marketplace expects.",
};

export const checkerVerdictCopy = {
  fail: "Curvi fixes all of this automatically. It keeps your real product pixels, rebuilds the background to pure white, corrects the fill ratio and exports at marketplace resolution.",
  pass: "This image passes the automated checks. Curvi can still build the rest of your pack, lifestyle scenes and channel crops, from the same photo.",
};
