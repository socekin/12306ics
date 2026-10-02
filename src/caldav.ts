import type { Store } from './store';

export interface CalDavConfig {
  url: string;
  username: string;
  password: string;
  /** Display name of the target calendar; created if missing. */
  calendarName?: string;
  /** Skip discovery and use this collection URL directly. */
  calendarUrl?: string;
}

const CACHE_KEY = 'caldav-calendar-url';
const CACHE_TTL = 7 * 24 * 3600;

const tag = (name: string): string => `<(?:[A-Za-z0-9_-]+:)?${name}\\b`;
const closeTag = (name: string): string => `<\\/(?:[A-Za-z0-9_-]+:)?${name}\\s*>`;

function firstHref(xml: string): string | undefined {
  const m = xml.match(new RegExp(`${tag('href')}[^>]*>([^<]+)${closeTag('href')}`, 'i'));
  return m?.[1]?.trim();
}

function propHref(xml: string, prop: string): string | undefined {
  const m = xml.match(new RegExp(`${tag(prop)}[^>]*>\\s*${tag('href')}[^>]*>([^<]+)${closeTag('href')}`, 'i'));
  return m?.[1]?.trim();
}

function responses(xml: string): string[] {
  return xml.match(new RegExp(`${tag('response')}[\\s\\S]*?${closeTag('response')}`, 'gi')) ?? [];
}

function displayName(xml: string): string | undefined {
  const m = xml.match(new RegExp(`${tag('displayname')}[^>]*>([^<]*)${closeTag('displayname')}`, 'i'));
  return m?.[1]?.trim();
}

