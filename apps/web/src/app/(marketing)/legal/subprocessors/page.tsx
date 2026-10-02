import type { Metadata } from "next";
import Link from "next/link";
import { LegalHeader, LegalSection, MailLink } from "@/components/marketing/legal-parts";
import { LEGAL_FACTS } from "@/lib/legal/facts";
import { connectedServicesInUse, subprocessorsInUse, type VendorInUse } from "@/lib/legal/subprocessors";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Subprocessors",
  description: "The companies that process data for Curvi, what each one does and what it receives.",
  path: "/legal/subprocessors",
});

function VendorTable({ vendors, testId }: { vendors: VendorInUse[]; testId: string }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-ink-100">
      <table className="w-full min-w-[36rem] text-left text-sm" data-testid={testId}>
        <thead className="bg-ink-50 text-ink-900">
          <tr>
            <th scope="col" className="px-4 py-2 font-semibold">
              Company
            </th>
            <th scope="col" className="px-4 py-2 font-semibold">
              What it does for us
            </th>
            <th scope="col" className="px-4 py-2 font-semibold">
              What it receives
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {vendors.map((vendor) => (
            <tr key={vendor.key} data-testid={`vendor-${vendor.key}`} className="align-top">
              <th scope="row" className="px-4 py-3 font-medium text-ink-900">
                {vendor.name}
              </th>
              <td className="px-4 py-3">{vendor.purposes.join(" ")}</td>
              <td className="px-4 py-3">{vendor.receives.join(" ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The list comes from lib/legal/subprocessors.ts and shows only the vendors
// this deployment uses (docs/phases/PHASE_20.md P20-23). Changing an entry
// moves subprocessorsLastUpdated in lib/legal/facts.ts.
export default function SubprocessorsPage() {
  const facts = LEGAL_FACTS;
  const processors = subprocessorsInUse();
  const connected = connectedServicesInUse();
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <LegalHeader title="Subprocessors" lastUpdated={facts.subprocessorsLastUpdated} />
      <div className="mt-8 space-y-6 text-sm leading-relaxed text-ink-700">
        <p>
          These companies process data for Curvi so we can run the service. This page lists only the ones we use
          today, and we update it when that changes. Our{" "}
          <Link href="/privacy" className="font-medium text-ink-900 underline">
            privacy policy
          </Link>{" "}
          explains what we collect and how long we keep it.
        </p>
        <LegalSection heading="Companies that process data for us" testId="subprocessors">
          <VendorTable vendors={processors} testId="subprocessor-table" />
        </LegalSection>
        {connected.length > 0 ? (
          <LegalSection heading="Services you connect yourself" testId="connected-services">
            <p className="mt-2">These receive data from Curvi only after you connect them to your workspace.</p>
            <VendorTable vendors={connected} testId="connected-table" />
          </LegalSection>
        ) : null}
        <p>
          Questions about how a company on this list handles your data go to <MailLink email={facts.support.email} />.
        </p>
      </div>
    </div>
  );
}
