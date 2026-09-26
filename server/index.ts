import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { LANGUAGES, SCENARIOS, VOICES } from "./catalog.js";
import { loadConfig, redactSecrets } from "./config.js";
import { ParleySession } from "./session.js";

const config = loadConfig();

function log(line: string): void {
  console.log(`${new Date().toISOString()} ${redactSecrets(line, [config.apiKey])}`);
}

const app = express();
app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get("/healthz", (_request, response) => {
  response.json({ ok: true, sessions: sessions.size, hasServerKey: Boolean(config.apiKey) });
});

app.get("/api/catalog", (_request, response) => {
  response.json({
    languages: LANGUAGES,
    scenarios: SCENARIOS,
    voices: VOICES,
    models: config.models,
    hasServerKey: Boolean(config.apiKey),
    allowByok: config.allowByok,
    limits: { maxMinutes: config.sessionMaxMinutes, maxSessions: config.maxSessions },
  });
});

// Revalidate on every load: a cached app.js from before a deploy breaks against the new index.html.
app.use(express.static(config.publicDir, { extensions: ["html"], maxAge: 0 }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4 * 1024 * 1024 });
const sessions = new Set<ParleySession>();

function serverKeySessions(): number {
  let count = 0;
  for (const session of sessions) if (session.isLive && session.usesServerKey) count++;
  return count;
}

wss.on("connection", (socket: WebSocket, request) => {
  const session = new ParleySession(socket, {
    apiKey: config.apiKey,
    models: config.models,
    maxMinutes: config.sessionMaxMinutes,
    allowByok: config.allowByok,
    log,
  });
  sessions.add(session);
  const remote = request.headers["x-forwarded-for"] ?? request.socket.remoteAddress ?? "?";
  log(`[${session.id}] connected from ${String(remote).split(",")[0]} (sessions=${sessions.size})`);

  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 25_000);

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      session.handleAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    const text = data.toString();
    // Cap concurrent sessions that burn the hosted key; BYOK sessions are not counted.
    if (text.includes('"start"') && !text.includes('"apiKey"') && serverKeySessions() >= config.maxSessions) {
      socket.send(JSON.stringify({ type: "error", code: "busy", message: `The demo server is at capacity (${config.maxSessions} live sessions). Try again in a minute or use your own key.`, fatal: true }));
      return;
    }
    session.handleText(text);
  });
  socket.on("close", () => {
    clearInterval(heartbeat);
    session.destroy();
    sessions.delete(session);
    log(`[${session.id}] disconnected (sessions=${sessions.size})`);
  });
  socket.on("error", (error) => log(`[${session.id}] socket error: ${error.message}`));
});

server.listen(config.port, () => {
  log(`Parley listening on http://localhost:${config.port} (server key: ${config.apiKey ? "yes" : "no"}, byok: ${config.allowByok ? "allowed" : "off"})`);
  log(`models: ${Object.entries(config.models).map(([k, v]) => `${k}=${v}`).join(" ")}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} received, closing ${sessions.size} session(s)`);
    for (const session of sessions) session.destroy();
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
