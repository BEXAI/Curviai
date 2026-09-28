import { Badge } from "@curvi/ui";
import { amazonMainRules } from "@/lib/marketing-facts";

export interface ComplianceDemoRow {
  rule: string;
  requirement: string;
  measured: string;
}

/**
 * Rows for the example report. Requirements come from the amazon.main spec
 * in the registry (CLAUDE.md rule 2), and the example measurements sit inside
 * those rules. Only checks the real QC stage measures today are shown: text
 * and prop detection is not measured yet, so it is not listed.
 */
export function complianceDemoRows(): ComplianceDemoRow[] {
  const rules = amazonMainRules();
  const rgb = rules.rgb.join(" ");
  const exampleFill = Math.round(((rules.fillMinPercent + rules.fillMaxPercent) / 2) * 10) / 10;
  return [
    {
      rule: "Background",
      requirement: `Pure white, RGB ${rgb}`,
      measured: `${rgb} on every background pixel`,
    },
    {
      rule: "Product fill",
      requirement: `${rules.fillMinPercent} to ${rules.fillMaxPercent} percent of the frame`,
      measured: `${exampleFill} percent of the longest side`,
    },
    {
      rule: "Resolution",
      requirement: `Longest side at least ${rules.minLongSide} px`,
      measured: `${rules.width} by ${rules.height} px`,
    },
  ];
}

/**
 * Static example of the compliance report every Curvi file ships with. It is
 * labeled as an example; the real report carries the numbers the QC stage
 * measured on each output.
 */
export function ComplianceBadgeDemo() {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-ink-100 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink-900">
            SKU1.MAIN.jpg
            <Badge variant="outline" data-testid="example-report-label">
              Example report
            </Badge>
          </p>
          <p className="text-xs text-ink-500">Checked against the Amazon main image spec</p>
        </div>
        <Badge variant="success" className="px-3 py-1 text-sm">
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8.5 6.5 12 13 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Passes Amazon main image rules
        </Badge>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[24rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-ink-400">
            <tr>
              <th scope="col" className="py-2 pr-4 font-semibold">Rule</th>
              <th scope="col" className="py-2 pr-4 font-semibold">Requirement</th>
              <th scope="col" className="py-2 font-semibold">Measured</th>
            </tr>
          </thead>
          <tbody>
            {complianceDemoRows().map((row) => (
              <tr key={row.rule} className="border-t border-ink-100">
                <td className="py-2.5 pr-4 font-medium text-ink-900">{row.rule}</td>
                <td className="py-2.5 pr-4 text-ink-600">{row.requirement}</td>
                <td className="py-2.5 text-emerald-700">{row.measured}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs text-ink-400">
        An example of the report each file in a pack gets. Yours shows the numbers measured on the
        pixels of your own files.
      </p>
    </div>
  );
}
