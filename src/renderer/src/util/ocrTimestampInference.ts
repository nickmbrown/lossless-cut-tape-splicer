import { splitTimestampValue } from './ocrTimestamp';

// Fills in timestamps that OCR could not (fully) read, using what we know about a single tape:
// - segments are in chronological order
// - neighbouring clips are usually filmed within hours or days of each other
// - a clip between two known clips must lie between them
// Nothing here overwrites a value OCR did read; it only completes missing parts, and every
// filled-in value is flagged as estimated so the user can see (and veto) the guess.

export interface TimestampInference {
  value: string | undefined, // complete "YYYY-MM-DD HH:mm[:ss]", when known or estimated
  partial: string | undefined, // info we have but could not complete (e.g. a time with no date)
  estimated: boolean,
  outOfOrder: boolean, // inconsistent with a neighbour - likely an OCR misread, flagged not fixed
}

const pad = (n: number) => String(n).padStart(2, '0');

const timeToSeconds = (time: string) => {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
};

const secondsToTime = (totalSeconds: number, withSeconds: boolean) => {
  const clamped = Math.max(0, Math.min(24 * 3600 - 1, Math.round(totalSeconds)));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  return `${pad(hours)}:${pad(minutes)}${withSeconds ? `:${pad(clamped % 60)}` : ''}`;
};

// UTC throughout: these are wall-clock timestamps off a tape, so we only need stable arithmetic
function toEpoch(date: string, time: string) {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  const [hours = 0, minutes = 0, seconds = 0] = time.split(':').map(Number);
  return Date.UTC(year, month - 1, day, hours, minutes, seconds);
}

function fromEpoch(epoch: number, withSeconds: boolean) {
  const d = new Date(epoch);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${withSeconds ? `:${pad(d.getUTCSeconds())}` : ''}`;
  return `${date} ${time}`;
}

const addDays = (date: string, days: number) => fromEpoch(toEpoch(date, '00:00') + days * 24 * 3600 * 1000, false).slice(0, 10);

interface Anchor { date: string, time: string, epoch: number }

// Values must be supplied in chronological (tape) order.
export function inferTimestamps(values: (string | undefined)[]): TimestampInference[] {
  const parts = values.map((value) => (value != null ? splitTimestampValue(value) : { date: undefined, time: undefined }));

  const anchors: (Anchor | undefined)[] = parts.map(({ date, time }) => (
    date != null && time != null ? { date, time, epoch: toEpoch(date, time) } : undefined
  ));

  const findPrev = (i: number) => anchors.slice(0, i).findLast((a) => a != null);
  const findNext = (i: number) => anchors.slice(i + 1).find((a) => a != null);

  const results: TimestampInference[] = parts.map(({ date, time }, i) => {
    const known = anchors[i];
    if (known != null) return { value: `${known.date} ${known.time}`, partial: undefined, estimated: false, outOfOrder: false };

    const prev = findPrev(i);
    const next = findNext(i);

    // time known, date missing: take the neighbouring date, rolling over midnight where the
    // time of day says we must have
    if (time != null && date == null) {
      if (prev != null) {
        let inferredDate = timeToSeconds(time) < timeToSeconds(prev.time) ? addDays(prev.date, 1) : prev.date;
        // if that would place this clip after the next known clip, anchor to the next one instead
        if (next != null && toEpoch(inferredDate, time) > next.epoch) {
          inferredDate = timeToSeconds(time) > timeToSeconds(next.time) ? addDays(next.date, -1) : next.date;
        }
        return { value: `${inferredDate} ${time}`, partial: undefined, estimated: true, outOfOrder: false };
      }
      if (next != null) {
        const inferredDate = timeToSeconds(time) > timeToSeconds(next.time) ? addDays(next.date, -1) : next.date;
        return { value: `${inferredDate} ${time}`, partial: undefined, estimated: true, outOfOrder: false };
      }
      return { value: undefined, partial: time, estimated: false, outOfOrder: false };
    }

    // date known, time missing: take the midpoint of whatever bounds that day gives us
    if (date != null && time == null) {
      const lower = prev != null && prev.date === date ? timeToSeconds(prev.time) : 0;
      const upper = next != null && next.date === date ? timeToSeconds(next.time) : 24 * 3600 - 60;
      const midpoint = (lower + Math.max(lower, upper)) / 2;
      return { value: `${date} ${secondsToTime(midpoint, false)}`, partial: undefined, estimated: true, outOfOrder: false };
    }

    // nothing read: only interpolate when bounded on both sides (per the chronological assumption)
    if (prev != null && next != null) {
      return { value: fromEpoch((prev.epoch + next.epoch) / 2, false), partial: undefined, estimated: true, outOfOrder: false };
    }

    return { value: undefined, partial: undefined, estimated: false, outOfOrder: false };
  });

  // Flag values that contradict a neighbour. Both sides of an inversion are flagged, because
  // from here we cannot tell which of the two was misread.
  const epochs = results.map((r) => (r.value != null ? toEpoch(r.value.slice(0, 10), r.value.slice(11)) : undefined));
  return results.map((result, i) => {
    if (result.value == null || result.estimated) return result;
    const prevEpoch = epochs.slice(0, i).findLast((e) => e != null);
    const nextEpoch = epochs.slice(i + 1).find((e) => e != null);
    const epoch = epochs[i]!;
    const outOfOrder = (prevEpoch != null && epoch < prevEpoch) || (nextEpoch != null && epoch > nextEpoch);
    return { ...result, outOfOrder };
  });
}
