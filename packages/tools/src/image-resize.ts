/**
 * Image resizing for the read tool. Adapted from pi (badlogic/pi-mono, MIT) `image-resize-core.ts`
 * and `image-resize.ts`; resizing runs in process (pi moves it to a worker thread for its TUI).
 */
import { applyExifOrientation } from "./exif-orientation.js";
import { loadPhoton } from "./photon.js";

export interface ImageResizeOptions {
  /** Default 2000. */
  maxWidth?: number;
  /** Default 2000. */
  maxHeight?: number;
  /** Largest base64 payload, in bytes. Default 4.5 MB, below Anthropic's 5 MB limit. */
  maxBytes?: number;
  /** Default 80. */
  jpegQuality?: number;
}

export interface ResizedImage {
  /** Base64. */
  data: string;
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: 4.5 * 1024 * 1024,
  jpegQuality: 80,
};

interface EncodedCandidate {
  data: string;
  encodedSize: number;
  mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
  const data = Buffer.from(buffer).toString("base64");
  return { data, encodedSize: Buffer.byteLength(data, "utf-8"), mimeType };
}

function definedOptions(options: ImageResizeOptions | undefined): ImageResizeOptions {
  return Object.fromEntries(
    Object.entries(options ?? {}).filter(([, value]) => value !== undefined),
  ) as ImageResizeOptions;
}

/**
 * Fit an image within the max dimensions and encoded size. Returns `null` when it can't get below
 * `maxBytes`, or when Photon is unavailable.
 *
 * 1. Scale down to `maxWidth`/`maxHeight`.
 * 2. Encode as PNG and JPEG and keep the smaller.
 * 3. If neither fits, try lower JPEG qualities.
 * 4. If still too large, shrink the dimensions by a quarter and repeat, down to 1x1.
 */
export async function resizeImage(
  inputBytes: Uint8Array,
  mimeType: string,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const opts = { ...DEFAULT_OPTIONS, ...definedOptions(options) };
  const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
  const photon = await loadPhoton();
  if (!photon) return null;

  let image: InstanceType<typeof photon.PhotonImage> | undefined;
  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
    image = applyExifOrientation(photon, rawImage, inputBytes);
    if (image !== rawImage) rawImage.free();
    const source = image;

    const originalWidth = source.get_width();
    const originalHeight = source.get_height();
    if (
      originalWidth <= opts.maxWidth &&
      originalHeight <= opts.maxHeight &&
      inputBase64Size < opts.maxBytes
    ) {
      return {
        data: Buffer.from(inputBytes).toString("base64"),
        mimeType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      };
    }

    let width = originalWidth;
    let height = originalHeight;
    if (width > opts.maxWidth) {
      height = Math.max(1, Math.round((height * opts.maxWidth) / width));
      width = opts.maxWidth;
    }
    if (height > opts.maxHeight) {
      width = Math.max(1, Math.round((width * opts.maxHeight) / height));
      height = opts.maxHeight;
    }

    const encodings = (w: number, h: number, qualities: number[]): EncodedCandidate[] => {
      const resized = photon.resize(source, w, h, photon.SamplingFilter.Lanczos3);
      try {
        return [
          encodeCandidate(resized.get_bytes(), "image/png"),
          ...qualities.map((quality) =>
            encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"),
          ),
        ];
      } finally {
        resized.free();
      }
    };

    const qualities = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
    while (true) {
      const [png, jpeg, ...lowerQuality] = encodings(width, height, qualities);
      // Prefer the smaller of PNG and JPEG at the configured quality; lower quality only if neither fits.
      const preferred =
        jpeg && png && jpeg.encodedSize < png.encodedSize ? [jpeg, png] : [png, jpeg];
      for (const candidate of [...preferred, ...lowerQuality]) {
        if (candidate && candidate.encodedSize < opts.maxBytes) {
          return {
            data: candidate.data,
            mimeType: candidate.mimeType,
            originalWidth,
            originalHeight,
            width,
            height,
            wasResized: true,
          };
        }
      }
      if (width === 1 && height === 1) break;
      const nextWidth = Math.max(1, Math.floor(width * 0.75));
      const nextHeight = Math.max(1, Math.floor(height * 0.75));
      if (nextWidth === width && nextHeight === height) break;
      width = nextWidth;
      height = nextHeight;
    }
    return null;
  } catch {
    return null;
  } finally {
    image?.free();
  }
}

/** Tells the model how a resized image maps back to the original's coordinates. */
export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) return undefined;
  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

/** Decode any format Photon reads (BMP, TIFF, ...) and re-encode it as PNG, applying EXIF orientation. */
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  const photon = await loadPhoton();
  if (!photon) return null;
  try {
    const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
    const image = applyExifOrientation(photon, rawImage, bytes);
    if (image !== rawImage) rawImage.free();
    try {
      return new Uint8Array(image.get_bytes());
    } finally {
      image.free();
    }
  } catch {
    return null;
  }
}
