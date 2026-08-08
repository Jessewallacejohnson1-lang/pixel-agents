/**
 * Seats roster employees in the office.
 *
 * Session-driven agents come and go with their transcripts. Roster seats do not:
 * an employee who finishes work stays at their desk, which is what makes "who is
 * free right now" a question the office can answer.
 *
 * Seats are reconciled, not streamed. The source reports the whole roster on each
 * poll and this applies the difference, so a missed poll self-corrects on the next
 * one rather than leaving the office permanently wrong.
 */

import type { RosterSeat, SeatState } from '../../core/src/roster.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

/** Session id prefix marking an agent as roster-owned rather than session-owned. */
const ROSTER_SESSION_PREFIX = 'roster:';

/** Tool id used for the single activity line shown on a working seat. */
const ACTIVITY_TOOL_ID = 'roster-activity';

/** States that put a person at a desk. `open` has nobody to draw; `off` is
 *  switched-off staff, which reads better as an empty desk than a greyed one. */
const STAFFED_STATES: ReadonlySet<SeatState> = new Set<SeatState>(['idle', 'working', 'stuck']);

interface SeatedAgent {
  agentId: number;
  state: SeatState;
  activity: string | undefined;
}

export class RosterSeating {
  private readonly seated = new Map<string, SeatedAgent>();

  constructor(private readonly agents: AgentStateStore) {}

  /** Apply a complete roster. Seats absent from `seats` are vacated. */
  reconcile(seats: readonly RosterSeat[]): void {
    const staffed = seats.filter((s) => STAFFED_STATES.has(s.state));

    for (const seat of staffed) {
      const existing = this.seated.get(seat.id);
      if (existing === undefined) {
        this.seat(seat);
        continue;
      }
      this.applyState(seat, existing);
    }

    const staffedIds = new Set(staffed.map((s) => s.id));
    for (const seatId of [...this.seated.keys()]) {
      if (!staffedIds.has(seatId)) this.vacate(seatId);
    }
  }

  /**
   * Re-send the current state of every non-idle seat to one client.
   *
   * State is broadcast on change, and a client that connects afterwards never
   * saw it — employees would render at their desks with no activity, which
   * reads as idle whatever they are actually doing.
   *
   * Idle is deliberately not replayed: a character with no active tool already
   * renders as idle, and `agentStatus: 'waiting'` rings the notification chime,
   * so replaying it would beep once per idle employee on every page load.
   */
  replayTo(send: (message: Record<string, unknown>) => void): void {
    for (const entry of this.seated.values()) {
      if (entry.state !== 'working' && entry.state !== 'stuck') continue;

      if (entry.activity !== undefined) {
        send({
          type: 'agentToolStart',
          id: entry.agentId,
          toolId: ACTIVITY_TOOL_ID,
          status: entry.activity,
        });
      }
      send({ type: 'agentStatus', id: entry.agentId, status: 'active' });
      if (entry.state === 'stuck') {
        send({ type: 'agentToolPermission', id: entry.agentId });
      }
    }
  }

  /** Agent id backing a seat, for callers that need to route an action to it. */
  agentIdFor(seatId: string): number | undefined {
    return this.seated.get(seatId)?.agentId;
  }

  /** Seat id behind an agent, or undefined when the agent is session-owned. */
  seatIdFor(agentId: number): string | undefined {
    for (const [seatId, entry] of this.seated) {
      if (entry.agentId === agentId) return seatId;
    }
    return undefined;
  }

  private seat(seat: RosterSeat): void {
    const agentId = this.agents.nextAgentId.current++;
    const agent: AgentState = {
      id: agentId,
      sessionId: `${ROSTER_SESSION_PREFIX}${seat.id}`,
      terminalRef: undefined,
      // Roster seats are staff, not adopted external sessions; marking them
      // external would expose them to the stale-agent sweep, which removes
      // agents whose transcript has gone quiet. An idle employee is quiet by
      // definition and must survive it.
      isExternal: false,
      projectDir: '',
      jsonlFile: '',
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
      folderName: seat.title,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      // No transcript to watch: a seat's state comes from the roster.
      hooksOnly: true,
      contextTokens: 0,
      maxContextTokens: 0,
    } as AgentState;

    this.agents.set(agentId, agent);

    // Record before applying state so the transition below is computed against
    // a known-empty starting point rather than the incoming state itself.
    const entry: SeatedAgent = { agentId, state: 'off', activity: undefined };
    this.seated.set(seat.id, entry);
    this.applyState(seat, entry);
  }

  private vacate(seatId: string): void {
    const entry = this.seated.get(seatId);
    if (entry === undefined) return;
    this.agents.delete(entry.agentId);
    this.seated.delete(seatId);
  }

  private applyState(seat: RosterSeat, entry: SeatedAgent): void {
    const stateChanged = entry.state !== seat.state;
    const activityChanged = entry.activity !== seat.activity;
    if (!stateChanged && !activityChanged) return;

    const agent = this.agents.get(entry.agentId);
    if (agent === undefined) return;

    entry.state = seat.state;
    entry.activity = seat.activity;

    if (seat.state === 'idle') {
      this.goIdle(entry.agentId, agent);
      return;
    }

    // working | stuck both show the person at work; stuck adds the bubble.
    this.goActive(entry.agentId, agent, seat.activity);

    if (seat.state === 'stuck' && !agent.permissionSent) {
      agent.permissionSent = true;
      this.agents.broadcast({ type: 'agentToolPermission', id: entry.agentId });
    } else if (seat.state !== 'stuck' && agent.permissionSent) {
      agent.permissionSent = false;
      this.agents.broadcast({ type: 'agentToolPermissionClear', id: entry.agentId });
    }
  }

  private goIdle(agentId: number, agent: AgentState): void {
    agent.activeToolIds.clear();
    agent.activeToolNames.clear();
    agent.activeToolStatuses.clear();
    agent.isWaiting = true;
    agent.hadToolsInTurn = false;

    if (agent.permissionSent) {
      agent.permissionSent = false;
      this.agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
    }
    this.agents.broadcast({ type: 'agentToolsClear', id: agentId });
    this.agents.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting' });
  }

  private goActive(agentId: number, agent: AgentState, activity: string | undefined): void {
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;

    if (activity !== undefined) {
      agent.activeToolIds.add(ACTIVITY_TOOL_ID);
      agent.activeToolStatuses.set(ACTIVITY_TOOL_ID, activity);
      this.agents.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId: ACTIVITY_TOOL_ID,
        status: activity,
      });
    }
    this.agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
  }
}
