import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRosterActions } from '../src/rosterActions.js';

const OK = (body: unknown = {}) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

describe('HttpRosterActions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const actions = (token?: string) => new HttpRosterActions('http://host/api', token);

  describe('startWork', () => {
    it('sends the job to the orchestrator, which decides how to run it', async () => {
      fetchMock.mockResolvedValue(OK());

      await actions().startWork('shipper', 'fix the map pins');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://host/api/agents/shipper/chat',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ message: 'fix the map pins' }),
        }),
      );
    });

    it('escapes a seat id so it cannot alter the path', async () => {
      fetchMock.mockResolvedValue(OK());

      await actions().startWork('../pause', 'x');

      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://host/api/agents/..%2Fpause/chat');
    });

    it('sends the bearer token when configured', async () => {
      fetchMock.mockResolvedValue(OK());

      await actions('tok').startWork('shipper', 'x');

      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer tok' });
    });

    it('reports a failure rather than silently doing nothing', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 } as Response);

      await expect(actions().startWork('shipper', 'x')).rejects.toThrow(/500/);
    });
  });

  describe('resolveStuck', () => {
    it('finds the seat’s open escalation and resolves it by id', async () => {
      fetchMock
        .mockResolvedValueOnce(
          OK({
            escalations: [
              { id: 7, agent: 'ops' },
              { id: 9, agent: 'shipper' },
            ],
          }),
        )
        .mockResolvedValueOnce(OK());

      await actions().resolveStuck('shipper');

      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://host/api/escalations');
      expect(fetchMock.mock.calls[1]?.[0]).toBe('http://host/api/escalations/9/resolve');
    });

    it('does nothing when the seat has no open escalation', async () => {
      fetchMock.mockResolvedValue(OK({ escalations: [{ id: 7, agent: 'ops' }] }));

      await actions().resolveStuck('shipper');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('resolves the first open escalation when a seat has several', async () => {
      fetchMock
        .mockResolvedValueOnce(
          OK({
            escalations: [
              { id: 3, agent: 'shipper' },
              { id: 4, agent: 'shipper' },
            ],
          }),
        )
        .mockResolvedValueOnce(OK());

      await actions().resolveStuck('shipper');

      expect(fetchMock.mock.calls[1]?.[0]).toBe('http://host/api/escalations/3/resolve');
    });

    it('tolerates a malformed escalation list', async () => {
      fetchMock.mockResolvedValue(OK({ escalations: 'nope' }));

      await expect(actions().resolveStuck('shipper')).resolves.toBeUndefined();
    });

    it('ignores entries with no numeric id', async () => {
      fetchMock.mockResolvedValue(OK({ escalations: [{ id: 'nine', agent: 'shipper' }] }));

      await actions().resolveStuck('shipper');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('reports a failed lookup', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);

      await expect(actions().resolveStuck('shipper')).rejects.toThrow(/401/);
    });
  });
});
