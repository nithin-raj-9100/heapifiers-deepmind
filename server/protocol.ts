import { findLanguage, findScenario, VOICES, type ScenarioId } from "./catalog.js";

/**
 * Browser ↔ server protocol. Text frames are JSON messages typed below; binary frames
 * carry audio (browser → server: raw 16 kHz PCM16; server → browser: 4-byte header +
 * 24 kHz PCM16, see audio.ts).
 */

export interface SessionConfig {
  languageA: string;
  languageB: string;
  scenario: ScenarioId;
  agentVoice: string;
  counterpartVoice: string;
  /** half: mute the mic while translated audio plays (prevents feedback loops). */
  duplex: "half" | "full";
  /** auto: hands-free, the mic is always live. tap: the mic streams only while a speaker's turn is open. */
  mode: "auto" | "tap";
  /** Optional browser-supplied key, used instead of the server key when allowed. */
  apiKey?: string;
}

export type ClientMessage =
  | { type: "start"; config: Partial<SessionConfig> }
  | { type: "playback"; source: "translate" | "agent" | "inject" | "readback"; state: "start" | "end" }
  | { type: "agent"; action: "engage" | "release" | "interrupt" }
  | { type: "turn"; action: "start" | "stop" }
  | { type: "inject"; text?: string; opener?: number }
  | { type: "end" }
  | { type: "readback"; language: "A" | "B" }
  | { type: "ping" };

export type StreamName = "translate" | "agent" | "scribe";

export interface ToneReading {
  tone: string;
  urgency: "low" | "medium" | "high";
  language?: string;
  speaker?: string;
  at: number;
}

export interface SummaryActionItem {
  owner: string;
  task: string;
  due: string;
  language_of_owner: string;
}

export interface SessionSummary {
  title: string;
  summary_a: string;
  summary_b: string;
  participants: Array<{ label: string; language: string; role: string }>;
  key_points: string[];
  decisions: string[];
  action_items: SummaryActionItem[];
  open_questions: string[];
  scenario_fields: Array<{ key: string; label: string; value: string }>;
  tone_arc: string;
  risk_flags: string[];
}

export type ServerMessage =
  | { type: "ready"; sessionId: string; models: Record<string, string>; config: SessionConfig; limits: { maxMinutes: number } }
  | { type: "status"; stream: StreamName; state: "connecting" | "ready" | "reconnecting" | "closed" | "error"; detail?: string }
  | { type: "caption"; stream: "toA" | "toB"; role: "source" | "target"; text: string; languageCode?: string; final: boolean; phraseId: number }
  | { type: "transcript"; kind: "interim" | "final"; text: string; at: number; replaced?: boolean }
  | { type: "activity"; stream: StreamName; state: "start" | "end" }
  | { type: "agent"; event: "listening" | "thinking" | "speaking" | "interrupted" | "done" | "engaged" | "released"; text?: string }
  | { type: "tone"; reading: ToneReading }
  | { type: "inject"; state: "thinking" | "speaking" | "done" | "error"; text?: string; translation?: string; detail?: string }
  | { type: "metric"; name: string; valueMs: number; stream?: string }
  | { type: "turn"; turnId: number; state: "listening" | "translating" | "done" }
  | { type: "summary"; summary: SessionSummary | null; transcript: Array<{ speaker: string; text: string; start: number; end: number }>; stats: Record<string, unknown>; error?: string }
  | { type: "readback"; language: "A" | "B"; state: "thinking" | "speaking" | "done" | "error"; detail?: string }
  | { type: "error"; code: string; message: string; fatal?: boolean }
  | { type: "pong" };

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("invalid_json", "Control messages must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
    throw new ProtocolError("invalid_message", "A control message requires a string type.");
  }
  const message = parsed as Record<string, unknown>;
  switch (message.type) {
    case "start":
      return { type: "start", config: (message.config && typeof message.config === "object" ? message.config : {}) as Partial<SessionConfig> };
    case "playback": {
      const source = message.source;
      const state = message.state;
      if (source !== "translate" && source !== "agent" && source !== "inject" && source !== "readback") throw new ProtocolError("invalid_playback", "Unknown playback source.");
      if (state !== "start" && state !== "end") throw new ProtocolError("invalid_playback", "Playback state must be start or end.");
      return { type: "playback", source, state };
    }
    case "agent": {
      const action = message.action;
      if (action !== "engage" && action !== "release" && action !== "interrupt") throw new ProtocolError("invalid_agent_action", "Unknown agent action.");
      return { type: "agent", action };
    }
    case "turn": {
      const action = message.action;
      if (action !== "start" && action !== "stop") throw new ProtocolError("invalid_turn", "Turn action must be start or stop.");
      return { type: "turn", action };
    }
    case "inject": {
      const text = typeof message.text === "string" ? message.text.slice(0, 600) : undefined;
      const opener = typeof message.opener === "number" && Number.isInteger(message.opener) ? message.opener : undefined;
      return { type: "inject", text, opener };
    }
    case "end":
      return { type: "end" };
    case "readback": {
      const language = message.language;
      if (language !== "A" && language !== "B") throw new ProtocolError("invalid_readback", "Readback language must be A or B.");
      return { type: "readback", language };
    }
    case "ping":
      return { type: "ping" };
    default:
      throw new ProtocolError("unknown_message", `Unknown message type: ${String(message.type)}`);
  }
}

export function normalizeSessionConfig(input: Partial<SessionConfig> | undefined, allowByok: boolean): SessionConfig {
  const languageA = typeof input?.languageA === "string" ? input.languageA : "en";
  const languageB = typeof input?.languageB === "string" ? input.languageB : "es";
  if (!findLanguage(languageA) || !findLanguage(languageB)) throw new ProtocolError("invalid_language", "Choose languages from the catalog.");
  if (languageA === languageB) throw new ProtocolError("invalid_language", "Pick two different languages.");
  const scenario = typeof input?.scenario === "string" && findScenario(input.scenario) ? (input.scenario as ScenarioId) : "general";
  const voiceNames = new Set(VOICES.map((voice) => voice.name));
  const agentVoice = typeof input?.agentVoice === "string" && voiceNames.has(input.agentVoice) ? input.agentVoice : "Kore";
  const counterpartVoice = typeof input?.counterpartVoice === "string" && voiceNames.has(input.counterpartVoice) ? input.counterpartVoice : "Leda";
  const duplex = input?.duplex === "full" ? "full" : "half";
  // Always-on listening garbled conversations on laptop speakers (translations leaked back into the
  // mic); every session is tap-to-talk.
  const mode = "tap";
  const apiKey = allowByok && typeof input?.apiKey === "string" && input.apiKey.trim().length >= 20 ? input.apiKey.trim() : undefined;
  return { languageA, languageB, scenario, agentVoice, counterpartVoice, duplex, mode, ...(apiKey ? { apiKey } : {}) };
}
