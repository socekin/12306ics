# Deployment guide

This guide sets up 12306ics from scratch: the Worker, the target calendar, email delivery, and an
end-to-end test. Allow about 30 minutes.

- [1. Prerequisites](#1-prerequisites)
- [2. Deploy the Worker](#2-deploy-the-worker)
- [3. Create the calendar](#3-create-the-calendar)
- [4. Route email to the Worker](#4-route-email-to-the-worker)
- [5. Forward 12306 emails from your mailbox](#5-forward-12306-emails-from-your-mailbox)
- [6. Test without buying a ticket](#6-test-without-buying-a-ticket)
- [Alternative: Gmail + Apps Script bridge](#alternative-gmail--apps-script-bridge)
- [Optional: custom domain for the Worker](#optional-custom-domain-for-the-worker)
- [Local development](#local-development)

## 1. Prerequisites

- **Cloudflare account** with at least one zone (domain) using Cloudflare DNS. Email Routing only
  works on a zone; the Worker itself is not tied to it.
- **A mailbox that receives 12306 emails** (the address on your 12306 account) and can auto-forward
  while keeping the original `From` header. QQ Mail is tested. If your mailbox cannot forward, use
  the [Gmail bridge](#alternative-gmail--apps-script-bridge).
- **CalDAV credentials** (optional). For iCloud, create an app-specific password at
  [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords.
- **Node.js 22+** and the repository cloned locally.

## 2. Deploy the Worker

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler kv namespace create STORE
```

Paste the printed namespace id into `wrangler.jsonc` → `kv_namespaces[0].id`, review `vars` (see the
[configuration table](../README.md#configuration)), then deploy and set the secrets:

```bash
npx wrangler deploy
openssl rand -hex 32                      # run twice: one value per token, save both
npx wrangler secret put INGEST_TOKEN      # paste the first value
npx wrangler secret put CALENDAR_TOKEN    # paste the second value
npx wrangler secret put CALDAV_USERNAME   # skip both CalDAV secrets to use the ICS feed only
npx wrangler secret put CALDAV_PASSWORD
```

Store both tokens in a password manager; you need them to call the API and to subscribe to the feed.
Until they are set, the Worker rejects every authenticated request.

Check that it is up:

```bash
curl https://12306ics.<your-subdomain>.workers.dev/health
# {"ok": true}
```

## 3. Create the calendar

The Worker finds its calendar by display name (`CALDAV_CALENDAR_NAME`, default `12306`) but cannot
create it on iCloud: Workers' `fetch` rejects the `MKCALENDAR` method and iCloud ignores extended
`MKCOL`. Create it once, either in the Calendar app (in your iCloud account, not "On My Mac"), or
from your computer:

```bash
# reads CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD from the environment or .dev.vars
node scripts/caldav-calendar.mjs list
node scripts/caldav-calendar.mjs create 12306
```

Skip this step if you only use the ICS feed.

## 4. Route email to the Worker

In the Cloudflare dashboard, open your zone → **Email** → **Email Routing**:

1. Enable Email Routing if it is not on yet. Cloudflare adds the required MX and TXT records.
2. Under **Routing rules**, create a custom address, for example `12306@your-domain`.
3. Set the action to **Send to a Worker** and the destination to `12306ics`.

The Worker processes each message and never rejects it; failures are stored for replay rather than
bounced back to the sender.

## 5. Forward 12306 emails from your mailbox

Create a rule in the mailbox that receives your 12306 emails. For QQ Mail: Settings → 收信规则 → new
rule, condition "sender contains `12306@rails.com.cn`", action "forward to `12306@your-domain`".

Most providers send a confirmation email to the forwarding target before they start forwarding. That
email reaches the Worker, which does not recognise it and stores it. Retrieve it and open the
confirmation link:

```bash
curl "https://<your-worker-host>/raw?token=$CALENDAR_TOKEN"     # find the message id
npx wrangler kv key get --remote --namespace-id=<kv-id> "raw:<message id>"
```

Why the sender check still works: QQ Mail keeps the original `From: 12306@rails.com.cn` header when
forwarding and re-signs the message as qq.com, so SPF passes and `ALLOWED_SENDERS` matches.
`rails.com.cn` publishes no DMARC record, so forwarded mail is not rejected.

## 6. Test without buying a ticket

Post one of the anonymised fixtures straight to the Worker:

```bash
jq '. + {id: "test-1"}' test/fixtures/purchase-2.json | \
  curl -X POST "https://<your-worker-host>/ingest" \
       -H "Authorization: Bearer $INGEST_TOKEN" \
       -H "Content-Type: application/json" --data @-
```

The response lists the trips it created, and the event should appear in your calendar. To test the full
email path, send a real 12306 email body to your own mailbox and let the forwarding rule pick it up.
For that, temporarily add your own address to `ALLOWED_SENDERS` and remove it afterwards.

Clean up the test data afterwards; see [Operations → Removing test data](operations.md#removing-test-data).

## Alternative: Gmail + Apps Script bridge

If you cannot use Email Routing, [`gas/Code.gs`](../gas/Code.gs) polls Gmail every minute and POSTs new
12306 emails to `/ingest`. It uses the same Message-ID as Email Routing, so running both paths at once
does not create duplicates.

1. Make sure your 12306 emails reach Gmail (directly or forwarded).
2. Create a project at [script.google.com](https://script.google.com) and paste `gas/Code.gs`.
3. Project Settings → Script Properties: set `ENDPOINT` to `https://<your-worker-host>/ingest` and
   `TOKEN` to your `INGEST_TOKEN`. Optionally set `QUERY` to override the Gmail search
   (default `from:12306@rails.com.cn newer_than:7d`).
4. Run `setup()` once and accept the authorisation prompt. It installs a one-minute trigger.

`status()` prints the delivery state of recent messages; `reset(id)` re-delivers one message.

## Optional: custom domain for the Worker

To serve the Worker from your own hostname instead of `workers.dev`, uncomment `routes` in
`wrangler.jsonc`, set the hostname, and deploy again. The zone must be on the same Cloudflare account.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in local values; never commit this file
npm run dev                      # wrangler dev on http://localhost:8787
npm test
npm run typecheck
```

`wrangler kv key …` commands target local storage by default. Add `--remote` to read or change
production data.
