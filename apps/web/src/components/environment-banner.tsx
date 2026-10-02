export function EnvironmentBanner({ label }: { label?: string }) {
  if (!label?.trim()) return null;
  return <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-950" role="status" data-testid="environment-banner">{label.trim().slice(0, 40)} environment. Use test accounts and test payments only.</div>;
}
