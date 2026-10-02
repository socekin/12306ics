/** Payload posted by the Gmail Apps Script (or any other mail source). */
export interface IngestPayload {
  /** Stable message id, used for idempotency. */
  id: string;
  from: string;
  subject: string;
  /** ISO timestamp of the email. */
  date?: string;
  html?: string;
  text?: string;
}

export type EmailKind =
  | 'purchase'
  | 'waitlist_fulfilled'
  | 'rebook'
  | 'refund'
  | 'waitlist_cancelled'
  | 'unknown';

/** One "N.姓名，日期时间开，甲站-乙站，车次，座位，..." line from a 12306 email. */
export interface TicketLine {
  passenger: string;
  /** YYYY-MM-DD, boarding date. */
  date: string;
  /** HH:mm, boarding time. */
  departTime: string;
  /** Station names without the trailing 站. */
  from: string;
  to: string;
  train: string;
  seat: string;
  seatType: string;
  ticketType?: string;
  price?: number;
  gate?: string;
}

export interface ParsedEmail {
  kind: EmailKind;
  orderNo?: string;
  tickets: TicketLine[];
}

export interface Ticket {
  passenger: string;
  seat: string;
  seatType: string;
  ticketType?: string;
  price?: number;
  orderNo?: string;
  /** Free-form remark shown in the event description (e.g. unmatched rebooking). */
  note?: string;
}

/** A trip is one train ride on one day; several passengers share one calendar event. */
export interface Trip {
  /** date|train|from|to */
  key: string;
  /** Deterministic iCalendar UID derived from key. */
  uid: string;
  date: string;
  departTime: string;
  arriveTime: string;
  /** Days between boarding date and arrival date (0 for same day). */
  arriveDayOffset: number;
  /** True when arrival could not be queried and was estimated. */
  arrivalEstimated: boolean;
  from: string;
  to: string;
  train: string;
  gate?: string;
  tickets: Ticket[];
  /** iCalendar SEQUENCE, bumped on every update. */
  sequence: number;
  /** Set when the last CalDAV push failed; retried by the cron job. */
  pendingPush?: boolean;
  createdAt: string;
  updatedAt: string;
  sourceIds: string[];
}

export interface Env {
  STORE: KVNamespace;
  INGEST_TOKEN: string;
  CALENDAR_TOKEN: string;
  ALLOWED_SENDERS?: string;
  CALDAV_URL?: string;
  CALDAV_USERNAME?: string;
  CALDAV_PASSWORD?: string;
  CALDAV_CALENDAR_NAME?: string;
  /** Optional: skip discovery and write directly to this collection URL. */
  CALDAV_CALENDAR_URL?: string;
  ALARM_MINUTES?: string;
  /** Optional verified Email Routing destination that receives a copy of every routed email. */
  ARCHIVE_TO?: string;
}
