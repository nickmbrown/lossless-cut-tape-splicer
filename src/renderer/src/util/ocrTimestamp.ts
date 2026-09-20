import { DateTime } from 'luxon';


export type DateOrder = 'auto' | 'DMY' | 'MDY' | 'YMD';

export interface ParsedOcrTimestamp {
  value: string,
  hasDate: boolean,
  hasTime: boolean,
}

// characters commonly misrecognized by OCR when the actual character is a digit
const digitConfusions: Record<string, string> = {
  O: '0',
  o: '0',
  Q: '0',
  D: '0',
  l: '1',
  I: '1',
  '|': '1',
  S: '5',
  s: '5',
  B: '8',
  Z: '2',
  G: '6',
};

const monthsByName: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

const protectedWords = new Set([...Object.keys(monthsByName), 'AM', 'PM']);

// A token is likely to be (part of) a date/time if it contains at least one digit,
// in which case letters inside it are probably misrecognized digits - except letter runs
// that spell a known word (month name, AM/PM), e.g. the "jul" in "jul.14.2003".
// Tokens without digits (e.g. standalone "JUL", "PM") are left untouched.
function fixDigitConfusionsInToken(token: string) {
  if (!/\d/.test(token)) return token;
  return token.replaceAll(/[A-Za-z|]+/g, (run) => {
    if (protectedWords.has(run.toUpperCase())) return run;
    return [...run].map((char) => digitConfusions[char] ?? char).join('');
  });
}

export function cleanOcrText(raw: string) {
  return raw
    .replaceAll(/\p{Cc}/gu, ' ') // control chars (including newlines)
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => fixDigitConfusionsInToken(token))
    .join(' ')
    .trim();
}

// tag values end up as ffmpeg -metadata values; newlines/control chars would corrupt them
export function sanitizeTagValue(value: string) {
  return value.replaceAll(/\p{Cc}/gu, ' ').replaceAll(/\s+/g, ' ').trim();
}

const daysInMonth = (year: number, month: number) => new Date(year, month, 0).getDate();

