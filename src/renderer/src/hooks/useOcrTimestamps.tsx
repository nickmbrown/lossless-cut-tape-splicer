import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import i18n from 'i18next';
import invariant from 'tiny-invariant';

import { captureFrameAndOcr } from '../ocr';
import { parseOcrTimestamp } from '../util/ocrTimestamp';
import { inferTimestamps } from '../util/ocrTimestampInference';
import type { DateOrder } from '../util/ocrTimestamp';
import openOcrReviewDialog from '../components/OcrReviewDialog';
import type { OcrReviewRow, OcrRowStates } from '../components/OcrReviewDialog';
import type { ShowGenericDialog } from '../components/GenericDialog';
import type { OcrCropResult } from '../components/OcrCropOverlay';
import { errorToast } from '../swal';
import { getSegmentTags } from '../segments';
import type { FormatTimecode, StateSegment } from '../types';
import type { OcrCropRect } from '../../../common/types';
import type { FfmpegDialog } from '../ffmpegParameters';

const dateOrders = new Set<DateOrder>(['auto', 'DMY', 'MDY', 'YMD']);

// crop to the user-drawn region (expressed relative to the frame so we never need intrinsic pixel sizes),
// upscale (helps tesseract with small analog-era timestamps) and grayscale
function buildOcrFilter(rect: OcrCropRect | undefined) {
  if (rect == null) return 'scale=iw*2:ih*2:flags=lanczos,format=gray';
  const num = (n: number) => n.toFixed(4);
  return `crop=iw*${num(rect.width)}:ih*${num(rect.height)}:iw*${num(rect.x)}:ih*${num(rect.y)},scale=iw*4:ih*4:flags=lanczos,format=gray`;
}

function formatRegionDescription(rect: OcrCropRect | undefined) {
  if (rect == null) return i18n.t('Whole frame');
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return i18n.t('Region: {{width}}×{{height}} at {{x}}, {{y}}', { width: pct(rect.width), height: pct(rect.height), x: pct(rect.x), y: pct(rect.y) });
}

