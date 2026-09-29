/**
 * A small argv parser: positionals, --flag value, --flag=value and boolean
 * switches. Only flags a command declares are accepted, so a typo is an
 * error rather than a silently ignored option.
 */

export interface FlagSpec {
  /** True for a switch that takes no value. */
  boolean?: boolean;
  /** True when the flag may repeat; its values are collected in order. */
  multiple?: boolean;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: readonly string[], specs: Record<string, FlagSpec>): ParsedArgs {
  const positionals: string[] = [];
  const flags: ParsedArgs["flags"] = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg.length === 2) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const spec = specs[name];
    if (!spec) {
      throw new UsageError(`Unknown option ${arg.slice(0, eq === -1 ? undefined : eq)}.`);
    }
    if (spec.boolean) {
      if (eq !== -1) throw new UsageError(`The option --${name} takes no value.`);
      flags[name] = true;
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[i + 1];
      i += 1;
    }
    if (value === undefined || value === "") {
      throw new UsageError(`The option --${name} needs a value.`);
    }
    if (spec.multiple) {
      const list = flags[name];
      flags[name] = Array.isArray(list) ? [...list, value] : [value];
    } else {
      flags[name] = value;
    }
  }
  return { positionals, flags };
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function listFlag(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return raw
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
