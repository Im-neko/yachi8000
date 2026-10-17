/** 日本時間（JST）の表記。見回りの報告で、時刻を人が読める形にする。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `10-16 03:00（JST）` の形。 */
export function formatJstMoment(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}（JST）`;
}

/** `10-16 03:00〜05:00（JST）` の形。日をまたぐなら両端に日付を付ける。 */
export function formatJstWindow(start: Date, end: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const label = (date: Date) => {
    const shifted = new Date(date.getTime() + JST_OFFSET_MS);
    return {
      day: `${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
      time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
    };
  };
  const from = label(start);
  const to = label(end);
  return from.day === to.day
    ? `${from.day} ${from.time}〜${to.time}（JST）`
    : `${from.day} ${from.time}〜${to.day} ${to.time}（JST）`;
}
