import { readFileSync } from 'node:fs';
import type { CalDav } from '../src/caldav';
import { Store } from '../src/store';
import type { ApplyDeps } from '../src/trip';
import type { ArrivalInfo, LookupQuery } from '../src/train';

export interface Fixture {
  subject: string;
  from: string;
  date: string;
  html: string;
}

export function fixture(name: string): Fixture {
  const path = decodeURIComponent(new URL(`./fixtures/${name}.json`, import.meta.url).pathname);
  return JSON.parse(readFileSync(path, 'utf-8')) as Fixture;
}

/** Minimal in-memory stand-in for KVNamespace covering what Store uses. */
export class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.map.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
  async list(opts: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: true; cursor?: string }> {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).map((name) => ({ name }));
    return { keys, list_complete: true };
  }
}

export class FakeCalDav {
  readonly puts: Array<{ uid: string; ics: string }> = [];
  readonly deletes: string[] = [];
  failPut = false;
  async putEvent(uid: string, ics: string): Promise<void> {
    if (this.failPut) throw new Error('simulated CalDAV outage');
    this.puts.push({ uid, ics });
  }
  async deleteEvent(uid: string): Promise<void> {
    this.deletes.push(uid);
  }
}

export interface TestWorld {
  kv: FakeKV;
  store: Store;
  caldav: FakeCalDav;
  lookups: LookupQuery[];
  deps: ApplyDeps;
}

export function world(lookup?: (q: LookupQuery) => ArrivalInfo | null): TestWorld {
  const kv = new FakeKV();
  const store = new Store(kv as unknown as KVNamespace);
  const caldav = new FakeCalDav();
  const lookups: LookupQuery[] = [];
  const deps: ApplyDeps = {
    store,
    caldav: caldav as unknown as CalDav,
    lookup: async (q) => {
      lookups.push(q);
      return lookup ? lookup(q) : { arriveTime: '12:00', dayOffset: 0, trainNo: 'test' };
    },
    now: () => new Date('2026-09-03T04:00:00Z'),
    alarmMinutes: 60,
  };
  return { kv, store, caldav, lookups, deps };
}
