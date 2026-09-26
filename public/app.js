import { MicCapture, Player, SOURCE_NAMES } from "./audio.js";

/**
 * Parley browser client. One WebSocket to the Parley server; binary frames carry audio
 * (mic up, model speech down), JSON frames carry captions, transcript, agent state,
 * tone readings, metrics and the final structured record.
 */

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  catalog: null,
  ws: null,
  mic: null,
  player: null,
  config: null,
  scenario: null,
  languages: { A: null, B: null },
  startedAt: 0,
  clockTimer: null,
  cards: new Map(), // `${stream}:${phraseId}` -> card
  agentCard: null,
  agentState: "idle",
  engaged: false,
  muted: false,
  tones: [],
  metrics: { translate: [], tail: [], agent: [], interrupts: 0, phrases: 0 },
  summary: null,
  transcript: [],
  stats: null,
  duckTimer: null,
  playing: {},
  talking: false,
  turnId: 0,
  turnDone: true,
};

const isTapMode = () => state.config?.mode === "tap";

// ----------------------------------------------------------------- boot

async function boot() {
  const response = await fetch("/api/catalog");
  state.catalog = await response.json();
  populateSetup();
  bindSetup();
  bindLive();
  bindSummary();
}

function populateSetup() {
  const { languages, scenarios, voices, hasServerKey, allowByok } = state.catalog;
  const prefs = JSON.parse(localStorage.getItem("parley:prefs") || "{}");
  for (const [id, fallback] of [["#lang-a", "en"], ["#lang-b", "es"]]) {
    const select = $(id);
    for (const language of languages) {
      const option = el("option", "", `${language.flag} ${language.name} · ${language.native}`);
      option.value = language.code;
      select.append(option);
    }
    select.value = prefs[id] ?? fallback;
    if (!select.value) select.value = fallback;
  }
  const grid = $("#scenario-grid");
  scenarios.forEach((scenario, index) => {
    const label = el("label", "scenario");
    const input = el("input");
    input.type = "radio";
    input.name = "scenario";
    input.value = scenario.id;
    input.checked = prefs.scenario ? prefs.scenario === scenario.id : index === 0;
    const body = el("div");
    body.append(el("b", "", scenario.name), el("small", "", scenario.tagline));
    label.append(input, body);
    grid.append(label);
  });
  for (const [id, fallback] of [["#voice-agent", "Kore"], ["#voice-counterpart", "Leda"]]) {
    const select = $(id);
    for (const voice of voices) {
      const option = el("option", "", `${voice.name} · ${voice.hint}`);
      option.value = voice.name;
      select.append(option);
    }
    select.value = prefs[id] ?? fallback;
  }
  if (!allowByok) $("#byok").hidden = true;
  if (!hasServerKey) {
    $("#byok").open = true;
    $("#setup-hint").textContent = "This server has no Gemini key configured: paste your own key to start a session.";
  }
  $("#api-key").value = sessionStorage.getItem("parley:key") || "";
}

function savePrefs() {
  const prefs = {
    "#lang-a": $("#lang-a").value,
    "#lang-b": $("#lang-b").value,
    "#voice-agent": $("#voice-agent").value,
    "#voice-counterpart": $("#voice-counterpart").value,
    scenario: document.querySelector('input[name="scenario"]:checked')?.value,
  };
  localStorage.setItem("parley:prefs", JSON.stringify(prefs));
  sessionStorage.setItem("parley:key", $("#api-key").value.trim());
}

function bindSetup() {
  $("#btn-swap").addEventListener("click", () => {
    const a = $("#lang-a");
    const b = $("#lang-b");
    [a.value, b.value] = [b.value, a.value];
  });
  $("#setup-form").addEventListener("submit", (event) => {
    event.preventDefault();
    savePrefs();
    void startSession();
  });
}

// ----------------------------------------------------------------- session

