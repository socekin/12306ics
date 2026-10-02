import type { EmailKind, ParsedEmail, TicketLine } from './types';

const SUBJECT_RULES: Array<[RegExp, EmailKind]> = [
  [/支付通知/, 'purchase'],
  [/候补订单兑现/, 'waitlist_fulfilled'],
  [/改签|变更到站/, 'rebook'],
  [/退票/, 'refund'],
  [/候补订单退单/, 'waitlist_cancelled'],
];

export function classify(subject: string, text: string): EmailKind {
  for (const [re, kind] of SUBJECT_RULES) {
    if (re.test(subject)) return kind;
  }
  // Body fallbacks, deliberately specific: every 12306 email mentions 退票 in its footer.
  if (/(改签|变更到站)后的车票信息/.test(text)) return 'rebook';
  if (/办理(?:了)?退票|退票信息如下/.test(text)) return 'refund';
  if (/所购车票信息如下|成功购买了/.test(text)) return 'purchase';
  if (/成功兑现了/.test(text)) return 'waitlist_fulfilled';
  return 'unknown';
}

export function extractOrderNo(text: string): string | undefined {
  const m = text.match(/订单号码?\s*[:：]?\s*([A-Z]\d{8,20})/);
  return m?.[1];
}

const pad = (n: string | number): string => String(n).padStart(2, '0');

// Optional passenger prefix, numbered ("1.姓名，", purchase/rebook notices) or bare ("姓名，", refund notices),
// then "2026年09月05日10:12开，" and the rest of the comma separated fields.
const LINE_HEAD =
  /^(?:(?:(\d{1,2})[.．、])?\s*([^，,]+?)[，,]\s*)?(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[:：](\d{2})\s*开[，,]\s*(.+)$/;

export function parseTicketLine(line: string): TicketLine | null {
  const m = LINE_HEAD.exec(line.trim());
  if (!m) return null;
  const [, , passengerRaw, y, mo, d, h, mi, rest] = m;
  const fields = (rest ?? '')
    .replace(/[。.]\s*$/, '')
    .split(/[，,]/)
    .map((f) => f.trim())
    .filter(Boolean);
  const route = fields[0]?.match(/^(.+?)站?\s*[-－—–~]\s*(.+?)站?$/);
  const train = fields[1]?.match(/^([A-Z]?\d{1,5})次(?:列车)?$/);
  if (!route || !train) return null;

  const ticket: TicketLine = {
    passenger: (passengerRaw ?? '').trim(),
    date: `${y}-${pad(mo!)}-${pad(d!)}`,
    departTime: `${pad(h!)}:${mi}`,
    from: route[1]!.trim(),
    to: route[2]!.trim(),
    train: train[1]!,
    seat: '',
    seatType: '',
  };

  for (const field of fields.slice(2)) {
    let mm: RegExpMatchArray | null;
    if ((mm = field.match(/^票价\s*(\d+(?:\.\d+)?)\s*元$/))) ticket.price = Number(mm[1]);
    else if ((mm = field.match(/^检票口\s*(.+)$/))) ticket.gate = mm[1]!.trim();
    else if (/^(成人|儿童|学生|残军|军人|伤残)票$/.test(field)) ticket.ticketType = field;
    else if (/^电子客票$/.test(field)) continue;
    else if (!ticket.seat && /^\d+车/.test(field)) ticket.seat = field;
    else if (!ticket.seatType && /(座|卧|铺|包)$/.test(field)) ticket.seatType = field;
  }
  return ticket;
}

export function parseTickets(text: string): TicketLine[] {
  return text
    .split('\n')
    .map(parseTicketLine)
    .filter((t): t is TicketLine => t !== null);
}

export function parseEmail(subject: string, text: string): ParsedEmail {
  return {
    kind: classify(subject, text),
    orderNo: extractOrderNo(text),
    tickets: parseTickets(text),
  };
}

/** Extract the bare address from "Name <addr>" or "addr". */
export function emailAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}
