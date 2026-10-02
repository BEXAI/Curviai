import { FileProof } from "@/components/app/file-proof";
import { DEMO_PROOF_NOTE, SHARE_PROOF_HEADING, SHARE_PROOF_INTRO } from "@/lib/proof-copy";
import type { PublicShare, PublicShareImage } from "@/lib/shares/types";

/** The images whose proof the panel lists: every pack image, else the after. */
export function proofImages(share: PublicShare): PublicShareImage[] {
  if (!share.proof) {
    return [];
  }
  const images = share.images.length > 0 ? share.images : share.after ? [share.after] : [];
  return images.filter((image) => image.proof);
}

/**
 * "Measured on every file" (docs/phases/PHASE_18.md P18-16): on a share page
 * whose owner turned proof on, each image's channel, the checks it passed,
 * "Product not redrawn" with its numbers and, on a composited scene, the
 * caption that keeps the public copy disclosed, since share images are
 * re-encoded without the file's AI label.
 */
export function ShareProofPanel({ share }: { share: PublicShare }) {
  const images = proofImages(share);
  if (images.length === 0) {
    return null;
  }
  return (
    <section className="mx-auto mt-12 max-w-xl" aria-labelledby="share-proof-heading" data-testid="share-proof-panel">
      <h2 id="share-proof-heading" className="text-center text-xl font-semibold text-ink-950">
        {SHARE_PROOF_HEADING}
      </h2>
      <p className="mt-2 text-center text-sm text-ink-600">{share.illustration ? DEMO_PROOF_NOTE : SHARE_PROOF_INTRO}</p>
      <ul className="mt-6 space-y-4">
        {images.map((image) =>
          image.proof ? (
            <li key={image.ref} className="rounded-xl border border-ink-100 bg-white p-4">
              <FileProof proof={image.proof} className="text-sm" />
            </li>
          ) : null,
        )}
      </ul>
    </section>
  );
}
