/**
 * Roster: employees rather than sessions.
 *
 * Upstream binds one character to one session — the character appears when work
 * starts and disappears when it ends, so an idle agent is invisible. That cannot
 * answer "who is free right now", which is most of what managing a fleet means.
 *
 * A roster source supplies seats that exist independently of any session. The
 * office seats them permanently and drives their appearance from seat state.
 * Sessions still arrive through providers; the two coexist, and a session that
 * has no seat is a walk-in.
 *
 * This file declares types only. The host (an orchestrator that owns a roster)
 * implements `RosterSource`; the office never reads the orchestrator's storage.
 */

/** What a seat is doing, as far as the office needs to draw it. */
export type SeatState =
  /** A role that exists but nobody fills — an empty desk with a job title. */
  | 'open'
  /** On staff, available, not working. The state a session-based office cannot show. */
  | 'idle'
  /** Actively working. */
  | 'working'
  /** Stopped and waiting on a human decision. */
  | 'stuck'
  /** On staff but switched off. */
  | 'off';

export interface RosterSeat {
  /** Stable identifier. Survives restarts; a seat is the same seat tomorrow. */
  id: string;
  /** Job title, shown instead of the seat id. */
  title: string;
  /** Seat this one reports to; null reports to the operator. Drives the org chart. */
  reportsTo: string | null;
  state: SeatState;
  /** One-line description of current work. Only meaningful while `working`. */
  activity?: string;
  /** The agent's own explanation of what it is asking. Shown when the seat is
   *  stuck, so a decision can be made without leaving the office for the
   *  console — a one-line title is rarely enough to answer anything. */
  detail?: string;
}

export interface RosterSource {
  /**
   * Every seat, including open and off ones — the office decides how to draw
   * them. Called on a poll, so it must be cheap and must not throw; a source
   * that fails should return its last known seats or an empty list.
   */
  listSeats(): Promise<readonly RosterSeat[]> | readonly RosterSeat[];
}
