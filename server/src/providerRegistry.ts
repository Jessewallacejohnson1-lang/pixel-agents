/**
 * Registry of the providers this runtime can dispatch to.
 *
 * `POST /api/hooks/:providerId` and `ServerAgentState.providerId` have always
 * carried a provider id; this is what turns that id into the provider that
 * should interpret the event. Before it existed, every event was interpreted by
 * a single injected provider regardless of its id, so only one CLI could be
 * tracked at a time.
 *
 * Unknown ids resolve to `undefined` rather than falling back to the default.
 * Interpreting a Codex event with the Claude provider produces confidently wrong
 * output, which is worse than dropping the event.
 */

import type { HookProvider } from '../../core/src/provider.js';

export class ProviderRegistry {
  private readonly byId = new Map<string, HookProvider>();
  private readonly ordered: readonly HookProvider[];

  constructor(providers: readonly HookProvider[]) {
    if (providers.length === 0) {
      throw new Error('ProviderRegistry requires at least one provider');
    }
    for (const provider of providers) {
      if (this.byId.has(provider.id)) {
        throw new Error(`ProviderRegistry: duplicate provider id "${provider.id}"`);
      }
      this.byId.set(provider.id, provider);
    }
    this.ordered = Object.freeze([...providers]);
  }

  /** The provider registered under `id`, or undefined if there is none. */
  get(id: string | undefined): HookProvider | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** First registered provider. Used only where no id is available — terminal
   *  launch, and legacy call sites that predate multi-provider dispatch. */
  get default(): HookProvider {
    // Non-null: the constructor rejects an empty list.
    return this.ordered[0]!;
  }

  /** Every provider, for operations that must span all of them (session-root
   *  discovery, terminal-name matching). */
  all(): readonly HookProvider[] {
    return this.ordered;
  }
}
