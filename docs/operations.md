# Operations

Day-to-day tasks for a deployed Worker: the HTTP API, checking what was processed, replaying emails,
and rotating tokens. Examples use `$HOST` for your Worker host and assume the tokens are exported as
shell variables.

## HTTP API

| Method | Path            | Auth             | Purpose                                                                 |
| ------ | --------------- | ---------------- | ----------------------------------------------------------------------- |
| GET    | `/health`       | none             | Liveness check                                                          |
| POST   | `/ingest`       | `INGEST_TOKEN`   | Process one email given as JSON `{id, from, subject, date, html, text}` |
| GET    | `/calendar.ics` | either token     | ICS feed of every stored trip                                           |
| GET    | `/trips`        | either token     | Stored trips as JSON                                                    |
| GET    | `/raw`          | either token     | Emails that were ignored, failed, or produced warnings                  |
| POST   | `/replay?id=`   | either token     | Re-run processing for a stored email                                    |
| POST   | `/maintain`     | either token     | Run the nightly maintenance job now                                     |

`/ingest` accepts only `Authorization: Bearer $INGEST_TOKEN`. Every other authenticated endpoint
accepts either token, as `?token=…` (calendar apps cannot send headers) or as a bearer header.

`/ingest` responds with one of:

- `{"action": "applied", "upserted": [...], "deleted": [...], "warnings": [...]}`
- `{"action": "duplicate"}`: this message id was already processed
- `{"action": "ignored", "reason": "..."}`: sender not allowed, unrecognised email, or nothing to do
- HTTP 500 with `{"error": "..."}`: the email is stored and can be replayed

## Routine checks

```bash
curl "$HOST/trips?token=$CALENDAR_TOKEN"   # what is stored
curl "$HOST/raw?token=$CALENDAR_TOKEN"     # what needs attention
npx wrangler tail                          # live logs
```

`/raw` lists emails kept for inspection (90 days), with the reason:

| Reason                         | Meaning and action                                                  |
| ------------------------------ | ------------------------------------------------------------------- |
| `unrecognized email`           | Not a known 12306 notice. Expected for forwarding confirmations; otherwise possibly a new format |
| `no ticket lines parsed`       | Recognised type but the ticket lines did not parse. Likely a format change |
| `rebook: original trip not found …` | The rebooked ticket was added, but the original could not be matched and is still in the calendar. Delete it manually |
| `refund: …`                    | A refunded ticket could not be found. Check the calendar manually   |
| `CalDAV push failed …`         | Saved; the nightly job retries the push                             |
| `error: …`                     | Processing threw. Fix the cause, then replay                        |

## Replaying an email

After fixing a parser bug or a configuration problem, re-run a stored email:

```bash
curl -X POST "$HOST/replay?id=<message id>&token=$CALENDAR_TOKEN"
```

Replay clears the message's processed marker and runs the normal pipeline. Every operation is
idempotent, so replaying an email that was already applied does not duplicate anything.

## Nightly maintenance

A cron trigger runs at 19:30 UTC (03:30 China time) and:

- retries CalDAV pushes that failed (`pendingPush` trips),
- retries CalDAV deletes that failed (tombstones),
- re-queries arrival times that were estimated, for trips that have not departed yet.

Run it on demand with `curl -X POST "$HOST/maintain?token=$CALENDAR_TOKEN"`.

## Inspecting KV directly

```bash
npx wrangler kv key list --remote --namespace-id=<kv-id> --prefix "trip:"
npx wrangler kv key get  --remote --namespace-id=<kv-id> "raw:<message id>"
```

Without `--remote`, wrangler reads the local development store. The key layout is described in
[architecture.md](architecture.md#data-model).

## Removing test data

After testing with `/ingest`, delete the keys you created:

```bash
npx wrangler kv key delete --remote --namespace-id=<kv-id> "msg:test-1"
npx wrangler kv key delete --remote --namespace-id=<kv-id> "raw:test-1"
npx wrangler kv key delete --remote --namespace-id=<kv-id> "trip:<date>|<train>|<from>|<to>"
```

Deleting a `trip:` key does not remove the calendar event; delete that in your calendar app.

## Rotating tokens

```bash
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put CALENDAR_TOKEN
```

After rotating `INGEST_TOKEN`, update the `TOKEN` script property of the Gmail bridge if you use it.
After rotating `CALENDAR_TOKEN`, update every ICS subscription URL.