async function startSession() {
  const languageA = $("#lang-a").value;
  const languageB = $("#lang-b").value;
  if (languageA === languageB) {
    toast("Pick two different languages.", "warn");
    return;
  }
  const button = $("#btn-start");
  button.disabled = true;
  button.textContent = "Requesting microphone…";
  try {
    state.player = new Player({ onPlaybackState: onPlaybackState, onLevel: onOutputLevel });
    await state.player.resume();
    state.mic = new MicCapture({ onFrame: onMicFrame, onLevel: onMicLevel });
    await state.mic.start();
  } catch (error) {
    toast(`Microphone unavailable: ${error.message}`, "error");
    button.disabled = false;
    button.textContent = "Start listening";
    state.player?.close();
    state.player = null;
    return;
  }
  button.textContent = "Connecting…";
  const config = {
    languageA,
    languageB,
    scenario: document.querySelector('input[name="scenario"]:checked')?.value ?? "general",
    agentVoice: $("#voice-agent").value,
    counterpartVoice: $("#voice-counterpart").value,
    mode: "tap",
  };
  const apiKey = $("#api-key").value.trim();
  if (apiKey) config.apiKey = apiKey;

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "start", config })));
  ws.addEventListener("message", onServerMessage);
  ws.addEventListener("close", (event) => {
    if (document.body.dataset.view === "live") {
      toast(`Connection closed (${event.code}). ${event.reason || ""}`, "error");
      teardownLive();
      showView("setup");
    }
  });
  ws.addEventListener("error", () => toast("Could not reach the Parley server.", "error"));
}

function onServerMessage(event) {
  if (event.data instanceof ArrayBuffer) {
    const view = new Uint8Array(event.data);
    const source = SOURCE_NAMES[view[0]];
    if (!source) return;
    state.player.enqueue(source, event.data.slice(4));
    return;
  }
  const message = JSON.parse(event.data);
  const handler = handlers[message.type];
  if (handler) handler(message);
}

const handlers = {
  ready(message) {
    state.config = message.config;
    state.scenario = state.catalog.scenarios.find((s) => s.id === message.config.scenario);
    state.languages.A = state.catalog.languages.find((l) => l.code === message.config.languageA);
    state.languages.B = state.catalog.languages.find((l) => l.code === message.config.languageB);
    state.startedAt = Date.now();
    enterLive();
  },
  status(message) {
    const pill = document.querySelector(`.pill[data-stream="${message.stream}"]`);
    if (pill) {
      pill.dataset.state = message.state;
      pill.title = message.detail ?? "";
    }
    if (message.state === "error") toast(`${message.stream}: ${message.detail ?? "error"}`, "error");
    if (message.state === "reconnecting") toast(`${message.stream} reconnecting… (${message.detail ?? ""})`, "warn");
    if (message.stream === "agent" && message.state === "ready" && state.agentState === "idle") setOrb("idle", "Listening to the room. Say “Parley” to ask me something.");
  },
  caption(message) {
    renderCaption(message);
  },
  transcript(message) {
    renderTranscript(message);
  },
  activity(message) {
    if (message.stream !== "agent") return;
    if (message.state === "start" && state.agentState !== "speaking") setOrb(state.engaged ? "engaged" : "listening", state.engaged ? "Parley is listening to you…" : "Hearing speech…");
  },
  agent(message) {
    onAgentEvent(message);
  },
  tone(message) {
    renderTone(message.reading);
  },
  inject(message) {
    renderInject(message);
  },
  metric(message) {
    onMetric(message);
  },
  summary(message) {
    renderSummary(message);
  },
  readback(message) {
    const buttons = document.querySelectorAll("[data-readback]");
    for (const button of buttons) {
      if (button.dataset.readback !== message.language) continue;
      button.disabled = message.state === "thinking";
      button.textContent = message.state === "thinking" ? "Synthesizing…" : message.state === "speaking" ? "Playing…" : "▶ Read aloud";
    }
    if (message.state === "error") toast(`Readback failed: ${message.detail}`, "error");
  },
  error(message) {
    toast(message.message, "error");
    if (message.fatal) {
      teardownLive();
      showView("setup");
    }
  },
  turn(message) {
    if (message.turnId !== state.turnId || message.state !== "done") return;
    state.turnDone = true;
    refreshTalk();
  },
  pong() {},
};

