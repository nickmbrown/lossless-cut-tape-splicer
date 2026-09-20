import type { FormEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TextField } from '@radix-ui/themes';

import * as Dialog from './Dialog';
import { DialogButton } from './Button';
import Checkbox from './Checkbox';
import { useGenericDialogContext } from './GenericDialog';
import type { ShowGenericDialog } from './GenericDialog';
import { safeCreateBlob } from '../ffmpeg';
import { sanitizeTagValue, splitTimestampValue } from '../util/ocrTimestamp';

// <input type="datetime-local"> speaks "YYYY-MM-DDTHH:mm[:ss]"; tags keep the friendlier
// "YYYY-MM-DD HH:mm[:ss]" form that is already used in existing projects
const toInputValue = (value: string | undefined) => {
  if (value == null) return '';
  const { date, time } = splitTimestampValue(value);
  return date != null && time != null ? `${date}T${time}` : '';
};

const fromInputValue = (value: string) => value.replace('T', ' ');

// show a seconds field only when we actually know the seconds
const hasSeconds = (value: string | undefined) => (value != null && (splitTimestampValue(value).time?.length ?? 0) > 5);

export interface OcrReviewRow {
  segId: string,
  label: string,
  timecode: string,
  start: number,
  image: Uint8Array | undefined, // absent when resuming from saved tags rather than a detection run
  rawText: string,
  parsedValue: string | undefined,
  partialValue: string | undefined, // e.g. a time whose date could not be determined
  estimated: boolean, // filled in from neighbouring clips rather than read by OCR
  outOfOrder: boolean, // contradicts a neighbouring clip - probably an OCR misread
}

export interface OcrReviewResult {
  segId: string,
  value: string,
}

export type OcrRowStates = Record<string, { include: boolean, value: string }>;

// The editor can be left and come back to: "close" keeps the detected rows (and any edits) alive
// in the caller, and "seek" closes it so the user can scrub the timeline for that segment.
export type OcrReviewOutcome =
  | { action: 'write', results: OcrReviewResult[] }
  | { action: 'seek', segId: string }
  | { action: 'close' };

