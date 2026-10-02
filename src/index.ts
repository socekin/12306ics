import { CalDav } from './caldav';
import { normalizeMessageId, parseRawEmail } from './email';
import { calendarDocument, tripEvent } from './ics';
import { emailAddress, parseEmail } from './parse';
import { Store } from './store';
import { htmlToText } from './text';
import { lookupArrival } from './train';
import { applyEmail, maintain, type ApplyDeps } from './trip';
import type { Env, IngestPayload } from './types';

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

function timingSafeEqual(a: string, b: string): boolean {
  if (!a || !b) return false; // never accept empty tokens, e.g. before secrets are configured
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}

function bearer(req: Request): string {
  const h = req.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function deps(env: Env): ApplyDeps {
  const store = new Store(env.STORE);
  const alarm = Number(env.ALARM_MINUTES ?? '0');
  return {
    store,
    caldav: CalDav.fromEnv(env, store),
    lookup: lookupArrival,
    now: () => new Date(),
    alarmMinutes: Number.isFinite(alarm) && alarm > 0 ? alarm : undefined,
  };
}

function allowedSenders(env: Env): string[] {
  return (env.ALLOWED_SENDERS ?? '12306@rails.com.cn')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

interface IngestOutcome {
  status: number;
  body: Record<string, unknown>;
}

async function ingest(payload: IngestPayload, env: Env, d: ApplyDeps): Promise<IngestOutcome> {
  const ok = (body: Record<string, unknown>, status = 200): IngestOutcome => ({ status, body });
  if (!payload.id || !payload.subject) return ok({ error: 'id and subject are required' }, 400);
  payload.id = normalizeMessageId(payload.id) ?? payload.id;
  const { store } = d;

  if (await store.isProcessed(payload.id)) return ok({ action: 'duplicate', id: payload.id });

  const sender = emailAddress(payload.from ?? '');
  if (!allowedSenders(env).includes(sender)) {
    await store.markProcessed(payload.id, { action: 'ignored', reason: 'sender', sender });
    return ok({ action: 'ignored', reason: `sender ${sender} not allowed`, id: payload.id });
  }

  const text = payload.html ? htmlToText(payload.html) : (payload.text ?? '');
  const parsed = parseEmail(payload.subject, text);

  const needsTickets = parsed.kind === 'purchase' || parsed.kind === 'waitlist_fulfilled' || parsed.kind === 'rebook';
  if (parsed.kind === 'unknown' || (needsTickets && parsed.tickets.length === 0)) {
    const reason = parsed.kind === 'unknown' ? 'unrecognized email' : 'no ticket lines parsed';
    await store.saveRaw(payload.id, payload, reason);
    await store.markProcessed(payload.id, { action: 'ignored', reason, kind: parsed.kind });
    return ok({ action: 'ignored', reason, kind: parsed.kind, id: payload.id });
  }
  if (parsed.kind === 'waitlist_cancelled') {
    await store.markProcessed(payload.id, { action: 'ignored', reason: 'waitlist cancelled', kind: parsed.kind });
    return ok({ action: 'ignored', reason: 'waitlist cancelled, nothing to change', id: payload.id });
  }

  try {
    const result = await applyEmail(parsed, payload.id, d);
    await store.markProcessed(payload.id, result);
    if (result.warnings.length) await store.saveRaw(payload.id, payload, result.warnings.join('; '));
    return ok({ action: 'applied', id: payload.id, ...result });
  } catch (e) {
    await store.saveRaw(payload.id, payload, `error: ${(e as Error).message}`);
    return ok({ error: (e as Error).message, id: payload.id }, 500);
  }
}

const respond = (r: IngestOutcome): Response => json(r.body, r.status);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const d = deps(env);

    if (path === '/health') return json({ ok: true });

    if (path === '/ingest' && req.method === 'POST') {
      if (!timingSafeEqual(bearer(req), env.INGEST_TOKEN ?? '')) return json({ error: 'unauthorized' }, 401);
      let payload: IngestPayload;
      try {
        payload = (await req.json()) as IngestPayload;
      } catch {
        return json({ error: 'invalid JSON' }, 400);
      }
      return respond(await ingest(payload, env, d));
    }

    // Everything below is read/admin access guarded by CALENDAR_TOKEN in the query string
    // (calendar apps cannot send headers) or INGEST_TOKEN as a bearer.
    const token = url.searchParams.get('token') ?? bearer(req);
    const authed = timingSafeEqual(token, env.CALENDAR_TOKEN ?? '') || timingSafeEqual(token, env.INGEST_TOKEN ?? '');
    if (!authed) return json({ error: 'unauthorized' }, 401);

    if (path === '/calendar.ics' && req.method === 'GET') {
      const trips = await d.store.listTrips();
      const now = d.now();
      const body = calendarDocument(
        trips.map((t) => tripEvent(t, { dtstamp: now, alarmMinutes: d.alarmMinutes })),
        { name: '12306 车票', publish: true },
      );
      return new Response(body, {
        headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache', 'Content-Disposition': 'inline; filename="12306.ics"' },
      });
    }

    if (path === '/trips' && req.method === 'GET') return json(await d.store.listTrips());

    if (path === '/raw' && req.method === 'GET') return json(await d.store.listRaw());

    if (path === '/replay' && req.method === 'POST') {
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id is required' }, 400);
      const raw = await d.store.getRaw(id);
      if (!raw) return json({ error: 'no stored payload for id' }, 404);
      await d.store.unmarkProcessed(id);
      return respond(await ingest(raw.payload, env, d));
    }

    if (path === '/maintain' && req.method === 'POST') return json(await maintain(d));

    return json({ error: 'not found' }, 404);
  },

  /**
   * Cloudflare Email Routing entry point. Never throws: a rejected message would
   * bounce back to 12306 or the forwarding mailbox, so failures are stored for /replay instead.
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const d = deps(env);
    let payload: IngestPayload | undefined;
    try {
      payload = await parseRawEmail(await new Response(message.raw).arrayBuffer());
      if (!payload.from) payload.from = message.from;
      const r = await ingest(payload, env, d);
      console.log(`email ${r.status} ${JSON.stringify(r.body)}`);
    } catch (e) {
      console.error('email handler failed', e);
      if (payload) await d.store.saveRaw(payload.id, payload, `email handler error: ${(e as Error).message}`);
    }
    if (env.ARCHIVE_TO) {
      try {
        await message.forward(env.ARCHIVE_TO);
      } catch (e) {
        console.warn('archive forward failed', e);
      }
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      maintain(deps(env)).then((r) => {
        if (r.warnings.length) console.warn('maintain warnings', r.warnings);
      }),
    );
  },
};
