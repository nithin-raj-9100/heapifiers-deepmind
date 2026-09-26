/**
 * Browser audio plumbing for Parley.
 *
 * MicCapture: getUserMedia → AudioWorklet → 100 ms frames of 16 kHz PCM16.
 * Player: schedules 24 kHz PCM16 chunks from the server on one shared timeline so
 * translation, Parley, the simulated counterpart and the readback never overlap,
 * and can flush a source instantly when the user barges in.
 */

export const OUTPUT_RATE = 24000;
// A finished voice must be silent this long before another voice may take over the speaker.
const SOURCE_SWITCH_QUIET_MS = 400;
export const SOURCE_NAMES = { 1: "translate", 2: "agent", 3: "inject", 4: "readback" };

export class MicCapture {
  constructor({ onFrame, onLevel }) {
    this.onFrame = onFrame;
    this.onLevel = onLevel;
    this.context = null;
    this.stream = null;
    this.node = null;
    this.muted = false;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    let context;
    try {
      context = new AudioContext({ sampleRate: 16000 });
    } catch {
      context = new AudioContext();
    }
    this.context = context;
    await context.audioWorklet.addModule("worklet-capture.js");
    this.node = new AudioWorkletNode(context, "pcm16-capture", { processorOptions: { targetRate: 16000, frameMs: 100 } });
    this.node.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "frame") {
        if (!this.muted) this.onFrame(data.buffer);
      } else if (data.type === "level") {
        this.onLevel(this.muted ? 0 : data.level);
      }
    };
    const source = context.createMediaStreamSource(this.stream);
    source.connect(this.node);
    // Keep the worklet alive without producing sound.
    const silence = context.createGain();
    silence.gain.value = 0;
    this.node.connect(silence).connect(context.destination);
    if (context.state === "suspended") await context.resume();
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close();
    this.node = null;
    this.stream = null;
    this.context = null;
  }
}

export class Player {
  constructor({ onPlaybackState, onLevel }) {
    this.onPlaybackState = onPlaybackState;
    this.onLevel = onLevel;
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
    this.gains = {};
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.connect(this.master);
    for (const name of Object.values(SOURCE_NAMES)) {
      const gain = this.context.createGain();
      gain.connect(this.analyser);
      this.gains[name] = gain;
    }
    this.queue = [];
    this.nextTime = 0;
    this.current = null;
    this.lastEnqueueAt = {};
    this.active = new Map(); // node -> source
    this.playing = { translate: false, agent: false, inject: false, readback: false };
    this.endTimers = {};
    this.pump = setInterval(() => this.schedule(), 40);
    this.levelData = new Uint8Array(this.analyser.frequencyBinCount);
    this.meter = setInterval(() => this.measure(), 60);
  }

  async resume() {
    if (this.context.state === "suspended") await this.context.resume();
  }

  /** pcm: ArrayBuffer of little-endian PCM16 at 24 kHz. */
  enqueue(source, pcm) {
    if (pcm.byteLength < 2) return;
    const aligned = pcm.byteLength % 2 === 0 ? pcm : pcm.slice(0, pcm.byteLength - 1);
    this.queue.push({ source, samples: new Int16Array(aligned) });
    this.lastEnqueueAt[source] = performance.now();
    this.schedule();
  }

  schedule() {
    const now = this.context.currentTime;
    if (this.nextTime < now) this.nextTime = now + 0.05;
    // One voice at a time: interleaving the 250 ms chunks of two streams that arrive together
    // (a translation and Parley, say) garbles both and clicks at every switch. The current
    // source keeps the timeline until it has finished and gone quiet, then the next one starts.
    if (this.current && !this.queue.some((item) => item.source === this.current)) {
      const finished = now >= this.nextTime - 0.06;
      const quiet = performance.now() - (this.lastEnqueueAt[this.current] ?? 0) > SOURCE_SWITCH_QUIET_MS;
      if (finished && quiet) this.current = null;
    }
    if (!this.current) this.current = this.queue[0]?.source ?? null;
    // Keep roughly 700 ms scheduled ahead: enough to absorb network jitter, small enough
    // that a flush feels instant.
    while (this.current && this.nextTime - now < 0.7) {
      const index = this.queue.findIndex((queued) => queued.source === this.current);
      if (index < 0) break;
      const [item] = this.queue.splice(index, 1);
      const buffer = this.context.createBuffer(1, item.samples.length, OUTPUT_RATE);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < item.samples.length; index++) channel[index] = item.samples[index] / 32768;
      const node = this.context.createBufferSource();
      node.buffer = buffer;
      node.connect(this.gains[item.source]);
      node.onended = () => this.ended(node);
      node.start(this.nextTime);
      this.nextTime += buffer.duration;
      this.active.set(node, item.source);
      this.markPlaying(item.source);
    }
  }

  markPlaying(source) {
    clearTimeout(this.endTimers[source]);
    if (!this.playing[source]) {
      this.playing[source] = true;
      this.onPlaybackState(source, "start");
    }
  }

  ended(node) {
    const source = this.active.get(node);
    this.active.delete(node);
    if (!source) return;
    const stillActive = [...this.active.values()].includes(source) || this.queue.some((item) => item.source === source);
    if (!stillActive) {
      clearTimeout(this.endTimers[source]);
      this.endTimers[source] = setTimeout(() => {
        const again = [...this.active.values()].includes(source) || this.queue.some((item) => item.source === source);
        if (again) return;
        this.playing[source] = false;
        this.onPlaybackState(source, "end");
      }, 120);
    }
  }

  /** Stop everything queued or playing for one source (or all sources). */
  flush(source = null) {
    this.queue = source ? this.queue.filter((item) => item.source !== source) : [];
    if (!source || source === this.current) this.current = null;
    for (const [node, nodeSource] of [...this.active.entries()]) {
      if (source && nodeSource !== source) continue;
      try {
        node.onended = null;
        node.stop();
      } catch {
        /* already stopped */
      }
      this.active.delete(node);
      const stillActive = [...this.active.values()].includes(nodeSource);
      if (!stillActive && this.playing[nodeSource]) {
        this.playing[nodeSource] = false;
        this.onPlaybackState(nodeSource, "end");
      }
    }
    if (!source || this.active.size === 0) this.nextTime = 0;
    this.schedule();
  }

  isPlaying(source) {
    return Boolean(this.playing[source]);
  }

  duck(source, value) {
    const gain = this.gains[source];
    if (!gain) return;
    gain.gain.setTargetAtTime(value, this.context.currentTime, 0.03);
  }

  measure() {
    this.analyser.getByteTimeDomainData(this.levelData);
    let sum = 0;
    for (let index = 0; index < this.levelData.length; index++) {
      const value = (this.levelData[index] - 128) / 128;
      sum += value * value;
    }
    this.onLevel(Math.sqrt(sum / this.levelData.length));
  }

  close() {
    clearInterval(this.pump);
    clearInterval(this.meter);
    this.flush();
    this.context.close();
  }
}
