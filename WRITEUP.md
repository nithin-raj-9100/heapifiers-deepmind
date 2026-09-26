# Parley: a real-time interpreter, mediator and scribe on the Gemini audio stack

*Four Gemini audio models on one microphone: simultaneous two-way translation, an interruptible assistant that reads tone of voice, a live scribe, and a diarized structured record with spoken readback.*

**Track:** Problem Statement 2, Next-Gen Voice & Real-Time Audio
**Team:** Heapifiers
**Live demo:** https://parley-production-085b.up.railway.app/
**Code:** https://github.com/nithin-raj-9100/heapifiers-deepmind

## The problem

A doctor and a patient, a landlord and a tenant, an agent and a customer who do not share a language need three things at once: to understand each other *now*, help when a word or a number is unclear, and a record both can trust. Translation apps make people take turns typing or pressing buttons; human interpreters are scarce. We wanted the interaction to be nothing but two people talking, with one attentive presence in the room that interprets, steps in only when named, and writes everything down.

## What Parley does

Pick two languages and a scenario, press start, and talk. Whoever speaks, in either language, is interpreted into the other language by voice. In hands-free mode on headphones the translation starts while the speaker is still talking and completes about 300 ms after they stop; on laptop speakers Parley behaves like a consecutive interpreter, holding the translation until the speaker pauses and muting the room while it speaks, so nothing feeds back. A tap-to-talk mode streams the microphone only while a turn is open and plays the translation whole.

A voice assistant, Parley, listens the whole time but stays silent until someone says "Parley, what does *deductible* mean?"; it answers in the asker's language, repeats the answer in the other language so both people follow, and stops. After every turn it reports the speaker's tone of voice from the audio and pins explicit commitments. Talk over it and it yields immediately. A scribe pane shows a verbatim transcript in both languages. A solo visitor can let Gemini play the other person: it writes an in-character reply in the other language, voices it, and that audio is fed through the live pipeline like real speech. Ending the session produces a diarized transcript and a structured record: summaries in both languages, decisions, action items with owners and dates, scenario fields (chief complaint, deposit, order number), a tone arc and risk flags, readable aloud in either language.

## Architecture

The browser captures the microphone in an AudioWorklet (16 kHz PCM16, 100 ms frames) and streams it over one WebSocket to a Node/TypeScript server. Each connection owns a `ParleySession` that fans every frame out, in real time, to four upstream Gemini Live sessions:

- `translate:toA` and `translate:toB`: two `gemini-3.5-live-translate-preview` sessions, one per target language, with `echoTargetLanguage: false`. The model is unidirectional per session; two sessions fed the same audio give bidirectional interpretation using the model's own per-phrase language detection.
- `agent`: `gemini-3.8-live` with a system prompt describing the two people and the scenario, and two blocking tools: `report_tone(tone, urgency, language, speaker, addressed_to_parley)` and `note_commitment(owner, note, due)`.
- `scribe`: `gemini-3.5-transcribe-live` in SMART mode with automatic voice activity detection.

Audio coming back (24 kHz PCM) is framed with a source byte. The browser's player owns one timeline and plays one voice at a time: a translation, Parley or the simulated counterpart keeps the speaker until it finishes and goes quiet, so streams that arrive together never interleave, and any source can be flushed instantly. Captions, transcript, tone readings, agent state, turn state and latency metrics travel as JSON.

"Simulate Person B" runs `gemini-3.8-flash` (JSON: line in language B plus a gloss in language A), then `gemini-3.8-flash-lite-tts` over server-sent events; chunks go to the browser for playback and, resampled to 16 kHz, are paced into all four live sessions at 100 ms per tick with trailing silence so the detectors close the turn. "End" sends the 16 kHz recording to `gemini-3.5-transcribe` through the Interactions API (verbatim, speaker diarization, word timestamps), rebuilds speaker segments from the word annotations, and asks `gemini-3.8-flash` for the record against a JSON schema whose scenario fields come from the catalog. "Read aloud" streams `gemini-3.8-flash-tts`. The Gemini key never leaves the server, which caps concurrent sessions and session length; visitors may bring their own key.

## Why these choices were right

Using the dedicated translate model rather than asking Gemini 3.8 Live to interpret keeps the interpreter faithful and fast (it neither editorialises nor waits for the end of the sentence), and frees the general model to do what only it can: understand who is being addressed, read tone, call tools and be interrupted. Blocking tools, server-side gating and a single-voice player make the experience deterministic where the model is probabilistic. Offering hands-free and tap-to-talk modes lets the same pipeline serve headphones, laptop speakers and noisy rooms. Streaming TTS cut the counterpart's time to first audio from 8.7 s to 3.8 s; `thinkingLevel: low` keeps the structured record under 5 s. A plain Node server with the key server-side is safe to host publicly.

## Results

Measured against the real API by `scripts/e2e.mjs`, which synthesizes speech, drives a full session and asserts fifteen behaviours (all passing): first translated audio arrives 2.2–2.4 s after a speaker starts and completes 250–350 ms after they stop; Parley's first audio arrives 0.9–1.6 s after the speaker stops when addressed and never when not; barge-in produces an `interrupted` event in under half a second; a 62 s conversation is diarized in 7.7 s and reduced to the structured record in 3.5–4.6 s with speakers correctly mapped to clinician and patient. Twenty unit tests, including the foundation's transcript-merging cases, run in CI. A Chromium test with a WAV file as the microphone exercised the real UI end to end, and sessions with real voices on laptop speakers shaped the final gating and playback design.
