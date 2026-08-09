/**
 * Reads a roster from an orchestrator over HTTP.
 *
 * The office holds no roster state of its own: it mirrors what the orchestrator
 * reports, and every poll re-reconciles the whole list. The orchestrator stays
 * the only place that knows who is on staff and what they are doing, so the two
 * cannot disagree about it — a failed poll leaves the last good roster in place
 * and the next one corrects it.
 */

import type { RosterSeat, RosterSource, SeatState } from '../../core/src/roster.js';

const VALID_STATES: ReadonlySet<string> = new Set<SeatState>([
  'open',
  'idle',
  'working',
  'stuck',
  'off',
]);

/** Abandon a poll after this long; a hung orchestrator must not stall the loop. */
const REQUEST_TIMEOUT_MS = 4000;

/** Re-warn after this many consecutive failures. Warning only once per outage
 *  keeps the log quiet, but an outage that never ends then serves a stale roster
 *  in silence — the office shows a fleet that stopped updating and says nothing.
 *  At the default 2s poll this speaks up about every minute. */
const REWARN_AFTER_FAILURES = 30;

function toSeat(raw: unknown): RosterSeat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const id = record.id;
  const title = record.title;
  const state = record.state;
  if (typeof id !== 'string' || !id) return null;
  if (typeof state !== 'string' || !VALID_STATES.has(state)) return null;

  return {
    id,
    // A seat with no title still belongs on screen; its id is a usable label.
    title: typeof title === 'string' && title ? title : id,
    reportsTo: typeof record.reportsTo === 'string' ? record.reportsTo : null,
    state: state as SeatState,
    activity: typeof record.activity === 'string' ? record.activity : undefined,
    detail: typeof record.detail === 'string' ? record.detail : undefined,
  };
}

export class HttpRosterSource implements RosterSource {
  /** Last roster read successfully. Returned when a poll fails, so a blip in
   *  the orchestrator empties nobody's desk. */
  private lastGood: readonly RosterSeat[] = [];
  private consecutiveFailures = 0;

  constructor(
    private readonly url: string,
    private readonly token?: string,
  ) {}

  async listSeats(): Promise<readonly RosterSeat[]> {
    try {
      const response = await fetch(this.url, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return this.fail(`HTTP ${response.status}`);

      const body: unknown = await response.json();
      const rawSeats = (body as { seats?: unknown })?.seats;
      if (!Array.isArray(rawSeats)) return this.fail('response had no seats array');

      const seats = rawSeats.map(toSeat).filter((s): s is RosterSeat => s !== null);
      this.lastGood = seats;
      if (this.consecutiveFailures > 0) {
        console.warn(`[Pixel Agents] Roster: ${this.url} is back; seats are live again`);
        this.consecutiveFailures = 0;
      }
      return seats;
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Keep the last roster and say so — at the start of an outage and periodically
   * while it lasts.
   *
   * Warning only at the start would leave a permanent outage silent: the office
   * would keep drawing a roster that stopped updating, and nothing on screen or
   * in the log would say the picture is old.
   */
  private fail(reason: string): readonly RosterSeat[] {
    const isFirst = this.consecutiveFailures === 0;
    this.consecutiveFailures++;
    if (isFirst || this.consecutiveFailures % REWARN_AFTER_FAILURES === 0) {
      const age = isFirst ? '' : ` for ${this.consecutiveFailures} polls`;
      console.warn(
        `[Pixel Agents] Roster: ${this.url} unavailable${age} (${reason}); showing a stale roster`,
      );
    }
    return this.lastGood;
  }
}
