/** One owner id across Next.js bundles in this process. */
const scope = globalThis as typeof globalThis & { __curviRunnerId?: string };
export function runnerId(): string {
  return (scope.__curviRunnerId ??= crypto.randomUUID());
}
