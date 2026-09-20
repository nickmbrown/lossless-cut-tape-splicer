import { describe, it, expect } from 'vitest';

import { inferTimestamps } from './ocrTimestampInference';

const values = (results: ReturnType<typeof inferTimestamps>) => results.map((r) => r.value);
const flags = (results: ReturnType<typeof inferTimestamps>) => results.map((r) => (r.estimated ? 'est' : (r.outOfOrder ? 'ooo' : 'ok')));

describe('inferTimestamps', () => {
  it('leaves fully read timestamps untouched', () => {
    const input = ['1993-03-07 19:51', '1993-03-07 19:58', '1993-03-08 02:32'];
    expect(values(inferTimestamps(input))).toEqual(input);
    expect(flags(inferTimestamps(input))).toEqual(['ok', 'ok', 'ok']);
  });

  it('interpolates a completely unread clip between two known clips', () => {
    const result = inferTimestamps(['1993-03-07 19:00', undefined, '1993-03-07 21:00']);
    expect(result[1]!.value).toBe('1993-03-07 20:00');
    expect(result[1]!.estimated).toBe(true);
  });

  it('interpolates across a day boundary', () => {
    const result = inferTimestamps(['1993-03-07 23:00', undefined, '1993-03-08 01:00']);
    expect(result[1]!.value).toBe('1993-03-08 00:00');
  });

  it('does not guess when only one side is known', () => {
    expect(values(inferTimestamps([undefined, '1993-03-07 19:00']))).toEqual([undefined, '1993-03-07 19:00']);
    expect(values(inferTimestamps(['1993-03-07 19:00', undefined]))).toEqual(['1993-03-07 19:00', undefined]);
  });

  it('completes a time-only clip using the previous date', () => {
    // OCR read "7:53PM" but lost the date
    const result = inferTimestamps(['1993-03-07 19:51', '19:53', '1993-03-07 19:58']);
    expect(result[1]!.value).toBe('1993-03-07 19:53');
    expect(result[1]!.estimated).toBe(true);
  });

  it('rolls a time-only clip past midnight when the clock went backwards', () => {
    const result = inferTimestamps(['1993-03-07 23:40', '00:20', '1993-03-08 02:00']);
    expect(result[1]!.value).toBe('1993-03-08 00:20');
  });

  it("keeps a time-only clip on the previous clip's day when it still fits before the next", () => {
    const result = inferTimestamps(['1993-03-07 08:00', '23:30', '1993-03-09 06:00']);
    expect(result[1]!.value).toBe('1993-03-07 23:30');
  });

  it('completes a time-only clip with no previous anchor from the next one', () => {
    expect(inferTimestamps(['22:00', '1993-03-08 01:00'])[0]!.value).toBe('1993-03-07 22:00');
    expect(inferTimestamps(['08:00', '1993-03-08 09:00'])[0]!.value).toBe('1993-03-08 08:00');
  });

  it('estimates a missing time as the midpoint of the bounds that day gives', () => {
    const sameDay = inferTimestamps(['1993-03-07 10:00', '1993-03-07', '1993-03-07 14:00']);
    expect(sameDay[1]!.value).toBe('1993-03-07 12:00');

    // no same-day neighbours: midpoint of the whole day
    const otherDays = inferTimestamps(['1993-03-06 10:00', '1993-03-07', '1993-03-09 14:00']);
    expect(otherDays[1]!.value).toBe('1993-03-07 11:59');
  });

  it('leaves a time-only clip unresolved when there is nothing to anchor it to', () => {
    const result = inferTimestamps(['19:53']);
    expect(result[0]!.value).toBeUndefined();
    expect(result[0]!.partial).toBe('19:53');
  });

  it('flags both sides of a chronological inversion without changing them', () => {
    // the 1995 row is a misread year among 1993 clips
    const result = inferTimestamps(['1993-03-07 19:51', '1995-12-25 00:04', '1993-03-08 02:32']);
    expect(values(result)).toEqual(['1993-03-07 19:51', '1995-12-25 00:04', '1993-03-08 02:32']);
    expect(result.map((r) => r.outOfOrder)).toEqual([false, true, true]);
  });

  it('handles an all-unknown list without inventing anything', () => {
    expect(values(inferTimestamps([undefined, undefined]))).toEqual([undefined, undefined]);
  });
});
