import { describe, expect, it } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import { ProviderRegistry } from '../src/providerRegistry.js';

function fakeProvider(id: string): HookProvider {
  return {
    kind: 'hook',
    id,
    displayName: id,
    protocolVersion: 1,
    normalizeHookEvent: () => null,
    installHooks: () => Promise.resolve(),
    uninstallHooks: () => Promise.resolve(),
    areHooksInstalled: () => Promise.resolve(false),
    formatToolStatus: (toolName: string) => toolName,
    permissionExemptTools: new Set<string>(),
    subagentToolNames: new Set<string>(),
    readingTools: new Set<string>(),
  };
}

describe('ProviderRegistry', () => {
  it('resolves a registered provider by id', () => {
    const claude = fakeProvider('claude');
    const codex = fakeProvider('codex');
    const registry = new ProviderRegistry([claude, codex]);

    expect(registry.get('claude')).toBe(claude);
    expect(registry.get('codex')).toBe(codex);
  });

  it('returns undefined for an unregistered id rather than guessing', () => {
    const registry = new ProviderRegistry([fakeProvider('claude')]);

    expect(registry.get('codex')).toBeUndefined();
    expect(registry.get(undefined)).toBeUndefined();
  });

  it('treats the first provider as the default', () => {
    const claude = fakeProvider('claude');
    const registry = new ProviderRegistry([claude, fakeProvider('codex')]);

    expect(registry.default).toBe(claude);
  });

  it('exposes every provider for operations that span all of them', () => {
    const registry = new ProviderRegistry([fakeProvider('claude'), fakeProvider('codex')]);

    expect(registry.all().map((p) => p.id)).toEqual(['claude', 'codex']);
  });

  it('reports membership', () => {
    const registry = new ProviderRegistry([fakeProvider('claude')]);

    expect(registry.has('claude')).toBe(true);
    expect(registry.has('codex')).toBe(false);
  });

  it('rejects an empty provider list — the runtime always needs a default', () => {
    expect(() => new ProviderRegistry([])).toThrow(/at least one/i);
  });

  it('rejects duplicate ids, which would make resolution ambiguous', () => {
    expect(() => new ProviderRegistry([fakeProvider('claude'), fakeProvider('claude')])).toThrow(
      /duplicate/i,
    );
  });

  it('does not expose a mutable view of its providers', () => {
    const registry = new ProviderRegistry([fakeProvider('claude')]);
    const all = registry.all() as HookProvider[];

    expect(() => all.push(fakeProvider('codex'))).toThrow();
    expect(registry.all()).toHaveLength(1);
  });
});
