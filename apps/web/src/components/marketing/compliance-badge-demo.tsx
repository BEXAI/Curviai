import { Badge } from "@curvi/ui";

const demoRows = [
  {
    rule: "Background",
    requirement: "Pure white, RGB 255 255 255",
    measured: "255 255 255 across 100 percent of background pixels",
  },
  {
    rule: "Product fill",
    requirement: "85 to 90 percent of the frame",
    measured: "87.2 percent of the longest side",
  },
  {
    rule: "Resolution",
    requirement: "Longest side at least 1600 px",
    measured: "2000 by 2000 px",
  },
  {
    rule: "Text and props",
    requirement: "None allowed on the main image",
    measured: "None detected",
  },
];

/**
 * Static demo of the compliance report every Curvi file ships with. The
 * numbers here mirror what the real QC stage measures per output.
 */
export function ComplianceBadgeDemo() {
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-ink-100 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink-900">SKU1.MAIN.jpg</p>
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
            {demoRows.map((row) => (
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
        Every file in a Curvi pack ships with a report like this, measured on the actual pixels of the
        output, not a promise.
      </p>
    </div>
  );
}
