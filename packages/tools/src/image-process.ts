/**
 * Image handling for the read tool. Supported inline formats (PNG, JPEG, GIF, WebP) pass through
 * unchanged; other formats are omitted with a note. Unlike pi, images are not resized or converted
 * (that needs a native image library); providers reject images above their own limits.
 */
export interface ProcessImageOptions {
  autoResizeImages?: boolean;
  resizeOptions?: unknown;
}

export type ProcessImageResult =
  | { ok: true; data: string; mimeType: string; hints: string[] }
  | { ok: false; message: string };

/** Inline image size limit, matching the common provider limit for base64 images. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function normalizeSupportedImageMimeType(mimeType: string): string | null {
  switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
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

export async function processImage(
  bytes: Uint8Array,
  mimeType: string,
  _options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
  const supported = normalizeSupportedImageMimeType(mimeType);
  if (!supported) {
    return { ok: false, message: "[Image omitted: unsupported inline image format.]" };
  }
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return { ok: false, message: "[Image omitted: larger than the inline image size limit.]" };
  }
  return { ok: true, data: Buffer.from(bytes).toString("base64"), mimeType: supported, hints: [] };
}
