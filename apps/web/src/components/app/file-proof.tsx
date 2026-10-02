import { cn } from "@curvi/ui";
import type { FileProofView } from "@/lib/proof-view";

/**
 * One delivered file's measured proof (docs/phases/PHASE_18.md P18-16): its
 * channel, the size, background and fill rows, "Product not redrawn" with the
 * measured numbers, the note, and the AI caption of a composited scene. The
 * pack page's "See the proof" and the public share page's proof panel both
 * render it, so the two always show the same numbers in the same words.
 * Server safe: no hooks, no browser APIs.
 */
export function FileProof({ proof, className }: { proof: FileProofView; className?: string }) {
  return (
    <div className={cn("text-xs", className)} data-testid="file-proof">
      <p className="font-medium text-ink-900">{proof.channel}</p>
      {proof.rows.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-ink-600">
          {proof.rows.map((row) => (
            <li key={row.key} data-testid="proof-row">
              {row.label}: {row.measured}. Required: {row.required}.
              {row.pass === null ? null : (
                <span className={cn("ml-1 font-medium", row.pass ? "text-emerald-700" : "text-red-700")}>
                  {row.pass ? "Pass" : "Fail"}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {proof.productUnchanged ? (
        <p className="mt-1 font-medium text-ink-800" data-testid="proof-product-unchanged">
          {proof.productUnchanged}
        </p>
      ) : null}
      {proof.note ? <p className="mt-0.5 text-ink-500">{proof.note}</p> : null}
      {proof.caption ? (
        <p className="mt-1 text-ink-500" data-testid="proof-caption">
          {proof.caption}
        </p>
      ) : null}
    </div>
  );
}

/** The pack page's per shot disclosure: "See the proof" for each delivered file. */
export function SeeTheProof({ files }: { files: FileProofView[] | undefined }) {
  if (!files || files.length === 0) {
    return null;
  }
  return (
    <details className="mt-2" data-testid="see-the-proof">
      <summary className="cursor-pointer text-xs font-medium text-accent-700">See the proof</summary>
      <div className="mt-2 space-y-3">
        {files.map((file) => (
          <FileProof key={file.specId} proof={file} />
        ))}
      </div>
    </details>
  );
}
