/** All 12306 times are Asia/Shanghai (UTC+8, no DST). */
const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

export function cnToUtc(date: string, time: string, dayOffset = 0): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d + dayOffset, h, mi) - CN_OFFSET_MS);
}

/** Format as iCalendar UTC date-time, e.g. 20260905T021200Z. */
export function icsUtc(dt: Date): string {
  return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Today's date (YYYY-MM-DD) in Asia/Shanghai. */
export function todayCn(now: Date = new Date()): string {
  return new Date(now.getTime() + CN_OFFSET_MS).toISOString().slice(0, 10);
}

/** Add minutes to HH:mm, returning the new time and how many days rolled over. */
export function addMinutes(time: string, minutes: number): { time: string; dayOffset: number } {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const total = h * 60 + m + minutes;
  const dayOffset = Math.floor(total / (24 * 60));
  const rem = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return { time: `${hh}:${mm}`, dayOffset };
}
