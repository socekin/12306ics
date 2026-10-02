/**
 * Arrival lookup against the JSON endpoints behind 12306's "列车信息查询" page.
 * No browser needed: search.12306.cn resolves the internal train_no, then
 * kyfw.12306.cn returns the full stop list with arrive/depart times.
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

export interface LookupQuery {
  train: string;
  /** Boarding date YYYY-MM-DD. */
  date: string;
  from: string;
  to: string;
  /** HH:mm from the ticket, used to disambiguate trains sharing a code. */
  departTime: string;
}

export interface ArrivalInfo {
  arriveTime: string;
  /** Days after the boarding date. */
  dayOffset: number;
  trainNo: string;
}

interface SearchHit {
  station_train_code: string;
  from_station: string;
  to_station: string;
  train_no: string;
}

interface Stop {
  station_name: string;
  arrive_time: string;
  start_time: string;
  arrive_day_diff?: string;
  station_no?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function getJson<T>(url: string, fetchImpl: FetchLike, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...headers },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const norm = (name: string): string => name.replace(/站$/, '').replace(/\s+/g, '');
const TIME_RE = /^\d{1,2}:\d{2}$/;

export async function lookupArrival(q: LookupQuery, fetchImpl: FetchLike = fetch): Promise<ArrivalInfo | null> {
  const compact = q.date.replace(/-/g, '');
  const search = await getJson<{ data?: SearchHit[] }>(
    `https://search.12306.cn/search/v1/train/search?keyword=${encodeURIComponent(q.train)}&date=${compact}`,
    fetchImpl,
  );
  // The search is a prefix match (Z1 also returns Z11), so require an exact code.
  const candidates = (search?.data ?? []).filter((h) => h.station_train_code === q.train);
  const score = (h: SearchHit): number =>
    (norm(h.from_station) === norm(q.from) ? 2 : 0) + (norm(h.to_station) === norm(q.to) ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a));

  let fallback: ArrivalInfo | null = null;
  for (const c of candidates.slice(0, 3)) {
    const res = await getJson<{ data?: { data?: Stop[] } }>(
      `https://kyfw.12306.cn/otn/queryTrainInfo/query?leftTicketDTO.train_no=${encodeURIComponent(c.train_no)}&leftTicketDTO.train_date=${q.date}&rand_code=`,
      fetchImpl,
      { Referer: 'https://kyfw.12306.cn/otn/queryTrainInfo/init' },
    );
    const stops = res?.data?.data ?? [];
    const from = stops.find((s) => norm(s.station_name) === norm(q.from));
    const to = stops.find((s) => norm(s.station_name) === norm(q.to));
    if (!from || !to) continue;
    if (Number(to.station_no ?? 0) <= Number(from.station_no ?? 0)) continue;
    if (!TIME_RE.test(to.arrive_time)) continue;

    const info: ArrivalInfo = {
      arriveTime: to.arrive_time.padStart(5, '0'),
      dayOffset: Number(to.arrive_day_diff ?? 0) - Number(from.arrive_day_diff ?? 0),
      trainNo: c.train_no,
    };
    if (from.start_time.padStart(5, '0') === q.departTime) return info;
    fallback ??= info;
  }
  return fallback;
}
