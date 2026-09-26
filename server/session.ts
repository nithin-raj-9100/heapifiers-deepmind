import { randomBytes } from "node:crypto";
import type WebSocket from "ws";
import { frameAudio, MIC_CHUNK_BYTES, MIC_SAMPLE_RATE, MODEL_OUTPUT_SAMPLE_RATE, resamplePcm16, type AudioSource } from "./audio.js";
import { findLanguage, findScenario, type Scenario } from "./catalog.js";
import type { ModelIds } from "./config.js";
import { LiveClient, type LiveCloseInfo, type LiveMessage } from "./gemini/live-client.js";
import { GeminiRest } from "./gemini/rest.js";
import { AGENT_TOOLS, buildAgentSetup, buildScribeSetup, buildTranslateSetup } from "./gemini/setups.js";
import { composeCounterpartLine } from "./counterpart.js";
import { normalizeSessionConfig, parseClientMessage, ProtocolError, type ClientMessage, type ServerMessage, type SessionConfig, type SessionSummary, type StreamName, type ToneReading } from "./protocol.js";
import { runScribe, type CaptionRecord, type LiveNote, type ScribeOutput } from "./scribe.js";
import { LiveTranscriptTracker } from "./transcript.js";

export interface SessionDeps {
  apiKey: string | null;
  models: ModelIds;
  maxMinutes: number;
  allowByok: boolean;
  log: (line: string) => void;
}

type Phase = "idle" | "live" | "ending" | "ended" | "destroyed";
type TranslateDirection = "toA" | "toB";

/** Ways speech recognition tends to spell the wake word, plus "interpreter" in a few languages. */
const WAKE_PATTERN = /\b(parl(?:ey|ay|ee|e|y|i)|pharley|barley|interpreter|int[ée]rprete|interpr[èe]te|dolmetscher|traductor(?:a)?|通訳|翻译|दुभाषिया)\b/i;
const RECONNECT_LIMIT = 4;
const PHRASE_IDLE_MS = 2200;
const PLAYBACK_TAIL_MS = 300;

/**
 * Collects the fragmentary input/output transcriptions of the translate model into
 * phrases (one per utterance) and emits caption updates for the browser.
 */
class PhraseAssembler {
  private phraseId = 0;
  private source = "";
  private target = "";
  private sourceLang: string | undefined;
  private targetLang: string | undefined;
  private sourceDone = false;
  private targetDone = false;
  private sourceDoneAt = 0;
  private targetDoneAt = 0;
  private startedAt = 0;
  private firstAudioAt: number | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Detected source language is neither of the session's languages: almost always a
   * misdetection (e.g. "Parley" heard as French "parlez"); the other stream handles it. */
  private foreign = false;

  constructor(
    private readonly stream: TranslateDirection,
    private readonly emit: (message: ServerMessage) => void,
    private readonly onComplete: (record: CaptionRecord) => void,
    private readonly onFirstAudio: (at: number) => void,
    private readonly onTail: (latencyMs: number) => void,
    private readonly isSessionLanguage: (code: string) => boolean,
  ) {}

  get audioAllowed(): boolean {
    return !this.foreign;
  }

  /**
   * The translate model streams text fragments and, once an utterance is over, a
   * transcription message with only a languageCode. Those empty messages also arrive
   * as keepalives while nobody speaks, so they never open or extend a phrase.
   */
  acceptSource(text: string | undefined, languageCode: string | undefined): void {
    if (!text) {
      if (this.startedAt === 0 || this.sourceDone) return;
      this.sourceDone = true;
      this.sourceDoneAt = Date.now();
      this.caption("source", true);
      this.maybeComplete();
      return;
    }
    if (this.sourceDone) this.finalize();
    this.begin();
    if (languageCode && !this.isSessionLanguage(languageCode)) this.foreign = true;
    this.source += text;
    if (languageCode) this.sourceLang = languageCode;
    this.caption("source", false);
    this.touch();
  }

  acceptTarget(text: string | undefined, languageCode: string | undefined): void {
    if (!text) {
      if (this.startedAt === 0 || this.targetDone) return;
      this.targetDone = true;
      this.targetDoneAt = Date.now();
      this.caption("target", true);
      this.maybeComplete();
      return;
    }
    if (this.targetDone) this.finalize();
    this.begin();
    this.target += text;
    if (languageCode) this.targetLang = languageCode;
    this.caption("target", false);
    this.touch();
  }

  private caption(role: "source" | "target", final: boolean): void {
    if (this.foreign) return;
    const text = role === "source" ? this.source : this.target;
    const languageCode = role === "source" ? this.sourceLang : this.targetLang;
    this.emit({ type: "caption", stream: this.stream, role, text, languageCode, final, phraseId: this.phraseId });
  }

