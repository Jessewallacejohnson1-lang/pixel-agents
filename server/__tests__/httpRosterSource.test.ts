import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRosterSource } from '../src/httpRosterSource.js';

const OK = (body: unknown) =>
  ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;

describe('HttpRosterSource', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warn.mockRestore();
  });

  it('reads seats from the orchestrator', async () => {
    fetchMock.mockResolvedValue(
      OK({
        seats: [
          { id: 'shipper', title: 'Engineer', reportsTo: 'ops', state: 'idle' },
          { id: 'ops', title: 'Chief of staff', reportsTo: null, state: 'working', activity: 'x' },
        ],
      }),
    );

    const seats = await new HttpRosterSource('http://host/seats').listSeats();

    expect(seats).toEqual([
      { id: 'shipper', title: 'Engineer', reportsTo: 'ops', state: 'idle', activity: undefined },
      { id: 'ops', title: 'Chief of staff', reportsTo: null, state: 'working', activity: 'x' },
    ]);
  });

  it('sends a bearer token when one is configured', async () => {
    fetchMock.mockResolvedValue(OK({ seats: [] }));

    await new HttpRosterSource('http://host/seats', 'tok').listSeats();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://host/seats',
      expect.objectContaining({ headers: { Authorization: 'Bearer tok' } }),
    );
  });

  it('drops a seat with no usable id instead of seating a nameless desk', async () => {
    fetchMock.mockResolvedValue(
      OK({
        seats: [
          { title: 'Nobody', state: 'idle' },
          { id: 'ok', state: 'idle' },
        ],
      }),
    );

    const seats = await new HttpRosterSource('http://host/seats').listSeats();

    expect(seats.map((s) => s.id)).toEqual(['ok']);
  });

  it('drops a seat whose state it does not recognize', async () => {
    fetchMock.mockResolvedValue(
      OK({
        seats: [
          { id: 'a', state: 'vibing' },
          { id: 'b', state: 'idle' },
        ],
      }),
    );

    const seats = await new HttpRosterSource('http://host/seats').listSeats();

    expect(seats.map((s) => s.id)).toEqual(['b']);
  });

  it('falls back to the seat id when no title is given', async () => {
    fetchMock.mockResolvedValue(OK({ seats: [{ id: 'shipper', state: 'idle' }] }));

    const seats = await new HttpRosterSource('http://host/seats').listSeats();

    expect(seats[0]?.title).toBe('shipper');
  });

  describe('when the orchestrator is unavailable', () => {
    it('keeps the last known roster rather than emptying every desk', async () => {
      const source = new HttpRosterSource('http://host/seats');
      fetchMock.mockResolvedValue(OK({ seats: [{ id: 'shipper', state: 'idle' }] }));
      await source.listSeats();

      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const seats = await source.listSeats();

      expect(seats.map((s) => s.id)).toEqual(['shipper']);
    });

    it('returns nothing when it never succeeded', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await new HttpRosterSource('http://host/seats').listSeats()).toEqual([]);
    });

    it('treats a non-2xx response as unavailable', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);

      expect(await new HttpRosterSource('http://host/seats').listSeats()).toEqual([]);
    });

    it('treats a malformed body as unavailable', async () => {
      fetchMock.mockResolvedValue(OK({ nope: true }));

      expect(await new HttpRosterSource('http://host/seats').listSeats()).toEqual([]);
    });

    it('never throws — a failed poll must not kill the loop', async () => {
      fetchMock.mockRejectedValue(new Error('boom'));

      await expect(new HttpRosterSource('http://host/seats').listSeats()).resolves.toEqual([]);
    });

    it('warns once per outage, not once per poll', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const source = new HttpRosterSource('http://host/seats');

      await source.listSeats();
      await source.listSeats();
      await source.listSeats();

      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('speaks up again during a long outage, so stale seats are never silent', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const source = new HttpRosterSource('http://host/seats');

      // 30 polls at the default 2s interval is about a minute of staleness.
      for (let i = 0; i < 30; i++) await source.listSeats();

      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]?.[0]).toMatch(/stale/i);
    });

    it('says when the roster comes back', async () => {
      const source = new HttpRosterSource('http://host/seats');
      fetchMock.mockRejectedValue(new Error('down'));
      await source.listSeats();

      fetchMock.mockResolvedValue(OK({ seats: [] }));
      await source.listSeats();

      expect(warn.mock.calls[1]?.[0]).toMatch(/back/i);
    });

    it('warns again after recovering and failing anew', async () => {
      const source = new HttpRosterSource('http://host/seats');
      fetchMock.mockRejectedValue(new Error('down'));
      await source.listSeats();

      fetchMock.mockResolvedValue(OK({ seats: [] }));
      await source.listSeats();

      fetchMock.mockRejectedValue(new Error('down again'));
      await source.listSeats();

      // down, back, down again — each transition is worth saying out loud.
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[2]?.[0]).toMatch(/unavailable/i);
    });
  });
});
