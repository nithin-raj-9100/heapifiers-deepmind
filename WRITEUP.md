# Parley: a real-time interpreter, mediator and scribe on the Gemini audio stack

*Four Gemini audio models on one microphone: simultaneous two-way translation, an interruptible assistant that reads tone of voice, a live scribe, and a diarized structured record with spoken readback.*

**Track:** Problem Statement 2, Next-Gen Voice & Real-Time Audio
**Team:** Heapifiers
**Code:** public GitHub repository (attached) · **Demo:** hosted web app (attached)

## The problem

A doctor and a patient, a landlord and a tenant, an agent and a customer who do not share a language have three needs at once: understand each other *now*, get help when a word or a number is unclear, and leave with a record both can trust. Phone apps make people take turns typing or pressing buttons; human interpreters are scarce. We wanted the interaction to be nothing but two people talking, with one attentive presence in the room that interprets, steps in only when asked, and writes everything down.

## What Parley does

Pick two languages and a scenario, press start, and talk. Whoever speaks, in either language, is interpreted into the other language by voice, with the translation starting while they are still talking and finishing about 300 ms after they stop. A voice assistant, Parley, listens the whole time but stays silent until someone says "Parley, what does *deductible* mean?"; it answers in that person's language in one or two sentences and stops. After every turn it reports the speaker's tone of voice from the audio, and it pins explicit commitments as they are made. Talk over it and it yields immediately. A scribe pane shows a verbatim transcript in both languages. A solo visitor can let Gemini play the other person: it writes an in-character reply in the other language, voices it, and that audio is fed through the live pipeline like real speech. Ending the session produces a diarized transcript and a structured record: summaries in both languages, decisions, action items with owners and dates, scenario fields (chief complaint, deposit, order number), a tone arc and risk flags, readable aloud in either language.

## Architecture

The browser captures the microphone in an AudioWorklet (16 kHz PCM16, 100 ms frames) and streams it over one WebSocket to a Node/TypeScript server. Each browser connection owns a `ParleySession` that fans every frame out, in real time, to four upstream Gemini Live sessions:

- `translate:toA` and `translate:toB`: two `gemini-3.5-live-translate-preview` sessions, one per target language, with `echoTargetLanguage: false`. The model is unidirectional per session, so two sessions fed the same audio give bidirectional interpretation using the model's own per-phrase language detection. Whichever language is spoken, exactly one of them speaks back.
- `agent`: `gemini-3.8-live` with a system prompt describing the two people and the scenario, and two blocking tools: `report_tone(tone, urgency, language, speaker, addressed_to_parley)` and `note_commitment(owner, note, due)`.
- `scribe`: `gemini-3.5-transcribe-live` in SMART mode with automatic voice activity detection.

Audio coming back (24 kHz PCM) is framed with a source byte and played by a browser scheduler with one shared timeline, so translation, Parley and the simulated counterpart never overlap and any source can be flushed instantly. Captions, transcript, tone readings, agent state and latency metrics travel as JSON.

"Simulate Person B" runs `gemini-3.8-flash` (JSON: line in language B plus a gloss in language A), then `gemini-3.8-flash-lite-tts` over server-sent events; chunks go to the browser for playback and, resampled to 16 kHz, are paced into all four live sessions at 100 ms per tick with trailing silence so the detectors close the turn. "End" sends the 16 kHz recording to `gemini-3.5-transcribe` through the Interactions API (verbatim, speaker diarization, word timestamps), rebuilds speaker segments from the word annotations, and asks `gemini-3.8-flash` for the record against a JSON schema whose scenario fields come from the catalog. "Read aloud" streams `gemini-3.8-flash-tts`.

## Challenges we overcame

**Documentation that did not match the wire.** The Live Translate guide places `inputAudioTranscription` inside `generationConfig`; the endpoint closes the socket with code 1007. Only `translationConfig` belongs there; the transcription flags sit at setup level. We wrote small smoke scripts against every model first and built the server on what the API actually returned: `languageCode` per transcription fragment, empty transcription messages that mark both phrase ends and keepalives, transcribe word annotations labelled `spk:N` whose concatenated text drops the spaces between speakers, multi-speaker TTS needing the speaker inside a `speech_metadata` annotation, and Gemini 3.8 Live rejecting the old affective-dialog and proactive-audio flags because both are now always on.

**A tool-call loop.** Gemini 3.8 Live defaults to non-blocking function calls. Each tool result triggered a fresh generation that dutifully called `report_tone` again: 24 tone readings for 4 turns, and the assistant never got to its answer. Declaring the tools `BLOCKING` gives one report per turn, delivered before any speech.

**Wake words that speech recognition mangles.** "Parley" came back as "Parle", "Par", "Parlay" and, from the translate model, as French "Parlez". Text matching alone was unreliable, so we made the gate two-key: the model, which heard the audio, states `addressed_to_parley` in its tone report; a wake-word pattern and a push-to-talk button are the other keys. The server forwards Parley's audio only when a key is set, so a chatty model cannot talk over the conversation.

**Interruptions after generation ends.** The model generates faster than it speaks, so its `interrupted` signal only covers the first second or two. A user interrupting playback got no signal at all. The browser reports playback state; the server treats speech that starts while Parley's audio is still playing as a barge-in, flushes the queue and closes the turn. Local energy detection ducks the voice before the round trip completes.

**Feedback loops and duplicate captions.** Laptop speakers feed translations back into the microphone; the second translate session would translate them back. We added a half-duplex gate driven by browser playback events, kept barge-in on the assistant open, and let both translate sessions transcribe everything while showing each utterance once, attributed by detected language, dropping third-language misdetections.

**Demoing a two-person product alone.** Judges evaluate solo. The simulated counterpart closes the loop: a real second voice, in the other language, that reacts to what the judge just said, interpreted back through the same pipeline.

## Why these choices were right

Using the dedicated translate model rather than asking Gemini 3.8 Live to interpret keeps the interpreter faithful and fast (it neither editorialises nor waits for the end of the sentence), and frees the general model to do what only it can: understand who is being addressed, read tone, call tools and be interrupted. Blocking tools, server-side gating and a client scheduler with one timeline make the experience deterministic where the model is probabilistic. A plain Node server with the Gemini key on the server side, session caps and an optional bring-your-own-key path make the demo safe to host publicly. Streaming TTS cut the counterpart's time to first audio from 8.7 s to 3.8 s; `thinkingLevel: low` keeps the structured record under 4 s.

## Results

Measured against the real API by `scripts/e2e.mjs`, which synthesizes speech, drives a full session and asserts fifteen behaviours (all passing): translated audio completes 190–350 ms after the speaker stops; Parley's first audio arrives 1.0–1.6 s after the speaker stops when addressed and never when not; barge-in produces an `interrupted` event in under half a second; a 62 s conversation is diarized in 7.4 s and reduced to the structured record in 3.8 s with speakers correctly mapped to clinician and patient. A Chromium test with a WAV file as the microphone exercised the actual UI end to end.

## What is next

Per-participant devices over WebRTC so each person hears only their language, speaker-attributed live captions, a Files API path for long sessions, and Lyria hold music while the record is prepared.

## Foundation

Parley grew out of our teammate's `gemini-whisper-local`, a macOS dictation app on Gemini 3.5 Transcribe Live. We ported its interim-hypothesis merging (with its original test cases) to TypeScript and reused its audio framing and voice-activity findings, then scaled the idea from one dictation stream to four concurrent audio sessions.
