/** Discord timestamp markup. <t:UNIX:f> shows the date and time in each reader's own zone; <t:UNIX:R> shows it relative. */
export const discordTime = (ms: number, style: 'f' | 'R' = 'f'): string => `<t:${Math.floor(ms / 1000)}:${style}>`;

/** The full time with the relative time in brackets, for example "<t:…:f> (<t:…:R>)". */
export const discordTimeWithRelative = (ms: number): string => `${discordTime(ms)} (${discordTime(ms, 'R')})`;

/** Discord time markup for an ISO string saved in a record. Text that does not parse is returned as it was. */
export const discordTimeIso = (iso: string): string => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? discordTime(ms) : iso;
};

const TIME_MARKUP = /<t:(-?\d+)(?::[a-zA-Z])?>/g;

/** Web views have no <t:> markup. Replace each one with a UTC date and time. */
export function webTimeText(text: string): string {
  return text.replace(TIME_MARKUP, (match, seconds: string) => {
    const when = new Date(Number(seconds) * 1000);
    return Number.isNaN(when.getTime()) ? match : `${when.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  });
}

/** Web views get their text without Discord markup, at any depth of a UI document or message. */
export function forWeb<T>(value: T): T {
  if (typeof value === 'string') return webTimeText(value) as T;
  if (Array.isArray(value)) return value.map(item => forWeb(item)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, forWeb(item)])) as T;
  return value;
}
