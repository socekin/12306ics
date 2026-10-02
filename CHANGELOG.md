# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.0.0] - 2026-10-02

Complete rewrite as a Cloudflare Worker in TypeScript. There is no data migration from 1.x; see
[Upgrading from v1](README.md#upgrading-from-v1-pythondocker).

### Added

- Email delivery through Cloudflare Email Routing, deduplicated by Message-ID.
- Gmail + Apps Script bridge as an alternative mail source.
- Rebooking (改签) and refund (退票) handling, including partial rebooking and refunds without ticket
  lines.
- Waitlist cancellation notices are recognised and need no change.
- One event per train ride, shared by every passenger on it, with deterministic UIDs so
  reprocessing never creates duplicates.
- Overnight arrivals and mid-route boarding through 12306's public stop-list endpoints, with an
  estimated fallback that is corrected nightly.
- Retries for failed CalDAV pushes and deletes by a nightly cron job.
- Reminder before departure (`ALARM_MINUTES`).
- HTTP API: `/trips`, `/raw`, `/replay`, `/maintain`, `/health`.
- Unit tests built on anonymised real 12306 emails, and CI.

### Changed

- The ICS feed moved from `/ticket` on port 2306 to `/calendar.ics`, and now requires `CALENDAR_TOKEN`.
- Configuration moved from `.env` to `wrangler.jsonc` variables and Worker secrets.

### Removed

- The Docker image, Flask server, IMAP IDLE mailbox monitor, and Playwright-based lookup.
- The need to store a mailbox password.

## [1.0.0] - 2025-09-05

Last version of the Python implementation: a Docker service that watched a QQ mailbox over IMAP
IDLE, looked up arrival times with Playwright, served an ICS feed on port 2306, and could push events
to a CalDAV calendar.

[Unreleased]: https://github.com/socekin/12306ics/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/socekin/12306ics/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/socekin/12306ics/tree/v1.0.0
