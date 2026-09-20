import { join } from 'node:path';
import { createRequire } from 'node:module';
// eslint-disable-next-line import/no-extraneous-dependencies
import { app } from 'electron';

import { captureFrameToBuffer } from './ffmpeg.js';
import logger from './logger.js';

// tesseract.js is CJS with a non-statically-analyzable export object, so import it via require
// (this also gives us require.resolve for locating the worker script)
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createWorker, PSM } = require('tesseract.js') as typeof import('tesseract.js');

// digits, date/time separators, and the letters needed for month abbreviations and AM/PM
const defaultCharWhitelist = "0123456789:./-' ABCDEFGJLMNOPRSTUVY";

function getTessdataPath() {
  // eng.traineddata.gz is shipped via electron-builder extraResources (like locales)
  if (app.isPackaged) return join(process.resourcesPath, 'tessdata');
  return 'tessdata';
}

// worker_threads scripts cannot be loaded from inside app.asar (tesseract.js is asarUnpack'ed)
const fixAsarPath = (path: string) => path.replace('app.asar', 'app.asar.unpacked');

type TesseractWorker = Awaited<ReturnType<typeof createWorker>>;

let workerPromise: Promise<TesseractWorker> | undefined;

async function getWorker() {
  if (workerPromise == null) {
    workerPromise = (async () => {
      const worker = await createWorker('eng', undefined, {
        langPath: getTessdataPath(),
        gzip: true,
        cacheMethod: 'none', // read straight from langPath, never write a cache
        workerPath: fixAsarPath(require.resolve('tesseract.js/src/worker-script/node/index.js')),
        logger: (message) => logger.debug('tesseract', message),
      });
      await worker.setParameters({
        // camcorder/VCR timestamps are often two lines (time above date);
        // SINGLE_LINE fails badly on those
        tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      });
      return worker;
    })();
    // allow retrying if initialization fails (e.g. missing traineddata)
    workerPromise.catch(() => {
      workerPromise = undefined;
    });
  }
  return workerPromise;
}

export async function terminateOcrWorker() {
  const promise = workerPromise;
  workerPromise = undefined;
  if (promise != null) {
    try {
      const worker = await promise;
      await worker.terminate();
    } catch (err) {
      logger.warn('Failed to terminate OCR worker', err);
    }
  }
}

export async function captureFrameAndOcr({ videoPath, timestamp, filter, charWhitelist = defaultCharWhitelist }: {
  videoPath: string,
  timestamp: number,
  filter?: string | undefined,
  charWhitelist?: string | undefined,
}) {
  const { buffer, ffmpegArgs } = await captureFrameToBuffer({ timestamp, videoPath, filter });
  const worker = await getWorker();
  await worker.setParameters({ tessedit_char_whitelist: charWhitelist });
  const { data } = await worker.recognize(buffer);
  return {
    text: data.text,
    confidence: data.confidence,
    image: buffer,
    ffmpegArgs,
  };
}