function enterLive() {
  showView("live");
  $("#btn-end").hidden = false;
  const { A, B } = state.languages;
  $("#flag-a").textContent = A.flag;
  $("#name-a").textContent = A.name;
  $("#role-a").textContent = state.scenario.roleA;
  $("#flag-b").textContent = B.flag;
  $("#name-b").textContent = B.name;
  $("#role-b").textContent = state.scenario.roleB;
  $("#gate-hint").textContent = isTapMode()
    ? "Tap to talk: the mic is only on while you speak (Space works too)."
    : state.config.duplex === "half" ? "Half-duplex: mic pauses while translations play." : "Full-duplex: use headphones.";
  $("#talk-row").hidden = !isTapMode();
  state.talking = false;
  state.turnId = 0;
  state.turnDone = true;
  refreshTalk();
  const chips = $("#opener-chips");
  chips.innerHTML = "";
  state.scenario.openers.forEach((opener, index) => {
    const chip = el("button", "chip", opener.length > 64 ? `${opener.slice(0, 62)}…` : opener);
    chip.type = "button";
    chip.title = opener;
    chip.addEventListener("click", () => sendJson({ type: "inject", opener: index }));
    chips.append(chip);
  });
  state.clockTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
    $("#clock").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 500);
  setOrb("idle", "Connecting to Gemini…");
}

function teardownLive() {
  clearInterval(state.clockTimer);
  state.mic?.stop();
  state.mic = null;
  state.player?.close();
  state.player = null;
  if (state.ws && state.ws.readyState <= 1) state.ws.close();
  state.ws = null;
  state.talking = false;
  $("#btn-end").hidden = true;
  const button = $("#btn-start");
  button.disabled = false;
  button.textContent = "Start listening";
  for (const pill of document.querySelectorAll(".pill")) pill.dataset.state = "";
}

function resetLiveUi() {
  state.cards.clear();
  state.agentCard = null;
  state.tones = [];
  state.metrics = { translate: [], tail: [], agent: [], interrupts: 0, phrases: 0 };
  $("#feed").innerHTML = "";
  $("#feed").append(el("div", "feed-empty", "Start talking in either language. Translations appear here as they are spoken, and you will hear them in the other language."));
  $("#feed").firstChild.id = "feed-empty";
  $("#scribe").innerHTML = '<div class="scribe-empty" id="scribe-empty">Verbatim transcript, both languages, as it is spoken.</div>';
  $("#scribe-interim").textContent = "";
  $("#tone-list").innerHTML = '<li class="hint">No readings yet.</li>';
  $("#tone-chip").hidden = true;
  $("#inject-status").hidden = true;
  $("#m-translate").textContent = "–";
  $("#m-tail").textContent = "–";
  $("#m-agent").textContent = "–";
  $("#m-interrupts").textContent = "0";
  $("#m-phrases").textContent = "0";
  $("#clock").textContent = "00:00";
}

function showView(name) {
  document.body.dataset.view = name;
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== `view-${name}`;
  if (name === "live") resetLiveUi();
}

function sendJson(message) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(message));
}

// ----------------------------------------------------------------- audio callbacks

function onMicFrame(buffer) {
  if (isTapMode() && !state.talking && !state.engaged) return;
  if (state.ws?.readyState === 1) state.ws.send(buffer);
}

let speechFrames = 0;
function onMicLevel(level) {
  const live = !isTapMode() || state.talking || state.engaged;
  $("#mic-meter i").style.width = live ? `${Math.min(100, level * 400)}%` : "0%";
  // Local barge-in: duck Parley the instant the user starts talking, before the server confirms.
  if (state.agentState === "speaking" && state.player?.isPlaying("agent")) {
    speechFrames = level > 0.035 ? speechFrames + 1 : 0;
    if (speechFrames >= 2) {
      state.player.duck("agent", 0.15);
      clearTimeout(state.duckTimer);
      state.duckTimer = setTimeout(() => state.player?.duck("agent", 1), 1400);
    }
  } else {
    speechFrames = 0;
  }
}

function onOutputLevel(level) {
  $("#orb").style.setProperty("--level", Math.min(1, level * 3).toFixed(2));
}

