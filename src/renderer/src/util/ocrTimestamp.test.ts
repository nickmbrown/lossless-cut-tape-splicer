import { describe, it, expect } from 'vitest';

import { cleanOcrText, parseOcrTimestamp, sanitizeTagValue, toFfmpegCreationTime } from './ocrTimestamp';

describe('cleanOcrText', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(cleanOcrText('  JUL 14\n2003\t18:32 ')).toBe('JUL 14 2003 18:32');
  });

  it('fixes digit confusions only in tokens containing digits', () => {
    expect(cleanOcrText('JUL l4 2OO3')).toBe('JUL 14 2003');
    expect(cleanOcrText('l8:32:O5')).toBe('18:32:05');
    // pure-letter tokens (month names, AM/PM) must not be touched
    expect(cleanOcrText('DEC 25 1995')).toBe('DEC 25 1995');
    expect(cleanOcrText('6:32 PM')).toBe('6:32 PM');
  });
});

describe('parseOcrTimestamp', () => {
  it('parses year-first numeric dates with time', () => {
    expect(parseOcrTimestamp('2003/07/14 18:32:05')?.value).toBe('2003-07-14 18:32:05');
    expect(parseOcrTimestamp('2003-7-14 18:32')?.value).toBe('2003-07-14 18:32');
    expect(parseOcrTimestamp('2003 07 14')?.value).toBe('2003-07-14');
  });

  it('parses day-first numeric dates (unambiguous)', () => {
    expect(parseOcrTimestamp('14.7.2003 18:32')?.value).toBe('2003-07-14 18:32');
    expect(parseOcrTimestamp('31/12/1998')?.value).toBe('1998-12-31');
  });

  it('parses month-first numeric dates (unambiguous)', () => {
    expect(parseOcrTimestamp('7-14-2003')?.value).toBe('2003-07-14');
    expect(parseOcrTimestamp("12 31 '98")?.value).toBe('1998-12-31');
  });

  it('respects dateOrder for ambiguous dates', () => {
    expect(parseOcrTimestamp('01/02/2003', { dateOrder: 'DMY' })?.value).toBe('2003-02-01');
    expect(parseOcrTimestamp('01/02/2003', { dateOrder: 'MDY' })?.value).toBe('2003-01-02');
    // auto defaults ambiguous to month-first
    expect(parseOcrTimestamp('01/02/2003')?.value).toBe('2003-01-02');
    // explicit order falls back to the other interpretation when impossible
    expect(parseOcrTimestamp('31/12/1998', { dateOrder: 'MDY' })?.value).toBe('1998-12-31');
  });

  it('supports 2-digit years including year-first under YMD', () => {
    expect(parseOcrTimestamp('98/07/14', { dateOrder: 'YMD' })?.value).toBe('1998-07-14');
    expect(parseOcrTimestamp('03/07/14', { dateOrder: 'YMD' })?.value).toBe('2003-07-14');
    expect(parseOcrTimestamp('14-7-03')?.value).toBe('2003-07-14');
  });

  it('parses month-name dates in both orders', () => {
    expect(parseOcrTimestamp('JUL 14 2003')?.value).toBe('2003-07-14');
    expect(parseOcrTimestamp('14 JUL 2003')?.value).toBe('2003-07-14');
    expect(parseOcrTimestamp('jul.14.2003')?.value).toBe('2003-07-14');
    expect(parseOcrTimestamp("DEC 25 '95")?.value).toBe('1995-12-25');
    expect(parseOcrTimestamp('SEPT 1 1999')?.value).toBe('1999-09-01');
  });

  it('parses 12-hour times', () => {
    expect(parseOcrTimestamp('6:32 PM')?.value).toBe('18:32');
    expect(parseOcrTimestamp('6:32:05PM')?.value).toBe('18:32:05');
    expect(parseOcrTimestamp('12:00 AM')?.value).toBe('00:00');
    expect(parseOcrTimestamp('12:00 PM')?.value).toBe('12:00');
    expect(parseOcrTimestamp('6:32 P.M.')?.value).toBe('18:32');
  });

  it('parses time-only and date-only', () => {
    expect(parseOcrTimestamp('18:32:05')?.value).toBe('18:32:05');
    expect(parseOcrTimestamp('JUL 14 2003')?.value).toBe('2003-07-14');
  });

  it('parses date and time together regardless of order', () => {
    expect(parseOcrTimestamp('18:32 14.7.2003')?.value).toBe('2003-07-14 18:32');
    expect(parseOcrTimestamp('AUG 3 1997 9:15:00 AM')?.value).toBe('1997-08-03 09:15:00');
  });

  it('recovers times whose colon was misread, anchored on AM/PM', () => {
    // real-world tesseract outputs from a VHS tape (true values: 7:51PM, 2:33AM)
    expect(parseOcrTimestamp('7.51PM 37 7793')?.value).toBe('1993-03-07 19:51');
    expect(parseOcrTimestamp('2 -33AM 37-8793')?.value).toBe('1993-03-08 02:33');
    expect(parseOcrTimestamp('6.30 PM')?.value).toBe('18:30');
    // without an AM/PM anchor, loose separators must NOT turn dates into times
    expect(parseOcrTimestamp('14.7.2003')?.value).toBe('2003-07-14');
  });

  it('recovers dates with extra stray digits in the separator positions', () => {
    // "3/ 7/93" where "/" was read as "7"+extra digit or as "8"
    expect(parseOcrTimestamp('7:51PM 37 77893')?.value).toBe('1993-03-07 19:51');
    expect(parseOcrTimestamp('2:32AM 37 8793')?.value).toBe('1993-03-08 02:32');
    expect(parseOcrTimestamp('37-8793')?.value).toBe('1993-03-08');
  });

  it('reports which components were found', () => {
    expect(parseOcrTimestamp('37 7793')).toMatchObject({ value: '1993-03-07', hasDate: true, hasTime: false });
    expect(parseOcrTimestamp('7:51PM')).toMatchObject({ value: '19:51', hasDate: false, hasTime: true });
    expect(parseOcrTimestamp('7:51PM 3/ 7/93')).toMatchObject({ hasDate: true, hasTime: true });
  });

  it('recovers dates whose separators were misread as digits', () => {
    // real-world tesseract output for a VCR OSD reading "7:51PM / 3/ 7/93": both slashes read as 7
    expect(parseOcrTimestamp('7:51PM 37 7793')?.value).toBe('1993-03-07 19:51');
    expect(parseOcrTimestamp('37 7793')?.value).toBe('1993-03-07');
    // slash misread as 1
    expect(parseOcrTimestamp('31 7193')?.value).toBe('1993-03-07');
    // one slash read correctly, the other as a digit
    expect(parseOcrTimestamp('3/ 7793')?.value).toBe('1993-03-07');
    expect(parseOcrTimestamp('37 7/93', { dateOrder: 'DMY' })?.value).toBe('1993-07-03');
    // recovery must not fire when a real date is present
    expect(parseOcrTimestamp('14.7.2003 37 7793')?.value).toBe('2003-07-14');
    // and must not invent dates from unrelated digit runs
    expect(parseOcrTimestamp('7793')).toBeUndefined();
    expect(parseOcrTimestamp('17193')).toBeUndefined();
  });

  it('parses two-line VCR-style timestamps with space-padded date components', () => {
    // exact tesseract output for a typical camcorder OSD (time above date)
    expect(parseOcrTimestamp('7:51PM\n3/ 7/93\n')?.value).toBe('1993-03-07 19:51');
    expect(parseOcrTimestamp('3/ 7/93')?.value).toBe('1993-03-07');
    expect(parseOcrTimestamp('3/ 7/93', { dateOrder: 'DMY' })?.value).toBe('1993-07-03');
    expect(parseOcrTimestamp('12/ 4/ 95')?.value).toBe('1995-12-04');
    expect(parseOcrTimestamp('10. 5.1989 12:00')?.value).toBe('1989-10-05 12:00'); // ambiguous, auto defaults to month-first
  });

  it('survives OCR noise', () => {
    expect(parseOcrTimestamp('JUL l4 2OO3 l8:32:O5')?.value).toBe('2003-07-14 18:32:05');
    expect(parseOcrTimestamp('2OO3/O7/l4')?.value).toBe('2003-07-14');
  });

  it('rejects invalid dates and times', () => {
    expect(parseOcrTimestamp('32/13/2003')).toBeUndefined();
    expect(parseOcrTimestamp('25:70')).toBeUndefined();
    expect(parseOcrTimestamp('FEB 30 2003')).toBeUndefined();
  });

  it('returns undefined for garbage and empty input', () => {
    expect(parseOcrTimestamp('')).toBeUndefined();
    expect(parseOcrTimestamp('   \n ')).toBeUndefined();
    expect(parseOcrTimestamp('no timestamp here')).toBeUndefined();
    expect(parseOcrTimestamp('REC')).toBeUndefined();
  });

  it('uses a custom luxon format when given', () => {
    expect(parseOcrTimestamp('14.07.2003 18:32:05', { customFormat: 'dd.MM.yyyy HH:mm:ss' })?.value).toBe('2003-07-14 18:32:05');
    expect(parseOcrTimestamp('garbage', { customFormat: 'dd.MM.yyyy HH:mm:ss' })).toBeUndefined();
  });
});

