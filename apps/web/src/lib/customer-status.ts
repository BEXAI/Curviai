export type CustomerState = "Working normally" | "Slower than usual" | "Paused";
export function customerStatus(health: unknown, acquisition: unknown): Array<{ name: string; state: CustomerState }> {
  const data = health as { status?: string; degradedBy?: string[] } | null;
  const paused = (acquisition as { acquisition?: string } | null)?.acquisition === "waitlist";
  const codes = Array.isArray(data?.degradedBy) ? data.degradedBy.filter((code): code is string => typeof code === "string") : [];
  const base: CustomerState = data?.status === "ok" ? "Working normally" : data?.status === "down" ? "Paused" : "Slower than usual";
  const packsPaused = paused || codes.some((code) => code.startsWith("packs_paused") || code === "breaker_open:cutout");
  return [
    { name: "Making packs", state: packsPaused ? "Paused" : base },
    { name: "Lifestyle scenes", state: packsPaused || codes.some((code) => code === "scenes_paused" || code === "breaker_open:generate") ? "Paused" : base },
    { name: "Downloads", state: base },
    { name: "Sign in and billing", state: base },
  ];
}
