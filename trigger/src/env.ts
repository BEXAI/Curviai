/**
 * The worker's one env reader. Modules take a ReadEnv parameter that
 * defaults to optionalEnv, so tests pass their own values. This module
 * imports nothing, so any module can use it without an import cycle.
 */

/** Reads one env variable by name; undefined when it is not set. */
export type ReadEnv = (name: string) => string | undefined;

/** process.env[name], with an empty value read as unset. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
