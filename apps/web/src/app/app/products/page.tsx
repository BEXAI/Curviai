import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardContent, buttonVariants } from "@curvi/ui";
import { StatusChip } from "@/components/app/status-chip";
import {
  newPackHref,
  packChannelsLine,
  packCreditsLine,
  packDateLine,
  productFactsLine,
} from "@/lib/product-library";
import { getServices } from "@/lib/services";

export const metadata: Metadata = { title: "Products" };
export const dynamic = "force-dynamic";

/**
 * The products library: every product in the workspace with its photos,
 * saved details and pack history, and a link to start the next pack for it.
 */
export default async function ProductsPage() {
  const services = getServices();
  const workspace = await services.ensureWorkspace();
  if (!workspace) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-bold text-ink-950">Sign in to see your products</h1>
        <p className="mt-3 text-ink-600">Your products and their packs appear here after you sign in.</p>
        <Link href="/login?next=/app/products" className={buttonVariants({ variant: "secondary", className: "mt-6" })}>
          Log in
        </Link>
      </div>
    );
  }

  const products = await services.listProductLibrary(workspace.id);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-950">Products</h1>
          <p className="mt-1 text-sm text-ink-500">Every product in this workspace and the packs made for it.</p>
        </div>
        <Link href="/app/new" className={buttonVariants({ variant: "secondary" })}>
          New pack
        </Link>
      </div>

      {products.length === 0 ? (
        <Card data-testid="products-empty">
          <CardContent className="p-8 text-center">
            <p className="text-sm text-ink-600">No products yet. Your first pack creates one.</p>
            <Link href="/app/new" className={buttonVariants({ className: "mt-4" })}>
              Start your first pack
            </Link>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-4" data-testid="product-library">
          {products.map((product) => (
            <li key={product.id}>
              <Card data-testid="product-entry">
                <CardContent className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-semibold text-ink-950">{product.title}</h2>
                        {product.mode === "concept" ? <Badge variant="warning">Concept</Badge> : null}
                      </div>
                      <p className="mt-1 text-xs text-ink-500">
                        {product.category.replaceAll("_", " ")}. {productFactsLine(product)}.
                      </p>
                      {product.boxContents.length > 0 ? (
                        <p className="mt-1 text-xs text-ink-500">In the box: {product.boxContents.join(", ")}</p>
                      ) : null}
                      {product.comparisonFacts.length > 0 ? (
                        <p className="mt-1 text-xs text-ink-500">
                          How it compares: {product.comparisonFacts.join(". ")}
                        </p>
                      ) : null}
                    </div>
                    <Link
                      href={newPackHref(product.id)}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      New pack for this product
                    </Link>
                  </div>

                  {product.packs.length === 0 ? (
                    <p className="mt-4 text-sm text-ink-500">No packs yet.</p>
                  ) : (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full text-left text-sm" data-testid="pack-history">
                        <caption className="sr-only">Packs for {product.title}</caption>
                        <thead>
                          <tr className="border-b border-ink-100 text-xs text-ink-500">
                            <th scope="col" className="py-2 pr-4 font-medium">
                              Date
                            </th>
                            <th scope="col" className="py-2 pr-4 font-medium">
                              Status
                            </th>
                            <th scope="col" className="py-2 pr-4 font-medium">
                              Channels
                            </th>
                            <th scope="col" className="py-2 pr-4 font-medium">
                              Credits
                            </th>
                            <th scope="col" className="py-2 font-medium">
                              <span className="sr-only">Open</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-100">
                          {product.packs.map((pack) => (
                            <tr key={pack.id} data-testid="pack-history-row">
                              <td className="whitespace-nowrap py-2 pr-4 text-ink-700">{packDateLine(pack.createdAt)}</td>
                              <td className="py-2 pr-4">
                                <StatusChip status={pack.status} />
                              </td>
                              <td className="py-2 pr-4 text-ink-700">{packChannelsLine(pack.channels)}</td>
                              <td className="whitespace-nowrap py-2 pr-4 text-ink-700">{packCreditsLine(pack)}</td>
                              <td className="py-2 text-right">
                                <Link
                                  href={`/app/jobs/${pack.id}`}
                                  className="text-sm font-medium text-accent-600 hover:text-accent-700"
                                >
                                  Open
                                </Link>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
