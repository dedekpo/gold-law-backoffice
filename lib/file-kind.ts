import type { FileKind } from "@/lib/types";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac|webm|amr|3gp|opus)$/;

/**
 * Classify a file as case evidence by its declared media type, falling back to
 * the filename extension. Used for both manual uploads and files imported from
 * a GHL opportunity. Returns null for anything that is neither audio nor image.
 */
export function detectKind(mediaType: string, name: string): FileKind | null {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  const lower = name.toLowerCase();
  if (IMAGE_EXT_RE.test(lower)) return "image";
  if (AUDIO_EXT_RE.test(lower)) return "audio";
  return null;
}
