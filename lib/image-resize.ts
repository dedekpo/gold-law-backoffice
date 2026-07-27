/**
 * Anthropic applies a stricter per-image dimension cap once a single request
 * carries MORE than 20 images — 2000px per side, against the 8000px that
 * applies at 20 or fewer. Over it, the whole request is rejected:
 *
 *   messages.0.content.35.image.source.base64.data: At least one of the image
 *   dimensions exceed max allowed size for many-image requests: 2000 pixels
 *
 * Phone screenshots are routinely ~1320x2868, so any case with 21+ screenshots
 * trips this — the screen extraction fails wholesale, and no partial result is
 * salvageable because it is one request. Downscaling costs nothing we want:
 * Claude reads images in 28px patches and already downscales anything past
 * 2576px on its long edge, so 2000px keeps a screenshot's text comfortably
 * legible while cutting visual tokens (and upload size) by ~40%.
 */
export const MODEL_MAX_IMAGE_EDGE = 2000;

/**
 * Downscale an image so neither side exceeds `maxEdge`, preserving the aspect
 * ratio. Re-encodes as PNG — lossless, because JPEG/WebP artifacts on small
 * on-screen text are exactly what breaks reading a sender number off a
 * screenshot.
 *
 * Returns the ORIGINAL blob whenever it already fits, or when the browser
 * can't decode/encode it (e.g. HEIC): sending an oversized image and risking
 * the API's limit beats silently dropping a piece of evidence.
 */
export async function downscaleImage(
  blob: Blob,
  maxEdge: number = MODEL_MAX_IMAGE_EDGE,
): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return blob;
  }

  try {
    const scale = maxEdge / Math.max(bitmap.width, bitmap.height);
    if (scale >= 1) return blob;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    return (await encodePng(bitmap, width, height)) ?? blob;
  } catch {
    return blob;
  } finally {
    bitmap.close();
  }
}

/** Draw the bitmap at the target size and encode it as PNG. */
async function encodePng(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: "image/png" });
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
