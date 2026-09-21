export interface DetectedSegment {
  start: number,
  end: number,
}

/**
 * Turns detected scene-change boundaries into segments.
 *
 * Boundaries arrive one at a time while ffmpeg is still running, so segments are emitted as
 * soon as they are complete rather than all at the end. Two rules apply:
 *
 * - the whole range is covered, including the scene before the first boundary and the one
 *   after the last (those used to be dropped entirely)
 * - a boundary that would carve off a sliver shorter than `minSegmentLength` is ignored, at
 *   either end, so a handful of noisy frames at a tape cut cannot produce a 3-frame segment
 */
export function createSceneSegmenter({ from, to, minSegmentLength, onSegment }: {
  from: number,
  to: number,
  minSegmentLength: number,
  onSegment: (segment: DetectedSegment) => void,
}) {
  let segmentStart = from;

  return {
    /** @param boundary absolute time of a detected scene change */
    addBoundary(boundary: number) {
      if (boundary <= segmentStart || boundary >= to) return;
      // too close to the previous cut, or would leave too short a remainder at the end
      if (boundary - segmentStart < minSegmentLength || to - boundary < minSegmentLength) return;

      onSegment({ start: segmentStart, end: boundary });
      segmentStart = boundary;
    },

    /** emits the final scene; call once ffmpeg has finished */
    finish() {
      if (to > segmentStart) onSegment({ start: segmentStart, end: to });
    },
  };
}
