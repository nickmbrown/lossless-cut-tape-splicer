// eslint-disable-next-line import/no-extraneous-dependencies
import { describe, it, expect } from 'vitest';

import { createSceneSegmenter } from './sceneDetection.js';
import type { DetectedSegment } from './sceneDetection.js';

function run({ from = 0, to = 100, minSegmentLength = 0, boundaries }: {
  from?: number, to?: number, minSegmentLength?: number, boundaries: number[],
}) {
  const segments: DetectedSegment[] = [];
  const segmenter = createSceneSegmenter({ from, to, minSegmentLength, onSegment: (segment) => segments.push(segment) });
  boundaries.forEach((b) => segmenter.addBoundary(b));
  segmenter.finish();
  return segments;
}

describe('createSceneSegmenter', () => {
  it('covers the scenes before the first and after the last boundary', () => {
    // the old behaviour emitted only [10,20] and [20,30], silently dropping both ends
    expect(run({ to: 40, boundaries: [10, 20, 30] })).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 30 },
      { start: 30, end: 40 },
    ]);
  });

  it('emits the whole range when nothing was detected', () => {
    expect(run({ to: 40, boundaries: [] })).toEqual([{ start: 0, end: 40 }]);
  });

  it('works within a sub-range rather than from zero', () => {
    expect(run({ from: 100, to: 130, boundaries: [110] })).toEqual([
      { start: 100, end: 110 },
      { start: 110, end: 130 },
    ]);
  });

  it('ignores boundaries that would make a segment shorter than the minimum', () => {
    // 10.1 and 10.2 are a burst of noise at one cut, not three separate scenes
    expect(run({ to: 40, minSegmentLength: 1, boundaries: [10, 10.1, 10.2, 20] })).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 20 },
      { start: 20, end: 40 },
    ]);
  });

  it('keeps a short tail attached to the previous scene instead of emitting a sliver', () => {
    expect(run({ to: 40, minSegmentLength: 1, boundaries: [10, 39.8] })).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 40 },
    ]);
  });

  it('ignores a boundary too close to the start of the range', () => {
    expect(run({ to: 40, minSegmentLength: 2, boundaries: [0.5, 10] })).toEqual([
      { start: 0, end: 10 },
      { start: 10, end: 40 },
    ]);
  });

  it('ignores boundaries outside the range', () => {
    expect(run({ from: 10, to: 20, boundaries: [5, 10, 20, 25] })).toEqual([{ start: 10, end: 20 }]);
  });

  it('never emits a segment shorter than the minimum, whatever arrives', () => {
    const segments = run({ to: 30, minSegmentLength: 3, boundaries: [1, 2, 3, 4, 12, 12.5, 13, 28, 29] });
    expect(segments.every((segment) => segment.end - segment.start >= 3)).toBe(true);
    // 1 and 2 are too early; 3 is the first boundary clearing the minimum, and 28/29 would
    // leave a sliver at the end so they are ignored too
    expect(segments).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 12 },
      { start: 12, end: 30 },
    ]);
  });
});
