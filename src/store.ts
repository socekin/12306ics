import type { IngestPayload, Trip } from './types';

const TRIP_PREFIX = 'trip:';
const MSG_PREFIX = 'msg:';
const RAW_PREFIX = 'raw:';
const TOMBSTONE_PREFIX = 'tombstone:';
const CACHE_PREFIX = 'cache:';

export interface RawRecord {
  reason: string;
  storedAt: string;
  payload: IngestPayload;
}

export interface ProcessedRecord {
  at: string;
  summary: unknown;
}

/** Thin typed wrapper over the KV namespace. */
export class Store {
  constructor(private readonly kv: KVNamespace) {}

  async getTrip(key: string): Promise<Trip | null> {
    return this.kv.get<Trip>(TRIP_PREFIX + key, 'json');
  }

  async putTrip(trip: Trip): Promise<void> {
    await this.kv.put(TRIP_PREFIX + trip.key, JSON.stringify(trip));
  }

  async deleteTrip(key: string): Promise<void> {
    await this.kv.delete(TRIP_PREFIX + key);
  }

  async listTrips(): Promise<Trip[]> {
    const keys = await this.listKeys(TRIP_PREFIX);
    const trips = await Promise.all(keys.map((k) => this.kv.get<Trip>(k, 'json')));
    return trips.filter((t): t is Trip => t !== null).sort((a, b) => (a.date + a.departTime).localeCompare(b.date + b.departTime));
  }

  async isProcessed(id: string): Promise<boolean> {
    return (await this.kv.get(MSG_PREFIX + id)) !== null;
  }

  async unmarkProcessed(id: string): Promise<void> {
    await this.kv.delete(MSG_PREFIX + id);
  }

  async markProcessed(id: string, summary: unknown): Promise<void> {
    const rec: ProcessedRecord = { at: new Date().toISOString(), summary };
    await this.kv.put(MSG_PREFIX + id, JSON.stringify(rec));
  }

  async saveRaw(id: string, payload: IngestPayload, reason: string): Promise<void> {
    const rec: RawRecord = { reason, storedAt: new Date().toISOString(), payload };
    await this.kv.put(RAW_PREFIX + id, JSON.stringify(rec), { expirationTtl: 90 * 24 * 3600 });
  }

  async getRaw(id: string): Promise<RawRecord | null> {
    return this.kv.get<RawRecord>(RAW_PREFIX + id, 'json');
  }

  async listRaw(): Promise<Array<{ id: string; reason: string; storedAt: string; subject: string }>> {
    const keys = await this.listKeys(RAW_PREFIX);
    const out = [];
    for (const k of keys) {
      const rec = await this.kv.get<RawRecord>(k, 'json');
      if (rec) out.push({ id: k.slice(RAW_PREFIX.length), reason: rec.reason, storedAt: rec.storedAt, subject: rec.payload.subject });
    }
    return out;
  }

  /** Remember a CalDAV delete that failed so the cron job can retry it. */
  async addTombstone(uid: string): Promise<void> {
    await this.kv.put(TOMBSTONE_PREFIX + uid, '1');
  }

  async listTombstones(): Promise<string[]> {
    return (await this.listKeys(TOMBSTONE_PREFIX)).map((k) => k.slice(TOMBSTONE_PREFIX.length));
  }

  async removeTombstone(uid: string): Promise<void> {
    await this.kv.delete(TOMBSTONE_PREFIX + uid);
  }

  async getCache<T>(key: string): Promise<T | null> {
    return this.kv.get<T>(CACHE_PREFIX + key, 'json');
  }

  async setCache(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.kv.put(CACHE_PREFIX + key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  }

  async deleteCache(key: string): Promise<void> {
    await this.kv.delete(CACHE_PREFIX + key);
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor });
      names.push(...page.keys.map((k) => k.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return names;
  }
}
