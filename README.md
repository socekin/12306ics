# 12306ics

[![CI](https://github.com/socekin/12306ics/actions/workflows/ci.yml/badge.svg)](https://github.com/socekin/12306ics/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/socekin/12306ics?sort=semver&label=version)](https://github.com/socekin/12306ics/tags)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](package.json)

English | [简体中文](README.zh-CN.md)

Turn China Railway 12306 ticket emails into calendar events. Runs entirely on Cloudflare Workers:
no server to maintain, no browser automation, no mailbox password.

Buy a ticket, and a few seconds later the trip is in your calendar with the seat, check-in gate,
arrival time, and a reminder before departure. Rebook or refund it, and the event moves or disappears.

## Features

- **Every ticket email that matters**: purchase, waitlist fulfilment (候补兑现), rebooking (改签), and
  refund (退票) notices.
- **One event per train ride.** Passengers on the same train share one event that lists every seat.
- **Real arrival times** from 12306's train schedule, including overnight trains and boarding
  mid-route. Falls back to an estimate and corrects it later if the lookup fails.
- **Two ways to get events**: pushed straight into iCloud or another CalDAV calendar within seconds,
  and/or a subscribable ICS feed.
- **Safe to retry.** Duplicate deliveries and reprocessing never create duplicate events.
- **Free to run** for personal use on Cloudflare's free plan (Workers, KV, Email Routing).

## How it works

```
12306 ──email──▶ your mailbox ──forward──▶ 12306@your-domain (Cloudflare Email Routing)
                                                   │
                                                   ▼
                                            12306ics Worker
                                   ├─ KV: trips, dedup markers, unrecognised emails
                                   ├─ CalDAV PUT/DELETE ─▶ your calendar (e.g. iCloud)
                                   └─ GET /calendar.ics ─▶ any calendar app
```

1. 12306 sends a notification email to the address on your 12306 account.
2. Your mailbox forwards it to an address handled by Cloudflare Email Routing, which hands it to
   the Worker.
3. The Worker parses the tickets, looks up the arrival time, updates its trip records, and writes the
   calendar event.

No email access? A Gmail + Apps Script bridge ([`gas/Code.gs`](gas/Code.gs)) can poll Gmail and POST
emails to the Worker instead.

## Requirements

- A Cloudflare account with at least one domain on Cloudflare DNS (needed for Email Routing; the
  domain can be used for anything else too).
- A mailbox that receives your 12306 emails and can forward them automatically while keeping the
  original sender. QQ Mail is tested.
- Optional: a CalDAV calendar. For iCloud you need an
  [app-specific password](https://support.apple.com/102654). Without CalDAV you can still subscribe
  to the ICS feed.
- Node.js 22 or later, to deploy.

## Quick start

```bash
git clone https://github.com/socekin/12306ics.git
cd 12306ics
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler kv namespace create STORE   # paste the printed id into wrangler.jsonc
npx wrangler deploy
npx wrangler secret put INGEST_TOKEN     # long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put CALENDAR_TOKEN   # another long random string
npx wrangler secret put CALDAV_USERNAME  # optional: your Apple ID email
npx wrangler secret put CALDAV_PASSWORD  # optional: app-specific password
```

Then:

1. Create a calendar named `12306` in your calendar app (the Worker writes into it but cannot create it).
2. In the Cloudflare dashboard, open **Email Routing** for your domain and create a custom address,
   such as `12306@your-domain`, with the action **Send to a Worker** → `12306ics`.
3. In your mailbox, add a rule that forwards emails from `12306@rails.com.cn` to that address.

The [deployment guide](docs/deployment.md) walks through each step, including mailbox forwarding
confirmation, the Gmail bridge, and how to test without buying a ticket.

## Configuration

Secrets (`npx wrangler secret put <NAME>`; for local development, put them in `.dev.vars`, see
[`.dev.vars.example`](.dev.vars.example)):

| Secret            | Required | Purpose                                                       |
| ----------------- | -------- | ------------------------------------------------------------- |
| `INGEST_TOKEN`    | yes      | Bearer token for `POST /ingest` and admin endpoints           |
| `CALENDAR_TOKEN`  | yes      | `?token=` for the ICS feed and read-only endpoints            |
| `CALDAV_USERNAME` | no       | CalDAV login. Leave unset to disable CalDAV                   |
| `CALDAV_PASSWORD` | no       | CalDAV password (app-specific password for iCloud)            |

Variables (`vars` in `wrangler.jsonc`):

| Variable               | Default                      | Purpose                                                        |
| ---------------------- | ---------------------------- | -------------------------------------------------------------- |
| `ALLOWED_SENDERS`      | `12306@rails.com.cn`         | Comma-separated `From` addresses to process; others are ignored |
| `CALDAV_URL`           | `https://caldav.icloud.com/` | CalDAV server root                                             |
| `CALDAV_CALENDAR_NAME` | `12306`                      | Target calendar, matched by display name                       |
| `CALDAV_CALENDAR_URL`  | unset                        | Skip discovery and write to this calendar collection URL       |
| `ALARM_MINUTES`        | `60`                         | Reminder before departure; `0` disables it                     |
| `ARCHIVE_TO`           | unset                        | Verified Email Routing destination that gets a copy of each email |

## Subscribing to the ICS feed

```
https://<your-worker-host>/calendar.ics?token=<CALENDAR_TOKEN>
```

Add it as a subscribed calendar in Apple Calendar, Google Calendar, or Outlook. Subscriptions refresh
on the calendar app's schedule (often hourly or slower), so use CalDAV if you want events within seconds.

## Supported emails

| 12306 email (subject suffix) | What happens                                                         |
| ---------------------------- | -------------------------------------------------------------------- |
| 用户支付通知 (purchase)       | Adds the tickets; creates an event per train ride                   |
| 候补订单兑现成功通知 (waitlist fulfilled) | Same as purchase                                          |
| 用户改签通知 (rebooking)      | Moves the rebooked passengers to the new train; untouched passengers stay |
| 用户退票通知 (refund)         | Removes the refunded passengers; deletes the event when none are left |
| 候补订单退单通知 (waitlist cancelled) | Nothing to change                                           |
| Anything else                | Ignored and kept for 90 days so it can be replayed after a parser fix |

Details and edge cases: [docs/email-formats.md](docs/email-formats.md).

## Limitations

- Only iCloud has been tested as a CalDAV server. Others should work but are unverified.
- The Worker cannot create calendars on iCloud. Create the target calendar yourself, in the
  Calendar app or with [`scripts/caldav-calendar.mjs`](scripts/caldav-calendar.mjs).
- Arrival times come from undocumented 12306 endpoints that may change. When the lookup fails,
  the event shows an estimated arrival, which a nightly job corrects once the lookup works again.
- If 12306 changes its email format, affected emails are kept and can be replayed after the parser
  is updated. Please [report it](https://github.com/socekin/12306ics/issues/new/choose).
- Trips are kept indefinitely.

## Upgrading from v1 (Python/Docker)

v2 is a complete rewrite; v1 remains available at tag [`v1.0.0`](https://github.com/socekin/12306ics/tree/v1.0.0).
There is no data migration: stop the v1 container, deploy the Worker, and point your mailbox
forwarding at the new address. Events created by v1 use different identifiers, so write v2 into a
new calendar, or delete the old v1 events, to avoid duplicates.

## Documentation

- [Deployment guide](docs/deployment.md): set up from scratch, mailbox forwarding, Gmail bridge
- [Operations](docs/operations.md): HTTP API, routine checks, replaying emails, rotating tokens
- [Architecture](docs/architecture.md): data model, processing pipeline, design decisions
- [Email formats](docs/email-formats.md): what 12306 sends and how it is parsed

## Contributing

Bug reports, new email samples, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
Never post a raw 12306 email publicly; it contains your name and order details.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

[MIT](LICENSE)

This project is not affiliated with China Railway or 12306.
