import { describe, expect, it } from 'vitest';
import { parseEmail } from '../src/parse';
import { htmlToText } from '../src/text';
import { applyEmail, maintain, REBOOK_UNMATCHED_NOTE, tripKey } from '../src/trip';
import type { ParsedEmail } from '../src/types';
import { fixture, world } from './helpers';

const parsed = (name: string): ParsedEmail => {
  const f = fixture(name);
  return parseEmail(f.subject, htmlToText(f.html));
};

const G7507 = '2026-09-05|G7507|上海虹桥|宁波';
const G7516 = '2026-07-19|G7516|宁波|上海虹桥';
const D3102 = '2026-07-19|D3102|宁波|上海虹桥';

describe('purchase', () => {
  it('creates one trip with two tickets and pushes one event', async () => {
    const w = world();
    const r = await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    expect(r.upserted).toEqual([G7507]);
    expect(r.deleted).toEqual([]);
    expect(r.warnings).toEqual([]);
    const trip = (await w.store.getTrip(G7507))!;
    expect(trip.tickets.map((t) => t.passenger)).toEqual(['乘客甲', '乘客乙']);
    expect(trip.arriveTime).toBe('12:00');
    expect(trip.arrivalEstimated).toBe(false);
    expect(trip.gate).toBe('9A9B');
    expect(trip.sequence).toBe(0);
    expect(w.lookups).toHaveLength(1);
    expect(w.caldav.puts).toHaveLength(1);
    expect(w.caldav.puts[0]!.uid).toBe(trip.uid);
    expect(w.caldav.puts[0]!.ics).toContain('SUMMARY:G7507 上海虹桥 → 宁波');
  });

  it('is idempotent: processing the same tickets again does not duplicate anything', async () => {
    const w = world();
    await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    const r = await applyEmail(parsed('purchase-2'), 'm1-again', w.deps);
    expect(r.upserted).toEqual([G7507]);
    const trips = await w.store.listTrips();
    expect(trips).toHaveLength(1);
    expect(trips[0]!.tickets).toHaveLength(2);
    expect(trips[0]!.sequence).toBe(1);
    expect(w.caldav.puts.map((p) => p.uid)).toEqual([trips[0]!.uid, trips[0]!.uid]);
    expect(w.lookups).toHaveLength(1);
  });

  it('falls back to an estimated arrival when lookup fails', async () => {
    const w = world(() => null);
    await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    const trip = (await w.store.getTrip(G7507))!;
    expect(trip.arrivalEstimated).toBe(true);
    expect(trip.arriveTime).toBe('12:12');
    expect(w.caldav.puts[0]!.ics).toContain('预估');
  });

  it('handles waitlist fulfilment like a purchase', async () => {
    const w = world();
    const r = await applyEmail(parsed('waitlist-fulfilled'), 'm1', w.deps);
    expect(r.upserted).toEqual(['2026-07-18|D3125|上海虹桥|宁波']);
  });
});

describe('rebook', () => {
  it('moves both passengers from the original trip to the new one and deletes the empty trip', async () => {
    const w = world();
    await applyEmail(parsed('purchase'), 'm1', w.deps);
    const oldUid = (await w.store.getTrip(G7516))!.uid;
    const r = await applyEmail(parsed('rebook'), 'm2', w.deps);
    expect(r.deleted).toEqual([G7516]);
    expect(r.upserted).toEqual([D3102]);
    expect(r.warnings).toEqual([]);
    expect(await w.store.getTrip(G7516)).toBeNull();
    const trip = (await w.store.getTrip(D3102))!;
    expect(trip.tickets).toHaveLength(2);
    expect(trip.tickets.every((t) => t.note === undefined)).toBe(true);
    expect(w.caldav.deletes).toEqual([oldUid]);
  });

  it('keeps the other passenger when only one ticket is rebooked', async () => {
    const w = world();
    await applyEmail(parsed('purchase'), 'm1', w.deps);
    const one = parsed('rebook');
    one.tickets = one.tickets.slice(0, 1);
    const r = await applyEmail(one, 'm2', w.deps);
    expect(r.deleted).toEqual([]);
    expect(r.upserted.sort()).toEqual([G7516, D3102].sort());
    expect((await w.store.getTrip(G7516))!.tickets.map((t) => t.passenger)).toEqual(['乘客乙']);
    expect((await w.store.getTrip(D3102))!.tickets.map((t) => t.passenger)).toEqual(['乘客甲']);
  });

  it('flags tickets whose original trip is unknown', async () => {
    const w = world();
    const r = await applyEmail(parsed('rebook'), 'm2', w.deps);
    expect(r.warnings).toHaveLength(2);
    const trip = (await w.store.getTrip(D3102))!;
    expect(trip.tickets.every((t) => t.note === REBOOK_UNMATCHED_NOTE)).toBe(true);
    expect(w.caldav.puts[0]!.ics).toContain(REBOOK_UNMATCHED_NOTE);
  });

  it('falls back to passenger + route matching when the order number is missing', async () => {
    const w = world();
    await applyEmail(parsed('purchase'), 'm1', w.deps);
    const noOrder = { ...parsed('rebook'), orderNo: undefined };
    // The fixture trip is in the past relative to deps.now(); move the clock back so it counts as upcoming.
    w.deps.now = () => new Date('2026-07-18T10:00:00Z');
    const r = await applyEmail(noOrder, 'm2', w.deps);
    expect(r.deleted).toEqual([G7516]);
    expect(r.warnings).toEqual([]);
  });

  it('is safe to retry after a partial failure', async () => {
    const w = world();
    await applyEmail(parsed('purchase'), 'm1', w.deps);
    await applyEmail(parsed('rebook'), 'm2', w.deps);
    const r = await applyEmail(parsed('rebook'), 'm2', w.deps);
    expect(r.warnings).toEqual([]);
    expect((await w.store.getTrip(D3102))!.tickets.every((t) => t.note === undefined)).toBe(true);
    expect(await w.store.listTrips()).toHaveLength(1);
  });
});

