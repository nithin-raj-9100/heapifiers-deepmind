import type { ModelIds } from "../config.js";
import { redactSecrets } from "../config.js";

/**
 * REST-side Gemini calls: text-to-speech and prerecorded transcription through the
 * Interactions API, structured extraction through generateContent.
 * Shapes verified against the live endpoints in September 2026.
 */

const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export interface SpeechResult {
  /** Raw PCM16 mono. */
  pcm: Buffer;
  sampleRate: number;
  latencyMs: number;
  model: string;
}

export interface SpeechChunk {
  pcm: Buffer;
  sampleRate: number;
}

export interface SpeechStreamSummary {
  latencyMs: number;
  firstChunkMs: number | null;
  bytes: number;
  model: string;
}

export interface DialogueLine {
  speaker: string;
  text: string;
  style?: string;
}

export interface TranscribedWord {
  text: string;
  speaker: string;
  start: number;
  end: number;
}

export interface DiarizedSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  words: TranscribedWord[];
  segments: DiarizedSegment[];
  latencyMs: number;
  model: string;
}

export interface JsonResult<T> {
  data: T;
  latencyMs: number;
  thoughtsTokens: number;
  model: string;
}

interface InteractionContentItem {
  type?: string;
  text?: string;
  data?: string;
  mime_type?: string;
  sample_rate?: number;
  annotations?: Array<Record<string, unknown>>;
}

interface InteractionResponse {
  status?: string;
  steps?: Array<{ type?: string; content?: InteractionContentItem[] }>;
  error?: { message?: string; code?: string | number };
}

export class GeminiRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface GeminiRestOptions {
  apiKey: string;
  models: ModelIds;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GeminiRest {
  private readonly apiKey: string;
  private readonly models: ModelIds;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: GeminiRestOptions) {
    this.apiKey = options.apiKey;
    this.models = options.models;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 90_000;
  }

