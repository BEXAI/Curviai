import { Card, CardContent, CardHeader, CardTitle } from "@curvi/ui";

/** The copy, in one place for the copy lint (CLAUDE.md rule 9). */
export const EXAMPLE_PACK_COPY = {
  title: "Example pack",
  label: "Example made by Curvi from one candle photo",
  note: "Your pack is made from your own photo, sized for the channels you pick.",
} as const;

/** Real files from one Curvi pack of a pink candle (apps/web/public/home/pack),
 * the same files the home page shows. No compute: static images. */
export const EXAMPLE_PACK_FILES: readonly { src: string; caption: string; alt: string; white?: boolean }[] = [
  { src: "amazon-main.webp", caption: "Amazon main image", alt: "Amazon main image of a pink candle on pure white", white: true },
  { src: "cutout.webp", caption: "Transparent cutout", alt: "Transparent cutout of the candle", white: true },
  { src: "sweep-gray.webp", caption: "Gray studio sweep", alt: "Candle on a gray studio sweep" },
  { src: "sweep-brand.webp", caption: "Brand color sweep", alt: "Candle on a brand color sweep" },
  { src: "lifestyle-warm.webp", caption: "Lifestyle scene", alt: "Candle in a warm lifestyle scene" },
  { src: "lifestyle-table.webp", caption: "Lifestyle scene", alt: "Candle on a table in a lifestyle scene" },
  { src: "social.webp", caption: "Square social post", alt: "Square social post of the candle" },
];

/**
 * The example pack on an empty dashboard (docs/phases/PHASE_18.md P18-20):
 * what a finished pack looks like before the seller makes one.
 */
export function ExamplePack() {
  return (
    <Card data-testid="example-pack">
      <CardHeader>
        <CardTitle>{EXAMPLE_PACK_COPY.title}</CardTitle>
        <p className="text-sm text-ink-500">{EXAMPLE_PACK_COPY.label}</p>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {EXAMPLE_PACK_FILES.map((file) => (
            <li key={file.src}>
              <div
                className={
                  "aspect-square overflow-hidden rounded-lg border border-ink-100 " + (file.white ? "bg-white" : "bg-ink-50")
                }
              >
                <img
                  src={`/home/pack/${file.src}`}
                  alt={file.alt}
                  loading="lazy"
                  decoding="async"
                  className={"h-full w-full " + (file.white ? "object-contain" : "object-cover")}
                />
              </div>
              <p className="mt-1 text-xs text-ink-500">{file.caption}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-ink-400">{EXAMPLE_PACK_COPY.note}</p>
      </CardContent>
    </Card>
  );
}