describe('refund', () => {
  const refundLine = (passenger: string): ParsedEmail => {
    const p = parsed('purchase-2');
    return { kind: 'refund', orderNo: p.orderNo, tickets: p.tickets.filter((t) => t.passenger === passenger) };
  };

  it('removes one passenger and keeps the event alive', async () => {
    const w = world();
    await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    const r = await applyEmail(refundLine('乘客乙'), 'm2', w.deps);
    expect(r.upserted).toEqual([G7507]);
    const trip = (await w.store.getTrip(G7507))!;
    expect(trip.tickets.map((t) => t.passenger)).toEqual(['乘客甲']);
    expect(trip.sequence).toBe(1);
  });

  it('deletes the event once the last ticket is refunded', async () => {
    const w = world();
    await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    await applyEmail(refundLine('乘客乙'), 'm2', w.deps);
    const r = await applyEmail(refundLine('乘客甲'), 'm3', w.deps);
    expect(r.deleted).toEqual([G7507]);
    expect(await w.store.listTrips()).toHaveLength(0);
    expect(w.caldav.deletes).toHaveLength(1);
  });

  it('falls back to the order number when the notice has no ticket lines', async () => {
    const w = world();
    await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    await applyEmail(parsed('purchase'), 'm2', w.deps);
    const r = await applyEmail({ kind: 'refund', orderNo: parsed('purchase-2').orderNo, tickets: [] }, 'm3', w.deps);
    expect(r.deleted).toEqual([G7507]);
    expect(await w.store.getTrip(G7516)).not.toBeNull();
  });

  it('applies a real refund notice: removes only the refunded passenger of a two-passenger order', async () => {
    const w = world();
    const refund = parsed('refund');
    const line = refund.tickets[0]!;
    const purchase: ParsedEmail = {
      kind: 'purchase',
      orderNo: refund.orderNo,
      tickets: [line, { ...line, passenger: '乘客乙', seat: '1车2D号' }],
    };
    await applyEmail(purchase, 'm1', w.deps);
    const r = await applyEmail(refund, 'm2', w.deps);
    expect(r.warnings).toEqual([]);
    const key = '2026-02-10|G896|南昌东|上海虹桥';
    expect(r.upserted).toEqual([key]);
    expect((await w.store.getTrip(key))!.tickets.map((t) => t.passenger)).toEqual(['乘客乙']);
  });

  it('warns instead of failing when nothing matches', async () => {
    const w = world();
    const r = await applyEmail(refundLine('乘客甲'), 'm1', w.deps);
    expect(r.warnings[0]).toMatch(/trip not found/);
  });
});

describe('resilience and maintenance', () => {
  it('keeps the trip and marks it for retry when CalDAV is down, then recovers via maintain()', async () => {
    const w = world();
    w.caldav.failPut = true;
    const r = await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    expect(r.warnings[0]).toMatch(/CalDAV push failed/);
    expect((await w.store.getTrip(G7507))!.pendingPush).toBe(true);

    w.caldav.failPut = false;
    const m = await maintain(w.deps);
    expect(m.pushed).toEqual([G7507]);
    expect((await w.store.getTrip(G7507))!.pendingPush).toBeUndefined();
    expect(w.caldav.puts).toHaveLength(1);
  });

  it('re-queries estimated arrivals for upcoming trips', async () => {
    let calls = 0;
    const w = world(() => (calls++ === 0 ? null : { arriveTime: '12:07', dayOffset: 0, trainNo: 'x' }));
    await applyEmail(parsed('purchase-2'), 'm1', w.deps);
    const m = await maintain(w.deps);
    expect(m.refreshed).toEqual([G7507]);
    const trip = (await w.store.getTrip(G7507))!;
    expect(trip.arrivalEstimated).toBe(false);
    expect(trip.arriveTime).toBe('12:07');
    expect(trip.sequence).toBe(1);
  });

  it('tripKey is stable', () => {
    expect(tripKey({ date: '2026-09-05', train: 'G7507', from: '上海虹桥', to: '宁波' })).toBe(G7507);
  });
});
