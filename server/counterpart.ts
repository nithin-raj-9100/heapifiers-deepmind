import { findLanguage, type Scenario } from "./catalog.js";
import type { GeminiRest } from "./gemini/rest.js";

/**
 * Plays "Person B" when a single person is trying Parley: Gemini 3.8 Flash writes the
 * next in-character line in language B (plus a gloss in language A for the UI), and
 * the caller voices it with TTS and feeds it through the live pipeline like real speech.
 */

export interface CounterpartLine {
  text: string;
  gloss: string;
  latencyMs: number;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    line: { type: "STRING", description: "What Person B says next, in their own language only." },
    gloss: { type: "STRING", description: "Faithful translation of the line into Person A's language." },
  },
  required: ["line", "gloss"],
};

export async function composeCounterpartLine(
  rest: GeminiRest,
  input: {
    scenario: Scenario;
    languageA: string;
    languageB: string;
    recentTranscript: string[];
    seedText?: string;
  },
): Promise<CounterpartLine> {
  const a = findLanguage(input.languageA)?.name ?? input.languageA;
  const b = findLanguage(input.languageB)?.name ?? input.languageB;
  const system = [
    `You are roleplaying Person B (${input.scenario.roleB}) in a spoken ${input.scenario.name.toLowerCase()} with Person A (${input.scenario.roleA}).`,
    `Persona: ${input.scenario.counterpartPersona}`,
    `Person B speaks ONLY ${b}. Person A speaks ${a}; an interpreter translates between you.`,
    `Write Person B's next line: one or two natural spoken sentences in ${b}, no stage directions, no quotation marks, no names of tools or systems.`,
    `Also provide a gloss: a faithful translation of that line into ${a}.`,
  ].join("\n");
  const transcript = input.recentTranscript.length > 0 ? input.recentTranscript.slice(-12).join("\n") : "(the conversation has just started)";
  const prompt = input.seedText
    ? `Conversation so far:\n${transcript}\n\nSay the following, adapted naturally into ${b} and into your persona: "${input.seedText}"`
    : `Conversation so far:\n${transcript}\n\nReply as Person B to the most recent thing Person A said. If Person A has not spoken yet, open the conversation in character.`;
  const result = await rest.generateJson<{ line: string; gloss: string }>({ system, prompt, schema: SCHEMA, thinkingLevel: "low", temperature: 0.8 });
  return { text: result.data.line.trim(), gloss: result.data.gloss.trim(), latencyMs: result.latencyMs };
}
