/**
 * Image handling for the read tool. Adapted from pi (badlogic/pi-mono, MIT) `image-process.ts`.
 * Formats providers can't take inline (such as BMP) are converted to PNG, and images are resized
 * to fit provider limits (2000x2000 and 4.5 MB of base64 by default), with a note that maps
 * coordinates back to the original. Without Photon, supported formats pass through unchanged up to
 * 5 MB and other formats are omitted.
 */
import {
  convertImageBytesToPng,
  formatDimensionNote,
  type ImageResizeOptions,
  resizeImage,
} from "./image-resize.js";
import { loadPhoton } from "./photon.js";

export interface ProcessImageOptions {
  /** Resize images to inline provider limits. Default true. */
  autoResizeImages?: boolean | undefined;
  /** Overrides for the resize defaults. */
  resizeOptions?: ImageResizeOptions | undefined;
}

export type ProcessImageResult =
  | { ok: true; data: string; mimeType: string; hints: string[] }
  | { ok: false; message: string };

/** Pass-through limit when Photon is unavailable, matching the common provider limit. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function baseMimeType(mimeType: string): string {
  return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function normalizeSupportedImageMimeType(mimeType: string): string | null {
  switch (baseMimeType(mimeType)) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/gif":
      return "image/gif";
    case "image/webp":
      return "image/webp";
    default:
      return null;
  }
}

function conversionHint(from: string | undefined, to: string): string | undefined {
  if (!from || from === to) return undefined;
  return `[Image converted from ${from} to ${to}.]`;
}

export async function processImage(
  bytes: Uint8Array,
  mimeType: string,
  options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
  const autoResizeImages = options?.autoResizeImages ?? true;
  let normalized: { bytes: Uint8Array; mimeType: string; convertedFrom?: string };
  const supported = normalizeSupportedImageMimeType(mimeType);
  if (supported) {
    normalized = { bytes, mimeType: supported };
  } else {
    const png = await convertImageBytesToPng(bytes);
    if (!png) {
      return {
        ok: false,
        message: "[Image omitted: could not be converted to a supported inline image format.]",
      };
    }
    normalized = { bytes: png, mimeType: "image/png", convertedFrom: baseMimeType(mimeType) };
  }

  const hints: string[] = [];
  if (autoResizeImages && (await loadPhoton())) {
    const resized = await resizeImage(
      normalized.bytes,
      normalized.mimeType,
      options?.resizeOptions,
    );
    if (!resized) {
      return {
        ok: false,
        message: "[Image omitted: could not be resized below the inline image size limit.]",
      };
    }
    const converted = conversionHint(normalized.convertedFrom, resized.mimeType);
    if (converted) hints.push(converted);
    const dimensions = formatDimensionNote(resized);
    if (dimensions) hints.push(dimensions);
    return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
  }

  if (normalized.bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return { ok: false, message: "[Image omitted: larger than the inline image size limit.]" };
  }
  const converted = conversionHint(normalized.convertedFrom, normalized.mimeType);
  if (converted) hints.push(converted);
  return {
    ok: true,
    data: Buffer.from(normalized.bytes).toString("base64"),
    mimeType: normalized.mimeType,
    hints,
  };
}
