export interface OcrCaptureResult {
  text: string,
  confidence: number,
  // Buffer in the main process; over @electron/remote it arrives as a (possibly resizable)
  // Uint8Array - pass it through safeCreateBlob before use in the DOM
  image: Uint8Array,
  ffmpegArgs: string[],
}

const { ocr } = window.require('@electron/remote').require('./index.js') as {
  ocr: {
    captureFrameAndOcr: (params: {
      videoPath: string,
      timestamp: number,
      filter?: string | undefined,
      charWhitelist?: string | undefined,
    }) => Promise<OcrCaptureResult>,
    terminateOcrWorker: () => Promise<void>,
  },
};

export const { captureFrameAndOcr, terminateOcrWorker } = ocr;
