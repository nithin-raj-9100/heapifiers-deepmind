import { findLanguage, type Scenario } from "./catalog.js";
import { wavFromPcm16, MIC_SAMPLE_RATE } from "./audio.js";
import type { DiarizedSegment, GeminiRest } from "./gemini/rest.js";
import type { SessionSummary, ToneReading } from "./protocol.js";
import type { TranscriptSegment } from "./transcript.js";

/**
 * End-of-session pipeline: diarized transcription of the whole recording
 * (Gemini 3.5 Transcribe) followed by structured extraction (Gemini 3.8 Flash).
 */

export interface CaptionRecord {
  stream: "toA" | "toB";
  source: string;
  target: string;
  sourceLang?: string;
  targetLang?: string;
  /** Who spoke, decided from the detected source language. */
  speaker?: "A" | "B";
  at: number;
}

export interface LiveNote {
  owner: string;
  note: string;
  due?: string;
  at: number;
}

export interface ScribeInput {
  recording: Buffer | null;
  sessionStartedAt: number;
  languageA: string;
  languageB: string;
  scenario: Scenario;
  captions: CaptionRecord[];
  liveSegments: TranscriptSegment[];
  tones: ToneReading[];
  notes: LiveNote[];
  agentLines: string[];
}

export interface ScribeOutput {
  summary: SessionSummary | null;
  transcript: DiarizedSegment[];
  stats: Record<string, unknown>;
  error?: string;
}

/** Inline audio must stay under the 20 MB request cap once base64-encoded. */
const MAX_TRANSCRIBE_SECONDS = 7 * 60;

export function buildSummarySchema(scenario: Scenario): Record<string, unknown> {
  return {
    type: "OBJECT",
    properties: {
      title: { type: "STRING", description: "Short title for the conversation." },
      summary_a: { type: "STRING", description: "Three to five sentence summary written in Person A's language." },
      summary_b: { type: "STRING", description: "The same summary written in Person B's language." },
      participants: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            label: { type: "STRING", description: "Speaker label as it appears in the transcript, e.g. Speaker 1." },
            language: { type: "STRING" },
            role: { type: "STRING", description: `Best guess of the role, e.g. ${scenario.roleA} or ${scenario.roleB}.` },
          },
          required: ["label", "language", "role"],
        },
      },
      key_points: { type: "ARRAY", items: { type: "STRING" } },
      decisions: { type: "ARRAY", items: { type: "STRING" } },
      action_items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            owner: { type: "STRING" },
            task: { type: "STRING" },
            due: { type: "STRING" },
            language_of_owner: { type: "STRING" },
          },
          required: ["owner", "task", "due", "language_of_owner"],
        },
      },
      open_questions: { type: "ARRAY", items: { type: "STRING" } },
      scenario_fields: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            key: { type: "STRING", enum: scenario.fields.map((field) => field.key) },
            label: { type: "STRING" },
            value: { type: "STRING" },
          },
          required: ["key", "label", "value"],
        },
      },
      tone_arc: { type: "STRING", description: "One or two sentences on how the emotional tone evolved, based on the tone timeline." },
      risk_flags: { type: "ARRAY", items: { type: "STRING" }, description: "Misunderstandings, contradictions or safety concerns worth a human's attention." },
    },
    required: ["title", "summary_a", "summary_b", "participants", "key_points", "decisions", "action_items", "open_questions", "scenario_fields", "tone_arc", "risk_flags"],
  };
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function buildSummaryPrompt(input: ScribeInput, transcript: DiarizedSegment[], transcriptSource: string): { system: string; prompt: string } {
  const a = findLanguage(input.languageA)?.name ?? input.languageA;
  const b = findLanguage(input.languageB)?.name ?? input.languageB;
  const system = [
    `You are the scribe for a spoken, interpreted conversation between Person A (${input.scenario.roleA}, speaks ${a}) and Person B (${input.scenario.roleB}, speaks ${b}).`,
    `Scenario: ${input.scenario.name}. ${input.scenario.tagline}`,
    `Produce a faithful structured record. Never invent facts; when something was not said, use an empty string or an empty list.`,
    `Write summary_a in ${a} and summary_b in ${b}. Write everything else in ${a}.`,
    `Action items must name the owner by role (${input.scenario.roleA} or ${input.scenario.roleB}) and keep dates and amounts exactly as spoken.`,
    `Fill scenario_fields for every key listed, using the label given.`,
  ].join("\n");

  const lines: string[] = [];
  lines.push(`## Diarized transcript (${transcriptSource})`);
  if (transcript.length === 0) lines.push("(no speech was captured)");
  for (const segment of transcript) lines.push(`[${formatClock(segment.start)}] ${segment.speaker}: ${segment.text}`);

  // Both translate sessions transcribe every utterance; only the one that produced a
  // translation is informative here.
  const translated = input.captions.filter((caption) => caption.target.trim() && caption.source.trim());
  if (translated.length > 0) {
    lines.push("", "## Live translation pairs (speaker, source → target), for cross-checking meaning");
    for (const caption of translated.slice(-60)) {
      const who = caption.speaker === "A" ? input.scenario.roleA : caption.speaker === "B" ? input.scenario.roleB : "?";
      lines.push(`- ${who} (${caption.sourceLang ?? "?"} → ${caption.targetLang ?? "?"}): ${caption.source.trim()} → ${caption.target.trim()}`);
    }
  }
  if (input.tones.length > 0) {
    lines.push("", "## Tone timeline perceived from the voices (speaker, tone, urgency)");
    for (const tone of input.tones.slice(-40)) {
      lines.push(`- [${formatClock((tone.at - input.sessionStartedAt) / 1000)}] ${tone.speaker ?? "?"}: ${tone.tone} (${tone.urgency})`);
    }
  }
  if (input.notes.length > 0) {
    lines.push("", "## Commitments noted live by the assistant");
    for (const note of input.notes) lines.push(`- ${note.owner}: ${note.note}${note.due ? ` (due ${note.due})` : ""}`);
  }
  if (input.agentLines.length > 0) {
    lines.push("", "## What the assistant (Parley) said aloud");
    for (const line of input.agentLines.slice(-10)) lines.push(`- ${line}`);
  }
  lines.push("", `## Scenario fields to fill`);
  for (const field of input.scenario.fields) lines.push(`- ${field.key}: ${field.label}`);
  return { system, prompt: lines.join("\n") };
}

