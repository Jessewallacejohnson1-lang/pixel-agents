import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { codexProvider } from '../src/providers/hook/codex/codex.js';
import { applyTranscriptEvent } from '../src/transcriptEventDispatch.js';
import type { AgentState } from '../src/types.js';

/**
 * Generic transcript-event dispatch: the path taken by providers that implement
 * `parseTranscriptLine`. Claude keeps its bespoke `processTranscriptLine` path,
 * which tracks context usage, teams, and /clear — things AgentEvent cannot express.
 */

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/rollout.jsonl',
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
    providerId: 'codex',
    ...overrides,
  } as AgentState;
}

describe('applyTranscriptEvent', () => {
  let agents: AgentStateStore;
  let agent: AgentState;
  let broadcasts: { type: string; [key: string]: unknown }[];
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const apply = (event: Parameters<typeof applyTranscriptEvent>[2]) =>
    applyTranscriptEvent(1, agent, event, codexProvider, agents, waitingTimers, permissionTimers);

  beforeEach(() => {
    agents = new AgentStateStore();
    broadcasts = [];
    agent = createTestAgent();
    agents.set(1, agent);
    agents.on('broadcast', (msg) => broadcasts.push(msg as { type: string }));
  });

  const typesOf = () => broadcasts.map((b) => b.type);

  describe('toolStart', () => {
    it('tracks the tool and announces it with the provider-formatted status', () => {
      apply({ kind: 'toolStart', toolId: 'c1', toolName: 'exec', input: 'npm test' });

      expect(agent.activeToolIds.has('c1')).toBe(true);
      expect(agent.activeToolNames.get('c1')).toBe('exec');
      expect(agent.activeToolStatuses.get('c1')).toBe('Running: npm test');
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          type: 'agentToolStart',
          id: 1,
          toolId: 'c1',
          status: 'Running: npm test',
          toolName: 'exec',
        }),
      );
    });

    it('marks the agent active and no longer waiting', () => {
      agent.isWaiting = true;

      apply({ kind: 'toolStart', toolId: 'c1', toolName: 'exec', input: 'ls' });

      expect(agent.isWaiting).toBe(false);
      expect(agent.hadToolsInTurn).toBe(true);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'agentStatus', id: 1, status: 'active' }),
      );
    });

    it('formats an apply_patch by the file it edits', () => {
      apply({
        kind: 'toolStart',
        toolId: 'c2',
        toolName: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: /a/b/Thing.swift\n',
      });

      expect(agent.activeToolStatuses.get('c2')).toBe('Editing Thing.swift');
    });
  });

  describe('toolEnd', () => {
    it('clears the tool and announces it done', () => {
      apply({ kind: 'toolStart', toolId: 'c1', toolName: 'exec', input: 'ls' });
      broadcasts.length = 0;

      apply({ kind: 'toolEnd', toolId: 'c1' });

      expect(agent.activeToolIds.has('c1')).toBe(false);
      expect(agent.activeToolNames.has('c1')).toBe(false);
      expect(agent.activeToolStatuses.has('c1')).toBe(false);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'agentToolDone', id: 1, toolId: 'c1' }),
      );
    });

    it('is idempotent — Codex ends an apply_patch twice (patch_apply_end and the call output)', () => {
      apply({ kind: 'toolStart', toolId: 'c1', toolName: 'apply_patch', input: 'x' });
      apply({ kind: 'toolEnd', toolId: 'c1' });
      broadcasts.length = 0;

      expect(() => apply({ kind: 'toolEnd', toolId: 'c1' })).not.toThrow();
      // No second agentToolDone for a tool that is already gone.
      expect(typesOf()).not.toContain('agentToolDone');
    });

    it('ignores an end for a tool that never started', () => {
      apply({ kind: 'toolEnd', toolId: 'never-seen' });

      expect(typesOf()).not.toContain('agentToolDone');
    });
  });

  describe('turnEnd', () => {
    it('clears active tools and puts the agent in waiting', () => {
      apply({ kind: 'toolStart', toolId: 'c1', toolName: 'exec', input: 'ls' });
      broadcasts.length = 0;

      apply({ kind: 'turnEnd' });

      expect(agent.activeToolIds.size).toBe(0);
      expect(agent.isWaiting).toBe(true);
      expect(agent.hadToolsInTurn).toBe(false);
      expect(typesOf()).toContain('agentToolsClear');
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'agentStatus', id: 1, status: 'waiting' }),
      );
    });

    it('clears tools even when none are tracked, so stale bubbles cannot survive a turn', () => {
      apply({ kind: 'turnEnd' });

      expect(typesOf()).toContain('agentToolsClear');
    });

    it('clears a pending permission bubble', () => {
      agent.permissionSent = true;

      apply({ kind: 'turnEnd' });

      expect(agent.permissionSent).toBe(false);
    });
  });

  describe('sub-agents', () => {
    it('announces a sub-agent starting under its parent', () => {
      apply({
        kind: 'subagentStart',
        parentToolId: 'current',
        toolId: 'sub1',
        toolName: 'review_scroll_fix',
      });

      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'subagentToolStart', id: 1, toolId: 'sub1' }),
      );
    });

    it('announces a sub-agent finishing', () => {
      apply({
        kind: 'subagentStart',
        parentToolId: 'current',
        toolId: 'sub1',
        toolName: 'reviewer',
      });
      broadcasts.length = 0;

      apply({ kind: 'subagentEnd', parentToolId: 'current', toolId: 'sub1' });

      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'subagentToolDone', id: 1, toolId: 'sub1' }),
      );
    });
  });

  describe('events with no visible effect', () => {
    it.each([
      ['sessionStart', { kind: 'sessionStart' as const, cwd: '/w' }],
      ['progress', { kind: 'progress' as const, toolId: 't', data: {} }],
    ])('accepts %s without broadcasting', (_label, event) => {
      apply(event);

      expect(broadcasts).toHaveLength(0);
    });
  });
});