function isEventCalendar(xml: string): boolean {
  const rt = xml.match(new RegExp(`${tag('resourcetype')}[^>]*>([\\s\\S]*?)${closeTag('resourcetype')}`, 'i'));
  if (!rt || !new RegExp(`${tag('calendar')}[\\s/>]`, 'i').test(rt[1] ?? '')) return false;
  const comp = xml.match(new RegExp(`${tag('supported-calendar-component-set')}[^>]*>([\\s\\S]*?)${closeTag('supported-calendar-component-set')}`, 'i'));
  return comp ? /name=["']VEVENT["']/i.test(comp[1] ?? '') : true;
}

export interface CalendarEntry {
  name: string | undefined;
  url: string;
}

/** Parse a Depth: 1 PROPFIND multistatus into the event calendars it contains. */
export function parseCalendarList(xml: string, homeUrl: string): CalendarEntry[] {
  return responses(xml)
    .filter(isEventCalendar)
    .map((r) => ({ href: firstHref(r), name: displayName(r) }))
    .filter((c): c is { href: string; name: string | undefined } => Boolean(c.href))
    .map((c) => ({ name: c.name, url: new URL(c.href, homeUrl).toString() }));
}

function basicAuth(user: string, pass: string): string {
  const bytes = new TextEncoder().encode(`${user}:${pass}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

export class CalDavError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class CalDav {
  constructor(private readonly cfg: CalDavConfig, private readonly store: Store) {}

  static fromEnv(env: { CALDAV_URL?: string; CALDAV_USERNAME?: string; CALDAV_PASSWORD?: string; CALDAV_CALENDAR_NAME?: string; CALDAV_CALENDAR_URL?: string }, store: Store): CalDav | null {
    if (!env.CALDAV_URL || !env.CALDAV_USERNAME || !env.CALDAV_PASSWORD) return null;
    return new CalDav(
      { url: env.CALDAV_URL, username: env.CALDAV_USERNAME, password: env.CALDAV_PASSWORD, calendarName: env.CALDAV_CALENDAR_NAME, calendarUrl: env.CALDAV_CALENDAR_URL },
      store,
    );
  }

  async putEvent(uid: string, ics: string): Promise<void> {
    await this.withCalendar(async (base) => {
      const res = await this.request('PUT', `${base}${encodeURIComponent(uid)}.ics`, ics, { 'Content-Type': 'text/calendar; charset=utf-8' });
      if (!res.ok) throw new CalDavError(`PUT failed: ${res.status} ${await res.text()}`, res.status);
    });
  }

  async deleteEvent(uid: string): Promise<void> {
    await this.withCalendar(async (base) => {
      const res = await this.request('DELETE', `${base}${encodeURIComponent(uid)}.ics`);
      if (!res.ok && res.status !== 404) throw new CalDavError(`DELETE failed: ${res.status} ${await res.text()}`, res.status);
    });
  }

  /** Resolve (and cache) the calendar collection URL; on 404/405 rediscover once. */
  private async withCalendar(fn: (base: string) => Promise<void>): Promise<void> {
    const base = await this.calendarUrl();
    try {
      await fn(base);
    } catch (e) {
      if (e instanceof CalDavError && (e.status === 404 || e.status === 405 || e.status === 403)) {
        await this.store.deleteCache(CACHE_KEY);
        await fn(await this.calendarUrl());
        return;
      }
      throw e;
    }
  }

  async calendarUrl(): Promise<string> {
    if (this.cfg.calendarUrl) return this.cfg.calendarUrl.endsWith('/') ? this.cfg.calendarUrl : `${this.cfg.calendarUrl}/`;
    const cached = await this.store.getCache<string>(CACHE_KEY);
    if (cached) return cached;
    const url = await this.discover();
    await this.store.setCache(CACHE_KEY, url, CACHE_TTL);
    return url;
  }

  private async discover(): Promise<string> {
    const root = this.cfg.url;
    const principalXml = await this.propfind(root, 0, '<D:current-user-principal/>');
    const principalHref = propHref(principalXml, 'current-user-principal');
    if (!principalHref) throw new CalDavError('current-user-principal not found');
    const principalUrl = new URL(principalHref, root).toString();

    const homeXml = await this.propfind(principalUrl, 0, '<C:calendar-home-set/>');
    const homeHref = propHref(homeXml, 'calendar-home-set');
    if (!homeHref) throw new CalDavError('calendar-home-set not found');
    const homeUrl = new URL(homeHref, principalUrl).toString();

    const listXml = await this.propfind(homeUrl, 1, '<D:displayname/><D:resourcetype/><C:supported-calendar-component-set/>');
    const calendars = parseCalendarList(listXml, homeUrl);

    const wanted = this.cfg.calendarName;
    const match = wanted ? calendars.find((c) => c.name === wanted) : calendars[0];
    if (match) return match.url;
    if (!wanted) throw new CalDavError('no calendar collections found');
    return this.makeCalendar(homeUrl, wanted);
  }

  /**
   * Create the calendar with extended MKCOL (RFC 5689). Workers' fetch rejects the
   * MKCALENDAR method name, and iCloud accepts MKCOL with a calendar resourcetype.
   */
  private async makeCalendar(homeUrl: string, name: string): Promise<string> {
    const url = new URL(`${crypto.randomUUID()}/`, homeUrl).toString();
    const body =
      '<?xml version="1.0" encoding="utf-8" ?>' +
      '<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>' +
      '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>' +
      `<D:displayname>${name.replace(/[<>&]/g, '')}</D:displayname>` +
      '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' +
      '</D:prop></D:set></D:mkcol>';
    const res = await this.request('MKCOL', url, body, { 'Content-Type': 'application/xml; charset=utf-8' });
    if (!res.ok) {
      throw new CalDavError(
        `could not create calendar "${name}" (MKCOL ${res.status}); create it manually in your calendar app and retry`,
        res.status,
      );
    }
    return url;
  }

  private async propfind(url: string, depth: 0 | 1, props: string): Promise<string> {
    const body = `<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop>${props}</D:prop></D:propfind>`;
    const res = await this.request('PROPFIND', url, body, { 'Content-Type': 'application/xml; charset=utf-8', Depth: String(depth) });
    if (!res.ok) throw new CalDavError(`PROPFIND ${url} failed: ${res.status} ${await res.text()}`, res.status);
    return res.text();
  }

  private request(method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, {
      method,
      body,
      headers: { Authorization: basicAuth(this.cfg.username, this.cfg.password), 'User-Agent': '12306ics/0.1', ...headers },
      signal: AbortSignal.timeout(20_000),
    });
  }
}
