import type { Metadata } from "next";
import Link from "next/link";
import { Badge, buttonVariants } from "@curvi/ui";
import { galleryCases } from "@/components/marketing/demo-images";

export const metadata: Metadata = {
  title: "Gallery of makeovers",
  description:
    "Before and after product photo makeovers built with Curvi. Demo cases now, opted in customer makeovers as they come in.",
};

export default function GalleryPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-4xl font-bold tracking-tight text-ink-950">Makeover gallery</h1>
        <p className="mt-4 text-lg text-ink-600">
          Every case shows the customer photo on the left and the Curvi output on the right. The
          product pixels are identical in both.
        </p>
      </div>

      <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-ink-100 bg-ink-50 p-5 text-center text-sm text-ink-600">
        Honest note: Curvi is in early access, so the cases below are demo renders we generated to
        show the format. Real customer makeovers appear here only when the customer opts in, and each
        one will say so.
      </div>

      <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {galleryCases.map((item) => (
          <article key={item.slug} className="overflow-hidden rounded-xl border border-ink-100 bg-white shadow-sm">
            <div className="grid grid-cols-2">
              <figure className="relative">
                <img src={item.before} alt={`${item.title}, before`} className="aspect-square w-full object-cover" />
                <figcaption className="absolute left-2 top-2 rounded-full bg-ink-900/80 px-2 py-0.5 text-[10px] font-medium text-white">
                  Before
                </figcaption>
              </figure>
              <figure className="relative border-l border-ink-100">
                <img src={item.after} alt={`${item.title}, after`} className="aspect-square w-full object-cover" />
                <figcaption className="absolute right-2 top-2 rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-medium text-white">
                  After
                </figcaption>
              </figure>
            </div>
            <div className="flex items-center justify-between gap-3 p-4">
              <div>
                <h2 className="text-sm font-semibold text-ink-900">{item.title}</h2>
                <p className="text-xs text-ink-500">{item.category}</p>
              </div>
              <Badge variant="outline">Demo</Badge>
            </div>
          </article>
        ))}
      </div>

      <div className="mt-14 rounded-xl bg-ink-950 p-10 text-center">
        <h2 className="text-2xl font-bold text-white">Your product could be the first real case here</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-300">
          Run one photo through Curvi, get your pack, and share the before and after if you like the
          result. Sharing is always your call.
        </p>
        <Link
          href="/signup"
          className={buttonVariants({ variant: "secondary", size: "lg", className: "mt-6" })}
        >
          Start free
        </Link>
      </div>
    </div>
  );
}
