import type { ReactNode } from "react";
import { isPending, legalDate, type LegalLine } from "@/lib/legal/copy";

/**
 * Shared pieces of the terms, privacy and subprocessors pages
 * (docs/phases/PHASE_20.md P20-23). A pending line, a fact the founder has
 * not supplied yet, is marked so nobody reads it as final text.
 */

export function LegalLineText({ line }: { line: LegalLine }) {
  if (isPending(line)) {
    return (
      <span
        data-testid="legal-pending"
        className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900 ring-1 ring-inset ring-amber-200"
      >
        {line.pending}
      </span>
    );
  }
  return <>{line}</>;
}

export function LegalHeader({ title, lastUpdated }: { title: string; lastUpdated: string }) {
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight text-ink-950">{title}</h1>
      <p className="mt-2 text-sm text-ink-500" data-testid="legal-last-updated">
        Last updated {legalDate(lastUpdated)}
      </p>
    </>
  );
}

export function LegalSection({
  id,
  heading,
  testId,
  children,
}: {
  id?: string;
  heading: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} data-testid={testId} className="scroll-mt-24">
      <h2 className="text-base font-semibold text-ink-950">{heading}</h2>
      {children}
    </section>
  );
}

export function MailLink({ email }: { email: string }) {
  return (
    <a href={`mailto:${email}`} className="font-medium text-ink-900 underline">
      {email}
    </a>
  );
}
