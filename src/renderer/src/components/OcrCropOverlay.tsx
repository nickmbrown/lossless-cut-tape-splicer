import type { CSSProperties, MouseEventHandler, RefObject } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { OcrCropRect } from '../../../common/types';

// the result of a marquee interaction:
// undefined = cancelled (Esc), { rect: undefined } = cleared (click without dragging), { rect } = drawn
export type OcrCropResult = { rect: OcrCropRect | undefined } | undefined;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

// display rect of the video content inside the overlay (letterboxing compensated),
// in coordinates relative to the overlay element
function getContentRect(overlay: HTMLElement, video: HTMLVideoElement) {
  const rect = overlay.getBoundingClientRect();
  const { videoWidth, videoHeight } = video;
  if (videoWidth === 0 || videoHeight === 0 || rect.width === 0 || rect.height === 0) return undefined;
  // <video> uses object-fit: contain
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { left: (rect.width - width) / 2, top: (rect.height - height) / 2, width, height };
}

function OcrCropOverlay({ videoRef, existingRect, onComplete }: {
  videoRef: RefObject<HTMLVideoElement | null>,
  existingRect: OcrCropRect | undefined,
  onComplete: (result: OcrCropResult) => void,
}) {
  const { t } = useTranslation();

  const overlayRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef<{ x: number, y: number } | undefined>(undefined);
  const [dragRect, setDragRect] = useState<OcrCropRect | undefined>();
  const [contentRect, setContentRect] = useState<{ left: number, top: number, width: number, height: number } | undefined>();

  const updateContentRect = useCallback(() => {
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (overlay == null || video == null) return;
    setContentRect(getContentRect(overlay, video));
  }, [videoRef]);

  useLayoutEffect(() => {
    updateContentRect();
    window.addEventListener('resize', updateContentRect);
    return () => window.removeEventListener('resize', updateContentRect);
  }, [updateContentRect]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onComplete(undefined);
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [onComplete]);

  // mouse position normalized (0..1) to the video content
  const getNormalizedPos = useCallback((e: MouseEvent) => {
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (overlay == null || video == null) return undefined;
    const content = getContentRect(overlay, video);
    if (content == null) return undefined;
    const overlayRect = overlay.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - overlayRect.left - content.left) / content.width),
      y: clamp01((e.clientY - overlayRect.top - content.top) / content.height),
    };
  }, [videoRef]);

  const onMouseDown = useCallback<MouseEventHandler<HTMLElement>>((e) => {
    if (e.nativeEvent.buttons !== 1) return; // not primary button
    const start = getNormalizedPos(e.nativeEvent);
    if (start == null) return;
    dragStartRef.current = start;

    const makeRect = (end: { x: number, y: number }): OcrCropRect => ({
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    });

    function onMouseMove(e2: MouseEvent) {
      if (dragStartRef.current == null) return;
      const pos = getNormalizedPos(e2);
      if (pos != null) setDragRect(makeRect(pos));
    }

    function onMouseUp(e2: MouseEvent) {
      window.removeEventListener('mousemove', onMouseMove);
      if (dragStartRef.current == null) return;
      dragStartRef.current = undefined;
      setDragRect(undefined);
      const pos = getNormalizedPos(e2);
      if (pos == null) {
        onComplete(undefined);
        return;
      }
      const rect = makeRect(pos);
      // a click without a meaningful drag means "clear the region" (OCR the full frame)
      const tooSmall = rect.width < 0.005 || rect.height < 0.005;
      onComplete({ rect: tooSmall ? undefined : rect });
    }

    // https://stackoverflow.com/questions/11533098/how-to-catch-mouse-up-event-outside-of-element
    window.addEventListener('mouseup', onMouseUp, { once: true });
    window.addEventListener('mousemove', onMouseMove);
  }, [getNormalizedPos, onComplete]);

  const rectToStyle = useCallback((rect: OcrCropRect): CSSProperties | undefined => {
    if (contentRect == null) return undefined;
    return {
      position: 'absolute',
      left: contentRect.left + rect.x * contentRect.width,
      top: contentRect.top + rect.y * contentRect.height,
      width: rect.width * contentRect.width,
      height: rect.height * contentRect.height,
    };
  }, [contentRect]);

  const existingRectStyle = existingRect != null && dragRect == null ? rectToStyle(existingRect) : undefined;
  const dragRectStyle = dragRect != null ? rectToStyle(dragRect) : undefined;

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={overlayRef}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, cursor: 'crosshair', backgroundColor: 'rgba(0,0,0,0.3)', zIndex: 1 }}
      onMouseDown={onMouseDown}
    >
      <div style={{ position: 'absolute', top: '1em', left: 0, right: 0, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ backgroundColor: 'var(--gray-2)', color: 'var(--gray-12)', borderRadius: '.5em', padding: '.5em 1em', maxWidth: '80%', textAlign: 'center' }}>
          {t('Drag a rectangle around the burned-in timestamp. Click without dragging to clear the region (OCR the whole frame). Press Esc to cancel.')}
        </div>
      </div>

      {existingRectStyle != null && (
        <div style={{ ...existingRectStyle, border: '2px dashed var(--gray-10)', pointerEvents: 'none' }} />
      )}

      {dragRectStyle != null && (
        <div style={{ ...dragRectStyle, border: '2px solid var(--red-9)', backgroundColor: 'rgba(255,255,255,0.1)', pointerEvents: 'none' }} />
      )}
    </div>
  );
}

export default memo(OcrCropOverlay);