describe('sanitizeTagValue', () => {
  it('strips control chars and collapses whitespace', () => {
    expect(sanitizeTagValue(' 2003-07-14\n18:32 ')).toBe('2003-07-14 18:32');
  });
});

describe('toFfmpegCreationTime', () => {
  // asserted as a round trip so the test holds in any timezone: the stored UTC instant must
  // come back as the same wall clock the camera burned in, which is what Explorer/players show
  it('stores the instant that displays as the original wall clock locally', () => {
    const iso = toFfmpegCreationTime('1995-10-12 05:42');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const back = new Date(iso!);
    expect([back.getFullYear(), back.getMonth() + 1, back.getDate()]).toEqual([1995, 10, 12]);
    expect([back.getHours(), back.getMinutes()]).toEqual([5, 42]);
  });

  it('keeps seconds when they are known', () => {
    const back = new Date(toFfmpegCreationTime('2003-07-14 18:32:05')!);
    expect([back.getHours(), back.getMinutes(), back.getSeconds()]).toEqual([18, 32, 5]);
  });

  it('returns undefined when there is no complete date and time', () => {
    expect(toFfmpegCreationTime(undefined)).toBeUndefined();
    expect(toFfmpegCreationTime('1993-03-07')).toBeUndefined();
    expect(toFfmpegCreationTime('19:51')).toBeUndefined();
    expect(toFfmpegCreationTime('not a timestamp')).toBeUndefined();
  });
});