export default function useOcrTimestamps({ filePath, workingRef, setWorking, setProgress, fileDuration, selectedSegments, safeSetCutSegments, showParametersDialog, getFfmpegParameters, setFfmpegParametersForDialog, showGenericDialog, ocrCropRect, setOcrCropRect, armOcrMarquee, compatPlayerEnabled, seekAbs, formatTimecode, appendFfmpegCommandLog, handleError, ocrTimestampTagName, setOcrTimestampTagName }: {
  filePath: string | undefined,
  workingRef: MutableRefObject<boolean>,
  setWorking: (w: { text: string, abortController?: AbortController } | undefined) => void,
  setProgress: (p: number | undefined) => void,
  fileDuration: number | undefined,
  selectedSegments: StateSegment[],
  safeSetCutSegments: (updater: (existing: StateSegment[]) => StateSegment[]) => void,
  showParametersDialog: (a: {
    title?: string,
    description?: string,
    dialogType: FfmpegDialog,
    parameters: Record<string, string>,
    docUrl?: string,
    extra?: { label: string, description?: string, onClick: () => void },
  }) => Promise<Record<string, string> | undefined>,
  getFfmpegParameters: (key: FfmpegDialog) => Record<string, string>,
  setFfmpegParametersForDialog: (dialogType: FfmpegDialog, newParameters: Record<string, string>) => void,
  showGenericDialog: ShowGenericDialog,
  ocrCropRect: OcrCropRect | undefined,
  setOcrCropRect: (rect: OcrCropRect | undefined) => void,
  armOcrMarquee: () => Promise<OcrCropResult>,
  compatPlayerEnabled: boolean,
  seekAbs: (a: number) => void,
  formatTimecode: FormatTimecode,
  appendFfmpegCommandLog: (args: string[]) => void,
  handleError: (a: { err: unknown, title: string }) => void,
  // persisted so that export knows which tag holds the recording time
  ocrTimestampTagName: string,
  setOcrTimestampTagName: (name: string) => void,
}) {
  // Detected rows outlive the dialog so the user can close it, scrub the timeline, and come
  // back without re-running OCR. Kept in a ref: nothing in the UI renders from it, and it must
  // not re-render the app on every keystroke in the editor.
  const pendingReviewRef = useRef<{ rows: OcrReviewRow[], tagName: string, states: OcrRowStates | undefined } | undefined>(undefined);

  // results belong to the file they were detected from
  useEffect(() => {
    pendingReviewRef.current = undefined;
  }, [filePath]);

  const openReview = useCallback(async () => {
    const pending = pendingReviewRef.current;
    if (pending == null) return;

    const outcome = await openOcrReviewDialog({
      showGenericDialog,
      rows: pending.rows,
      tagName: pending.tagName,
      initialStates: pending.states,
      onStateSnapshot: (states) => {
        if (pendingReviewRef.current != null) pendingReviewRef.current.states = states;
      },
    });

    if (outcome.action === 'seek') {
      const row = pending.rows.find((r) => r.segId === outcome.segId);
      if (row != null) seekAbs(row.start);
      return;
    }

    if (outcome.action === 'write' && outcome.results.length > 0) {
      const valueBySegId = new Map(outcome.results.map((result) => [result.segId, result.value]));
      // a single state write: one undo step for the whole batch
      safeSetCutSegments((existing) => existing.map((segment) => {
        const value = valueBySegId.get(segment.segId);
        if (value == null) return segment;
        return { ...segment, tags: { ...getSegmentTags(segment), [pending.tagName]: value } };
      }));
      // the rows stay available, so a mistake can be corrected without detecting again
    }
  }, [safeSetCutSegments, seekAbs, showGenericDialog]);

  // Rebuild an editing session from timestamps already saved on the segments, so that reopening
  // a project (where the in-memory session is gone) still picks up where the user left off.
  // There are no frame previews here - this reads tags, it does not run OCR again.
  const buildReviewFromTags = useCallback((tagName: string) => {
    const chronological = [...selectedSegments].sort((a, b) => a.start - b.start);
    const savedValues = chronological.map((segment) => getSegmentTags(segment)[tagName]);
    if (savedValues.every((value) => value == null || value.trim() === '')) return undefined;

    // run the same inference over the saved values, so clips still missing a timestamp get an
    // estimate from their neighbours instead of coming back empty
    const inferred = inferTimestamps(savedValues.map((value) => (value != null && value.trim() !== '' ? value.trim() : undefined)));

    const rows: OcrReviewRow[] = chronological.map((segment, i) => {
      const { value, partial, estimated, outOfOrder } = inferred[i]!;
      const saved = savedValues[i];
      return {
        segId: segment.segId,
        label: segment.name || String(i + 1),
        timecode: formatTimecode({ seconds: segment.start, shorten: true }),
        start: segment.start,
        image: undefined,
        rawText: saved ?? '',
        parsedValue: value,
        partialValue: partial,
        estimated,
        outOfOrder,
      };
    });
    return { rows, tagName, states: undefined };
  }, [formatTimecode, selectedSegments]);

  // reopen the editor: the last detection run if we still have it, otherwise the saved tags
  const reviewOcrTimestamps = useCallback(async () => {
    if (workingRef.current) return;

    if (pendingReviewRef.current == null) {
      if (selectedSegments.length === 0) {
        errorToast(i18n.t('No segments are selected'));
        return;
      }
      const fromTags = buildReviewFromTags(ocrTimestampTagName);
      if (fromTags == null) {
        errorToast(i18n.t('No timestamps to review yet. Run "OCR timestamps" first.'));
        return;
      }
      pendingReviewRef.current = fromTags;
    }

    await openReview();
  }, [buildReviewFromTags, ocrTimestampTagName, openReview, selectedSegments.length, workingRef]);

  const ocrTimestamps = useCallback(async () => {
    if (filePath == null) return;
    if (workingRef.current) return;

    try {
      if (selectedSegments.length === 0) {
        errorToast(i18n.t('No segments are selected'));
        return;
      }

      const dialogType = 'ocrTimestamp';

      // the crop rect is tracked locally because the setting will not re-render this
      // callback invocation after the marquee updates it
      let cropRect = ocrCropRect;
      let parameters: Record<string, string> | undefined;

      // params dialog loop: "Draw region" closes the dialog, arms the marquee, then re-opens the dialog
      for (;;) {
        let drawRequested = false;
        // eslint-disable-next-line no-await-in-loop
        parameters = await showParametersDialog({
          title: i18n.t('OCR timestamps'),
          description: i18n.t('Read a burned-in (baked) timestamp from each selected segment using OCR, and save it to a segment tag.'),
          dialogType,
          parameters: { ...getFfmpegParameters(dialogType), tagName: ocrTimestampTagName },
          extra: {
            label: i18n.t('Draw region'),
            description: formatRegionDescription(cropRect),
            onClick: () => { drawRequested = true; },
          },
        });

        if (!drawRequested) break;

        if (compatPlayerEnabled) {
          errorToast(i18n.t('Cannot draw the OCR region while rotation preview or FFmpeg-assisted playback is active.'));
          // eslint-disable-next-line no-continue
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const marqueeResult = await armOcrMarquee();
        if (marqueeResult != null) {
          cropRect = marqueeResult.rect;
          setOcrCropRect(marqueeResult.rect);
        } // else cancelled - keep the previous region
      }

      if (parameters == null) return; // cancelled

      const tagName = parameters['tagName']?.trim();
      if (!tagName || tagName.includes('=')) {
        errorToast(i18n.t('Invalid tag name: it must not be empty and cannot contain "="'));
        return;
      }
      const frameOffsetRaw = parseFloat(parameters['frameOffset'] ?? '');
      const frameOffset = Number.isFinite(frameOffsetRaw) && frameOffsetRaw >= 0 ? frameOffsetRaw : 1;
      const dateOrder = dateOrders.has(parameters['dateOrder'] as DateOrder) ? parameters['dateOrder'] as DateOrder : 'auto';
      const { customFormat } = parameters;

      setFfmpegParametersForDialog(dialogType, parameters);
      setOcrTimestampTagName(tagName); // export reads this to write creation_time

      const abortController = new AbortController();
      setWorking({ text: i18n.t('Detecting timestamps'), abortController });
      setProgress(0);

      const rows: OcrReviewRow[] = [];
      let commandLogged = false;
      try {
        // sequential: there is a single OCR worker, and each item is one short-lived ffmpeg process
        for (const [i, segment] of selectedSegments.entries()) {
          if (abortController.signal.aborted) return;

          const segmentDuration = segment.end != null ? segment.end - segment.start : undefined;
          const baseOffset = segmentDuration != null ? Math.min(frameOffset, segmentDuration / 2) : frameOffset;

          // a single tape frame can be corrupted by transient noise (dropouts, head switching),
          // so if the timestamp does not fully parse, retry on a couple of nearby frames
          const attemptTimes = [...new Set([0, 0.7, 1.4].map((extra) => {
            const offset = segmentDuration != null ? Math.min(baseOffset + extra, Math.max(segmentDuration - 0.05, 0)) : baseOffset + extra;
            const captureTime = segment.start + offset;
            return fileDuration != null ? Math.min(captureTime, Math.max(segment.start, fileDuration - 0.1)) : captureTime;
          }))];

          let best: { rawText: string, image: Uint8Array, parsedValue: string | undefined, score: number } | undefined;
          for (const captureTime of attemptTimes) {
            if (abortController.signal.aborted) return;
            // eslint-disable-next-line no-await-in-loop
            const { text, image, ffmpegArgs } = await captureFrameAndOcr({ videoPath: filePath, timestamp: captureTime, filter: buildOcrFilter(cropRect) });
            if (!commandLogged) {
              appendFfmpegCommandLog(ffmpegArgs);
              commandLogged = true;
            }
            const parsed = parseOcrTimestamp(text, { dateOrder, customFormat });
            const score = (parsed?.hasDate ? 1 : 0) + (parsed?.hasTime ? 1 : 0);
            if (best == null || score > best.score) best = { rawText: text, image, parsedValue: parsed?.value, score };
            if (score === 2) break; // both date and time found - no need to look further
          }

          invariant(best != null);
          rows.push({
            segId: segment.segId,
            label: segment.name || String(i + 1),
            timecode: formatTimecode({ seconds: segment.start, shorten: true }),
            start: segment.start,
            image: best.image,
            rawText: best.rawText,
            parsedValue: best.parsedValue,
            partialValue: undefined,
            estimated: false,
            outOfOrder: false,
          });

          setProgress((i + 1) / selectedSegments.length);
        }
      } finally {
        setWorking(undefined);
        setProgress(undefined);
      }

      // Complete what OCR could not read, using the tape's chronology. Inference needs the rows
      // in chronological order, which is segment start order (not necessarily selection order).
      const chronological = [...rows].sort((a, b) => a.start - b.start);
      const inferred = inferTimestamps(chronological.map((row) => row.parsedValue));
      const reviewRows = chronological.map((row, i) => {
        const { value, partial, estimated, outOfOrder } = inferred[i]!;
        return { ...row, parsedValue: value, partialValue: partial, estimated, outOfOrder };
      });

      pendingReviewRef.current = { rows: reviewRows, tagName, states: undefined };
      await openReview();
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      handleError({ err, title: i18n.t('Failed to OCR timestamps') });
    }
  }, [filePath, workingRef, selectedSegments, ocrCropRect, showParametersDialog, getFfmpegParameters, setFfmpegParametersForDialog, setWorking, setProgress, compatPlayerEnabled, armOcrMarquee, setOcrCropRect, fileDuration, appendFfmpegCommandLog, formatTimecode, handleError, openReview, ocrTimestampTagName, setOcrTimestampTagName]);

  return { ocrTimestamps, reviewOcrTimestamps };
}
