import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { ProviderRegistry } from '../src/providerRegistry.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

/**
 * Two providers, one runtime.
 *
 * Before the ProviderRegistry landed, `handleEvent` ignored its providerId and
 * interpreted every event with a single injected provider — so a Claude event and
 * a Codex event could not be understood by the same runtime. These tests pin that
 * they now can.
 */

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

describe('multi-provider dispatch', () => {
  let agents: AgentStateStore;
  let handler: HookEventHandler;
  let broadcasts: { type: string; [key: string]: unknown }[];

  beforeEach(() => {
    agents = new AgentStateStore();
    broadcasts = [];
    agents.on('broadcast', (msg) => broadcasts.push(msg as { type: string }));
    handler = new HookEventHandler(
      agents,
      new Map(),
      new Map(),
      new ProviderRegistry([claudeProvider, codexProvider]),
      new SessionRouter(),
    );
  });

  const seat = (id: number, sessionId: string) => {
    agents.set(id, createTestAgent({ id, sessionId }));
    handler.registerAgent(sessionId, id);
  };

  it('routes a Claude event and a Codex event to their own providers', () => {
    seat(1, 'claude-sess');
    seat(2, 'codex-sess');

    // Claude's own hook shape.
    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'claude-sess',
      tool_name: 'Read',
      tool_input: { file_path: '/a/b/file.ts' },
    });

    // Codex's rollout shape — a completely different payload format.
    handler.handleEvent('codex', {
      hook_event_name: 'rollout',
      session_id: 'codex-sess',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'npm test' },
    });

    expect(agents.get(1)?.providerId).toBe('claude');
    expect(agents.get(2)?.providerId).toBe('codex');

    const statuses = broadcasts
      .filter((m) => m.type === 'agentToolStart')
      .map((m) => m['status'] as string);

    // Each payload was read by the provider that understands it.
    expect(statuses).toContain('Reading file.ts');
    expect(statuses).toContain('Running: npm test');
  });

  it('drops events from an unregistered provider rather than misreading them', () => {
    seat(1, 'sess-1');

    handler.handleEvent('gemini', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/a/b/file.ts' },
    });

    expect(broadcasts.filter((m) => m.type === 'agentToolStart')).toHaveLength(0);
    expect(agents.get(1)?.providerId).toBeUndefined();
  });

  it('does not let a Codex payload reach the Claude provider', () => {
    seat(1, 'sess-1');

    // A Codex rollout record posted under the claude id: Claude's normalizer sees
    // no hook_event_name it recognizes and yields nothing, rather than inventing a tool.
    handler.handleEvent('claude', {
      hook_event_name: 'rollout',
      session_id: 'sess-1',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'rm -rf /' },
    });

    expect(broadcasts.filter((m) => m.type === 'agentToolStart')).toHaveLength(0);
  });

  it('keeps each agent bound to its provider across successive events', () => {
    seat(1, 'codex-sess');

    handler.handleEvent('codex', {
      hook_event_name: 'rollout',
      session_id: 'codex-sess',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: 'x' },
    });
    handler.handleEvent('codex', {
      hook_event_name: 'rollout',
      session_id: 'codex-sess',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: '1' },
    });

    expect(agents.get(1)?.providerId).toBe('codex');
    expect(agents.get(1)?.isWaiting).toBe(true);
  });
});
