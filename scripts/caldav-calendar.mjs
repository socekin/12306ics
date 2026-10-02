#!/usr/bin/env node
/**
 * One-off CalDAV helper for bootstrapping the target calendar.
 *
 *   node scripts/caldav-calendar.mjs list
 *   node scripts/caldav-calendar.mjs create <display name>
 *
 * Reads CALDAV_URL, CALDAV_USERNAME and CALDAV_PASSWORD from the environment or .dev.vars.
 * Cloudflare Workers cannot send MKCALENDAR, so the calendar is created from here once.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = { ...loadDevVars(), ...process.env };
const root = env.CALDAV_URL || 'https://caldav.icloud.com/';
const auth = 'Basic ' + Buffer.from(`${env.CALDAV_USERNAME}:${env.CALDAV_PASSWORD}`).toString('base64');
if (!env.CALDAV_USERNAME || !env.CALDAV_PASSWORD) {
  console.error('CALDAV_USERNAME and CALDAV_PASSWORD are required');
  process.exit(1);
}

function loadDevVars() {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../.dev.vars', import.meta.url), 'utf-8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}

async function dav(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { Authorization: auth, 'Content-Type': 'application/xml; charset=utf-8', ...headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}\n${text.slice(0, 500)}`);
  return text;
}

const tag = (n) => `<(?:[\\w-]+:)?${n}\\b`;
const close = (n) => `<\\/(?:[\\w-]+:)?${n}\\s*>`;
const propHref = (xml, prop) => xml.match(new RegExp(`${tag(prop)}[^>]*>\\s*${tag('href')}[^>]*>([^<]+)${close('href')}`, 'i'))?.[1]?.trim();
const propfind = (url, depth, props) =>
  dav('PROPFIND', url, `<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop>${props}</D:prop></D:propfind>`, { Depth: String(depth) });

async function home() {
  const principal = new URL(propHref(await propfind(root, 0, '<D:current-user-principal/>'), 'current-user-principal'), root).toString();
  return new URL(propHref(await propfind(principal, 0, '<C:calendar-home-set/>'), 'calendar-home-set'), principal).toString();
}

async function list(homeUrl) {
  const xml = await propfind(homeUrl, 1, '<D:displayname/><D:resourcetype/><C:supported-calendar-component-set/>');
  const out = [];
  for (const r of xml.match(new RegExp(`${tag('response')}[\\s\\S]*?${close('response')}`, 'gi')) ?? []) {
    const rt = r.match(new RegExp(`${tag('resourcetype')}[^>]*>([\\s\\S]*?)${close('resourcetype')}`, 'i'))?.[1] ?? '';
    if (!new RegExp(`${tag('calendar')}[\\s/>]`, 'i').test(rt)) continue;
    const comp = r.match(new RegExp(`${tag('supported-calendar-component-set')}[^>]*>([\\s\\S]*?)${close('supported-calendar-component-set')}`, 'i'))?.[1];
    if (comp && !/name=["']VEVENT["']/i.test(comp)) continue;
    out.push({
      name: r.match(new RegExp(`${tag('displayname')}[^>]*>([^<]*)${close('displayname')}`, 'i'))?.[1]?.trim() ?? '',
      href: new URL(r.match(new RegExp(`${tag('href')}[^>]*>([^<]+)${close('href')}`, 'i'))?.[1]?.trim() ?? '', homeUrl).toString(),
    });
  }
  return out;
}

const [cmd, ...args] = process.argv.slice(2);
const homeUrl = await home();
console.log('calendar home:', homeUrl);
const calendars = await list(homeUrl);

if (cmd === 'list') {
  for (const c of calendars) console.log(`- ${c.name || '(no name)'}\t${c.href}`);
} else if (cmd === 'create') {
  const name = args.join(' ').trim();
  if (!name) throw new Error('usage: create <display name>');
  const existing = calendars.find((c) => c.name === name);
  if (existing) {
    console.log(`already exists: ${existing.href}`);
  } else {
    const url = new URL(`${randomUUID()}/`, homeUrl).toString();
    await dav(
      'MKCALENDAR',
      url,
      '<?xml version="1.0" encoding="utf-8" ?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>' +
        `<D:displayname>${name.replace(/[<>&]/g, '')}</D:displayname>` +
        '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>' +
        '</D:prop></D:set></C:mkcalendar>',
    );
    console.log(`created: ${url}`);
  }
} else {
  console.error('usage: caldav-calendar.mjs list | create <name>');
  process.exit(1);
}
