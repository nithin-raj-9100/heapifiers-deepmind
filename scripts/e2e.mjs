#!/usr/bin/env node
// End-to-end check against a running Parley server, using synthesized speech as the microphone.
// Exercises: session start, simultaneous translation, the scribe, tone reports, wake gating,
// barge-in, the simulated counterpart, the end-of-session summary and spoken readback.
//
//   npm run build && node dist/server/index.js &   (server needs GEMINI_API_KEY)
//   node scripts/e2e.mjs [ws://localhost:8080/ws]
import WebSocket from "ws";
import { loadConfig } from "../dist/server/config.js";
import { GeminiRest } from "../dist/server/gemini/rest.js";
import { resamplePcm16, MIC_CHUNK_BYTES } from "../dist/server/audio.js";

const url = process.argv[2] || `ws://localhost:${process.env.PORT || 8080}/ws`;
const config = loadConfig();
if (!config.apiKey) {
  console.error("GEMINI_API_KEY is required to synthesize the test speech.");
  process.exit(1);
}
const rest = new GeminiRest({ apiKey: config.apiKey, models: config.models });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

console.log("synthesizing test speech (Person B in Spanish, Person A addressing Parley in English)…");
const [personB, personAParley, personAPlain] = await Promise.all([
  rest.synthesize({ text: "Buenos días doctor. Desde ayer me duele mucho la cabeza y tengo fiebre alta.", voice: "Leda", fast: true }),
  rest.synthesize({ text: "Parley, quick question: what does the word fiebre mean in English?", voice: "Charon", fast: true }),
  rest.synthesize({ text: "Okay, I will prescribe something for the fever and I want to see you again on Friday.", voice: "Charon", fast: true }),
]);
const toMic = (speech) => resamplePcm16(speech.pcm, speech.sampleRate, 16000);
console.log(`speech ready ${stamp()} (${config.models.ttsFast})`);

const ws = new WebSocket(url);
const events = [];
const audio = { translate: 0, agent: 0, inject: 0, readback: 0 };
const sourceNames = ["?", "translate", "agent", "inject", "readback"];
// A real browser reports when Parley's audio is playing; simulate that from the bytes received
// (24 kHz PCM16 = 48,000 bytes per second) so barge-in during playback can be exercised.
let agentPlayingUntil = 0;
let agentPlaybackReported = false;
setInterval(() => {
  if (agentPlaybackReported && Date.now() > agentPlayingUntil && ws.readyState === 1) {
    agentPlaybackReported = false;
    ws.send(JSON.stringify({ type: "playback", source: "agent", state: "end" }));
  }
}, 100).unref();
ws.on("message", (data, isBinary) => {
  if (isBinary) {
    const source = sourceNames[data[0]] ?? "?";
    audio[source] += data.length - 4;
    if (source === "agent") {
      const now = Date.now();
      agentPlayingUntil = Math.max(agentPlayingUntil, now) + ((data.length - 4) / 48_000) * 1000;
      if (!agentPlaybackReported) {
        agentPlaybackReported = true;
        ws.send(JSON.stringify({ type: "playback", source: "agent", state: "start" }));
      }
    }
    return;
  }
  const message = JSON.parse(data.toString());
  events.push(message);
  const quiet = (message.type === "caption" && !message.final) || (message.type === "transcript" && message.kind === "interim");
  if (!quiet) console.log(stamp(), JSON.stringify(message).slice(0, 240));
});
// Resolves with the first matching message that arrives from now on (or already arrived
// after `since`, an index into `events`); older matches are ignored.
function waitFor(predicate, timeoutMs, label, since = events.length) {
  const existing = events.slice(since).find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", listener);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const listener = (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (predicate(message)) {
        clearTimeout(timer);
        ws.off("message", listener);
        resolve(message);
      }
    };
    ws.on("message", listener);
  });
}
// Like a real microphone, keep streaming silence whenever nobody is "speaking"; the
// upstream voice-activity detectors need continuous audio to close an utterance.
let speaking = false;
const silenceFrame = Buffer.alloc(MIC_CHUNK_BYTES);
setInterval(() => {
  if (!speaking && sessionLive && ws.readyState === 1) ws.send(silenceFrame);
}, 100).unref();
let sessionLive = false;
async function streamMic(pcm16) {
  speaking = true;
  for (let offset = 0; offset < pcm16.length; offset += MIC_CHUNK_BYTES) {
    ws.send(pcm16.subarray(offset, offset + MIC_CHUNK_BYTES));
    await sleep(100);
  }
  speaking = false;
}
async function streamSilence(ms) {
  await sleep(ms);
}

await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
ws.send(JSON.stringify({ type: "start", config: { languageA: "en", languageB: "es", scenario: "clinic", duplex: "full" } }));
await waitFor((m) => m.type === "ready", 10_000, "ready", 0);
sessionLive = true;
try {
  await Promise.all([
    waitFor((m) => m.type === "status" && m.stream === "translate" && m.state === "ready", 25_000, "translate ready", 0),
    waitFor((m) => m.type === "status" && m.stream === "agent" && m.state === "ready", 25_000, "agent ready", 0),
    waitFor((m) => m.type === "status" && m.stream === "scribe" && m.state === "ready", 25_000, "scribe ready", 0),
  ]);
  check("all three live streams reach ready", true, stamp());
} catch (error) {
  check("all three live streams reach ready", false, error.message);
}

