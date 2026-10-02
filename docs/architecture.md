# Architecture

## Overview

```
mail source ─┬─ Cloudflare Email Routing ─▶ email()  ─┐
             └─ Gmail Apps Script ─▶ POST /ingest  ───┤
                                                      ▼
                                                  ingest()
                                   parse ─▶ apply to trips ─▶ KV ─▶ CalDAV
                                                      │
                                   GET /calendar.ics ◀┘     scheduled() ─▶ maintain()
```

The Worker has three entry points in [`src/index.ts`](../src/index.ts): `email()` for Email Routing,
`fetch()` for the HTTP API, and `scheduled()` for the nightly cron. Both mail paths produce the same
`IngestPayload` and share one pipeline.

## Source layout

```
src/
  index.ts    fetch() router, email() handler, scheduled() cron; ingest() pipeline
  email.ts    raw MIME → IngestPayload (postal-mime), Message-ID normalisation
  text.ts     HTML → plain text, one block element per line
  parse.ts    subject → EmailKind, ticket line parser, order number extraction
  train.ts    12306 lookup: train code → train_no → stop list → arrival time and day offset
  trip.ts     Trip model, purchase/rebook/refund reducers, CalDAV push, maintain()
  ics.ts      VEVENT/VCALENDAR rendering, RFC 5545 escaping and line folding
  caldav.ts   CalDAV client: discovery (PROPFIND), PUT, DELETE
  store.ts    KV wrapper: trips, processed ids, raw payloads, tombstones, cache
  time.ts     China time ↔ UTC helpers
  types.ts    shared types
gas/Code.gs                   Gmail polling bridge (optional mail source)
scripts/caldav-calendar.mjs   list or create CalDAV calendars from a computer
test/                         Vitest; fixtures are anonymised real 12306 emails
```

## Ingest pipeline

`ingest()` in `index.ts`:

1. Normalise the id (Message-ID without angle brackets). Stop if `msg:<id>` exists.
2. Ignore senders not in `ALLOWED_SENDERS`; mark the id processed.
3. `htmlToText` → `parseEmail` → `{kind, orderNo, tickets[]}`.
4. If the kind is `unknown`, or a purchase/rebook kind has no parsed tickets, store the raw email
   (`raw:<id>`, 90 days) and mark it processed.
5. `applyEmail` loads the affected trips, applies the change, saves them, and writes to CalDAV.
6. Mark the id processed with the result. If there were warnings, also store the raw email.

`email()` never throws. A thrown error makes Cloudflare reject the message, which bounces it back to
the forwarding mailbox. Failures are logged and stored for `/replay` instead.

## Data model

A **trip** is one train ride on one day: date + train + boarding station + destination. All
passengers on that ride are tickets on the same trip and share one calendar event.

| KV key                               | Value                                                 |
| ------------------------------------ | ----------------------------------------------------- |
| `trip:<date>\|<train>\|<from>\|<to>` | `Trip` JSON (see [`types.ts`](../src/types.ts)), no expiry |
| `msg:<message id>`                   | `{at, summary}`: idempotency marker                   |
| `raw:<message id>`                   | `{reason, storedAt, payload}`, 90-day TTL             |
| `tombstone:<uid>`                    | CalDAV delete that failed and must be retried         |
| `cache:caldav-calendar-url`          | Discovered calendar collection URL, 7-day TTL         |

The event UID is `sha256(tripKey)[0:24]@12306ics`. Every CalDAV write is a `PUT` to a fixed path, so
reprocessing can never create a duplicate event. `SEQUENCE` increases on every update.

Inside a trip, a ticket is identified by passenger name (or by seat when the name is missing): one
passenger holds at most one ticket per train.

## Applying an email

[`trip.ts`](../src/trip.ts) collects every trip an email touches in a session, then commits once:
trips left without tickets are deleted (KV and CalDAV), and changed trips are saved and pushed.

- **Purchase / waitlist fulfilled**: group ticket lines by trip key; create missing trips; upsert
  each ticket.
- **Rebooking**: for each new ticket, remove the same passenger's ticket with the same order number
  from any trip, then add the new ticket. 12306 keeps the original order number on rebooking notices,
  which makes this an exact match. Without an order number, fall back to the same passenger on the
  same route, not yet departed, closest in date. If nothing matches, the new ticket is still added
  with the note `改签，未匹配到原行程` and a warning.
- **Refund with ticket lines**: remove those passengers from their trips.
- **Refund without ticket lines**: remove every ticket with that order number.

A retry after a partial failure is safe: rebooking detects tickets that were already moved.

## Arrival lookup

[`train.ts`](../src/train.ts) uses two JSON endpoints behind 12306's train information page. They need
no cookies and have worked from Cloudflare's network without rate limiting:

1. `https://search.12306.cn/search/v1/train/search?keyword=<code>&date=<YYYYMMDD>` returns candidate
   trains with their internal `train_no`. It is a prefix match, so the code must match exactly. One
   code can map to several trains (for example from different origins); candidates are tried in
   order and the one whose departure time at the boarding station matches the ticket wins.
2. `https://kyfw.12306.cn/otn/queryTrainInfo/query?leftTicketDTO.train_no=<no>&leftTicketDTO.train_date=<YYYY-MM-DD>&rand_code=`
   returns the stop list with `arrive_time`, `start_time`, `arrive_day_diff`, and `station_no`.

The day offset is `arrive_day_diff(to) − arrive_day_diff(from)`, which handles overnight trains and
boarding mid-route. The endpoints only answer for roughly two days back to fifteen days ahead. When
the lookup fails, arrival is estimated as departure + 2 hours, flagged `arrivalEstimated`, shown as
`预估` in the event, and re-queried by the nightly job until it succeeds.

## Design decisions

- **Email Routing over mailbox polling.** Delivery takes seconds and needs no mailbox credentials.
  The Gmail bridge was built first and remains as an alternative mail source.
- **Times are written as UTC (`Z`).** China has no daylight saving time, every client renders UTC
  correctly, and no `VTIMEZONE` block is needed.
- **No `METHOD` in CalDAV objects** (RFC 4791). The ICS feed adds `METHOD:PUBLISH`; the CalDAV
  document does not.
- **CalDAV XML is parsed with regular expressions.** Workers have no DOM parser, and iCloud's
  responses use default namespaces and single-quoted attributes (`<comp name='VEVENT'/>`).
  `parseCalendarList` is tested against a real iCloud response.
- **Calendars are not created by the Worker.** Workers' `fetch` rejects the `MKCALENDAR` method, and
  iCloud ignores extended `MKCOL`. The Worker still tries `MKCOL` and returns a clear error if it fails.
- **Empty tokens never authenticate.** `timingSafeEqual` returns false for empty strings, so a Worker
  without secrets rejects everything instead of accepting everything.

## Known gaps

- `用户变更到站通知` (change of destination) has never been observed; it is treated like rebooking.
- Trips are kept forever. A retention window in `maintain()` would keep the ICS feed short; CalDAV
  events would be left in place.
- KV has no transactions. Two emails about the same trip processed at the same moment could
  overwrite each other's changes. In practice 12306 emails arrive minutes apart.
- A rebooking removes every ticket of that passenger under the order number. If one order ever held
  several rides for the same passenger (for example a connecting journey) and only one leg was
  rebooked, the other leg would be removed too. Not yet observed in real emails.
