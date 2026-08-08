import { beforeEach, describe, expect, it } from 'vitest';

import type { RosterSeat } from '../../core/src/roster.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { RosterSeating } from '../src/rosterSeating.js';

/**
 * Roster seats become permanent characters. The defining difference from
 * session-driven agents: a seat that stops working stays seated.
 */

const seat = (over: Partial<RosterSeat> = {}): RosterSeat => ({
  id: 'shipper',
  title: 'Engineer',
  reportsTo: 'ops',
  state: 'idle',
  ...over,
});

describe('RosterSeating', () => {
  let agents: AgentStateStore;
  let seating: RosterSeating;
  let broadcasts: { type: string; [key: string]: unknown }[];
  let removed: number[];

  beforeEach(() => {
    agents = new AgentStateStore();
    broadcasts = [];
    removed = [];
    agents.on('broadcast', (msg) => broadcasts.push(msg as { type: string }));
    // Removal is a store event, not a broadcast: the transport layer turns it
    // into `agentClosed`.
    agents.on('agentRemoved', (id) => removed.push(id));
    seating = new RosterSeating(agents);
  });

  const typesOf = () => broadcasts.map((b) => b.type);
  const agentFor = (id: string) => [...agents.values()].find((a) => a.sessionId === `roster:${id}`);

  describe('seating', () => {
    it('creates a character for a seat', () => {
      seating.reconcile([seat()]);

      const agent = agentFor('shipper');
      expect(agent).toBeDefined();
      expect(agent?.folderName).toBe('Engineer');
      expect(agent?.hooksOnly).toBe(true);
      expect(agent?.isExternal).toBe(false);
    });

    it('gives an idle seat the waiting appearance so it is visibly free', () => {
      seating.reconcile([seat({ state: 'idle' })]);

      expect(agentFor('shipper')?.isWaiting).toBe(true);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'agentStatus', status: 'waiting' }),
      );
    });

    it('does not recreate a seat that is already seated', () => {
      seating.reconcile([seat()]);
      const firstId = agentFor('shipper')?.id;
      broadcasts.length = 0;

      seating.reconcile([seat()]);

      expect(agentFor('shipper')?.id).toBe(firstId);
      expect(agents.size).toBe(1);
      expect(removed).toHaveLength(0);
    });

    it('seats several employees at once', () => {
      seating.reconcile([seat(), seat({ id: 'ops', title: 'Chief of staff', reportsTo: null })]);

      expect(agents.size).toBe(2);
      expect(agentFor('ops')?.folderName).toBe('Chief of staff');
    });

    it('keeps roster seats separate from session agents', () => {
      seating.reconcile([seat()]);

      expect(agentFor('shipper')?.sessionId).toBe('roster:shipper');
    });
  });

  describe('state changes', () => {
    it('marks a seat active when it starts working', () => {
      seating.reconcile([seat({ state: 'idle' })]);
      broadcasts.length = 0;

      seating.reconcile([seat({ state: 'working', activity: 'Fixing the map' })]);

      expect(agentFor('shipper')?.isWaiting).toBe(false);
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'agentStatus', status: 'active' }),
      );
    });

    it('shows the activity of a working seat', () => {
      seating.reconcile([seat({ state: 'working', activity: 'Fixing the map' })]);

      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'agentToolStart', status: 'Fixing the map' }),
      );
    });

    it('returns a seat to idle when work finishes, without removing it', () => {
      seating.reconcile([seat({ state: 'working', activity: 'Fixing the map' })]);
      broadcasts.length = 0;

      seating.reconcile([seat({ state: 'idle' })]);

      // The whole point: the employee is still here.
      expect(agentFor('shipper')).toBeDefined();
      expect(agentFor('shipper')?.isWaiting).toBe(true);
      expect(typesOf()).toContain('agentToolsClear');
    });

    it('raises the permission bubble for a stuck seat', () => {
      seating.reconcile([seat({ state: 'working' })]);
      broadcasts.length = 0;

      seating.reconcile([seat({ state: 'stuck' })]);

      expect(agentFor('shipper')?.permissionSent).toBe(true);
      expect(typesOf()).toContain('agentToolPermission');
    });

    it('clears the bubble once the seat is unstuck', () => {
      seating.reconcile([seat({ state: 'stuck' })]);
      broadcasts.length = 0;

      seating.reconcile([seat({ state: 'working', activity: 'Back at it' })]);

      expect(agentFor('shipper')?.permissionSent).toBe(false);
      expect(typesOf()).toContain('agentToolPermissionClear');
    });

    it('does not re-announce a state that has not changed', () => {
      seating.reconcile([seat({ state: 'working', activity: 'Fixing the map' })]);
      broadcasts.length = 0;

      seating.reconcile([seat({ state: 'working', activity: 'Fixing the map' })]);

      expect(broadcasts).toHaveLength(0);
    });

    it('announces a changed activity within the same working state', () => {
      seating.reconcile([seat({ state: 'working', activity: 'Fixing the map' })]);
      broadcasts.length = 0;

      seating.reconcile([seat({ state: 'working', activity: 'Running tests' })]);

      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'agentToolStart', status: 'Running tests' }),
      );
    });
  });

  describe('seats that should not be staffed', () => {
    it.each([['open'], ['off']] as const)('does not seat a %s role', (state) => {
      seating.reconcile([seat({ state })]);

      expect(agents.size).toBe(0);
    });

    it('unseats an employee who is switched off', () => {
      seating.reconcile([seat({ state: 'idle' })]);
      expect(agents.size).toBe(1);

      seating.reconcile([seat({ state: 'off' })]);

      expect(agents.size).toBe(0);
      expect(removed).toHaveLength(1);
    });

    it('removes a seat that disappears from the roster entirely', () => {
      seating.reconcile([seat(), seat({ id: 'ops', title: 'Chief of staff' })]);

      seating.reconcile([seat()]);

      expect(agents.size).toBe(1);
      expect(agentFor('ops')).toBeUndefined();
    });

    it('re-seats an employee switched back on', () => {
      seating.reconcile([seat({ state: 'idle' })]);
      seating.reconcile([seat({ state: 'off' })]);

      seating.reconcile([seat({ state: 'idle' })]);

      expect(agentFor('shipper')).toBeDefined();
    });
  });

  describe('coexistence with session agents', () => {
    it('leaves agents it did not create alone', () => {
      agents.set(99, {
        id: 99,
        sessionId: 'a-real-claude-session',
        isExternal: true,
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
      } as never);

      seating.reconcile([seat()]);
      seating.reconcile([]);

      expect(agents.get(99)).toBeDefined();
    });
  });
});
