// eslint-disable-line unicorn/filename-case
import i18n from 'i18next';

const parametersRaw = {
  blackdetect: {
    black_min_duration: {
      value: '2.0',
      hint: () => i18n.t('Set the minimum detected black duration expressed in seconds. It must be a non-negative floating point number.'),
    },
    picture_black_ratio_th: {
      value: '0.98',
      hint: () => i18n.t('Set the threshold for considering a picture "black".'),
    },
    pixel_black_th: {
      value: '0.10',
      hint: () => i18n.t('Set the threshold for considering a pixel "black".'),
    },
    mode: {
      value: '1',
      hint: () => i18n.t('Segment mode: "{{mode1}}" will create segments bounding the black sections. "{{mode2}}" will create segments that start/stop at the center of each black section.', { mode1: '1', mode2: '2' }),
    },
  },
  silencedetect: {
    noise: {
      value: '-60dB',
      hint: () => i18n.t('Set noise tolerance. Can be specified in dB (in case "dB" is appended to the specified value) or amplitude ratio. Default is -60dB, or 0.001.'),
    },
    duration: {
      value: '2.0',
      hint: () => i18n.t('Set minimum silence duration that will be converted into a segment.'),
    },
    mode: {
      value: '1',
      hint: () => i18n.t('Segment mode: "{{mode1}}" will create segments bounding the silent sections. "{{mode2}}" will create segments that start/stop at the center of each silent section.', { mode1: '1', mode2: '2' }),
    },
  },
  sceneChange: {
    minChange: {
      value: '0.3',
      hint: () => i18n.t('How much two frames must differ in brightness or colour to count as a new scene, from 0 to 1. A value between 0.3 and 0.5 is generally a sane choice; lower it if cuts are being missed.'),
    },
    minSegmentLength: {
      value: '1',
      hint: () => i18n.t('Minimum length in seconds of a detected segment. Scene changes closer together than this are ignored, which avoids a handful of noisy frames at a cut turning into their own tiny segment.'),
    },
  },
  ocrTimestamp: {
    tagName: {
      value: 'recordedAt',
      hint: () => i18n.t('Name of the segment tag to write the timestamp to.'),
    },
    frameOffset: {
      value: '1.0',
      hint: () => i18n.t('How many seconds into each segment to capture the frame used for OCR (to avoid transition frames at the segment start).'),
    },
    dateOrder: {
      value: 'auto',
      hint: () => i18n.t('How to interpret ambiguous numeric dates like 01/02/2003: "auto", "DMY" (day first), "MDY" (month first) or "YMD" (year first).'),
    },
    customFormat: {
      value: '',
      hint: () => i18n.t('Optional: a date/time format to parse the OCR text with (e.g. "dd.MM.yyyy HH:mm:ss"), overriding automatic detection. Leave empty for automatic detection.'),
    },
  },
};

export type FfmpegDialog = keyof typeof parametersRaw;

// widen types
export const parameters: Record<FfmpegDialog, Record<string, { value: string, hint?: () => string, label?: string }>> = parametersRaw;

export const getHint = (dialogType: FfmpegDialog, param: string) => parameters[dialogType][param]?.hint?.();
export const getLabel = (dialogType: FfmpegDialog, param: string) => parameters[dialogType][param]?.label;