  audioArrived(): void {
    // Audio that arrives after a phrase closed is the tail of that phrase's speech,
    // not a new phrase: never open one on audio alone.
    if (this.startedAt === 0) return;
    if (this.firstAudioAt === null) {
      this.firstAudioAt = Date.now();
      this.onFirstAudio(this.firstAudioAt);
    }
    this.touch();
  }

  finalize(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.source && !this.target) {
      this.reset();
      return;
    }
    if (!this.sourceDone) this.caption("source", true);
    if (!this.targetDone) this.caption("target", true);
    if (!this.foreign) {
      if (this.sourceDoneAt && this.targetDoneAt && this.target) this.onTail(this.targetDoneAt - this.sourceDoneAt);
      this.onComplete({ stream: this.stream, source: this.source, target: this.target, sourceLang: this.sourceLang, targetLang: this.targetLang, at: this.startedAt });
    }
    this.reset();
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private begin(): void {
    if (this.startedAt === 0) {
      this.startedAt = Date.now();
      this.phraseId += 1;
    }
  }

  private maybeComplete(): void {
    if (this.sourceDone && this.targetDone) this.finalize();
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.finalize(), PHRASE_IDLE_MS);
  }

  private reset(): void {
    this.source = "";
    this.target = "";
    this.sourceLang = undefined;
    this.targetLang = undefined;
    this.sourceDone = false;
    this.targetDone = false;
    this.sourceDoneAt = 0;
    this.targetDoneAt = 0;
    this.startedAt = 0;
    this.firstAudioAt = null;
    this.foreign = false;
  }
}

interface AgentTurn {
  addressed: boolean;
  speaking: boolean;
  suppressed: boolean;
  heard: string;
  said: string;
  activityEndAt: number | null;
  firstAudioAt: number | null;
}

function newAgentTurn(addressed: boolean): AgentTurn {
  return { addressed, speaking: false, suppressed: false, heard: "", said: "", activityEndAt: null, firstAudioAt: null };
}

/** One browser connection = one Parley session owning up to four upstream Live sessions. */
export class ParleySession {
  readonly id = randomBytes(4).toString("hex");
  private phase: Phase = "idle";
  private config!: SessionConfig;
  private scenario!: Scenario;
  private rest!: GeminiRest;
  private apiKey!: string;

  private translateToA: LiveClient | null = null;
  private translateToB: LiveClient | null = null;
  private agent: LiveClient | null = null;
  private scribe: LiveClient | null = null;
  private agentResumeHandle: string | null = null;
  private reconnects: Record<string, number> = {};

  private readonly phrases: Record<TranslateDirection, PhraseAssembler>;
  private readonly scribeTracker = new LiveTranscriptTracker();
  private readonly captions: CaptionRecord[] = [];
  private readonly tones: ToneReading[] = [];
  private readonly notes: LiveNote[] = [];
  private readonly agentLines: string[] = [];
  private agentTurn: AgentTurn = newAgentTurn(false);
  private engaged = false;
  private lastSpeechStartAt = 0;

  private readonly recording: Buffer[] = [];
  private recordingBytes = 0;
  private startedAt = 0;
  private endedAt = 0;
  private maxTimer: NodeJS.Timeout | null = null;

  private injecting = false;
  private injectTimer: NodeJS.Timeout | null = null;
  private playingUntil: Record<AudioSource, number> = { translate: 0, agent: 0, inject: 0, readback: 0 };

