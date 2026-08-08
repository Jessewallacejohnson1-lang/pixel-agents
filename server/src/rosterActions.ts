/**
 * Sends office actions back to the orchestrator that owns the roster.
 *
 * The office decides nothing: it names an employee and an intent, and the
 * orchestrator decides how. Which CLI backs an employee, what a job costs, and
 * whether it is allowed to run are all facts the orchestrator holds — that is
 * what lets a third harness be added without touching the office.
 */

export interface RosterActions {
  /** Give a seat a job. Resolves once the orchestrator accepts it. */
  startWork(seatId: string, task: string): Promise<void>;
  /** Mark whatever a seat is waiting on as answered. */
  resolveStuck(seatId: string): Promise<void>;
}

/** Abandon a request after this long; the office must not hang on a click. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Talks to a bizops-shaped orchestrator.
 *
 * `baseUrl` points at the API root (e.g. `http://127.0.0.1:4317/api`). Failures
 * are surfaced to the caller rather than swallowed: a click that silently did
 * nothing is worse than one that reports it failed.
 */
export class HttpRosterActions implements RosterActions {
  constructor(
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async startWork(seatId: string, task: string): Promise<void> {
    await this.post(`/agents/${encodeURIComponent(seatId)}/chat`, { message: task });
  }

  async resolveStuck(seatId: string): Promise<void> {
    // The orchestrator keys escalations by id, not by seat, so the seat's open
    // one has to be looked up first. Resolving "whatever this employee is stuck
    // on" is the office's whole vocabulary here — it has no escalation ids.
    const open = await this.openEscalationId(seatId);
    if (open === null) return;
    await this.post(`/escalations/${open}/resolve`, {});
  }

  private async openEscalationId(seatId: string): Promise<number | null> {
    const response = await this.request('/escalations', 'GET');
    const body: unknown = await response.json();
    const list = (body as { escalations?: unknown })?.escalations;
    if (!Array.isArray(list)) return null;

    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue;
      const item = raw as Record<string, unknown>;
      if (item.agent === seatId && typeof item.id === 'number') return item.id;
    }
    return null;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    await this.request(path, 'POST', body);
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path} failed: HTTP ${response.status}`);
    }
    return response;
  }
}
