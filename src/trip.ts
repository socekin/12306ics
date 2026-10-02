import type { CalDav } from './caldav';
import { calendarDocument, tripEvent } from './ics';
import type { Store } from './store';
import { addMinutes, todayCn } from './time';
import type { ArrivalInfo, LookupQuery } from './train';
import type { EmailKind, ParsedEmail, Ticket, TicketLine, Trip } from './types';

export interface ApplyDeps {
  store: Store;
  caldav: CalDav | null;
  lookup: (q: LookupQuery) => Promise<ArrivalInfo | null>;
  now: () => Date;
  alarmMinutes?: number;
}

export interface ApplyResult {
  kind: EmailKind;
  orderNo?: string;
  upserted: string[];
  deleted: string[];
  warnings: string[];
}

export const REBOOK_UNMATCHED_NOTE = '改签，未匹配到原行程';
const ESTIMATED_DURATION_MIN = 120;

export function tripKey(t: { date: string; train: string; from: string; to: string }): string {
  return `${t.date}|${t.train}|${t.from}|${t.to}`;
}

export async function tripUid(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 24)}@12306ics`;
}

/** Identity of a ticket inside a trip: one passenger holds at most one ticket per train. */
const ticketId = (t: { passenger: string; seat: string }): string => t.passenger || t.seat;

async function newTrip(line: TicketLine, deps: ApplyDeps): Promise<Trip> {
  const arrival = await deps.lookup({ train: line.train, date: line.date, from: line.from, to: line.to, departTime: line.departTime });
  const estimated = arrival === null;
  const fallback = addMinutes(line.departTime, ESTIMATED_DURATION_MIN);
  const now = deps.now().toISOString();
  const key = tripKey(line);
  return {
    key,
    uid: await tripUid(key),
    date: line.date,
    departTime: line.departTime,
    arriveTime: arrival?.arriveTime ?? fallback.time,
    arriveDayOffset: arrival?.dayOffset ?? fallback.dayOffset,
    arrivalEstimated: estimated,
    from: line.from,
    to: line.to,
    train: line.train,
    gate: line.gate,
    tickets: [],
    sequence: 0,
    createdAt: now,
    updatedAt: now,
    sourceIds: [],
  };
}

/** Render a trip and push it to CalDAV, flagging it for retry on failure. */
export async function pushTrip(trip: Trip, deps: ApplyDeps, warnings: string[]): Promise<void> {
  if (!deps.caldav) return;
  const ics = calendarDocument([tripEvent(trip, { dtstamp: deps.now(), alarmMinutes: deps.alarmMinutes })]);
  try {
    await deps.caldav.putEvent(trip.uid, ics);
    if (trip.pendingPush) {
      delete trip.pendingPush;
      await deps.store.putTrip(trip);
    }
  } catch (e) {
    trip.pendingPush = true;
    await deps.store.putTrip(trip);
    warnings.push(`CalDAV push failed for ${trip.key}: ${(e as Error).message}`);
  }
}

async function deleteRemote(trip: Trip, deps: ApplyDeps, warnings: string[]): Promise<void> {
  if (!deps.caldav) return;
  try {
    await deps.caldav.deleteEvent(trip.uid);
  } catch (e) {
    await deps.store.addTombstone(trip.uid);
    warnings.push(`CalDAV delete failed for ${trip.key}: ${(e as Error).message}`);
  }
}

class Session {
  /** Trips touched in this session, keyed by trip key. */
  readonly touched = new Map<string, Trip>();
  readonly existing = new Set<string>();
  readonly result: ApplyResult;

  constructor(readonly parsed: ParsedEmail, readonly messageId: string, readonly deps: ApplyDeps) {
    this.result = { kind: parsed.kind, orderNo: parsed.orderNo, upserted: [], deleted: [], warnings: [] };
  }

  warn(msg: string): void {
    this.result.warnings.push(msg);
  }

  async load(key: string): Promise<Trip | null> {
    const cached = this.touched.get(key);
    if (cached) return cached;
    const trip = await this.deps.store.getTrip(key);
    if (trip) {
      this.existing.add(key);
      this.touched.set(key, trip);
    }
    return trip;
  }

  async loadAll(): Promise<Trip[]> {
    const trips = await this.deps.store.listTrips();
    return trips.map((t) => {
      const cached = this.touched.get(t.key);
      if (cached) return cached;
      this.existing.add(t.key);
      this.touched.set(t.key, t);
      return t;
    });
  }

  async addTickets(lines: TicketLine[], noteFor: (line: TicketLine) => string | undefined = () => undefined): Promise<void> {
    const groups = new Map<string, TicketLine[]>();
    for (const line of lines) {
      const key = tripKey(line);
      groups.set(key, [...(groups.get(key) ?? []), line]);
    }
    for (const [key, group] of groups) {
      let trip = await this.load(key);
      if (!trip) {
        trip = await newTrip(group[0]!, this.deps);
        this.touched.set(key, trip);
      }
      for (const line of group) {
        const ticket: Ticket = {
          passenger: line.passenger,
          seat: line.seat,
          seatType: line.seatType,
          ticketType: line.ticketType,
          price: line.price,
          orderNo: this.parsed.orderNo,
          note: noteFor(line),
        };
        const idx = trip.tickets.findIndex((t) => ticketId(t) === ticketId(ticket));
        if (idx >= 0) trip.tickets[idx] = ticket;
        else trip.tickets.push(ticket);
        if (line.gate) trip.gate = line.gate;
      }
      if (!trip.sourceIds.includes(this.messageId)) trip.sourceIds.push(this.messageId);
    }
  }

  /** Remove tickets matching `pred` from every trip; returns how many were removed. */
  async removeWhere(trips: Trip[], pred: (t: Ticket, trip: Trip) => boolean): Promise<number> {
    let removed = 0;
    for (const trip of trips) {
      const before = trip.tickets.length;
      trip.tickets = trip.tickets.filter((t) => !pred(t, trip));
      if (trip.tickets.length !== before) {
        removed += before - trip.tickets.length;
        if (!trip.sourceIds.includes(this.messageId)) trip.sourceIds.push(this.messageId);
        this.touched.set(trip.key, trip);
      }
    }
    return removed;
  }

  async refund(): Promise<void> {
    const { parsed } = this;
    if (parsed.tickets.length > 0) {
      for (const line of parsed.tickets) {
        const trip = await this.load(tripKey(line));
        if (!trip) {
          this.warn(`refund: trip not found for ${tripKey(line)}`);
          continue;
        }
        const n = await this.removeWhere([trip], (t) =>
          line.passenger ? t.passenger === line.passenger : line.seat ? t.seat === line.seat : parsed.orderNo ? t.orderNo === parsed.orderNo : true,
        );
        if (n === 0) this.warn(`refund: no matching ticket in ${trip.key}`);
      }
      return;
    }
    if (!parsed.orderNo) {
      this.warn('refund: neither ticket lines nor order number found');
      return;
    }
    const n = await this.removeWhere(await this.loadAll(), (t) => t.orderNo === parsed.orderNo);
    if (n === 0) this.warn(`refund: no ticket found for order ${parsed.orderNo}`);
  }

  async rebook(): Promise<void> {
    const { parsed } = this;
    const all = await this.loadAll();
    const unmatched = new Set<TicketLine>();
    for (const line of parsed.tickets) {
      const target = this.touched.get(tripKey(line));
      // Already applied (retry after a partial failure): the new trip holds this passenger under the same order.
      if (target?.tickets.some((t) => ticketId(t) === ticketId(line) && t.orderNo === parsed.orderNo && t.seat === line.seat)) continue;

      let n = 0;
      if (parsed.orderNo) {
        // 12306 keeps the original order number on the rebooking notice, so this is an exact match.
        n = await this.removeWhere(all, (t) => t.passenger === line.passenger && t.orderNo === parsed.orderNo);
      }
      if (n === 0) {
        // Fallback: same passenger, same route, not yet departed; prefer the trip closest to the new date.
        const today = todayCn(this.deps.now());
        const candidates = all
          .filter((trip) => trip.key !== tripKey(line) && trip.from === line.from && trip.to === line.to && trip.date >= today)
          .filter((trip) => trip.tickets.some((t) => t.passenger === line.passenger))
          .sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(line.date)) - Math.abs(Date.parse(b.date) - Date.parse(line.date)));
        const pick = candidates[0];
        if (pick) n = await this.removeWhere([pick], (t) => t.passenger === line.passenger);
      }
      if (n === 0) unmatched.add(line);
    }
    await this.addTickets(parsed.tickets, (line) => (unmatched.has(line) ? REBOOK_UNMATCHED_NOTE : undefined));
    for (const line of unmatched) this.warn(`rebook: original trip not found for ${line.passenger} (${parsed.orderNo ?? 'no order'})`);
  }

  async commit(): Promise<ApplyResult> {
    const now = this.deps.now().toISOString();
    for (const [key, trip] of this.touched) {
      if (trip.tickets.length === 0) {
        await this.deps.store.deleteTrip(key);
        await deleteRemote(trip, this.deps, this.result.warnings);
        this.result.deleted.push(key);
        continue;
      }
      if (!trip.sourceIds.includes(this.messageId)) continue; // loaded but untouched
      if (this.existing.has(key)) trip.sequence += 1;
      trip.updatedAt = now;
      await this.deps.store.putTrip(trip);
      await pushTrip(trip, this.deps, this.result.warnings);
      this.result.upserted.push(key);
    }
    return this.result;
  }
}

export async function applyEmail(parsed: ParsedEmail, messageId: string, deps: ApplyDeps): Promise<ApplyResult> {
  const s = new Session(parsed, messageId, deps);
  switch (parsed.kind) {
    case 'purchase':
    case 'waitlist_fulfilled':
      await s.addTickets(parsed.tickets);
      break;
    case 'rebook':
      await s.rebook();
      break;
    case 'refund':
      await s.refund();
      break;
    default:
      return s.result;
  }
  return s.commit();
}

/** Cron job: retry failed pushes/deletes and upgrade estimated arrivals for upcoming trips. */
export async function maintain(deps: ApplyDeps): Promise<{ pushed: string[]; refreshed: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const pushed: string[] = [];
  const refreshed: string[] = [];
  const today = todayCn(deps.now());

  for (const trip of await deps.store.listTrips()) {
    let changed = false;
    if (trip.arrivalEstimated && trip.date >= today) {
      const arrival = await deps.lookup({ train: trip.train, date: trip.date, from: trip.from, to: trip.to, departTime: trip.departTime });
      if (arrival) {
        trip.arriveTime = arrival.arriveTime;
        trip.arriveDayOffset = arrival.dayOffset;
        trip.arrivalEstimated = false;
        trip.sequence += 1;
        trip.updatedAt = deps.now().toISOString();
        await deps.store.putTrip(trip);
        refreshed.push(trip.key);
        changed = true;
      }
    }
    if (changed || trip.pendingPush) {
      await pushTrip(trip, deps, warnings);
      if (!trip.pendingPush) pushed.push(trip.key);
    }
  }

  if (deps.caldav) {
    for (const uid of await deps.store.listTombstones()) {
      try {
        await deps.caldav.deleteEvent(uid);
        await deps.store.removeTombstone(uid);
      } catch (e) {
        warnings.push(`tombstone delete failed for ${uid}: ${(e as Error).message}`);
      }
    }
  }
  return { pushed, refreshed, warnings };
}