function onPlaybackState(source, playbackState) {
  state.playing[source] = playbackState === "start";
  sendJson({ type: "playback", source, state: playbackState });
  if (source === "translate") refreshTalk();
  if (source === "agent") {
    if (playbackState === "start") setOrb("speaking", state.agentCard?.querySelector(".utt-source")?.textContent || "Parley is speaking…");
    else if (state.agentState === "speaking") {
      setOrb("idle", "Listening to the room. Say “Parley” to ask me something.");
      finishAgentCard();
    }
  }
  if (source === "inject" && playbackState === "end") {
    const status = $("#inject-status");
    if (!status.hidden) status.querySelector("em").textContent = "";
  }
}

// ----------------------------------------------------------------- live UI

function bindLive() {
  $("#btn-end").addEventListener("click", () => {
    if (state.talking) stopTalking();
    sendJson({ type: "end" });
    showView("summary");
    $("#summary-grid").hidden = true;
    $("#summary-progress").hidden = false;
    $("#summary-title").textContent = "Summarizing…";
    $("#btn-end").hidden = true;
    state.mic?.stop();
    state.mic = null;
    clearInterval(state.clockTimer);
  });
  const ask = $("#btn-ask");
  const engage = (event) => {
    event.preventDefault();
    if (state.engaged) return;
    state.engaged = true;
    ask.classList.add("active");
    state.player?.flush("agent");
    sendJson({ type: "agent", action: "engage" });
    setOrb("engaged", "Parley is listening to you… release to send.");
  };
  const release = () => {
    if (!state.engaged) return;
    state.engaged = false;
    ask.classList.remove("active");
    sendJson({ type: "agent", action: "release" });
    setOrb("thinking", "Parley is thinking…");
  };
  ask.addEventListener("pointerdown", engage);
  ask.addEventListener("pointerup", release);
  ask.addEventListener("pointerleave", release);
  ask.addEventListener("pointercancel", release);
  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || document.body.dataset.view !== "live" || event.repeat || isTyping(event)) return;
    if (isTapMode()) {
      event.preventDefault();
      toggleTalk();
    } else {
      engage(event);
    }
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space" && document.body.dataset.view === "live" && !isTapMode()) release();
  });
  $("#btn-talk").addEventListener("click", toggleTalk);
  $("#btn-stop").addEventListener("click", () => {
    state.player?.flush();
    sendJson({ type: "agent", action: "interrupt" });
  });
  $("#btn-mute").addEventListener("click", () => {
    state.muted = !state.muted;
    if (state.mic) state.mic.muted = state.muted;
    $("#btn-mute").textContent = state.muted ? "Unmute mic" : "Mute mic";
  });
  $("#btn-inject").addEventListener("click", () => {
    const text = $("#inject-text").value.trim();
    sendJson(text ? { type: "inject", text } : { type: "inject" });
    $("#inject-text").value = "";
  });
  $("#inject-text").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("#btn-inject").click();
    }
  });
}

function toggleTalk() {
  if (!isTapMode()) return;
  if (state.talking) stopTalking();
  else startTalking();
}

function startTalking() {
  state.player?.flush();
  state.talking = true;
  state.turnDone = false;
  state.turnId += 1;
  sendJson({ type: "turn", action: "start" });
  refreshTalk();
}

function stopTalking() {
  state.talking = false;
  sendJson({ type: "turn", action: "stop" });
  refreshTalk();
}

function refreshTalk() {
  if (!isTapMode()) return;
  const [talkState, label] = state.talking
    ? ["listening", "Listening… tap when done"]
    : state.player?.isPlaying("translate")
      ? ["speaking", "Speaking translation… tap to talk"]
      : !state.turnDone
        ? ["translating", "Translating…"]
        : ["idle", "Tap to talk"];
  $("#btn-talk").dataset.state = talkState;
  $("#talk-label").textContent = label;
}

