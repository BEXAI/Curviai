/**
 * POST /api/products
 * Creates a product to attach uploads and packs to. Client role members are
 * read only and get a 403.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const ProductRequest = z.object({
  title: z.string().trim().min(1).max(120),
  mode: z.enum(["listing", "concept"]),
});

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }
  const parsed = ProductRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request.", issues: parsed.error.issues.map((i) => i.message) },
      { status: 400 },
    );
  }

  const services = getServices();
  const workspace = await services.getCurrentWorkspace();
  if (!workspace) {
    return NextResponse.json({ error: "Sign in to add a product." }, { status: 401 });
  }

  const product = await services.createProduct(workspace.id, parsed.data);
  if (!product) {
    return NextResponse.json(
      { error: "Client seats can review assets but cannot add products." },
      { status: 403 },
    );
  }
  return NextResponse.json({ product }, { status: 201 });
}
