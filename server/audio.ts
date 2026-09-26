/** PCM helpers. Everything Gemini-facing is 16-bit little-endian mono. */

export const MIC_SAMPLE_RATE = 16_000;
export const MODEL_OUTPUT_SAMPLE_RATE = 24_000;
/** 100 ms of 16 kHz PCM16, the chunk size the Live models are tuned for. */
export const MIC_CHUNK_BYTES = (MIC_SAMPLE_RATE / 10) * 2;

function alignedInt16(buffer: Buffer): Int16Array {
  const source = buffer.byteOffset % 2 === 0 ? buffer : Buffer.from(buffer);
  return new Int16Array(source.buffer, source.byteOffset, Math.floor(source.length / 2));
}

/** Wrap raw PCM16 in a RIFF/WAVE header so REST endpoints can accept it as audio/wav. */
export function wavFromPcm16(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Linear-interpolation resampler; adequate for speech between 16 kHz and 24 kHz. */
export function resamplePcm16(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input;
  const source = alignedInt16(input);
  const outLength = Math.floor((source.length * toRate) / fromRate);
  const out = new Int16Array(outLength);
  for (let index = 0; index < outLength; index++) {
    const position = (index * fromRate) / toRate;
    const left = Math.floor(position);
    const right = Math.min(left + 1, source.length - 1);
    const fraction = position - left;
    const a = source[left] ?? 0;
    const b = source[right] ?? 0;
    out[index] = Math.round(a * (1 - fraction) + b * fraction);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

export function pcmDurationMs(bytes: number, sampleRate: number): number {
  return (bytes / 2 / sampleRate) * 1000;
}

export function* chunkPcm(buffer: Buffer, bytesPerChunk: number): Generator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += bytesPerChunk) {
    yield buffer.subarray(offset, Math.min(offset + bytesPerChunk, buffer.length));
  }
}

/** Root-mean-square level in 0..1, used for cheap speech-energy metrics. */
export function rmsLevel(pcm: Buffer): number {
  const samples = alignedInt16(pcm);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = (samples[index] ?? 0) / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

/** Server → browser binary audio frames carry a 4-byte header: [source, flags, 0, 0]. */
export const AUDIO_SOURCE = { translate: 1, agent: 2, inject: 3, readback: 4 } as const;
export type AudioSource = keyof typeof AUDIO_SOURCE;

export function frameAudio(source: AudioSource, pcm24k: Buffer, flags = 0): Buffer {
  const header = Buffer.from([AUDIO_SOURCE[source], flags, 0, 0]);
  return Buffer.concat([header, pcm24k]);
}