function isTyping(event) {
  const tag = event.target?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function setOrb(orbState, status) {
  state.agentState = orbState;
  $("#orb").dataset.state = orbState;
  if (status !== undefined) $("#orb-status").textContent = status;
}

function primaryLanguage(code) {
  return (code || "").toLowerCase().split("-")[0];
}

/** Who spoke: decided by the detected language, falling back to the stream direction. */
function speakerFor(languageCode, stream) {
  const code = primaryLanguage(languageCode);
  if (code && code === primaryLanguage(state.config.languageA)) return "A";
  if (code && code === primaryLanguage(state.config.languageB)) return "B";
  return stream === "toB" ? "A" : "B";
}

function labelCard(card, who) {
  card.dataset.who = who;
  card.querySelector(".who").textContent = who === "A" ? state.scenario.roleA : state.scenario.roleB;
}

function renderCaption(message) {
  const key = `${message.stream}:${message.phraseId}`;
  let card = state.cards.get(key);
  if (card === null) return; // a phrase this stream will not translate; the other stream shows it
  const streamTarget = message.stream === "toA" ? state.config.languageA : state.config.languageB;
  // Both translate sessions transcribe every utterance, but only the one whose target
  // differs from the language spoken will translate it. Show each utterance once.
  const spoken = message.role === "source" ? primaryLanguage(message.languageCode) : "";
  const spokenInTarget = spoken && spoken === primaryLanguage(streamTarget);
  // A language outside the session's pair is almost always a misdetection the other stream got right.
  const foreign = spoken && spoken !== primaryLanguage(state.config.languageA) && spoken !== primaryLanguage(state.config.languageB);
  if (foreign) {
    // Possibly one misheard word; a later fragment in a session language brings the card back.
    if (card) {
      card.remove();
      state.cards.delete(key);
      state.metrics.phrases = Math.max(0, state.metrics.phrases - 1);
      $("#m-phrases").textContent = String(state.metrics.phrases);
    }
    return;
  }
  if (spokenInTarget) {
    if (card) {
      card.remove();
      state.metrics.phrases = Math.max(0, state.metrics.phrases - 1);
      $("#m-phrases").textContent = String(state.metrics.phrases);
    }
    state.cards.set(key, null);
    return;
  }
  if (!card) {
    if (!message.text.trim()) return;
    card = $("#tpl-utterance").content.firstElementChild.cloneNode(true);
    card.classList.add("pending");
    labelCard(card, speakerFor(message.role === "source" ? message.languageCode : undefined, message.stream));
    state.cards.set(key, card);
    $("#feed-empty")?.remove();
    $("#feed").append(card);
    state.metrics.phrases++;
    $("#m-phrases").textContent = String(state.metrics.phrases);
  }
  const target = message.role === "source" ? card.querySelector(".utt-source") : card.querySelector(".utt-target");
  target.textContent = message.text.trim();
  if (message.languageCode && message.role === "source") {
    card.querySelector(".lang").textContent = message.languageCode;
    labelCard(card, speakerFor(message.languageCode, message.stream));
  }
  if (message.final && message.role === "target") card.classList.remove("pending");
  if (message.final && message.role === "source") {
    // A translation normally follows within a moment; if none comes, stop blinking.
    setTimeout(() => {
      if (!card.querySelector(".utt-target").textContent) card.classList.remove("pending");
    }, 3000);
  }
  scrollFeed();
}

function scrollFeed() {
  const feed = $("#feed");
  feed.scrollTop = feed.scrollHeight;
}

function renderTranscript(message) {
  const scribe = $("#scribe");
  if (message.kind === "interim") {
    $("#scribe-interim").textContent = message.text;
    return;
  }
  $("#scribe-interim").textContent = "";
  $("#scribe-empty")?.remove();
  const isNote = message.text.startsWith("📌");
  if (message.replaced && scribe.lastElementChild && !scribe.lastElementChild.classList.contains("note")) {
    scribe.lastElementChild.textContent = message.text;
  } else {
    const line = el("p", isNote ? "note" : "", message.text);
    scribe.append(line);
  }
  scribe.scrollTop = scribe.scrollHeight;
}

function onAgentEvent(message) {
  switch (message.event) {
    case "listening":
      if (state.agentState !== "speaking" && !state.engaged) setOrb("listening", "Hearing speech…");
      break;
    case "thinking":
      if (state.agentState !== "speaking") setOrb("thinking", state.engaged ? "Parley is thinking…" : "Parley heard that…");
      break;
    case "speaking":
      if (!state.agentCard) {
        state.agentCard = $("#tpl-utterance").content.firstElementChild.cloneNode(true);
        state.agentCard.dataset.who = "P";
        state.agentCard.classList.add("pending");
        state.agentCard.querySelector(".who").textContent = "Parley";
        state.agentCard.querySelector(".lang").textContent = "gemini-3.8-live";
        $("#feed-empty")?.remove();
        $("#feed").append(state.agentCard);
      }
      if (message.text) {
        state.agentCard.querySelector(".utt-source").textContent = message.text;
        if (state.agentState === "speaking") $("#orb-status").textContent = message.text;
        scrollFeed();
      }
      if (state.agentState !== "speaking") setOrb("speaking", message.text || "Parley is speaking…");
      break;
    case "interrupted":
      state.metrics.interrupts++;
      $("#m-interrupts").textContent = String(state.metrics.interrupts);
      state.player?.flush("agent");
      state.player?.duck("agent", 1);
      if (state.agentCard) {
        state.agentCard.classList.add("interrupted");
        state.agentCard.querySelector(".utt-target").textContent = "interrupted";
      }
      finishAgentCard();
      setOrb("interrupted", "Interrupted. Go ahead.");
      setTimeout(() => {
        if (state.agentState === "interrupted") setOrb("listening", "Hearing speech…");
      }, 700);
      break;
    case "done":
      if (message.text && state.agentCard) state.agentCard.querySelector(".utt-source").textContent = message.text;
      if (!state.player?.isPlaying("agent")) {
        if (state.agentState !== "idle") setOrb("idle", "Listening to the room. Say “Parley” to ask me something.");
        finishAgentCard();
      }
      break;
    case "engaged":
      break;
    case "released":
      break;
  }
}

function finishAgentCard() {
  if (state.agentCard) state.agentCard.classList.remove("pending");
  state.agentCard = null;
}

const TONE_EMOJI = [
  [/calm|relax|neutral|steady|composed|friendly|warm|polite/i, "😌"],
  [/anx|worr|nerv|fear|scared|concern|uneasy/i, "😟"],
  [/frust|annoy|irrit|angry|upset|tense/i, "😤"],
  [/happy|relie|glad|cheer|grateful|pleased/i, "😊"],
  [/sad|tired|weary|low/i, "😔"],
  [/urgent|hurried|rushed|alarm|distress|panic/i, "🚨"],
  [/confus|unsure|hesit|uncertain/i, "🤔"],
];

function renderTone(reading) {
  state.tones.push(reading);
  const emoji = (TONE_EMOJI.find(([pattern]) => pattern.test(reading.tone)) ?? [null, "🎙️"])[1];
  const speaker = reading.speaker === "A" ? state.scenario.roleA : reading.speaker === "B" ? state.scenario.roleB : "Speaker";
  const chip = $("#tone-chip");
  chip.hidden = false;
  chip.dataset.urgency = reading.urgency;
  chip.querySelector(".tone-text").textContent = `${emoji} ${speaker}: ${reading.tone} · urgency ${reading.urgency}`;
  const list = $("#tone-list");
  if (state.tones.length === 1) list.innerHTML = "";
  const item = el("li");
  item.dataset.urgency = reading.urgency;
  const elapsed = Math.max(0, Math.floor((reading.at - state.startedAt) / 1000));
  item.append(el("i"), el("span", "", `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`), el("b", "", `${emoji} ${speaker}`), document.createTextNode(` ${reading.tone}${reading.language ? ` · ${reading.language}` : ""}`));
  list.prepend(item);
  while (list.children.length > 8) list.lastElementChild.remove();
}

function renderInject(message) {
  const status = $("#inject-status");
  const button = $("#btn-inject");
  status.hidden = false;
  if (message.state === "thinking") {
    button.disabled = true;
    status.innerHTML = "<em>Person B is thinking of a reply…</em>";
  } else if (message.state === "speaking") {
    status.innerHTML = "";
    status.append(el("b", "", message.text), el("br"), el("span", "hint", message.translation || ""), el("em", "", " · speaking"));
  } else if (message.state === "done") {
    button.disabled = false;
    const em = status.querySelector("em");
    if (em) em.textContent = "";
  } else if (message.state === "error") {
    button.disabled = false;
    status.innerHTML = `<span class="hint">Could not simulate Person B: ${message.detail ?? "error"}</span>`;
    toast(`Simulated reply failed: ${message.detail ?? "error"}`, "error");
  }
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function onMetric(message) {
  if (message.name === "translate_first_audio") {
    state.metrics.translate.push(message.valueMs);
    $("#m-translate").textContent = `${median(state.metrics.translate)} ms (n=${state.metrics.translate.length})`;
  } else if (message.name === "translate_tail") {
    state.metrics.tail.push(message.valueMs);
    $("#m-tail").textContent = `${median(state.metrics.tail)} ms (n=${state.metrics.tail.length})`;
  } else if (message.name === "agent_first_audio") {
    state.metrics.agent.push(message.valueMs);
    $("#m-agent").textContent = `${median(state.metrics.agent)} ms (n=${state.metrics.agent.length})`;
  }
}

// ----------------------------------------------------------------- summary

function bindSummary() {
  $("#btn-new").addEventListener("click", () => {
    teardownLive();
    showView("setup");
  });
  for (const button of document.querySelectorAll("[data-readback]")) {
    button.addEventListener("click", () => {
      state.player?.resume();
      sendJson({ type: "readback", language: button.dataset.readback });
    });
  }
  $("#btn-download-json").addEventListener("click", () => download("parley-session.json", JSON.stringify({ summary: state.summary, transcript: state.transcript, stats: state.stats }, null, 2), "application/json"));
  $("#btn-download-md").addEventListener("click", () => download("parley-session.md", summaryMarkdown(), "text/markdown"));
}

function renderSummary(message) {
  state.summary = message.summary;
  state.transcript = message.transcript ?? [];
  state.stats = message.stats ?? {};
  $("#summary-progress").hidden = true;
  $("#summary-grid").hidden = false;
  const error = $("#summary-error");
  error.hidden = !message.error;
  error.textContent = message.error ?? "";
  const summary = message.summary;
  const { A, B } = state.languages;
  $("#summary-flag-a").textContent = `${A.flag}`;
  $("#summary-flag-b").textContent = `${B.flag}`;
  $("#summary-title").textContent = summary?.title || "Session record";
  $("#summary-a").textContent = summary?.summary_a || "—";
  $("#summary-b").textContent = summary?.summary_b || "—";
  fillList("#decisions", summary?.decisions);
  fillList("#key-points", summary?.key_points);
  fillList("#open-questions", summary?.open_questions);
  fillList("#risk-flags", summary?.risk_flags);
  $("#tone-arc").textContent = summary?.tone_arc || "";
  $("#fields-title").textContent = `${state.scenario.name} fields`;
  const fields = $("#scenario-fields");
  fields.innerHTML = "";
  for (const field of summary?.scenario_fields ?? []) {
    fields.append(el("dt", "", field.label || field.key), el("dd", field.value ? "" : "empty", field.value || "not discussed"));
  }
  const table = $("#action-items");
  table.innerHTML = "";
  if (summary?.action_items?.length) {
    const head = el("tr");
    for (const title of ["Owner", "Task", "Due"]) head.append(el("th", "", title));
    table.append(head);
    for (const item of summary.action_items) {
      const row = el("tr");
      row.append(el("td", "", item.owner), el("td", "", item.task), el("td", "", item.due || "—"));
      table.append(row);
    }
  } else {
    const row = el("tr");
    row.append(el("td", "empty", "No explicit action items were spoken."));
    table.append(row);
  }
  const transcript = $("#transcript");
  transcript.innerHTML = "";
  const speakers = [...new Set(state.transcript.map((segment) => segment.speaker))];
  const roleOf = (label) => summary?.participants?.find((p) => p.label === label)?.role;
  for (const segment of state.transcript) {
    const line = el("p");
    line.dataset.speaker = String(speakers.indexOf(segment.speaker) % 4);
    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    line.append(el("time", "", `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`), el("b", "", roleOf(segment.speaker) ? `${segment.speaker} · ${roleOf(segment.speaker)}` : segment.speaker), el("span", "", segment.text));
    transcript.append(line);
  }
  if (state.transcript.length === 0) transcript.append(el("p", "empty", "No speech was captured."));
  $("#transcript-meta").textContent = state.stats.transcribedSeconds ? `${state.stats.transcribedSeconds}s transcribed · ${state.stats.words ?? "?"} words · ${speakers.length} speakers` : "";
  const stats = $("#stats");
  stats.innerHTML = "";
  const rows = [
    ["Duration", `${state.stats.durationSec ?? 0}s`],
    ["Translated audio after speaker starts (median)", state.stats.translateFirstAudioMedianMs ? `${state.stats.translateFirstAudioMedianMs} ms` : "–"],
    ["Translation done after speaker stops (median)", state.stats.translateTailMedianMs != null ? `${state.stats.translateTailMedianMs} ms` : "–"],
    ["Parley first audio (median)", state.stats.agentFirstAudioMedianMs ? `${state.stats.agentFirstAudioMedianMs} ms` : "–"],
    ["Phrases interpreted", state.stats.translatePhrases ?? 0],
    ["Parley turns heard / spoken / held back", `${state.stats.agentTurns ?? 0} / ${state.stats.agentSpokenTurns ?? 0} / ${state.stats.agentSuppressedTurns ?? 0}`],
    ["Interruptions", state.stats.interruptions ?? 0],
    ["Tone readings", state.stats.toneReadings ?? 0],
    ["Diarized transcription", state.stats.transcribeMs ? `${state.stats.transcribeMs} ms` : "–"],
    ["Structured extraction", state.stats.summaryMs ? `${state.stats.summaryMs} ms` : "–"],
    ["Upstream reconnects", state.stats.reconnects ?? 0],
  ];
  for (const [label, value] of rows) {
    const row = el("div");
    row.append(el("dt", "", label), el("dd", "", String(value)));
    stats.append(row);
  }
}

function fillList(selector, items) {
  const list = $(selector);
  list.innerHTML = "";
  if (!items || items.length === 0) {
    list.append(el("li", "empty", "None"));
    return;
  }
  for (const item of items) list.append(el("li", "", item));
}

function summaryMarkdown() {
  const s = state.summary;
  if (!s) return "# Parley session\n\nNo summary available.\n";
  const lines = [`# ${s.title}`, "", `## Summary (${state.languages.A.name})`, s.summary_a, "", `## Summary (${state.languages.B.name})`, s.summary_b, ""];
  lines.push("## Action items");
  for (const item of s.action_items) lines.push(`- [ ] **${item.owner}**: ${item.task}${item.due ? ` (due ${item.due})` : ""}`);
  lines.push("", "## Decisions", ...s.decisions.map((d) => `- ${d}`), "", "## Key points", ...s.key_points.map((k) => `- ${k}`), "", "## Open questions", ...s.open_questions.map((q) => `- ${q}`), "");
  lines.push(`## ${state.scenario.name} fields`);
  for (const field of s.scenario_fields) lines.push(`- **${field.label}**: ${field.value || "not discussed"}`);
  lines.push("", "## Tone arc", s.tone_arc, "", "## Risk flags", ...(s.risk_flags.length ? s.risk_flags.map((r) => `- ${r}`) : ["- none"]), "", "## Transcript");
  for (const segment of state.transcript) lines.push(`- [${Math.floor(segment.start / 60)}:${String(Math.floor(segment.start % 60)).padStart(2, "0")}] **${segment.speaker}**: ${segment.text}`);
  return lines.join("\n");
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ----------------------------------------------------------------- toasts

function toast(text, kind = "info") {
  const node = el("div", `toast ${kind}`, text);
  $("#toasts").append(node);
  setTimeout(() => node.remove(), kind === "error" ? 7000 : 4000);
}

boot().catch((error) => toast(`Failed to load: ${error.message}`, "error"));
