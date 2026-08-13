import decodeAmr from "@audio/decode-amr";
import { Mp3Encoder } from "@breezystack/lamejs";

const AMR_MIME_TYPES = new Set(["audio/amr", "audio/3gpp", "audio/amr-wb"]);

export function isAmr(blob: Blob, name?: string): boolean {
  if (AMR_MIME_TYPES.has(blob.type)) return true;
  if (name?.toLowerCase().endsWith(".amr")) return true;
  return false;
}

export async function amrToWavBlob(source: Blob): Promise<Blob> {
  const buffer = await source.arrayBuffer();
  const { channelData, sampleRate } = await decodeAmr(new Uint8Array(buffer));
  return encodeWav(channelData, sampleRate);
}

export async function amrToMp3Blob(source: Blob): Promise<Blob> {
  const buffer = await source.arrayBuffer();
  const { channelData, sampleRate } = await decodeAmr(new Uint8Array(buffer));
  return encodeMp3(channelData, sampleRate);
}

// 64 kbps mono covers AMR's whole quality range: AMR tops out at 16 kHz
// wideband speech, and 64 kbps is the highest rate MPEG-2.5 allows at the
// 8 kHz narrowband rate.
const MP3_KBPS = 64;

function encodeMp3(channelData: Float32Array[], sampleRate: number): Blob {
  const channels = Math.min(channelData.length, 2);
  const left = floatTo16(channelData[0]);
  const right = channels === 2 ? floatTo16(channelData[1]) : undefined;
  const encoder = new Mp3Encoder(channels, sampleRate, MP3_KBPS);

  // lamejs types its output as Uint8Array<ArrayBufferLike>, which the DOM's
  // BlobPart rejects; its buffers are ordinary ArrayBuffers, so the cast holds.
  const chunks: BlobPart[] = [];
  const block = 1152;
  for (let i = 0; i < left.length; i += block) {
    const chunk = encoder.encodeBuffer(
      left.subarray(i, i + block),
      right?.subarray(i, i + block),
    );
    if (chunk.length > 0) chunks.push(chunk as BlobPart);
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail as BlobPart);

  return new Blob(chunks, { type: "audio/mpeg" });
}

function floatTo16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

function encodeWav(channelData: Float32Array[], sampleRate: number): Blob {
  const numChannels = channelData.length;
  const numSamples = channelData[0].length;
  const bytesPerSample = 2;
  const dataLength = numSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
