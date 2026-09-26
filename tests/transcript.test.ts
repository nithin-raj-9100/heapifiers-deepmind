import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InterimTranscriptAccumulator,
  LiveTranscriptTracker,
  isRevisionReplacement,
  joinUniqueTranscript,
} from "../server/transcript.js";

// The first four cases are ported from the Swift foundation's GeminiLiveTests so the
// TypeScript port is held to the same behaviour.

test("preserves prior text when Gemini starts a new interim window", () => {
  const accumulator = new InterimTranscriptAccumulator();
  accumulator.accept("No, this is not what I meant.");
  const first = accumulator.accept("No, this is not what I meant. As seen in the attached image, when I speak some part");
  assert.equal(first, "No, this is not what I meant. As seen in the attached image, when I speak some part");

  const reset = accumulator.accept("after this You can see that it");
  assert.equal(reset, `${first} after this You can see that it`);

  const expanded = accumulator.accept("after this You can see that it no longer shows the earlier transcript");
  assert.equal(expanded, `${first} after this You can see that it no longer shows the earlier transcript`);
});

test("allows a rewritten interim hypothesis to replace similar sized text", () => {
  const accumulator = new InterimTranscriptAccumulator();
  accumulator.accept("The model should tell me what went correctly today");
  assert.equal(
    accumulator.accept("The model should tell the team what went wrong today"),
    "The model should tell the team what went wrong today",
  );
});

test("sliding interim revisions do not fabricate repeated paragraphs", () => {
  const accumulator = new InterimTranscriptAccumulator();
  accumulator.accept("My app targets developers and should make prompts shorter");
  accumulator.accept("making prompts shorter for example oh my god should become OMG");
  const result = accumulator.accept("for example oh my god should become OMG and numeric quantities should use digits");
  assert.equal(
    result,
    "My app targets developers and should make prompts shorter " +
      "making prompts shorter for example oh my god should become OMG " +
      "and numeric quantities should use digits",
  );
  assert.equal(result.split("oh my god should become OMG").length, 2);
});

test("preserves prior sentence when a new sentence begins with capital letters", () => {
  const accumulator = new InterimTranscriptAccumulator();
  accumulator.accept("There are two types of inconsistencies observed in this application.");
  const second = accumulator.accept("Second inconsistency is sometimes the end words are being cut off.");
  assert.equal(
    second,
    "There are two types of inconsistencies observed in this application. Second inconsistency is sometimes the end words are being cut off.",
  );
});

test("joinUniqueTranscript collapses containment and word overlaps", () => {
  assert.equal(joinUniqueTranscript("", "hello there"), "hello there");
  assert.equal(joinUniqueTranscript("Hello there friend", "there friend"), "Hello there friend");
  assert.equal(joinUniqueTranscript("we should ship it", "ship it tonight please"), "we should ship it tonight please");
  assert.equal(joinUniqueTranscript("first part.", "Second part."), "first part. Second part.");
});

test("isRevisionReplacement detects same-sentence rewordings but not new speech", () => {
  assert.equal(isRevisionReplacement("I want the the maid to come", "I want the maid to come"), true);
  assert.equal(isRevisionReplacement("we should ship it by friday for sure", "we should ship it by monday for sure"), true);
  assert.equal(isRevisionReplacement("Please send the invoice today", "And call the landlord after lunch"), false);
  // One changed word in a short sentence is ambiguous; the foundation treats it as new speech.
  assert.equal(isRevisionReplacement("Please send the invoice today", "Please send the invoice tomorrow"), false);
  assert.equal(isRevisionReplacement("", "anything"), false);
});

test("LiveTranscriptTracker merges interims into finals and drops server resends", () => {
  const tracker = new LiveTranscriptTracker();
  tracker.acceptInterim("Me duele");
  tracker.acceptInterim("Me duele mucho la cabeza");
  assert.equal(tracker.interimText, "Me duele mucho la cabeza");

  const first = tracker.acceptFinal("Me duele mucho la cabeza desde ayer.", 1);
  assert.deepEqual(first, { text: "Me duele mucho la cabeza desde ayer.", replaced: false });
  assert.equal(tracker.interimText, "");

  // Exact resend of the same final must not create a second segment.
  assert.equal(tracker.acceptFinal("Me duele mucho la cabeza desde ayer.", 2), null);
  assert.equal(tracker.segments.length, 1);

  // A self-correction of the last sentence (a stutter removed) replaces it instead of appending.
  tracker.acceptFinal("Y tengo mucha mucha fiebre desde anoche.", 3);
  const revised = tracker.acceptFinal("Y tengo mucha fiebre desde anoche.", 4);
  assert.deepEqual(revised, { text: "Y tengo mucha fiebre desde anoche.", replaced: true });
  assert.equal(tracker.segments.length, 2);

  const next = tracker.acceptFinal("Gracias, doctor.", 5);
  assert.deepEqual(next, { text: "Gracias, doctor.", replaced: false });
  assert.equal(tracker.committedText, "Me duele mucho la cabeza desde ayer. Y tengo mucha fiebre desde anoche. Gracias, doctor.");
});

test("LiveTranscriptTracker flushes a dangling interim once", () => {
  const tracker = new LiveTranscriptTracker();
  tracker.acceptInterim("the connection dropped mid");
  assert.equal(tracker.flushInterim(5), "the connection dropped mid");
  assert.equal(tracker.flushInterim(6), null);
  assert.equal(tracker.segments.length, 1);
});