  /** Single-voice TTS. `style` is a free-text delivery hint ("calm, unhurried"). */
  async synthesize(input: { text: string; voice: string; style?: string; fast?: boolean }): Promise<SpeechResult> {
    const model = input.fast ? this.models.ttsFast : this.models.tts;
    const content: Record<string, unknown> = { type: "text", text: input.text };
    if (input.style) content.annotations = [{ type: "speech_metadata", style: input.style }];
    const body = {
      model,
      input: [{ type: "user_input", content: [content] }],
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24_000 },
      generation_config: { speech_config: [{ voice: input.voice }] },
    };
    return this.speech(body, model);
  }

  /**
   * Streaming TTS over server-sent events: yields raw PCM chunks as the model produces
   * them. First audio typically lands within a second, versus 6–8 s for the unary call.
   */
  async *synthesizeStream(input: { text: string; voice: string; style?: string; fast?: boolean }): AsyncGenerator<SpeechChunk, SpeechStreamSummary, void> {
    const model = input.fast ? this.models.ttsFast : this.models.tts;
    const content: Record<string, unknown> = { type: "text", text: input.text };
    if (input.style) content.annotations = [{ type: "speech_metadata", style: input.style }];
    const body = {
      model,
      input: [{ type: "user_input", content: [content] }],
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24_000 },
      generation_config: { speech_config: [{ voice: input.voice }] },
      stream: true,
    };
    const started = Date.now();
    let firstChunkMs: number | null = null;
    let bytes = 0;
    for await (const event of this.postSse(INTERACTIONS_URL, body)) {
      const data = event.data as { delta?: InteractionContentItem; error?: { message?: string } } | null;
      if (data?.error) throw new GeminiRestError(redactSecrets(`TTS stream error: ${data.error.message ?? "unknown"}`, [this.apiKey]), 200);
      if (event.event !== "step.delta" || data?.delta?.type !== "audio" || typeof data.delta.data !== "string") continue;
      const pcm = Buffer.from(data.delta.data, "base64");
      if (pcm.length < 2) continue;
      if (firstChunkMs === null) firstChunkMs = Date.now() - started;
      bytes += pcm.length;
      yield { pcm, sampleRate: data.delta.sample_rate ?? 24_000 };
    }
    return { latencyMs: Date.now() - started, firstChunkMs, bytes, model };
  }

  /** Multi-speaker TTS: each line carries its speaker inside a speech_metadata annotation. */
  async synthesizeDialogue(input: { lines: DialogueLine[]; speakers: Array<{ speaker: string; voice: string }>; fast?: boolean }): Promise<SpeechResult> {
    const model = input.fast ? this.models.ttsFast : this.models.tts;
    const body = {
      model,
      input: input.lines.map((line) => ({
        type: "user_input",
        content: [
          {
            type: "text",
            text: line.text,
            annotations: [{ type: "speech_metadata", speaker: line.speaker, ...(line.style ? { style: line.style } : {}) }],
          },
        ],
      })),
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24_000 },
      generation_config: { speech_config: { mode: "conversational", speakers: input.speakers } },
    };
    return this.speech(body, model);
  }

  /**
   * Prerecorded transcription with speaker diarization and word timestamps
   * (verbatim mode; smart mode cannot be combined with diarization).
   */
  async transcribe(input: { wav: Buffer; languageCodes?: string[] }): Promise<TranscriptionResult> {
    const model = this.models.transcribe;
    const transcriptionConfig: Record<string, unknown> = {
      mode: { type: "verbatim" },
      diarization_mode: "speaker",
      timestamp_granularities: ["word"],
    };
    if (input.languageCodes && input.languageCodes.length > 0) transcriptionConfig.language_codes = input.languageCodes;
    const body = {
      model,
      input: [{ type: "audio", data: input.wav.toString("base64"), mime_type: "audio/wav" }],
      generation_config: { transcription_config: transcriptionConfig },
    };
    const started = Date.now();
    const response = (await this.postJson(INTERACTIONS_URL, body)) as InteractionResponse;
    const item = firstContent(response, (candidate) => typeof candidate.text === "string");
    const parsed = parseTranscription(item);
    return { ...parsed, latencyMs: Date.now() - started, model };
  }

  /** Structured JSON generation with a response schema (Gemini 3.8 Flash). */
  async generateJson<T>(input: { system: string; prompt: string; schema: Record<string, unknown>; thinkingLevel?: "low" | "medium" | "high"; temperature?: number }): Promise<JsonResult<T>> {
    const model = this.models.flash;
    const body = {
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: input.schema,
        thinkingConfig: { thinkingLevel: input.thinkingLevel ?? "low" },
        temperature: input.temperature ?? 0.3,
        maxOutputTokens: 8192,
      },
    };
    const started = Date.now();
    const response = (await this.postJson(`${MODELS_URL}/${encodeURIComponent(model)}:generateContent`, body)) as {
      candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { thoughtsTokenCount?: number };
    };
    const candidate = response.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") throw new GeminiRestError("Structured output was truncated (MAX_TOKENS)", 200);
    const text = (candidate?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    if (!text.trim()) throw new GeminiRestError("Structured output was empty", 200);
    let data: T;
    try {
      data = JSON.parse(text) as T;
    } catch {
      throw new GeminiRestError("Structured output was not valid JSON", 200);
    }
    return { data, latencyMs: Date.now() - started, thoughtsTokens: response.usageMetadata?.thoughtsTokenCount ?? 0, model };
  }

  private async speech(body: Record<string, unknown>, model: string): Promise<SpeechResult> {
    const started = Date.now();
    const response = (await this.postJson(INTERACTIONS_URL, body)) as InteractionResponse;
    const item = firstContent(response, (candidate) => candidate.type === "audio" && typeof candidate.data === "string");
    if (!item?.data) throw new GeminiRestError("TTS response carried no audio", 200);
    return { pcm: Buffer.from(item.data, "base64"), sampleRate: item.sample_rate ?? 24_000, latencyMs: Date.now() - started, model };
  }

  /** POST and iterate the response as server-sent events ({event, data}). */
  private async *postSse(url: string, body: unknown): AsyncGenerator<{ event: string; data: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        let message = text.slice(0, 400);
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
        } catch {
          /* not JSON */
        }
        throw new GeminiRestError(redactSecrets(`Gemini HTTP ${response.status}: ${message}`, [this.apiKey]), response.status);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const parsed = parseSseEvent(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (parsed) yield parsed;
          boundary = buffer.indexOf("\n\n");
        }
      }
      const tail = parseSseEvent(buffer);
      if (tail) yield tail;
    } catch (error) {
      if (error instanceof GeminiRestError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GeminiRestError(redactSecrets(`Gemini stream failed: ${message}`, [this.apiKey]), 0);
    } finally {
      clearTimeout(timer);
    }
  }

  private async postJson(url: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (!response.ok) {
        const message = ((json as { error?: { message?: string } } | null)?.error?.message ?? text).slice(0, 400);
        throw new GeminiRestError(redactSecrets(`Gemini HTTP ${response.status}: ${message}`, [this.apiKey]), response.status);
      }
      if (json === null) throw new GeminiRestError("Gemini returned a non-JSON body", response.status);
      return json;
    } catch (error) {
      if (error instanceof GeminiRestError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GeminiRestError(redactSecrets(`Gemini request failed: ${message}`, [this.apiKey]), 0);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseSseEvent(raw: string): { event: string; data: unknown } | null {
  const trimmed = raw.replace(/\r/g, "").trim();
  if (!trimmed) return null;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const text = dataLines.join("\n");
  if (!text) return { event, data: null };
  try {
    return { event, data: JSON.parse(text) };
  } catch {
    return { event, data: text };
  }
}

function firstContent(response: InteractionResponse, predicate: (item: InteractionContentItem) => boolean): InteractionContentItem | undefined {
  for (const step of response.steps ?? []) {
    for (const item of step.content ?? []) {
      if (predicate(item)) return item;
    }
  }
  return undefined;
}

function parseOffset(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const seconds = Number.parseFloat(value.replace(/s$/, ""));
  return Number.isFinite(seconds) ? seconds : 0;
}

/** Turn transcribe word annotations into speaker segments (words joined with spaces). */
export function parseTranscription(item: InteractionContentItem | undefined): Omit<TranscriptionResult, "latencyMs" | "model"> {
  const words: TranscribedWord[] = [];
  for (const annotation of item?.annotations ?? []) {
    if (annotation.type !== "word_info" || typeof annotation.text !== "string") continue;
    const rawSpeaker = typeof annotation.speaker === "string" ? annotation.speaker : "spk:0";
    words.push({
      text: annotation.text,
      speaker: speakerLabel(rawSpeaker),
      start: parseOffset(annotation.start_offset),
      end: parseOffset(annotation.end_offset),
    });
  }
  const segments: DiarizedSegment[] = [];
  for (const word of words) {
    const last = segments[segments.length - 1];
    if (last && last.speaker === word.speaker && word.start - last.end < 2.5) {
      last.text += ` ${word.text}`;
      last.end = word.end;
    } else {
      segments.push({ speaker: word.speaker, text: word.text, start: word.start, end: word.end });
    }
  }
  const text = segments.length > 0 ? segments.map((segment) => segment.text).join(" ") : (item?.text ?? "").trim();
  if (segments.length === 0 && text) segments.push({ speaker: "Speaker 1", text, start: 0, end: 0 });
  return { text, words, segments };
}

/** "spk:0" / "spk_1" → "Speaker 1" / "Speaker 2". */
export function speakerLabel(raw: string): string {
  const match = raw.match(/(\d+)/);
  if (!match) return raw;
  return `Speaker ${Number(match[1]) + 1}`;
}
