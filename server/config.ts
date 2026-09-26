import fs from "node:fs";
import path from "node:path";

/** Gemini model IDs used by each stage of the pipeline. All overridable via env. */
export interface ModelIds {
  /** Voice agent ("Parley"): interruptible, tone-aware, tool calling. */
  live: string;
  /** Simultaneous speech-to-speech translation. */
  translate: string;
  /** Streaming verbatim/smart transcription for the live scribe pane. */
  transcribeLive: string;
  /** Prerecorded transcription with speaker diarization and word timestamps. */
  transcribe: string;
  /** Text-to-speech for the simulated counterpart and the spoken summary. */
  tts: string;
  /** Faster TTS used for the low-latency "simulate the other party" path. */
  ttsFast: string;
  /** Structured extraction (summary, decisions, action items, scenario fields). */
  flash: string;
}

export interface Config {
  apiKey: string | null;
  port: number;
  models: ModelIds;
  /** Concurrent live sessions the server will host with its own key. */
  maxSessions: number;
  /** Hard cap per session, protects the hosted key. */
  sessionMaxMinutes: number;
  /** Whether a browser may supply its own Gemini key for a session. */
  allowByok: boolean;
  publicDir: string;
}

/** Minimal .env loader; shell environment always wins over the file. */
export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1]!;
    if (process.env[key] !== undefined) continue;
    process.env[key] = (match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
  }
}

export function loadConfig(root = process.cwd()): Config {
  loadDotEnv(path.join(root, ".env"));
  const env = process.env;
  return {
    apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || null,
    port: Number(env.PORT) || 8080,
    models: {
      live: env.PARLEY_LIVE_MODEL || "gemini-3.8-live",
      translate: env.PARLEY_TRANSLATE_MODEL || "gemini-3.5-live-translate-preview",
      transcribeLive: env.PARLEY_TRANSCRIBE_LIVE_MODEL || "gemini-3.5-transcribe-live",
      transcribe: env.PARLEY_TRANSCRIBE_MODEL || "gemini-3.5-transcribe",
      tts: env.PARLEY_TTS_MODEL || "gemini-3.8-flash-tts",
      ttsFast: env.PARLEY_TTS_FAST_MODEL || "gemini-3.8-flash-lite-tts",
      flash: env.PARLEY_FLASH_MODEL || "gemini-3.8-flash",
    },
    maxSessions: Number(env.PARLEY_MAX_SESSIONS) || 8,
    sessionMaxMinutes: Number(env.PARLEY_SESSION_MAX_MINUTES) || 12,
    allowByok: env.PARLEY_ALLOW_BYOK !== "0",
    publicDir: path.join(root, "public"),
  };
}

const SECRET_PATTERNS = [/AIza[\w-]{20,}/g, /AQ\.[\w-]{20,}/g, /key=[\w.-]{20,}/g];

/** Strip API keys from anything that could reach a log or a browser. */
export function redactSecrets(text: string, knownSecrets: Array<string | null | undefined> = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