// per-segment review of OCR results before they get written to segment tags
export default async function openOcrReviewDialog({ showGenericDialog, rows, tagName, initialStates, onStateSnapshot }: {
  showGenericDialog: ShowGenericDialog,
  rows: OcrReviewRow[],
  tagName: string,
  initialStates?: OcrRowStates | undefined,
  // called with the latest edits whenever the dialog goes away, so they survive a close/reopen
  onStateSnapshot: (states: OcrRowStates) => void,
}) {
  return new Promise<OcrReviewOutcome>((resolve) => {
    function OcrReviewDialog() {
      const { t } = useTranslation();
      const { onOpenChange } = useGenericDialogContext();

      const [rowStates, setRowStates] = useState<OcrRowStates>(() => Object.fromEntries(rows.map((row) => [
        row.segId,
        initialStates?.[row.segId] ?? { include: row.parsedValue != null, value: toInputValue(row.parsedValue) },
      ])));

      // mirror into a ref so the unmount cleanup can report the final edits without
      // re-running (and without pushing a state update on every keystroke to the caller)
      const rowStatesRef = useRef(rowStates);
      rowStatesRef.current = rowStates;
      useEffect(() => () => onStateSnapshot(rowStatesRef.current), []);

      const [zoomedSegId, setZoomedSegId] = useState<string>();

      const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
      // keyed by url, not by segment: a stale error from a url that has already been replaced
      // must not mark the row as broken
      const [failedUrls, setFailedUrls] = useState<Record<string, true>>({});

      // Create the object URLs inside the effect that revokes them, so that creation and
      // revocation always stay paired. (Creating them in a useMemo/useState initializer instead
      // breaks under React StrictMode, which mounts, unmounts and remounts components in
      // development: the cleanup revokes the URLs, but the memo never re-runs to recreate them.)
      useEffect(() => {
        const urls = Object.fromEntries(rows.flatMap((row) => (row.image != null && row.image.length > 0
          ? [[row.segId, URL.createObjectURL(safeCreateBlob(row.image, { type: 'image/png' }))]]
          : [])));
        setImageUrls(urls);
        return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
        // `rows` is fixed for the lifetime of the dialog (it comes from the enclosing scope)
      }, []);

      const setRowState = useCallback((segId: string, newProps: Partial<{ include: boolean, value: string }>) => {
        setRowStates((existing) => ({ ...existing, [segId]: { ...existing[segId]!, ...newProps } }));
      }, []);

      const includedRows = rows.filter((row) => {
        const state = rowStates[row.segId];
        return state != null && state.include && sanitizeTagValue(state.value).length > 0;
      });

      const handleSubmit = useCallback((e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        resolve({ action: 'write', results: includedRows.map((row) => ({ segId: row.segId, value: sanitizeTagValue(fromInputValue(rowStates[row.segId]!.value)) })) });
        onOpenChange(false);
      }, [includedRows, onOpenChange, rowStates]);

      return (
        <Dialog.Content
          aria-describedby={undefined}
          style={{ width: '80vw' }}
          onEscapeKeyDown={(e) => {
            // Esc while zoomed closes only the zoomed image, not the whole review
            if (zoomedSegId != null) {
              e.preventDefault();
              setZoomedSegId(undefined);
            }
          }}
        >
          <Dialog.Title>{t('OCR timestamps')}</Dialog.Title>

          <Dialog.Description>{t('Review the detected timestamps below. Uncheck rows to skip them, or edit the values before writing them to the segment tags.')}</Dialog.Description>

          <p style={{ opacity: 0.7, fontSize: '.9em', marginTop: 0 }}>
            {t('Closing keeps these results: reopen them any time with Tools → Review OCR timestamps, without detecting again. Click a segment timecode to jump there and scrub the footage.')}
          </p>

          <form onSubmit={handleSubmit}>
            <div style={{ maxHeight: '50vh', overflowY: 'auto', marginBottom: '1em' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                    <th aria-label={t('Include')} />
                    <th style={{ padding: '.2em .5em' }}>{t('Segment')}</th>
                    <th style={{ padding: '.2em .5em' }}>{t('Image')}</th>
                    <th style={{ padding: '.2em .5em' }}>{t('Detected text')}</th>
                    <th style={{ padding: '.2em .5em' }}>{t('Value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const state = rowStates[row.segId]!;
                    const imageUrl = imageUrls[row.segId];
                    return (
                      <tr key={row.segId} style={{ borderTop: '1px solid var(--gray-6)', opacity: state.include ? undefined : 0.5 }}>
                        <td style={{ padding: '.3em .5em' }}>
                          <Checkbox checked={state.include} onCheckedChange={(checked) => setRowState(row.segId, { include: checked === true })} />
                        </td>
                        <td style={{ padding: '.3em .5em', whiteSpace: 'nowrap' }}>
                          <div>{row.label}</div>
                          <button
                            type="button"
                            className="link-button"
                            title={t('Close the editor and jump to this segment, so you can scrub the footage')}
                            onClick={() => { resolve({ action: 'seek', segId: row.segId }); onOpenChange(false); }}
                            style={{ opacity: 0.6, fontSize: '.85em', padding: 0 }}
                          >
                            {row.timecode}
                          </button>
                        </td>
                        <td style={{ padding: '.3em .5em' }}>
                          {row.image == null || row.image.length === 0 ? (
                            <span style={{ opacity: 0.5 }} title={t('No preview: these values were loaded from the saved segment tags')}>—</span>
                          ) : (imageUrl != null && failedUrls[imageUrl] ? (
                            // surfaces *why* a preview is missing instead of showing an empty cell
                            <span style={{ opacity: 0.6, fontSize: '.85em', whiteSpace: 'nowrap' }}>
                              {t('Preview unavailable ({{bytes}} bytes)', { bytes: row.image.length })}
                            </span>
                          ) : (
                            <button
                              type="button"
                              title={t('Click to enlarge')}
                              onClick={() => setZoomedSegId(row.segId)}
                              style={{ background: 'none', border: 'none', padding: 0, cursor: 'zoom-in', display: 'block' }}
                            >
                              <img src={imageUrl} alt="" onError={() => setFailedUrls((existing) => ({ ...existing, [imageUrl!]: true }))} style={{ maxWidth: '18em', maxHeight: '4.5em', display: 'block' }} />
                            </button>
                          ))}
                        </td>
                        <td style={{ padding: '.3em .5em', maxWidth: '12em' }}>
                          <div style={{ fontFamily: 'monospace', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.rawText.trim() || `<${t('empty')}>`}
                          </div>
                          {row.estimated && (
                            <div style={{ fontSize: '.8em', color: 'var(--amber-11)', whiteSpace: 'nowrap' }} title={t('Estimated from the clips before and after it, because OCR could not read this one')}>
                              {t('Estimated')}
                            </div>
                          )}
                          {row.outOfOrder && (
                            <div style={{ fontSize: '.8em', color: 'var(--red-11)', whiteSpace: 'nowrap' }} title={t('This timestamp is not in chronological order with its neighbours, so it was probably misread')}>
                              {t('Out of order')}
                            </div>
                          )}
                          {row.partialValue != null && (
                            <div style={{ fontSize: '.8em', opacity: 0.7 }}>
                              {t('Only read: {{value}}', { value: row.partialValue })}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '.3em .5em' }}>
                          <TextField.Root
                            type="datetime-local"
                            step={hasSeconds(row.parsedValue) ? 1 : 60}
                            value={state.value}
                            onChange={(e) => setRowState(row.segId, { value: e.target.value, ...(e.target.value !== '' && { include: true }) })}
                            style={{ minWidth: '13em' }}
                          />
                          {state.value === '' && (
                            <div style={{ fontSize: '.8em', opacity: 0.7 }}>{t('No timestamp detected')}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Dialog.ButtonRow>
              <Dialog.Close asChild>
                <DialogButton>{t('Close')}</DialogButton>
              </Dialog.Close>

              <DialogButton type="submit" primary disabled={includedRows.length === 0}>
                {t('Write tag {{tagName}} to {{count}} segments', { tagName, count: includedRows.length })}
              </DialogButton>
            </Dialog.ButtonRow>
          </form>

          {zoomedSegId != null && (
            <div
              role="button"
              onClick={() => setZoomedSegId(undefined)}
              style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1em', cursor: 'zoom-out', zIndex: 10, padding: '2em' }}
            >
              <img src={imageUrls[zoomedSegId]} alt="" style={{ maxWidth: '100%', maxHeight: '70%', objectFit: 'contain' }} />
              <div style={{ fontSize: '1.6em', fontFamily: 'monospace', color: 'var(--gray-12)' }}>
                {fromInputValue(rowStates[zoomedSegId]?.value ?? '') || `<${t('empty')}>`}
              </div>
              <div style={{ opacity: 0.6 }}>{t('Click to close')}</div>
            </div>
          )}
        </Dialog.Content>
      );
    }

    showGenericDialog({
      render: () => <OcrReviewDialog />,
      onClose: () => resolve({ action: 'close' }),
    });
  });
}
