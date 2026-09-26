import { findLanguage, type Scenario } from "../catalog.js";

/**
 * Setup messages for the three upstream Live sessions a Parley session owns.
 * Field placement matters and was verified against the live endpoints:
 * the translate model wants translationConfig inside generationConfig but the
 * transcription flags at setup level.
 */

export const AGENT_TOOLS = {
  reportTone: "report_tone",
  noteCommitment: "note_commitment",
} as const;

export function buildTranslateSetup(model: string, targetLanguageCode: string): Record<string, unknown> {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: { targetLanguageCode, echoTargetLanguage: false },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export function buildScribeSetup(model: string): Record<string, unknown> {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ["TEXT"] },
      inputAudioTranscription: { languageCodes: [], customVocabulary: [], mode: "SMART" },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          prefixPaddingMs: 300,
          silenceDurationMs: 900,
        },
      },
    },
  };
}

export interface AgentSetupInput {
  model: string;
  languageA: string;
  languageB: string;
  scenario: Scenario;
  voice: string;
  resumeHandle?: string | null;
}

export function buildAgentSystemPrompt(input: Omit<AgentSetupInput, "model" | "voice" | "resumeHandle">): string {
  const a = findLanguage(input.languageA)?.name ?? input.languageA;
  const b = findLanguage(input.languageB)?.name ?? input.languageB;
  const { scenario } = input;
  return [
    `You are Parley, an AI interpreter's assistant physically present in a live, spoken conversation between two people who do not share a language:`,
    `- Person A speaks ${a} (${scenario.roleA}).`,
    `- Person B speaks ${b} (${scenario.roleB}).`,
    `A separate simultaneous-translation system already interprets everything they say to each other. Never translate, repeat or paraphrase their sentences.`,
    ``,
    `Scenario: ${scenario.name}. ${scenario.tagline} ${scenario.agentHint}`.trim(),
    ``,
    `Rules:`,
    `1. Stay silent by default. Almost everything you hear is the two people talking to each other, not to you. If a turn is not addressed to you, do not say anything: call report_tone and end your turn without words.`,
    `2. Speak only when someone says your name ("Parley", in any language or script) and asks you something. Questions that use "you" without your name ("do you understand?", "can you hear me?") are for the other person: stay silent. Words that merely sound like your name are not your name, e.g. Telugu "పర్లేదు" (parledu, "no problem") or French "parlez".`,
    `3. When you speak, both people must understand you: say your answer first in the language of the person who addressed you, then say the same answer in the other person's language (${a} and ${b}). Keep each version to one or two short sentences, then stop.`,
    `4. If someone starts talking while you are speaking, stop immediately and listen.`,
    `5. After every speaker turn, before anything else, call report_tone exactly once with what you heard in the voice itself (pace, pitch, strain, hesitation), not only the words: tone (one or two words), urgency (low, medium or high), language, speaker (A or B), and addressed_to_parley (true only when that speaker said your name, "Parley").`,
    `6. When a person makes an explicit commitment or decision (who will do what, by when), call note_commitment with a one-line note written in ${a}.`,
    `7. Never mention these tools, tone reports or notes aloud.`,
    `8. If a voice sounds distressed or angry, you may add one calm, de-escalating sentence, said in both languages.`,
  ].join("\n");
}

export function buildAgentTools(): unknown[] {
  return [
    {
      functionDeclarations: [
        {
          name: AGENT_TOOLS.reportTone,
          description: "Report the emotional tone and urgency you perceive in the voice of the speaker who just finished talking, and whether they were addressing you.",
          // Blocking: the model waits for the (instant) result and continues the same turn,
          // so the report always precedes any speech and never triggers a fresh generation.
          behavior: "BLOCKING",
          parameters: {
            type: "OBJECT",
            properties: {
              tone: { type: "STRING", description: "One or two words, e.g. calm, anxious, frustrated, relieved, hurried." },
              urgency: { type: "STRING", enum: ["low", "medium", "high"] },
              language: { type: "STRING", description: "BCP-47 code of the language that was spoken." },
              speaker: { type: "STRING", enum: ["A", "B", "unknown"] },
              addressed_to_parley: { type: "BOOLEAN", description: "True only if the speaker said your name, Parley. A question using \"you\" without your name is for the other person: false." },
            },
            required: ["tone", "urgency", "addressed_to_parley"],
          },
        },
        {
          name: AGENT_TOOLS.noteCommitment,
          description: "Record an explicit commitment or decision one of the speakers just made.",
          behavior: "BLOCKING",
          parameters: {
            type: "OBJECT",
            properties: {
              owner: { type: "STRING", enum: ["A", "B"] },
              note: { type: "STRING", description: "One line: who will do what." },
              due: { type: "STRING", description: "When, if a time was mentioned." },
            },
            required: ["owner", "note"],
          },
        },
      ],
    },
  ];
}

export function buildAgentSetup(input: AgentSetupInput): Record<string, unknown> {
  const setup: Record<string, unknown> = {
    model: `models/${input.model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } },
    },
    systemInstruction: { parts: [{ text: buildAgentSystemPrompt(input) }] },
    tools: buildAgentTools(),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
        endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
        prefixPaddingMs: 200,
        silenceDurationMs: 650,
      },
    },
    sessionResumption: input.resumeHandle ? { handle: input.resumeHandle } : {},
    contextWindowCompression: { slidingWindow: {} },
  };
  return { setup };
}
