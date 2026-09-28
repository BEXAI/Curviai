import Link from "next/link";
import { cn } from "@curvi/ui";
import { EmailCapture } from "./email-capture";
import { toolPackCta } from "./tool-copy";

const tools = [
  { href: "/tools/main-image-checker", label: "Main Image Checker" },
  { href: "/tools/white-background-fixer", label: "White Background Fixer" },
  { href: "/tools/marketplace-resizer", label: "Marketplace Resizer" },
];

export function ToolPageShell({
  currentPath,
  title,
  description,
  children,
}: {
  currentPath: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <nav aria-label="Free tools" className="flex flex-wrap gap-2">
        {tools.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className={cn(
              "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
              tool.href === currentPath
                ? "border-ink-900 bg-ink-900 text-white"
                : "border-ink-200 text-ink-600 hover:bg-ink-50",
            )}
          >
            {tool.label}
          </Link>
        ))}
      </nav>
      <h1 className="mt-8 text-4xl font-bold tracking-tight text-ink-950">{title}</h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-600">{description}</p>
      <div className="mt-10">{children}</div>
      <div data-testid="tool-pack-cta" className="mt-16 rounded-xl border border-ink-100 bg-ink-50 p-8 text-center">
        <h2 className="text-xl font-semibold text-ink-950">{toolPackCta.title}</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm text-ink-600">{toolPackCta.body}</p>
        <div className="mt-6">
          <EmailCapture />
        </div>
      </div>
    </div>
  );
}