function isValidDate({ year, month, day }: { year: number, month: number, day: number }) {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

// camcorder footage is overwhelmingly from the tape era; treat 2-digit years >= 70 as 19xx
const normalizeYear = (year: number) => {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
};

interface DateParts { year: number, month: number, day: number }

function interpretNumericDate(a: number, b: number, c: number, { yearFirst, dateOrder }: { yearFirst: boolean, dateOrder: DateOrder }): DateParts | undefined {
  if (yearFirst) {
    // e.g. 2003/07/14 - always year month day
    const candidate = { year: normalizeYear(a), month: b, day: c };
    return isValidDate(candidate) ? candidate : undefined;
  }

  const year = normalizeYear(c);

  const dayFirst = { year, month: b, day: a };
  const monthFirst = { year, month: a, day: b };

  const pick = (order: 'DMY' | 'MDY') => {
    const preferred = order === 'DMY' ? dayFirst : monthFirst;
    const fallback = order === 'DMY' ? monthFirst : dayFirst;
    if (isValidDate(preferred)) return preferred;
    return isValidDate(fallback) ? fallback : undefined;
  };

  if (dateOrder === 'DMY') return pick('DMY');
  if (dateOrder === 'MDY') return pick('MDY');
  // auto: disambiguate by value where possible, otherwise assume month first (typical camcorder default)
  if (a > 12) return pick('DMY');
  return pick('MDY');
}

// Last resort: on VCR/camcorder pixel fonts, tesseract commonly misreads the date separators
// ("/" looks just like the diagonal of a "7", or like a "1"), e.g. "3/ 7/93" is read as "37 7793".
// Re-interpret digits in separator positions as separators; the month/day bounds check
// (and this only running when nothing else matched) keeps false positives out.
function findDateWithMisreadSeparators(text: string, dateOrder: DateOrder): DateParts | undefined {
  // separators can be misread as 1-2 junk characters (e.g. "/" -> "78"); the lazy digit groups
  // make stray digits fall into the separator slot rather than into the day/month numbers
  for (const match of text.matchAll(/\b(\d{1,2}?)[/.\-718]{1,2}\s?(\d{1,2}?)[/.\-718]{1,2}\s?(\d{4}|\d{2})\b/g)) {
    const [, a, b, y] = match;
    const parsed = interpretNumericDate(parseInt(a!, 10), parseInt(b!, 10), parseInt(y!, 10), { yearFirst: false, dateOrder });
    if (parsed) return parsed;
  }
  return undefined;
}

function findDate(text: string, dateOrder: DateOrder): DateParts | undefined {
  // month name form: JUL 14 2003, 14 JUL 2003, JUL 14 '98, JUL.14.2003
  const monthNames = Object.keys(monthsByName).join('|');
  const monthNameMatch = text.match(new RegExp(`\\b(?:(\\d{1,2})[\\s.,-]*(${monthNames})|(${monthNames})[\\s.,-]*(\\d{1,2}))[\\s.,-]+'?(\\d{4}|\\d{2})\\b`, 'i'));
  if (monthNameMatch) {
    const [, dayBefore, monthAfterDay, monthBeforeDay, dayAfter, yearStr] = monthNameMatch;
    const month = monthsByName[(monthAfterDay ?? monthBeforeDay)!.toUpperCase()]!;
    const day = parseInt((dayBefore ?? dayAfter)!, 10);
    const candidate = { year: normalizeYear(parseInt(yearStr!, 10)), month, day };
    if (isValidDate(candidate)) return candidate;
  }

  // year-first numeric: 2003/07/14, 2003-7-14, 2003 07 14
  const yearFirstMatch = text.match(/\b(\d{4})([/.\s-])(\d{1,2})\2(\d{1,2})\b/);
  if (yearFirstMatch) {
    const [, y, , m, d] = yearFirstMatch;
    const parsed = interpretNumericDate(parseInt(y!, 10), parseInt(m!, 10), parseInt(d!, 10), { yearFirst: true, dateOrder });
    if (parsed) return parsed;
  }

  // year-last numeric: 14.7.2003, 7/14/2003, 14-7-03, and space-padded VCR-style "3/ 7/93";
  // fallback pattern for space as the separator itself: 12 31 '98
  const yearLastMatch = text.match(/\b(\d{1,2})\s?([/.-])\s?(\d{1,2})\s?\2\s?'?(\d{4}|\d{2})\b/)
    ?? text.match(/\b(\d{1,2})(\s)(\d{1,2})\2'?(\d{4}|\d{2})\b/);
  if (yearLastMatch) {
    const [, a, , b, y] = yearLastMatch;
    // e.g. 98/07/14 under explicit YMD: the first (2-digit) number is the year.
    // A 4-digit last number is always the year, so YMD cannot apply there.
    if (dateOrder === 'YMD' && y!.length !== 4) {
      const parsed = interpretNumericDate(parseInt(a!, 10), parseInt(b!, 10), parseInt(y!, 10), { yearFirst: true, dateOrder });
      if (parsed) return parsed;
    }
    const parsed = interpretNumericDate(parseInt(a!, 10), parseInt(b!, 10), parseInt(y!, 10), { yearFirst: false, dateOrder });
    if (parsed) return parsed;
  }

  return findDateWithMisreadSeparators(text, dateOrder);
}

interface TimeParts { hours: number, minutes: number, seconds: number | undefined }

function parseTimeMatch(match: RegExpMatchArray): TimeParts | undefined {
  const [, hoursStr, minutesStr, secondsStr, amPm] = match;
  let hours = parseInt(hoursStr!, 10);
  const minutes = parseInt(minutesStr!, 10);
  const seconds = secondsStr != null ? parseInt(secondsStr, 10) : undefined;

  if (amPm != null) {
    if (hours < 1 || hours > 12) return undefined;
    const isPm = amPm.toUpperCase() === 'P';
    if (isPm && hours !== 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
  }

  if (hours > 23 || minutes > 59 || (seconds != null && seconds > 59)) return undefined;
  return { hours, minutes, seconds };
}

function findTime(text: string): TimeParts | undefined {
  for (const match of text.matchAll(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP])?\.?M?\.?(?![\d:])/gi)) {
    const time = parseTimeMatch(match);
    if (time != null) return time;
  }
  // the ":" of camcorder OSD fonts is often misread (as ".", "-", ";" or a space);
  // only trust such times when an AM/PM marker anchors them, so that numeric dates
  // like "14.7.2003" can never be eaten as a time
  for (const match of text.matchAll(/\b(\d{1,2})[.\-;:\s]{1,2}(\d{2})(?:[.:](\d{2}))?\s*([AP])\.?M?\.?(?![\d:])/gi)) {
    const time = parseTimeMatch(match);
    if (time != null) return time;
  }
  return undefined;
}

const pad = (n: number) => String(n).padStart(2, '0');

function formatValue(date: DateParts | undefined, time: TimeParts | undefined) {
  const datePart = date != null ? `${date.year}-${pad(date.month)}-${pad(date.day)}` : undefined;
  const timePart = time != null ? `${pad(time.hours)}:${pad(time.minutes)}${time.seconds != null ? `:${pad(time.seconds)}` : ''}` : undefined;
  return [datePart, timePart].filter((part) => part != null).join(' ');
}

export function parseOcrTimestamp(raw: string, { dateOrder = 'auto', customFormat }: { dateOrder?: DateOrder, customFormat?: string | undefined } = {}): ParsedOcrTimestamp | undefined {
  const cleaned = cleanOcrText(raw);
  if (cleaned.length === 0) return undefined;

  if (customFormat != null && customFormat.trim().length > 0) {
    const dateTime = DateTime.fromFormat(cleaned, customFormat.trim());
    if (!dateTime.isValid) return undefined;
    return { value: dateTime.toFormat('yyyy-MM-dd HH:mm:ss'), hasDate: true, hasTime: true };
  }

  const date = findDate(cleaned, dateOrder);
  const time = findTime(cleaned);
  if (date == null && time == null) return undefined;

  return { value: formatValue(date, time), hasDate: date != null, hasTime: time != null };
}

export interface TimestampParts {
  date: string | undefined, // YYYY-MM-DD
  time: string | undefined, // HH:mm or HH:mm:ss
}

// splits a normalized value (as produced by parseOcrTimestamp) back into its parts
export function splitTimestampValue(value: string): TimestampParts {
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})?\s*(\d{2}:\d{2}(?::\d{2})?)?$/);
  if (!match) return { date: undefined, time: undefined };
  return { date: match[1], time: match[2] };
}

export function joinTimestampValue({ date, time }: TimestampParts) {
  return [date, time].filter((part) => part != null).join(' ');
}

// Converts a stored timestamp tag into the form ffmpeg accepts for `creation_time`.
// Two things matter here (both verified against ffmpeg):
// - "1993-03-07 19:51" is rejected outright: it needs the "T" separator and seconds.
// - a naive time is read as the *exporting machine's* local time and converted to UTC, which
//   shifts the clock. The burned-in time is what the camera showed, so we mark it as UTC ("Z")
//   to store exactly those digits.
export function toFfmpegCreationTime(value: string | undefined) {
  if (value == null) return undefined;
  const { date, time } = splitTimestampValue(value);
  if (date == null || time == null) return undefined;
  const withSeconds = time.length > 5 ? time : `${time}:00`;
  return `${date}T${withSeconds}Z`;
}
