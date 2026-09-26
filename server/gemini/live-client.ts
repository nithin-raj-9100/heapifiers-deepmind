import WebSocket from "ws";
import { redactSecrets } from "../config.js";

/**
 * Thin, dependency-injected client for the Gemini Live API (BidiGenerateContent over
 * WebSocket). One instance = one upstream session. Reconnection policy lives in the
 * session orchestrator, which knows whether a stream is resumable.
 *
 * The message vocabulary below was verified against gemini-3.8-live,
 * gemini-3.5-live-translate-preview and gemini-3.5-transcribe-live in September 2026.
 */

export const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface LivePart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

export interface LiveTranscription {
  text?: string;
  languageCode?: string;
  finished?: boolean;
}

export interface LiveServerContent {
  modelTurn?: { parts?: LivePart[]; role?: string };
  turnComplete?: boolean;
  interrupted?: boolean;
  generationComplete?: boolean;
  inputTranscription?: LiveTranscription;
  outputTranscription?: LiveTranscription;
  interimInputTranscription?: LiveTranscription;
  interactionStatus?: string;
}

export interface LiveFunctionCall {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface LiveMessage {
  setupComplete?: Record<string, never>;
  serverContent?: LiveServerContent;
  toolCall?: { functionCalls?: LiveFunctionCall[] };
  toolCallCancellation?: { ids?: string[] };
  voiceActivity?: { type?: "ACTIVITY_START" | "ACTIVITY_END" | string; audioOffset?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  goAway?: { timeLeft?: string };
  usageMetadata?: Record<string, unknown>;
  error?: { code?: number; message?: string; status?: string };
}

export interface LiveCloseInfo {
  code: number;
  reason: string;
  /** True when we asked for the close. */
  expected: boolean;
}

export interface LiveClientOptions {
  label: string;
  apiKey: string;
  setup: Record<string, unknown>;
  onMessage: (message: LiveMessage) => void;
  onClose: (info: LiveCloseInfo) => void;
  onLog?: (line: string) => void;
  connectTimeoutMs?: number;
  /** Test seam: build the socket from a URL. */
  socketFactory?: (url: string) => WebSocket;
}

export type LiveState = "connecting" | "ready" | "closed";

const MAX_QUEUED_AUDIO_BYTES = 16_000 * 2 * 10; // 10 s of 16 kHz PCM while connecting

export class LiveClient {
  state: LiveState = "connecting";
  readonly label: string;
  readonly stats = { audioBytesSent: 0, audioBytesReceived: 0, messagesReceived: 0, connectedAt: 0, readyAt: 0 };
  private readonly socket: WebSocket;
  private readonly options: LiveClientOptions;
  private readonly queuedAudio: Buffer[] = [];
  private queuedBytes = 0;
  private expectedClose = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private settled = false;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(options: LiveClientOptions) {
    this.options = options;
    this.label = options.label;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Avoid unhandled rejection noise when nobody awaits ready().
    this.readyPromise.catch(() => {});

    const url = `${LIVE_ENDPOINT}?key=${encodeURIComponent(options.apiKey)}`;
    this.socket = options.socketFactory ? options.socketFactory(url) : new WebSocket(url, { perMessageDeflate: false });
    this.stats.connectedAt = Date.now();

    this.connectTimer = setTimeout(() => {
      if (this.state === "connecting") this.fail(new Error(`${this.label}: Gemini Live setup timed out`));
    }, options.connectTimeoutMs ?? 15_000);

    this.socket.on("open", () => {
      this.sendJson(options.setup);
    });
    this.socket.on("message", (data, isBinary) => {
      const text = isBinary || Buffer.isBuffer(data) ? (data as Buffer).toString("utf8") : String(data);
      let message: LiveMessage;
      try {
        message = JSON.parse(text) as LiveMessage;
      } catch {
        this.log("unreadable message from Gemini");
        return;
      }
      this.stats.messagesReceived++;
      if (message.setupComplete && this.state === "connecting") this.becomeReady();
      if (message.error) {
        const detail = redactSecrets(message.error.message ?? "Gemini Live error", [options.apiKey]);
        this.log(`error: ${message.error.status ?? message.error.code ?? ""} ${detail}`);
        if (this.state === "connecting") this.fail(new Error(`${this.label}: ${detail}`));
      }
      const parts = message.serverContent?.modelTurn?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.inlineData?.data) this.stats.audioBytesReceived += Math.floor((part.inlineData.data.length * 3) / 4);
        }
      }
      options.onMessage(message);
    });
    this.socket.on("error", (error) => {
      const detail = redactSecrets(error.message, [options.apiKey]);
      this.log(`socket error: ${detail}`);
      if (this.state === "connecting") this.fail(new Error(`${this.label}: ${detail}`));
    });
    this.socket.on("close", (code, reasonBuffer) => {
      const reason = redactSecrets(reasonBuffer.toString("utf8"), [options.apiKey]);
      const expected = this.expectedClose;
      if (this.state === "connecting") this.fail(new Error(`${this.label}: closed during setup (${code}) ${reason}`.trim()));
      this.state = "closed";
      this.clearTimer();
      options.onClose({ code, reason, expected });
    });
  }

  /** Resolves once Gemini acknowledges the setup message. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Stream a 16 kHz PCM16 chunk. Queued (up to 10 s) while the setup handshake is in flight. */
  sendAudio(pcm16k: Buffer): void {
    if (this.state === "closed") return;
    if (this.state === "connecting") {
      if (this.queuedBytes + pcm16k.length > MAX_QUEUED_AUDIO_BYTES) {
        this.queuedAudio.shift();
      }
      this.queuedAudio.push(pcm16k);
      this.queuedBytes = this.queuedAudio.reduce((sum, chunk) => sum + chunk.length, 0);
      return;
    }
    this.sendAudioNow(pcm16k);
  }

  sendRealtime(payload: Record<string, unknown>): void {
    this.sendJson({ realtimeInput: payload });
  }

  sendAudioStreamEnd(): void {
    this.sendRealtime({ audioStreamEnd: true });
  }

  sendActivityStart(): void {
    this.sendRealtime({ activityStart: {} });
  }

  sendActivityEnd(): void {
    this.sendRealtime({ activityEnd: {} });
  }

  /** Text turn (the agent accepts these at any time; turnComplete=true interrupts generation). */
  sendClientContent(text: string, turnComplete: boolean, role = "user"): void {
    this.sendJson({ clientContent: { turns: [{ role, parts: [{ text }] }], turnComplete } });
  }

  sendToolResponse(responses: Array<{ id?: string; name: string; response: Record<string, unknown>; scheduling?: string }>): void {
    this.sendJson({ toolResponse: { functionResponses: responses } });
  }

  close(code = 1000, reason = "session ended"): void {
    if (this.state === "closed") return;
    this.expectedClose = true;
    try {
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close(code, reason);
      }
    } catch {
      /* already closing */
    }
  }

  private becomeReady(): void {
    this.state = "ready";
    this.stats.readyAt = Date.now();
    this.clearTimer();
    for (const chunk of this.queuedAudio) this.sendAudioNow(chunk);
    this.queuedAudio.length = 0;
    this.queuedBytes = 0;
    if (!this.settled) {
      this.settled = true;
      this.resolveReady();
    }
  }

  private fail(error: Error): void {
    if (!this.settled) {
      this.settled = true;
      this.rejectReady(error);
    }
    this.clearTimer();
  }

  private sendAudioNow(pcm16k: Buffer): void {
    this.stats.audioBytesSent += pcm16k.length;
    this.sendRealtime({ audio: { data: pcm16k.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private clearTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private log(line: string): void {
    this.options.onLog?.(`[${this.label}] ${line}`);
  }
}
