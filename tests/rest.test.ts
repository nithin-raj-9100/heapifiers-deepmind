import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSseEvent, parseTranscription, speakerLabel } from "../server/gemini/rest.js";

test("parseTranscription groups word annotations into speaker segments", () => {
  const item = {
    text: "Good morning.Me duele.",
    annotations: [
      { type: "word_info", text: "Good", speaker: "spk:0", start_offset: "0.200s", end_offset: "0.300s" },
      { type: "word_info", text: "morning.", speaker: "spk:0", start_offset: "0.300s", end_offset: "0.800s" },
      { type: "word_info", text: "Me", speaker: "spk:1", start_offset: "2.800s", end_offset: "2.900s" },
      { type: "word_info", text: "duele.", speaker: "spk:1", start_offset: "2.900s", end_offset: "3.100s" },
    ],
  };
  const result = parseTranscription(item);
  assert.equal(result.words.length, 4);
  assert.deepEqual(result.segments, [
    { speaker: "Speaker 1", text: "Good morning.", start: 0.2, end: 0.8 },
    { speaker: "Speaker 2", text: "Me duele.", start: 2.8, end: 3.1 },
  ]);
  assert.equal(result.text, "Good morning. Me duele.");
});

test("parseTranscription splits the same speaker after a long pause", () => {
  const item = {
    annotations: [
      { type: "word_info", text: "One.", speaker: "spk:0", start_offset: "0s", end_offset: "0.5s" },
      { type: "word_info", text: "Two.", speaker: "spk:0", start_offset: "4s", end_offset: "4.5s" },
    ],
  };
  assert.equal(parseTranscription(item).segments.length, 2);
});

test("parseTranscription falls back to plain text without annotations", () => {
  const result = parseTranscription({ text: "  hello there  " });
  assert.equal(result.text, "hello there");
  assert.deepEqual(result.segments, [{ speaker: "Speaker 1", text: "hello there", start: 0, end: 0 }]);
  assert.deepEqual(parseTranscription(undefined).segments, []);
});

test("parseSseEvent reads the event name and JSON payload", () => {
  assert.deepEqual(parseSseEvent('event: step.delta\ndata: {"index":0,"delta":{"type":"audio"}}'), { event: "step.delta", data: { index: 0, delta: { type: "audio" } } });
  assert.deepEqual(parseSseEvent("data: not json"), { event: "message", data: "not json" });
  assert.equal(parseSseEvent("  \r\n"), null);
});

test("speakerLabel turns spk:N into a one-based label", () => {
  assert.equal(speakerLabel("spk:0"), "Speaker 1");
  assert.equal(speakerLabel("spk_3"), "Speaker 4");
  assert.equal(speakerLabel("narrator"), "narrator");
});
