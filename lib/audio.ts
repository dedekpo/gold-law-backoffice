import decodeAmr from "@audio/decode-amr";

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
