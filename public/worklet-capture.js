/**
 * AudioWorklet: converts the microphone graph (any sample rate, float32) into
 * 100 ms frames of 16 kHz PCM16, the format every Gemini Live model consumes.
 * Also posts a coarse RMS level for the UI meter and local barge-in ducking.
 */
class Pcm16Capture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = options.processorOptions?.targetRate ?? 16000;
    const frameMs = options.processorOptions?.frameMs ?? 100;
    this.step = sampleRate / targetRate;
    this.frameSamples = Math.round((targetRate * frameMs) / 1000);
    this.frame = new Int16Array(this.frameSamples);
    this.fill = 0;
    this.pending = new Float32Array(0);
    this.position = 0;
    this.levelAccumulator = 0;
    this.levelSamples = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    // Concatenate leftover samples with the new block, then walk it at the resampling step.
    const merged = new Float32Array(this.pending.length + channel.length);
    merged.set(this.pending, 0);
    merged.set(channel, this.pending.length);

    let position = this.position;
    while (position + 1 < merged.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const sample = merged[index] * (1 - fraction) + merged[index + 1] * fraction;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.frame[this.fill++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.levelAccumulator += clamped * clamped;
      this.levelSamples++;
      if (this.fill === this.frameSamples) {
        const buffer = this.frame.buffer;
        this.port.postMessage({ type: "frame", buffer }, [buffer]);
        this.frame = new Int16Array(this.frameSamples);
        this.fill = 0;
        this.port.postMessage({ type: "level", level: Math.sqrt(this.levelAccumulator / Math.max(1, this.levelSamples)) });
        this.levelAccumulator = 0;
        this.levelSamples = 0;
      }
      position += this.step;
    }
    const consumed = Math.floor(position);
    this.pending = merged.subarray(consumed);
    this.position = position - consumed;
    return true;
  }
}

registerProcessor("pcm16-capture", Pcm16Capture);
