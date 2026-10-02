import { cnToUtc, icsUtc } from './time';
import type { Trip } from './types';

export function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545 line folding: at most 75 octets per physical line, continuation lines start with a space. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > 75) {
      out.push(cur);
      cur = ' ' + ch;
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}

export function tripSummary(trip: Trip): string {
  return `${trip.train} ${trip.from} → ${trip.to}`;
}

export function tripDescription(trip: Trip): string {
  const lines: string[] = [];
  for (const t of trip.tickets) {
    const parts = [t.seat, t.seatType, t.ticketType, t.price !== undefined ? `${t.price}元` : undefined].filter(Boolean);
    lines.push(`${t.passenger || '乘客'}：${parts.join('，')}${t.note ? `（${t.note}）` : ''}`);
  }
  if (trip.gate) lines.push(`检票口：${trip.gate}`);
  const orders = [...new Set(trip.tickets.map((t) => t.orderNo).filter(Boolean))];
  if (orders.length) lines.push(`订单号：${orders.join('、')}`);
  lines.push(`到达：${trip.arriveTime}${trip.arriveDayOffset > 0 ? `（+${trip.arriveDayOffset}天）` : ''}${trip.arrivalEstimated ? '，预估' : ''}`);
  return lines.join('\n');
}

export interface EventOptions {
  dtstamp: Date;
  alarmMinutes?: number;
}

/** Build the VEVENT lines (unfolded) for a trip. */
export function tripEvent(trip: Trip, opts: EventOptions): string[] {
  const start = cnToUtc(trip.date, trip.departTime);
  let end = cnToUtc(trip.date, trip.arriveTime, trip.arriveDayOffset);
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  const lines = [
    'BEGIN:VEVENT',
    `UID:${trip.uid}`,
    `DTSTAMP:${icsUtc(opts.dtstamp)}`,
    `DTSTART:${icsUtc(start)}`,
    `DTEND:${icsUtc(end)}`,
    `SEQUENCE:${trip.sequence}`,
    `SUMMARY:${escapeText(tripSummary(trip))}`,
    `LOCATION:${escapeText(`${trip.from}站`)}`,
    `DESCRIPTION:${escapeText(tripDescription(trip))}`,
  ];
  if (opts.alarmMinutes && opts.alarmMinutes > 0) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeText(tripSummary(trip))}`,
      `TRIGGER:-PT${Math.round(opts.alarmMinutes)}M`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

export interface CalendarOptions {
  name?: string;
  /** Include METHOD:PUBLISH. Must be false for CalDAV PUT (RFC 4791 §4.1). */
  publish?: boolean;
}

export function calendarDocument(events: string[][], opts: CalendarOptions = {}): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//12306ics//EN', 'CALSCALE:GREGORIAN'];
  if (opts.publish) lines.push('METHOD:PUBLISH');
  if (opts.name) lines.push(`X-WR-CALNAME:${escapeText(opts.name)}`, 'X-WR-TIMEZONE:Asia/Shanghai');
  for (const ev of events) lines.push(...ev);
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