export async function runScribe(rest: GeminiRest, input: ScribeInput): Promise<ScribeOutput> {
  const stats: Record<string, unknown> = {};
  let transcript: DiarizedSegment[] = [];
  let transcriptSource = "live transcription stream";
  let transcribeError: string | undefined;

  const recording = input.recording;
  if (recording && recording.length > MIC_SAMPLE_RATE * 2 * 0.8) {
    const maxBytes = MAX_TRANSCRIBE_SECONDS * MIC_SAMPLE_RATE * 2;
    const slice = recording.length > maxBytes ? recording.subarray(recording.length - maxBytes) : recording;
    const offsetSeconds = (recording.length - slice.length) / (MIC_SAMPLE_RATE * 2);
    try {
      const result = await rest.transcribe({ wav: wavFromPcm16(slice, MIC_SAMPLE_RATE) });
      transcript = result.segments.map((segment) => ({ ...segment, start: segment.start + offsetSeconds, end: segment.end + offsetSeconds }));
      transcriptSource = `${result.model}, speaker diarization`;
      stats.transcribeMs = result.latencyMs;
      stats.transcribedSeconds = Math.round(slice.length / (MIC_SAMPLE_RATE * 2));
      stats.words = result.words.length;
      if (offsetSeconds > 0) stats.transcriptionTruncatedSeconds = Math.round(offsetSeconds);
    } catch (error) {
      transcribeError = error instanceof Error ? error.message : String(error);
    }
  }
  if (transcript.length === 0) {
    transcript = input.liveSegments.map((segment) => ({
      speaker: "Speaker",
      text: segment.text,
      start: Math.max(0, (segment.at - input.sessionStartedAt) / 1000),
      end: Math.max(0, (segment.at - input.sessionStartedAt) / 1000),
    }));
  }

  const nothingSaid = transcript.length === 0 && input.captions.length === 0;
  if (nothingSaid) {
    return { summary: null, transcript, stats, error: transcribeError ?? "No speech was captured in this session." };
  }

  try {
    const { system, prompt } = buildSummaryPrompt(input, transcript, transcriptSource);
    const result = await rest.generateJson<SessionSummary>({ system, prompt, schema: buildSummarySchema(input.scenario), thinkingLevel: "low" });
    stats.summaryMs = result.latencyMs;
    stats.summaryModel = result.model;
    return { summary: result.data, transcript, stats, ...(transcribeError ? { error: `Diarized transcription failed (${transcribeError}); used the live transcript instead.` } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { summary: null, transcript, stats, error: transcribeError ? `${transcribeError}; ${message}` : message };
  }
}
