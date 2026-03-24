import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Jimp from 'jimp';

const OCR_UPSCALE_THRESHOLD = 1600;
const OCR_PASSES = [
  {
    label: 'line-balanced',
    contrast: 0.34,
    thresholdMax: null,
    invert: false,
    pageSegMode: '6',
    binary: false,
  },
  {
    label: 'line-binary',
    contrast: 0.62,
    thresholdMax: 168,
    invert: false,
    pageSegMode: '6',
    binary: true,
  },
  {
    label: 'sparse-binary-invert',
    contrast: 0.68,
    thresholdMax: 176,
    invert: true,
    pageSegMode: '11',
    binary: true,
  },
] as const;

const PROJECT_ROOT = path.join(__dirname, '..');
const CV_OCR_DIR = path.join(PROJECT_ROOT, 'cv-ocr');

function firstExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fsSync.accessSync(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
  return '';
}

const TESS_CORE_PATH = firstExistingPath([
  (process.env.OVERLAY_FUZZ_TESS_CORE_PATH || '').trim(),
  path.join(CV_OCR_DIR, 'tesseract-core-simd.js'),
  path.join(PROJECT_ROOT, 'node_modules', 'tesseract.js-core', 'tesseract-core-simd.js'),
]);

const TRAINEDDATA_PATH = firstExistingPath([
  (process.env.OVERLAY_FUZZ_TRAINEDDATA_PATH || '').trim(),
  path.join(CV_OCR_DIR, 'eng.traineddata'),
  path.join(PROJECT_ROOT, 'eng.traineddata'),
]);

let tessModule: any = null;
let tessApi: any = null;
let initPromise: Promise<void> | null = null;

function postMessageSafe(payload: Record<string, unknown>): void {
  if (!parentPort) return;
  try {
    parentPort.postMessage(payload);
  } catch {
    // Ignore lifecycle races.
  }
}

function normalizeRecognizedText(text: unknown): string {
  if (!text) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function scoreCandidate(candidate: { text: string; confidence: number | null }): number {
  const lengthBoost = Math.min(candidate.text.length, 220) * 0.14;
  const emptyPenalty = candidate.text.length > 0 ? 0 : 42;
  return (candidate.confidence || 0) + lengthBoost - emptyPenalty;
}

function selectBestCandidate(candidates: Array<{ text: string; confidence: number | null }>): {
  text: string;
  confidence: number | null;
} {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { text: '', confidence: null };
  }

  return candidates.reduce((best, current) => {
    return scoreCandidate(current) > scoreCandidate(best) ? current : best;
  });
}

async function ensureTessApi(): Promise<void> {
  if (tessApi) {
    return;
  }

  if (!initPromise) {
    initPromise = (async () => {
      if (!TESS_CORE_PATH) {
        throw new Error(
          'Missing tesseract-core-simd.js. Put OCR files under ./cv-ocr or set OVERLAY_FUZZ_TESS_CORE_PATH.',
        );
      }

      if (!TRAINEDDATA_PATH) {
        throw new Error(
          'Missing eng.traineddata. Put OCR files under ./cv-ocr or set OVERLAY_FUZZ_TRAINEDDATA_PATH.',
        );
      }

      const coreUrl = pathToFileURL(TESS_CORE_PATH).href;
      const moduleFactory = (await import(coreUrl)).default as () => Promise<any>;
      tessModule = await moduleFactory();
      tessApi = new tessModule.TessBaseAPI();

      const langData = await fs.readFile(TRAINEDDATA_PATH);
      tessModule.FS.writeFile('eng.traineddata', langData);

      if (tessApi.Init(null, 'eng', tessModule.OEM_DEFAULT)) {
        throw new Error('Could not initialize tesseract core API.');
      }

      try {
        tessApi.SetVariable('preserve_interword_spaces', '1');
      } catch {
        // Optional runtime variable.
      }
    })();
  }

  await initPromise;
}

function ocrSetImage(bytes: Uint8Array, width: number, height: number, bytesPerPixel: number): void {
  const ptr = tessModule._malloc(bytes.byteLength);
  tessModule.HEAPU8.set(bytes, ptr);
  tessApi.SetImage(ptr, width, height, bytesPerPixel, width * bytesPerPixel);
  tessModule._free(ptr);
}

async function buildOcrBuffers(
  imageBytes: Uint8Array,
): Promise<Array<{ label: string; pageSegMode: string; bitmap: Jimp['bitmap'] }>> {
  const source = await Jimp.read(Buffer.from(imageBytes));
  const shouldUpscale = Math.max(source.bitmap.width, source.bitmap.height) < OCR_UPSCALE_THRESHOLD;
  const scale = shouldUpscale ? 2 : 1;
  const buffers: Array<{ label: string; pageSegMode: string; bitmap: Jimp['bitmap'] }> = [];

  for (const pass of OCR_PASSES) {
    const img = source.clone().greyscale().normalize().contrast(pass.contrast);

    if (shouldUpscale) {
      img.resize(
        Math.max(1, Math.round(source.bitmap.width * scale)),
        Math.max(1, Math.round(source.bitmap.height * scale)),
        Jimp.RESIZE_BICUBIC,
      );
    }

    if (pass.thresholdMax !== null) {
      img.threshold({ max: pass.thresholdMax });
    }

    if (pass.invert) {
      img.invert();
    }

    if (pass.binary) {
      img.posterize(2);
    }

    buffers.push({
      label: pass.label,
      pageSegMode: pass.pageSegMode,
      bitmap: img.bitmap,
    });
  }

  return buffers;
}

function toRgbaBytes(bitmap: Jimp['bitmap']): Uint8Array {
  return Uint8Array.from(bitmap.data);
}

async function recognizeImage(requestId: number, imageBytes: Uint8Array): Promise<{ text: string; confidence: number | null }> {
  await ensureTessApi();
  const inputs = await buildOcrBuffers(imageBytes);
  const candidates: Array<{ text: string; confidence: number | null }> = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const pass = inputs[index];
    postMessageSafe({
      type: 'progress',
      requestId,
      status: `Running OCR (${pass.label} ${index + 1}/${inputs.length})...`,
    });

    try {
      tessApi.SetVariable('tessedit_pageseg_mode', pass.pageSegMode);
    } catch {
      // Optional runtime variable, continue.
    }

    ocrSetImage(toRgbaBytes(pass.bitmap), pass.bitmap.width, pass.bitmap.height, 4);
    tessApi.Recognize();

    candidates.push({
      text: normalizeRecognizedText(tessApi.GetUTF8Text()),
      confidence: Number.isFinite(tessApi.MeanTextConf()) ? Number(tessApi.MeanTextConf()) : null,
    });
  }

  return selectBestCandidate(candidates);
}

async function shutdown(): Promise<void> {
  if (!tessApi) return;

  try {
    tessApi.End();
  } catch {
    // Ignore cleanup failures.
  } finally {
    tessApi = null;
    tessModule = null;
    initPromise = null;
  }
}

if (parentPort) {
  parentPort.on('message', async (message: any) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'recognize') {
      try {
        const result = await recognizeImage(message.requestId, message.image);
        postMessageSafe({
          type: 'result',
          requestId: message.requestId,
          text: result.text,
          confidence: result.confidence,
        });
      } catch (error) {
        postMessageSafe({
          type: 'error',
          requestId: message.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (message.type === 'terminate') {
      await shutdown();
      postMessageSafe({ type: 'terminated' });
    }
  });

  postMessageSafe({ type: 'ready' });
}
