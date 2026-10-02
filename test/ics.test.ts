import { describe, expect, it } from 'vitest';
import { calendarDocument, escapeText, foldLine, tripEvent } from '../src/ics';
import { cnToUtc, addMinutes, todayCn } from '../src/time';
import type { Trip } from '../src/types';

const trip: Trip = {
  key: '2026-09-05|G7507|上海虹桥|宁波',
  uid: 'abc@12306ics',
  date: '2026-09-05',
  departTime: '10:12',
  arriveTime: '12:07',
  arriveDayOffset: 0,
  arrivalEstimated: false,
  from: '上海虹桥',
  to: '宁波',
  train: 'G7507',
  gate: '9A9B',
  tickets: [
    { passenger: '乘客甲', seat: '10车9D号', seatType: '二等座', ticketType: '成人票', price: 159, orderNo: 'E200000004' },
    { passenger: '乘客乙', seat: '10车9F号', seatType: '二等座', ticketType: '成人票', price: 159, orderNo: 'E200000004', note: '改签，未匹配到原行程' },
  ],
  sequence: 2,
  createdAt: '2026-09-03T02:04:11.000Z',
  updatedAt: '2026-09-03T02:04:11.000Z',
  sourceIds: ['m1'],
};

describe('time', () => {
  it('converts Asia/Shanghai to UTC with day offsets', () => {
    expect(cnToUtc('2026-09-05', '10:12').toISOString()).toBe('2026-09-05T02:12:00.000Z');
    expect(cnToUtc('2026-09-05', '06:30', 1).toISOString()).toBe('2026-09-05T22:30:00.000Z');
    expect(cnToUtc('2026-12-31', '23:30', 1).toISOString()).toBe('2027-01-01T15:30:00.000Z');
  });
  it('adds minutes with rollover', () => {
    expect(addMinutes('23:30', 120)).toEqual({ time: '01:30', dayOffset: 1 });
    expect(addMinutes('10:12', 120)).toEqual({ time: '12:12', dayOffset: 0 });
  });
  it('computes today in Shanghai', () => {
    expect(todayCn(new Date('2026-09-03T17:00:00Z'))).toBe('2026-09-04');
  });
});

describe('ics formatting', () => {
  it('escapes text values', () => {
    expect(escapeText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });
  it('folds long lines at 75 octets without splitting multibyte characters', () => {
    const line = 'DESCRIPTION:' + '乘客甲：10车9D号，二等座，成人票，159元'.repeat(4);
    const folded = foldLine(line);
    const enc = new TextEncoder();
    for (const physical of folded.split('\r\n')) expect(enc.encode(physical).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
  it('renders a VEVENT with UTC times, sequence and alarm', () => {
    const lines = tripEvent(trip, { dtstamp: new Date('2026-09-03T04:00:00Z'), alarmMinutes: 60 });
    expect(lines).toContain('DTSTART:20260905T021200Z');
    expect(lines).toContain('DTEND:20260905T040700Z');
    expect(lines).toContain('SEQUENCE:2');
    expect(lines).toContain('SUMMARY:G7507 上海虹桥 → 宁波');
    expect(lines).toContain('LOCATION:上海虹桥站');
    expect(lines).toContain('TRIGGER:-PT60M');
    const desc = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(desc).toContain('乘客甲：10车9D号\\，二等座\\，成人票\\，159元'.replace(/\\，/g, '，'));
    expect(desc).toContain('（改签\\，未匹配到原行程）'.replace('\\，', '，'));
    expect(desc).toContain('检票口：9A9B');
    expect(desc).toContain('订单号：E200000004');
  });
  it('spans midnight for overnight arrivals and never ends before it starts', () => {
    const overnight = { ...trip, departTime: '23:50', arriveTime: '06:10', arriveDayOffset: 1 };
    const lines = tripEvent(overnight, { dtstamp: new Date() });
    expect(lines).toContain('DTSTART:20260905T155000Z');
    expect(lines).toContain('DTEND:20260905T221000Z');
    const broken = { ...trip, arriveTime: '09:00', arriveDayOffset: 0 };
    const l2 = tripEvent(broken, { dtstamp: new Date() });
    expect(l2).toContain('DTEND:20260905T041200Z');
  });
  it('omits METHOD for CalDAV documents and includes it for feeds', () => {
    const ev = tripEvent(trip, { dtstamp: new Date() });
    expect(calendarDocument([ev])).not.toContain('METHOD:');
    const feed = calendarDocument([ev], { name: '12306 车票', publish: true });
    expect(feed).toContain('METHOD:PUBLISH');
    expect(feed).toContain('X-WR-CALNAME:12306 车票');
    expect(feed.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
