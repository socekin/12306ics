import { describe, expect, it } from 'vitest';
import { lookupArrival, type FetchLike } from '../src/train';

const jsonResponse = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(routes: Record<string, unknown>): FetchLike {
  return async (url) => {
    for (const [needle, data] of Object.entries(routes)) if (url.includes(needle)) return jsonResponse(data);
    return new Response('not found', { status: 404 });
  };
}

const stops = (list: Array<[string, string, string, string]>) => ({
  data: { data: list.map(([station_name, arrive_time, start_time, arrive_day_diff], i) => ({ station_name, arrive_time, start_time, arrive_day_diff, station_no: String(i + 1).padStart(2, '0') })) },
});

describe('lookupArrival', () => {
  it('resolves train_no, requires an exact code match and reads the arrival at the destination', async () => {
    const fetch = fakeFetch({
      'search.12306.cn': { data: [{ station_train_code: 'Z11', from_station: 'x', to_station: 'y', train_no: 'WRONG' }, { station_train_code: 'Z1', from_station: '北京', to_station: '上海', train_no: 'Z1NO' }] },
      'train_no=Z1NO': stops([['北京', '----', '19:35', '0'], ['济南', '23:30', '23:36', '0'], ['上海', '08:40', '08:40', '1']]),
    });
    const r = await lookupArrival({ train: 'Z1', date: '2026-10-01', from: '北京', to: '上海', departTime: '19:35' }, fetch);
    expect(r).toEqual({ arriveTime: '08:40', dayOffset: 1, trainNo: 'Z1NO' });
  });

  it('computes the day offset relative to the boarding station', async () => {
    const fetch = fakeFetch({
      'search.12306.cn': { data: [{ station_train_code: 'Z1', from_station: '北京', to_station: '上海', train_no: 'Z1NO' }] },
      'train_no=Z1NO': stops([['北京', '----', '19:35', '0'], ['济南', '23:30', '23:36', '0'], ['南京', '05:50', '05:55', '1'], ['上海', '08:40', '08:40', '1']]),
    });
    const r = await lookupArrival({ train: 'Z1', date: '2026-10-02', from: '南京', to: '上海', departTime: '05:55' }, fetch);
    expect(r).toEqual({ arriveTime: '08:40', dayOffset: 0, trainNo: 'Z1NO' });
  });

  it('prefers the candidate whose departure time matches the ticket', async () => {
    const fetch = fakeFetch({
      'search.12306.cn': {
        data: [
          { station_train_code: 'K511', from_station: '上海松江', to_station: '海口', train_no: 'A' },
          { station_train_code: 'K511', from_station: '齐齐哈尔', to_station: '海口', train_no: 'B' },
        ],
      },
      'train_no=A': stops([['上海松江', '----', '10:00', '0'], ['杭州', '12:00', '12:05', '0']]),
      'train_no=B': stops([['上海松江', '09:00', '09:10', '1'], ['杭州', '11:30', '11:35', '1']]),
    });
    const r = await lookupArrival({ train: 'K511', date: '2026-10-01', from: '上海松江', to: '杭州', departTime: '09:10' }, fetch);
    expect(r?.trainNo).toBe('B');
    expect(r?.arriveTime).toBe('11:30');
  });

  it('returns null when the destination is not on the route or the API fails', async () => {
    const fetch = fakeFetch({
      'search.12306.cn': { data: [{ station_train_code: 'G1', from_station: '北京南', to_station: '上海虹桥', train_no: 'G1NO' }] },
      'train_no=G1NO': stops([['北京南', '----', '09:00', '0'], ['上海虹桥', '13:30', '13:30', '0']]),
    });
    expect(await lookupArrival({ train: 'G1', date: '2026-10-01', from: '北京南', to: '南京南', departTime: '09:00' }, fetch)).toBeNull();
    expect(await lookupArrival({ train: 'G1', date: '2026-10-01', from: '北京南', to: '上海虹桥', departTime: '09:00' }, async () => new Response('x', { status: 500 }))).toBeNull();
  });
});