  private readonly metrics = {
    translateFirstAudioMs: [] as number[],
    translateTailMs: [] as number[],
    agentFirstAudioMs: [] as number[],
    interruptions: 0,
    agentTurns: 0,
    agentSpokenTurns: 0,
    agentSuppressedTurns: 0,
    micFramesGated: 0,
    micFrames: 0,
    injections: 0,
    reconnects: 0,
  };
  private scribeResult: ScribeOutput | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: SessionDeps,
  ) {
    const isSessionLanguage = (code: string) => this.isSessionLanguage(code);
    this.phrases = {
      toA: new PhraseAssembler("toA", (m) => this.send(m), (r) => this.captions.push(this.attribute(r)), (at) => this.recordTranslateLatency(at), (ms) => this.recordTranslateTail(ms), isSessionLanguage),
      toB: new PhraseAssembler("toB", (m) => this.send(m), (r) => this.captions.push(this.attribute(r)), (at) => this.recordTranslateLatency(at), (ms) => this.recordTranslateTail(ms), isSessionLanguage),
    };
  }

  private static primaryLanguage(code: string | undefined): string {
    return (code ?? "").toLowerCase().split("-")[0] ?? "";
  }

  private isSessionLanguage(code: string): boolean {
    const spoken = ParleySession.primaryLanguage(code);
    return spoken === ParleySession.primaryLanguage(this.config.languageA) || spoken === ParleySession.primaryLanguage(this.config.languageB);
  }

  /** Decide who spoke from the detected language; fall back to the stream direction. */
  private attribute(record: CaptionRecord): CaptionRecord {
    const spoken = ParleySession.primaryLanguage(record.sourceLang);
    let speaker: "A" | "B" = record.stream === "toB" ? "A" : "B";
    if (spoken && spoken === ParleySession.primaryLanguage(this.config.languageA)) speaker = "A";
    else if (spoken && spoken === ParleySession.primaryLanguage(this.config.languageB)) speaker = "B";
    return { ...record, speaker };
  }

  get isLive(): boolean {
    return this.phase === "live";
  }

  get usesServerKey(): boolean {
    return this.phase !== "idle" && this.apiKey === this.deps.apiKey;
  }

  handleText(raw: string): void {
    let message: ClientMessage;
    try {
      message = parseClientMessage(raw);
    } catch (error) {
      if (error instanceof ProtocolError) this.send({ type: "error", code: error.code, message: error.message });
      return;
    }
    switch (message.type) {
      case "start":
        void this.start(message.config);
        return;
      case "playback":
        this.playingUntil[message.source] = message.state === "start" ? Number.POSITIVE_INFINITY : Date.now() + PLAYBACK_TAIL_MS;
        return;
      case "agent":
        this.handleAgentAction(message.action);
        return;
      case "inject":
        void this.inject(message.text, message.opener);
        return;
      case "end":
        void this.end("ended by user");
        return;
      case "readback":
        void this.readback(message.language);
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
    }
  }

  handleAudio(pcm: Buffer): void {
    if (this.phase !== "live" || pcm.length < 2) return;
    this.metrics.micFrames++;
    const now = Date.now();
    const gated =
      this.injecting ||
      now < this.playingUntil.readback ||
      now < this.playingUntil.inject ||
      (this.config.duplex === "half" && now < this.playingUntil.translate);
    if (gated) {
      this.metrics.micFramesGated++;
      return;
    }
    if (this.engaged) {
      // A private aside to the interpreter: only the agent hears it.
      this.agent?.sendAudio(pcm);
      this.record(pcm);
      return;
    }
    this.fanOut(pcm);
  }

  destroy(): void {
    if (this.phase === "destroyed") return;
    this.phase = "destroyed";
    this.stopInjection();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    for (const client of [this.translateToA, this.translateToB, this.agent, this.scribe]) client?.close();
    this.phrases.toA.dispose();
    this.phrases.toB.dispose();
  }

  // ---------------------------------------------------------------- lifecycle

  private async start(input: Partial<SessionConfig>): Promise<void> {
    if (this.phase !== "idle") {
      this.send({ type: "error", code: "already_started", message: "This connection already has a session." });
      return;
    }
    let config: SessionConfig;
    try {
      config = normalizeSessionConfig(input, this.deps.allowByok);
    } catch (error) {
      if (error instanceof ProtocolError) this.send({ type: "error", code: error.code, message: error.message, fatal: true });
      return;
    }
    const apiKey = config.apiKey ?? this.deps.apiKey;
    if (!apiKey) {
      this.send({ type: "error", code: "no_api_key", message: "This server has no Gemini API key configured. Paste your own key in the setup panel.", fatal: true });
      return;
    }
    this.config = config;
    this.apiKey = apiKey;
    this.scenario = findScenario(config.scenario) ?? findScenario("general")!;
    this.rest = new GeminiRest({ apiKey, models: this.deps.models });
    this.phase = "live";
    this.startedAt = Date.now();
    this.maxTimer = setTimeout(() => void this.end("session time limit reached"), this.deps.maxMinutes * 60_000);
    const { apiKey: _omit, ...publicConfig } = config;
    this.send({ type: "ready", sessionId: this.id, models: { ...this.deps.models }, config: publicConfig, limits: { maxMinutes: this.deps.maxMinutes } });
    this.log(`start ${config.languageA}↔${config.languageB} scenario=${config.scenario} duplex=${config.duplex} byok=${Boolean(config.apiKey)}`);

    this.openTranslate("toA");
    this.openTranslate("toB");
    this.openAgent();
    this.openScribe();
  }

  private async end(reason: string): Promise<void> {
    if (this.phase !== "live") return;
    this.phase = "ending";
    this.log(`ending: ${reason}`);
    this.stopInjection();
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    this.endedAt = Date.now();

    for (const client of [this.translateToA, this.translateToB, this.scribe]) {
      if (client?.state === "ready") client.sendAudioStreamEnd();
    }
    // Give the streams a moment to flush trailing finals before tearing them down.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const flushed = this.scribeTracker.flushInterim();
    if (flushed) this.send({ type: "transcript", kind: "final", text: flushed, at: Date.now() });
    this.phrases.toA.finalize();
    this.phrases.toB.finalize();
    for (const client of [this.translateToA, this.translateToB, this.agent, this.scribe]) client?.close();
    for (const stream of ["translate", "agent", "scribe"] as StreamName[]) this.send({ type: "status", stream, state: "closed", detail: reason });

    const recording = this.recordingBytes > 0 ? Buffer.concat(this.recording) : null;
    const result = await runScribe(this.rest, {
      recording,
      sessionStartedAt: this.startedAt,
      languageA: this.config.languageA,
      languageB: this.config.languageB,
      scenario: this.scenario,
      captions: this.captions,
      liveSegments: this.scribeTracker.segments,
      tones: this.tones,
      notes: this.notes,
      agentLines: this.agentLines,
    });
    this.scribeResult = result;
    this.phase = "ended";
    this.send({ type: "summary", summary: result.summary, transcript: result.transcript, stats: { ...result.stats, ...this.sessionStats() }, ...(result.error ? { error: result.error } : {}) });
    this.log(`ended; summary=${result.summary ? "ok" : "none"} ${result.error ? `error=${result.error}` : ""}`);
  }

  private sessionStats(): Record<string, unknown> {
    const median = (values: number[]) => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] ?? null;
    };
    return {
      durationSec: Math.round(((this.endedAt || Date.now()) - this.startedAt) / 1000),
      recordedSec: Math.round(this.recordingBytes / (MIC_SAMPLE_RATE * 2)),
      translateFirstAudioMedianMs: median(this.metrics.translateFirstAudioMs),
      translateTailMedianMs: median(this.metrics.translateTailMs),
      translatePhrases: this.captions.length,
      agentFirstAudioMedianMs: median(this.metrics.agentFirstAudioMs),
      agentTurns: this.metrics.agentTurns,
      agentSpokenTurns: this.metrics.agentSpokenTurns,
      agentSuppressedTurns: this.metrics.agentSuppressedTurns,
      interruptions: this.metrics.interruptions,
      toneReadings: this.tones.length,
      liveNotes: this.notes.length,
      injections: this.metrics.injections,
      micFrames: this.metrics.micFrames,
      micFramesGated: this.metrics.micFramesGated,
      reconnects: this.metrics.reconnects,
      models: this.deps.models,
    };
  }

  // ---------------------------------------------------------------- upstream streams

  private openTranslate(direction: TranslateDirection): void {
    const target = direction === "toA" ? this.config.languageA : this.config.languageB;
    const client = new LiveClient({
      label: `translate:${direction}`,
      apiKey: this.apiKey,
      setup: buildTranslateSetup(this.deps.models.translate, target),
      onMessage: (message) => this.onTranslateMessage(direction, client, message),
      onClose: (info) => this.onStreamClose("translate", direction, client, info),
      onLog: (line) => this.log(line),
    });
    if (direction === "toA") this.translateToA = client;
    else this.translateToB = client;
    this.send({ type: "status", stream: "translate", state: "connecting" });
    client.ready().then(
      () => {
        this.reconnects[`translate:${direction}`] = 0;
        if (this.bothTranslateReady()) this.send({ type: "status", stream: "translate", state: "ready" });
      },
      (error: Error) => this.send({ type: "status", stream: "translate", state: "error", detail: error.message }),
    );
  }

  private bothTranslateReady(): boolean {
    return this.translateToA?.state === "ready" && this.translateToB?.state === "ready";
  }

  private openAgent(): void {
    const client = new LiveClient({
      label: "agent",
      apiKey: this.apiKey,
      setup: buildAgentSetup({
        model: this.deps.models.live,
        languageA: this.config.languageA,
        languageB: this.config.languageB,
        scenario: this.scenario,
        voice: this.config.agentVoice,
        resumeHandle: this.agentResumeHandle,
      }),
      onMessage: (message) => this.onAgentMessage(client, message),
      onClose: (info) => this.onStreamClose("agent", null, client, info),
      onLog: (line) => this.log(line),
    });
    this.agent = client;
    this.send({ type: "status", stream: "agent", state: "connecting" });
    client.ready().then(
      () => {
        this.reconnects.agent = 0;
        this.send({ type: "status", stream: "agent", state: "ready" });
      },
      (error: Error) => {
        if (this.agentResumeHandle) {
          // A stale resumption handle must not keep the agent offline.
          this.agentResumeHandle = null;
        }
        this.send({ type: "status", stream: "agent", state: "error", detail: error.message });
      },
    );
  }

  private openScribe(): void {
    const client = new LiveClient({
      label: "scribe",
      apiKey: this.apiKey,
      setup: buildScribeSetup(this.deps.models.transcribeLive),
      onMessage: (message) => this.onScribeMessage(client, message),
      onClose: (info) => this.onStreamClose("scribe", null, client, info),
      onLog: (line) => this.log(line),
    });
    this.scribe = client;
    this.send({ type: "status", stream: "scribe", state: "connecting" });
    client.ready().then(
      () => {
        this.reconnects.scribe = 0;
        this.send({ type: "status", stream: "scribe", state: "ready" });
      },
      (error: Error) => this.send({ type: "status", stream: "scribe", state: "error", detail: error.message }),
    );
  }

  private onStreamClose(stream: StreamName, direction: TranslateDirection | null, client: LiveClient, info: LiveCloseInfo): void {
    const current = stream === "agent" ? this.agent : stream === "scribe" ? this.scribe : direction === "toA" ? this.translateToA : this.translateToB;
    if (current !== client) return; // an older socket we already replaced
    if (this.phase !== "live" || info.expected) return;
    const key = direction ? `${stream}:${direction}` : stream;
    const attempts = (this.reconnects[key] ?? 0) + 1;
    this.reconnects[key] = attempts;
    this.log(`${key} closed unexpectedly (${info.code} ${info.reason}); reconnect attempt ${attempts}`);
    if (attempts > RECONNECT_LIMIT || info.code === 1008) {
      this.send({ type: "status", stream, state: "error", detail: `${key} closed (${info.code}) ${info.reason}`.trim() });
      return;
    }
    this.metrics.reconnects++;
    this.send({ type: "status", stream, state: "reconnecting", detail: info.reason || `code ${info.code}` });
    if (stream === "scribe") {
      const flushed = this.scribeTracker.flushInterim();
      if (flushed) this.send({ type: "transcript", kind: "final", text: flushed, at: Date.now() });
    }
    setTimeout(() => {
      if (this.phase !== "live") return;
      if (stream === "agent") this.openAgent();
      else if (stream === "scribe") this.openScribe();
      else if (direction) this.openTranslate(direction);
    }, 400 * attempts);
  }

  // ---------------------------------------------------------------- message handlers

  private onTranslateMessage(direction: TranslateDirection, client: LiveClient, message: LiveMessage): void {
    if (this.phase !== "live" && this.phase !== "ending") return;
    const content = message.serverContent;
    if (!content) return;
    const phrase = this.phrases[direction];
    if (content.inputTranscription) phrase.acceptSource(content.inputTranscription.text, content.inputTranscription.languageCode);
    if (content.outputTranscription) phrase.acceptTarget(content.outputTranscription.text, content.outputTranscription.languageCode);
    for (const part of content.modelTurn?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      const pcm = Buffer.from(part.inlineData.data, "base64");
      if (pcm.length < 2) continue;
      phrase.audioArrived();
      if (phrase.audioAllowed) this.sendAudio("translate", pcm);
    }
    void client;
  }

  private onAgentMessage(client: LiveClient, message: LiveMessage): void {
    if (this.phase !== "live") return;
    if (message.sessionResumptionUpdate?.resumable && message.sessionResumptionUpdate.newHandle) {
      this.agentResumeHandle = message.sessionResumptionUpdate.newHandle;
    }
    if (message.goAway) {
      this.log(`agent goAway (${message.goAway.timeLeft ?? "?"}); rotating session`);
      client.close(1000, "rotating before goAway");
      this.metrics.reconnects++;
      this.send({ type: "status", stream: "agent", state: "reconnecting", detail: "rotating session" });
      setTimeout(() => this.phase === "live" && this.openAgent(), 100);
      return;
    }
    if (message.voiceActivity?.type === "ACTIVITY_START") {
      // The model interrupts itself only while it is still generating. Its audio is
      // buffered ahead in the browser, so speech that starts while that buffer is
      // still playing must count as a barge-in too: flush playback and end the turn.
      if (this.playingUntil.agent === Number.POSITIVE_INFINITY || this.agentTurn.speaking) {
        this.metrics.interruptions++;
        this.send({ type: "agent", event: "interrupted" });
        this.playingUntil.agent = Date.now();
      }
      this.agentTurn = newAgentTurn(this.engaged);
      this.metrics.agentTurns++;
      this.lastSpeechStartAt = Date.now();
      this.send({ type: "activity", stream: "agent", state: "start" });
      this.send({ type: "agent", event: "listening" });
    }
    if (message.voiceActivity?.type === "ACTIVITY_END") {
      this.agentTurn.activityEndAt = Date.now();
      this.send({ type: "activity", stream: "agent", state: "end" });
      this.send({ type: "agent", event: "thinking" });
    }
    if (message.toolCall?.functionCalls) this.handleToolCalls(client, message.toolCall.functionCalls);

    const content = message.serverContent;
    if (!content) return;
    if (content.inputTranscription?.text) {
      this.agentTurn.heard += content.inputTranscription.text;
      if (WAKE_PATTERN.test(this.agentTurn.heard)) this.agentTurn.addressed = true;
    }
    if (content.interrupted) {
      if (this.agentTurn.speaking) {
        this.metrics.interruptions++;
        this.send({ type: "agent", event: "interrupted" });
      }
      this.agentTurn.speaking = false;
      this.agentTurn.suppressed = true;
      this.playingUntil.agent = Date.now();
    }
    const allowed = this.agentTurn.addressed || this.engaged || this.latestUrgencyHigh();
    for (const part of content.modelTurn?.parts ?? []) {
      if (!part.inlineData?.data) continue;
      const pcm = Buffer.from(part.inlineData.data, "base64");
      if (pcm.length < 2) continue;
      if (!allowed || this.agentTurn.suppressed) {
        if (!this.agentTurn.suppressed) {
          this.agentTurn.suppressed = true;
          this.metrics.agentSuppressedTurns++;
        }
        continue;
      }
      if (!this.agentTurn.speaking) {
        this.agentTurn.speaking = true;
        this.agentTurn.firstAudioAt = Date.now();
        this.metrics.agentSpokenTurns++;
        if (this.agentTurn.activityEndAt) {
          const latency = this.agentTurn.firstAudioAt - this.agentTurn.activityEndAt;
          this.metrics.agentFirstAudioMs.push(latency);
          this.send({ type: "metric", name: "agent_first_audio", valueMs: latency, stream: "agent" });
        }
        this.send({ type: "agent", event: "speaking" });
      }
      this.sendAudio("agent", pcm);
    }
    if (content.outputTranscription?.text && this.agentTurn.speaking) {
      this.agentTurn.said += content.outputTranscription.text;
      this.send({ type: "agent", event: "speaking", text: this.agentTurn.said });
    }
    if (content.turnComplete) {
      if (this.agentTurn.speaking) {
        if (this.agentTurn.said.trim()) this.agentLines.push(this.agentTurn.said.trim());
        this.send({ type: "agent", event: "done", text: this.agentTurn.said });
      } else {
        this.send({ type: "agent", event: "done" });
      }
      this.agentTurn.speaking = false;
      this.agentTurn.suppressed = false;
    }
  }

  private handleToolCalls(client: LiveClient, calls: Array<{ id?: string; name: string; args?: Record<string, unknown> }>): void {
    const responses = calls.map((call) => {
      const args = call.args ?? {};
      if (call.name === AGENT_TOOLS.reportTone) {
        const urgencyRaw = String(args.urgency ?? "low").toLowerCase();
        const reading: ToneReading = {
          tone: String(args.tone ?? "neutral").slice(0, 40),
          urgency: urgencyRaw === "high" ? "high" : urgencyRaw === "medium" ? "medium" : "low",
          language: typeof args.language === "string" ? args.language : undefined,
          speaker: typeof args.speaker === "string" ? args.speaker : undefined,
          at: Date.now(),
        };
        this.tones.push(reading);
        this.send({ type: "tone", reading });
        // The model heard the audio itself, so it knows whether it was addressed even
        // when speech recognition mangles the wake word. Blocking tools mean this
        // arrives before any speech of the same turn, so the gate can rely on it.
        if (args.addressed_to_parley === true || String(args.addressed_to_parley).toLowerCase() === "true") this.agentTurn.addressed = true;
      } else if (call.name === AGENT_TOOLS.noteCommitment) {
        const note: LiveNote = { owner: String(args.owner ?? "?"), note: String(args.note ?? "").slice(0, 300), due: typeof args.due === "string" ? args.due : undefined, at: Date.now() };
        if (note.note) {
          this.notes.push(note);
          this.send({ type: "metric", name: "commitment_noted", valueMs: 0, stream: "agent" });
          this.sendNote(note);
        }
      }
      return { id: call.id, name: call.name, response: { ok: true } };
    });
    client.sendToolResponse(responses);
  }

  private sendNote(note: LiveNote): void {
    // Notes ride on the transcript channel so the UI can pin them inline.
    this.send({ type: "transcript", kind: "final", text: `📌 ${note.owner === "A" ? this.scenario.roleA : note.owner === "B" ? this.scenario.roleB : note.owner}: ${note.note}${note.due ? ` (${note.due})` : ""}`, at: note.at });
  }

  private latestUrgencyHigh(): boolean {
    const latest = this.tones[this.tones.length - 1];
    return Boolean(latest && latest.urgency === "high" && Date.now() - latest.at < 15_000);
  }

  private onScribeMessage(client: LiveClient, message: LiveMessage): void {
    if (this.phase !== "live" && this.phase !== "ending") return;
    const content = message.serverContent;
    if (!content) return;
    if (content.interimInputTranscription?.text) {
      const merged = this.scribeTracker.acceptInterim(content.interimInputTranscription.text);
      this.send({ type: "transcript", kind: "interim", text: merged, at: Date.now() });
    }
    if (content.inputTranscription?.text) {
      const result = this.scribeTracker.acceptFinal(content.inputTranscription.text);
      if (result) this.send({ type: "transcript", kind: "final", text: result.text, at: Date.now(), replaced: result.replaced });
    }
    void client;
  }

  // ---------------------------------------------------------------- agent controls

  private handleAgentAction(action: "engage" | "release" | "interrupt"): void {
    if (this.phase !== "live") return;
    if (action === "engage") {
      this.engaged = true;
      this.agentTurn.addressed = true;
      this.agent?.sendClientContent("[The next thing you hear is addressed directly to you, Parley. Answer it briefly.]", false);
      this.send({ type: "agent", event: "engaged" });
    } else if (action === "release") {
      this.engaged = false;
      this.send({ type: "agent", event: "released" });
    } else {
      // The browser already flushed its queue; drop the rest of this turn's audio.
      if (this.agentTurn.speaking) this.metrics.interruptions++;
      this.agentTurn.speaking = false;
      this.agentTurn.suppressed = true;
      this.send({ type: "agent", event: "interrupted" });
    }
  }

  // ---------------------------------------------------------------- simulated counterpart

  private async inject(seedText: string | undefined, opener: number | undefined): Promise<void> {
    if (this.phase !== "live" || this.injecting) return;
    this.injecting = true;
    this.metrics.injections++;
    this.send({ type: "inject", state: "thinking" });
    try {
      const seed = seedText ?? (opener !== undefined ? this.scenario.openers[opener] : undefined);
      const recent = this.recentTranscriptLines();
      const line = await composeCounterpartLine(this.rest, {
        scenario: this.scenario,
        languageA: this.config.languageA,
        languageB: this.config.languageB,
        recentTranscript: recent,
        seedText: seed,
      });
      const latestTone = this.tones[this.tones.length - 1];
      const style = latestTone && latestTone.urgency === "high" ? "tense, hurried" : "natural, conversational";
      if (this.phase !== "live") return;

      // Stream the synthesized speech: the browser starts playing within about a second
      // while the same audio is paced into the live models exactly as real speech would be.
      const queue: Buffer[] = [];
      let finished = false;
      let announced = false;
      let streamError: Error | null = null;
      const startedAt = Date.now();
      const pull = (async () => {
        try {
          for await (const chunk of this.rest.synthesizeStream({ text: line.text, voice: this.config.counterpartVoice, style, fast: true })) {
            if (this.phase !== "live") break;
            if (!announced) {
              announced = true;
              this.send({ type: "inject", state: "speaking", text: line.text, translation: line.gloss });
              this.send({ type: "metric", name: "counterpart_first_audio", valueMs: Date.now() - startedAt + line.latencyMs, stream: "inject" });
            }
            const pcm24 = chunk.sampleRate === MODEL_OUTPUT_SAMPLE_RATE ? chunk.pcm : resamplePcm16(chunk.pcm, chunk.sampleRate, MODEL_OUTPUT_SAMPLE_RATE);
            this.sendAudio("inject", pcm24);
            queue.push(resamplePcm16(chunk.pcm, chunk.sampleRate, MIC_SAMPLE_RATE));
          }
        } catch (error) {
          streamError = error instanceof Error ? error : new Error(String(error));
        } finally {
          finished = true;
        }
      })();
      await this.feedQueueAtRealTime(queue, () => finished);
      await pull;
      if (streamError) throw streamError;
      if (!announced) throw new Error("text-to-speech returned no audio");
      this.send({ type: "inject", state: "done" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`inject failed: ${detail}`);
      this.send({ type: "inject", state: "error", detail });
    } finally {
      // Keep the mic gated briefly so the tail of the playback is not re-captured.
      this.injectTimer = setTimeout(() => {
        this.injecting = false;
        this.injectTimer = null;
      }, 700);
    }
  }

  /**
   * Drains a growing queue of 16 kHz PCM into every upstream at real-time pace
   * (one 100 ms chunk per tick), then appends silence so the models' VAD closes the turn.
   */
  private feedQueueAtRealTime(queue: Buffer[], isFinished: () => boolean): Promise<void> {
    const SILENCE_CHUNKS = 8;
    return new Promise((resolve) => {
      let pending = Buffer.alloc(0);
      let silenceSent = 0;
      const tick = () => {
        if (this.phase !== "live") {
          this.injectTimer = null;
          resolve();
          return;
        }
        if (queue.length > 0) pending = Buffer.concat([pending, ...queue.splice(0, queue.length)]);
        if (pending.length >= MIC_CHUNK_BYTES) {
          this.fanOut(pending.subarray(0, MIC_CHUNK_BYTES));
          pending = pending.subarray(MIC_CHUNK_BYTES);
        } else if (isFinished()) {
          if (pending.length > 0) {
            this.fanOut(pending);
            pending = Buffer.alloc(0);
          } else if (silenceSent < SILENCE_CHUNKS) {
            this.fanOut(Buffer.alloc(MIC_CHUNK_BYTES));
            silenceSent++;
          } else {
            this.injectTimer = null;
            resolve();
            return;
          }
        }
        this.injectTimer = setTimeout(tick, 100);
      };
      tick();
    });
  }

  private stopInjection(): void {
    if (this.injectTimer) clearTimeout(this.injectTimer);
    this.injectTimer = null;
    this.injecting = false;
  }

  private recentTranscriptLines(): string[] {
    const lines: string[] = [];
    for (const caption of this.captions.filter((c) => c.target.trim() && c.source.trim()).slice(-8)) {
      lines.push(`${caption.speaker === "B" ? this.scenario.roleB : this.scenario.roleA}: ${caption.source.trim()}`);
    }
    if (lines.length === 0) for (const segment of this.scribeTracker.segments.slice(-8)) lines.push(segment.text);
    return lines;
  }

  // ---------------------------------------------------------------- readback

  private async readback(language: "A" | "B"): Promise<void> {
    const summary: SessionSummary | null | undefined = this.scribeResult?.summary;
    if (!summary) {
      this.send({ type: "readback", language, state: "error", detail: "No summary to read yet." });
      return;
    }
    this.send({ type: "readback", language, state: "thinking" });
    try {
      const languageName = findLanguage(language === "A" ? this.config.languageA : this.config.languageB)?.name ?? "";
      const body = language === "A" ? summary.summary_a : summary.summary_b;
      const items = summary.action_items.slice(0, 5).map((item) => `${item.owner}: ${item.task}${item.due ? `, ${item.due}` : ""}`);
      const text = items.length > 0 ? `${body} <short pause> ${items.join(". ")}.` : body;
      let first = true;
      for await (const chunk of this.rest.synthesizeStream({ text, voice: this.config.agentVoice, style: `calm, clear, professional; spoken in ${languageName}` })) {
        if (first) {
          first = false;
          this.send({ type: "readback", language, state: "speaking" });
        }
        const pcm24 = chunk.sampleRate === MODEL_OUTPUT_SAMPLE_RATE ? chunk.pcm : resamplePcm16(chunk.pcm, chunk.sampleRate, MODEL_OUTPUT_SAMPLE_RATE);
        this.sendAudio("readback", pcm24);
      }
      if (first) throw new Error("text-to-speech returned no audio");
      this.send({ type: "readback", language, state: "done" });
    } catch (error) {
      this.send({ type: "readback", language, state: "error", detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---------------------------------------------------------------- plumbing

  private fanOut(pcm: Buffer): void {
    this.record(pcm);
    this.translateToA?.sendAudio(pcm);
    this.translateToB?.sendAudio(pcm);
    this.scribe?.sendAudio(pcm);
    this.agent?.sendAudio(pcm);
  }

  private record(pcm: Buffer): void {
    // Cap the in-memory recording at 20 minutes of 16 kHz PCM.
    if (this.recordingBytes > MIC_SAMPLE_RATE * 2 * 60 * 20) return;
    this.recording.push(Buffer.from(pcm));
    this.recordingBytes += pcm.length;
  }

  /**
   * How long after a speaker started talking the first translated audio arrived. The
   * translate model reports no voice activity itself, so the agent session's
   * ACTIVITY_START for the same microphone audio is the reference point.
   */
  private recordTranslateLatency(firstAudioAt: number): void {
    if (!this.lastSpeechStartAt) return;
    const ms = firstAudioAt - this.lastSpeechStartAt;
    if (ms <= 0 || ms > 10_000) return;
    this.metrics.translateFirstAudioMs.push(ms);
    this.send({ type: "metric", name: "translate_first_audio", valueMs: ms, stream: "translate" });
  }

  /** How long after the speaker stopped the translated text was complete. */
  private recordTranslateTail(ms: number): void {
    if (ms < 0 || ms > 30_000) return;
    this.metrics.translateTailMs.push(ms);
    this.send({ type: "metric", name: "translate_tail", valueMs: ms, stream: "translate" });
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private sendAudio(source: AudioSource, pcm24k: Buffer, flags = 0): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(frameAudio(source, pcm24k, flags));
  }

  private log(line: string): void {
    this.deps.log(`[${this.id}] ${line}`);
  }
}
