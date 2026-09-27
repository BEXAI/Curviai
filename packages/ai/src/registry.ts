/**
 * Provider registry and routing table types.
 *
 * The registry holds live Provider instances keyed by name. Routing is pure
 * data passed into the router: a RoutingTable maps a task name to an ordered
 * failover chain of provider names. Routing tables are loaded from config or
 * seed data, never hardcoded next to call sites.
 */

import type { Provider, ProviderKind } from "./types";

/** Ordered provider failover chain per task name. Data, not code. */
export type RoutingTable = Record<string, string[]>;

export class ProviderRegistry {
  private readonly providers = new Map<string, Provider>();

  /** Registers a provider. Throws on a duplicate name to catch wiring mistakes. */
  register(provider: Provider): void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Provider "${provider.name}" is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  listByKind(kind: ProviderKind): Provider[] {
    return [...this.providers.values()].filter((p) => p.kind === kind);
  }

  list(): Provider[] {
    return [...this.providers.values()];
  }
}