// 1. Person B speaks Spanish: expect an English translation, live transcript and a tone reading; Parley must stay quiet.
console.log(`\n--- Person B speaks (Spanish) ${stamp()}`);
const agentAudioBefore = audio.agent;
await streamMic(toMic(personB));
await streamSilence(7000);
const englishCaption = events.find((m) => m.type === "caption" && m.stream === "toA" && m.role === "target" && m.final && m.text.trim());
check("translate: Spanish → English caption", Boolean(englishCaption), englishCaption?.text);
check("translate: translated audio streamed", audio.translate > 0, `${audio.translate} bytes`);
const spanishSource = events.find((m) => m.type === "caption" && m.stream === "toA" && m.role === "source" && m.languageCode === "es");
check("translate: source language detected as es", Boolean(spanishSource));
check("scribe: live transcript final", events.some((m) => m.type === "transcript" && m.kind === "final" && !m.text.startsWith("📌")));
check("agent: tone reading reported", events.some((m) => m.type === "tone"), JSON.stringify(events.find((m) => m.type === "tone")?.reading ?? null));
check("agent: stays quiet when not addressed", audio.agent === agentAudioBefore, `${audio.agent - agentAudioBefore} agent bytes`);

// 2. Person A addresses Parley by name: expect spoken answer.
console.log(`\n--- Person A asks Parley (English) ${stamp()}`);
const speakingBefore = events.filter((m) => m.type === "agent" && m.event === "speaking").length;
const askIndex = events.length;
await streamMic(toMic(personAParley));
let spoke = false;
try {
  await waitFor((m) => m.type === "agent" && m.event === "done" && m.text, 25_000, "agent answer", askIndex);
  spoke = true;
} catch {
  spoke = events.filter((m) => m.type === "agent" && m.event === "speaking").length > speakingBefore;
}
const answer = [...events].reverse().find((m) => m.type === "agent" && m.text);
check("agent: answers when addressed by name", spoke && audio.agent > agentAudioBefore, answer?.text ?? "");
check("translate: the question was also translated for Person B", events.some((m) => m.type === "caption" && m.stream === "toB" && m.role === "target" && m.text.trim()));

// 3. Barge-in: ask a question that needs a longer answer, then talk over it while it plays.
console.log(`\n--- barge-in test ${stamp()}`);
const interruptionsBefore = events.filter((m) => m.type === "agent" && m.event === "interrupted").length;
const longQuestion = await rest.synthesize({ text: "Parley, please explain to me in four or five sentences how a clinic visit with an interpreter usually works, step by step.", voice: "Charon", fast: true });
const bargeIndex = events.length;
await streamMic(toMic(longQuestion));
try {
  await waitFor((m) => m.type === "agent" && m.event === "speaking", 20_000, "agent speaking", bargeIndex);
  await sleep(900);
  const overIndex = events.length;
  await streamMic(toMic(personAPlain));
  await waitFor((m) => m.type === "agent" && m.event === "interrupted", 8000, "interrupted", overIndex);
} catch (error) {
  console.log("barge-in note:", error.message);
}
check("agent: barge-in produces an interrupted event", events.filter((m) => m.type === "agent" && m.event === "interrupted").length > interruptionsBefore);
await streamSilence(4000);

// 4. Simulated counterpart.
console.log(`\n--- simulated counterpart ${stamp()}`);
const injectIndex = events.length;
ws.send(JSON.stringify({ type: "inject" }));
const injected = await waitFor((m) => m.type === "inject" && (m.state === "done" || m.state === "error"), 90_000, "inject", injectIndex).catch((error) => ({ state: "error", detail: error.message }));
const injectLine = events.slice(injectIndex).find((m) => m.type === "inject" && m.state === "speaking");
check("counterpart: in-character line generated and voiced", injected.state === "done" && audio.inject > 0, `${injectLine?.text ?? injected.detail ?? ""}`);
await sleep(4000);
check("counterpart: its speech was translated back to English", events.filter((m) => m.type === "caption" && m.stream === "toA" && m.role === "target" && m.final && m.text.trim()).length >= 2);

// 5. End and summarize.
console.log(`\n--- end session ${stamp()}`);
sessionLive = false;
ws.send(JSON.stringify({ type: "end" }));
const summary = await waitFor((m) => m.type === "summary", 120_000, "summary").catch((error) => ({ summary: null, error: error.message }));
check("scribe: structured summary produced", Boolean(summary.summary), summary.error ?? summary.summary?.title);
check("scribe: diarized transcript has ≥2 speakers", new Set((summary.transcript ?? []).map((s) => s.speaker)).size >= 2, `${(summary.transcript ?? []).length} segments`);
if (summary.summary) console.log(JSON.stringify({ ...summary.summary }, null, 2).slice(0, 2500));
console.log("stats:", JSON.stringify(summary.stats));

// 6. Readback.
ws.send(JSON.stringify({ type: "readback", language: "A" }));
const readback = await waitFor((m) => m.type === "readback" && (m.state === "done" || m.state === "error"), 90_000, "readback").catch((error) => ({ state: "error", detail: error.message }));
await sleep(500);
check("tts: spoken readback delivered", readback.state === "done" && audio.readback > 0, `${audio.readback} bytes`);

console.log(`\naudio bytes received: ${JSON.stringify(audio)}`);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
ws.close();
process.exit(failed.length === 0 ? 0 : 1);
