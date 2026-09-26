import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSessionConfig, parseClientMessage, ProtocolError } from "../server/protocol.js";
import { buildAgentSetup, buildAgentSystemPrompt, buildScribeSetup, buildTranslateSetup } from "../server/gemini/setups.js";
import { findScenario, type ScenarioId } from "../server/catalog.js";
import { AUDIO_SOURCE, frameAudio, resamplePcm16, wavFromPcm16 } from "../server/audio.js";

test("normalizeSessionConfig applies defaults and rejects bad languages", () => {
  const config = normalizeSessionConfig({ languageA: "hi", languageB: "en", scenario: "rental", duplex: "full" }, true);
  assert.equal(config.scenario, "rental");
  assert.equal(config.agentVoice, "Kore");
  assert.equal(config.counterpartVoice, "Leda");
  assert.equal(config.duplex, "full");
  assert.equal(config.mode, "auto");
  assert.equal(normalizeSessionConfig({ mode: "tap" }, true).mode, "tap");
  assert.equal(normalizeSessionConfig({ mode: "walkie" as "tap" }, true).mode, "auto");
  assert.throws(() => normalizeSessionConfig({ languageA: "en", languageB: "en" }, true), ProtocolError);
  assert.throws(() => normalizeSessionConfig({ languageA: "xx", languageB: "en" }, true), ProtocolError);
  assert.equal(normalizeSessionConfig({ scenario: "nope" as ScenarioId }, true).scenario, "general");
});

test("a browser-supplied key is only kept when BYOK is allowed", () => {
  const key = "A".repeat(30);
  assert.equal(normalizeSessionConfig({ apiKey: key }, false).apiKey, undefined);
  assert.equal(normalizeSessionConfig({ apiKey: key }, true).apiKey, key);
  assert.equal(normalizeSessionConfig({ apiKey: "short" }, true).apiKey, undefined);
});

test("parseClientMessage validates message shapes", () => {
  assert.deepEqual(parseClientMessage('{"type":"end"}'), { type: "end" });
  assert.deepEqual(parseClientMessage('{"type":"inject","opener":1}'), { type: "inject", text: undefined, opener: 1 });
  assert.deepEqual(parseClientMessage('{"type":"playback","source":"agent","state":"end"}'), { type: "playback", source: "agent", state: "end" });
  assert.deepEqual(parseClientMessage('{"type":"turn","action":"start"}'), { type: "turn", action: "start" });
  assert.throws(() => parseClientMessage('{"type":"turn","action":"pause"}'), ProtocolError);
  assert.throws(() => parseClientMessage("nope"), ProtocolError);
  assert.throws(() => parseClientMessage('{"type":"playback","source":"x","state":"start"}'), ProtocolError);
  assert.throws(() => parseClientMessage('{"type":"readback","language":"C"}'), ProtocolError);
  assert.throws(() => parseClientMessage('{"type":"warp"}'), ProtocolError);
});

test("translate setup places translationConfig in generationConfig and transcription at setup level", () => {
  const setup = buildTranslateSetup("gemini-3.5-live-translate-preview", "hi") as { setup: Record<string, unknown> };
  assert.equal(setup.setup.model, "models/gemini-3.5-live-translate-preview");
  assert.deepEqual((setup.setup.generationConfig as Record<string, unknown>).translationConfig, { targetLanguageCode: "hi", echoTargetLanguage: false });
  assert.deepEqual(setup.setup.inputAudioTranscription, {});
  assert.deepEqual(setup.setup.outputAudioTranscription, {});
});

test("agent setup declares blocking tools and a prompt that names both languages", () => {
  const scenario = findScenario("clinic")!;
  const setup = buildAgentSetup({ model: "gemini-3.8-live", languageA: "en", languageB: "es", scenario, voice: "Kore" }) as { setup: Record<string, unknown> };
  const tools = setup.setup.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
  const declarations = tools[0]!.functionDeclarations;
  assert.deepEqual(declarations.map((d) => d.name), ["report_tone", "note_commitment"]);
  assert.ok(declarations.every((d) => d.behavior === "BLOCKING"));
  const toneParams = declarations[0]!.parameters as { required: string[] };
  assert.ok(toneParams.required.includes("addressed_to_parley"));
  assert.deepEqual(setup.setup.sessionResumption, {});
  const prompt = buildAgentSystemPrompt({ languageA: "en", languageB: "es", scenario });
  assert.match(prompt, /Person A speaks English/);
  assert.match(prompt, /Person B speaks Spanish/);
  assert.match(prompt, /Clinic visit/);
  const resumed = buildAgentSetup({ model: "gemini-3.8-live", languageA: "en", languageB: "es", scenario, voice: "Kore", resumeHandle: "abc" }) as { setup: Record<string, unknown> };
  assert.deepEqual(resumed.setup.sessionResumption, { handle: "abc" });
});

test("scribe setup asks for SMART transcription with automatic VAD", () => {
  const setup = buildScribeSetup("gemini-3.5-transcribe-live") as { setup: Record<string, unknown> };
  assert.deepEqual(setup.setup.generationConfig, { responseModalities: ["TEXT"] });
  assert.equal((setup.setup.inputAudioTranscription as { mode: string }).mode, "SMART");
});

test("audio helpers: WAV header, resampling length, frame header", () => {
  const pcm = Buffer.alloc(16_000 * 2); // one second at 16 kHz
  const wav = wavFromPcm16(pcm, 16_000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(resamplePcm16(pcm, 16_000, 24_000).length, 24_000 * 2);
  assert.equal(resamplePcm16(pcm, 16_000, 16_000), pcm);
  const frame = frameAudio("agent", Buffer.from([1, 2, 3, 4]));
  assert.equal(frame[0], AUDIO_SOURCE.agent);
  assert.equal(frame.length, 8);
});
