// plane-radio — a tiny SDR control server.
// One RTL-SDR dongle can only tune one frequency at a time, so this runs in
// exactly one of two modes: "map" (dump1090 -> ADS-B aircraft) or
// "listen" (rtl_fm -> AM aviation audio). Switching modes swaps the process.

import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8000;

// Receiver location (London CYXU) — used to query the online ADS-B API.
const HOME_LAT = Number(process.env.HOME_LAT ?? 43.0356); // CYXU by default; set HOME_LAT to your own receiver
const HOME_LON = Number(process.env.HOME_LON ?? -81.1539); // CYXU by default; set HOME_LON to your own receiver
const MAP_DIST_NM = Number(process.env.MAP_DIST_NM ?? 100); // search radius
const API_URL = `https://api.adsb.lol/v2/lat/${HOME_LAT}/lon/${HOME_LON}/dist/${MAP_DIST_NM}`;

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------
let mode = "idle"; // "idle" | "map" | "listen"
let mapSource = "api"; // "api" (online, no dongle) | "sdr" (local 1090 decode)
let listenInfo = { freq: 124.0, gain: "agc", squelch: 0 };
let lastError = null;

const sseClients = new Set(); // status + aircraft feed
const audioClients = new Set(); // mp3 stream

const aircraft = new Map(); // hex -> {hex, flight, alt, speed, track, lat, lon, vr, seen}
const AIRCRAFT_TTL = 60_000;

// child processes for the current mode
let dump = null; // dump1090
let sbsSock = null; // tcp to dump1090 :30003
let rtl = null; // rtl_fm
let ff = null; // ffmpeg
let apiTimer = null; // online ADS-B poll interval
let sdrGen = 0; // bumped on every stop; lets stale child callbacks bail out

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of sseClients) {
    try {
      sseSend(res, event, data);
    } catch {
      /* client gone; cleaned up on 'close' */
    }
  }
}
function statusPayload() {
  return { mode, mapSource, listen: listenInfo, home: { lat: HOME_LAT, lon: HOME_LON }, error: lastError };
}
function pushStatus() {
  broadcast("status", statusPayload());
}

// ---------------------------------------------------------------------------
// Mode control
// ---------------------------------------------------------------------------
function killProc(p) {
  if (p && !p.killed) {
    try {
      p.kill("SIGTERM");
    } catch {}
  }
}

function stopAll() {
  sdrGen++; // invalidate any in-flight child callbacks / pending retries
  killProc(dump);
  killProc(rtl);
  killProc(ff);
  dump = rtl = ff = null;
  if (apiTimer) {
    clearInterval(apiTimer);
    apiTimer = null;
  }
  if (sbsSock) {
    sbsSock.destroy();
    sbsSock = null;
  }
  // close any open audio responses
  for (const res of audioClients) {
    try {
      res.end();
    } catch {}
  }
  audioClients.clear();
}

function startMap(source = "api", attempt = 0) {
  stopAll();
  mode = "map";
  mapSource = source === "sdr" ? "sdr" : "api";
  lastError = null;
  aircraft.clear();

  if (mapSource === "api") {
    pollApi();
    apiTimer = setInterval(pollApi, 5000);
    pushStatus();
    return;
  }

  // --- SDR path: dump1090-fa --net enables the SBS BaseStation output on tcp/30003.
  const myGen = sdrGen;
  const startTs = Date.now();
  dump = spawn("dump1090", ["--net", "--quiet"], { stdio: ["ignore", "ignore", "pipe"] });
  dump.stderr.on("data", (b) => {
    if (myGen === sdrGen && /no supported devices/i.test(b.toString())) {
      lastError = "No RTL-SDR found — is the dongle plugged in?";
      pushStatus();
    }
  });
  dump.on("error", (e) => {
    if (myGen === sdrGen) { lastError = `dump1090 failed to start: ${e.message}`; pushStatus(); }
  });
  dump.on("exit", (code) => {
    if (myGen !== sdrGen || !code) return;
    // device-busy race after a fast mode switch — retry briefly
    if (Date.now() - startTs < 2500 && attempt < 4) {
      setTimeout(() => { if (myGen === sdrGen && mode === "map" && mapSource === "sdr") startMap("sdr", attempt + 1); }, 700);
      return;
    }
    lastError = `dump1090 exited (code ${code}). Is the dongle plugged in and not in use?`;
    pushStatus();
  });

  // Give dump1090 a moment to open its port, then connect to the SBS feed.
  connectSBS(0);
  pushStatus();
}

function connectSBS(attempt) {
  if (mode !== "map") return;
  sbsSock = net.connect(30003, "127.0.0.1");
  let buf = "";
  sbsSock.on("connect", () => {
    lastError = null;
    pushStatus();
  });
  sbsSock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) parseSBS(line.trim());
  });
  sbsSock.on("error", () => {});
  sbsSock.on("close", () => {
    if (mode === "map" && attempt < 30) {
      setTimeout(() => connectSBS(attempt + 1), 1000);
    }
  });
}

// SBS-1 BaseStation CSV. Field indices we care about:
// 1=type 4=hex 10=callsign 11=alt 12=gs 13=track 14=lat 15=lon 16=vr
function parseSBS(line) {
  if (!line.startsWith("MSG,")) return;
  const f = line.split(",");
  const hex = (f[4] || "").trim().toLowerCase();
  if (!hex) return;
  const a = aircraft.get(hex) || { hex };
  const set = (key, idx, fn = (x) => x) => {
    const v = (f[idx] || "").trim();
    if (v !== "") a[key] = fn(v);
  };
  set("flight", 10, (x) => x.trim());
  set("alt", 11, Number);
  set("speed", 12, Number);
  set("track", 13, Number);
  set("lat", 14, Number);
  set("lon", 15, Number);
  set("vr", 16, Number);
  a.seen = Date.now();
  aircraft.set(hex, a);
}

// Online ADS-B (adsb.lol) — no dongle needed, so it can run alongside audio.
async function pollApi() {
  if (mode !== "map" || mapSource !== "api") return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(API_URL, {
      headers: { "User-Agent": "plane-radio/1.0" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) throw new Error(`API HTTP ${r.status}`);
    const data = await r.json();
    const now = Date.now();
    const next = new Map();
    for (const a of data.ac || []) {
      if (!a.hex) continue;
      next.set(a.hex, {
        hex: a.hex,
        flight: (a.flight || "").trim(),
        alt: typeof a.alt_baro === "number" ? a.alt_baro : null,
        speed: typeof a.gs === "number" ? Math.round(a.gs) : null,
        track: typeof a.track === "number" ? a.track : (a.true_heading ?? null),
        lat: typeof a.lat === "number" ? a.lat : null,
        lon: typeof a.lon === "number" ? a.lon : null,
        vr: typeof a.baro_rate === "number" ? a.baro_rate : null,
        seen: now,
      });
    }
    aircraft.clear();
    for (const [k, v] of next) aircraft.set(k, v);
    if (lastError) { lastError = null; pushStatus(); }
    broadcast("aircraft", [...aircraft.values()]);
  } catch (e) {
    lastError = `ADS-B API: ${e.message}`;
    pushStatus();
  }
}

function startListen(freq, gain, squelch, attempt = 0) {
  stopAll();
  mode = "listen";
  lastError = null;
  listenInfo = { freq, gain, squelch };
  const myGen = sdrGen; // identifies this spawn; stale if a newer stop happens
  const startTs = Date.now();

  const fHz = Math.round(Number(freq) * 1e6);
  const args = ["-f", String(fHz), "-M", "am", "-s", "12k", "-l", String(squelch || 0)];
  if (gain && gain !== "agc") args.push("-g", String(gain));
  // rtl_fm -> raw s16le mono @12k -> ffmpeg -> mp3 stream
  rtl = spawn("rtl_fm", args, { stdio: ["ignore", "pipe", "pipe"] });
  rtl.stderr.on("data", (b) => {
    // Only surface a genuinely-missing dongle. "usb_claim"/busy is handled by the retry below.
    if (myGen === sdrGen && /no supported devices/i.test(b.toString())) {
      lastError = "No RTL-SDR found — is the dongle plugged in?";
      pushStatus();
    }
  });
  rtl.on("error", (e) => {
    if (myGen === sdrGen) { lastError = `rtl_fm failed: ${e.message}`; pushStatus(); }
  });
  rtl.on("exit", (code) => {
    if (myGen !== sdrGen || !code) return; // superseded by a newer mode switch, or clean exit
    // The USB tuner can take ~0.5s to release after the previous process; a fast
    // mode switch makes the new rtl_fm exit code 1 (device busy). Retry briefly.
    if (Date.now() - startTs < 2500 && attempt < 4) {
      setTimeout(() => {
        if (myGen === sdrGen && mode === "listen") startListen(freq, gain, squelch, attempt + 1);
      }, 700);
      return;
    }
    lastError = `rtl_fm exited (code ${code}). Is the dongle plugged in and not in use?`;
    pushStatus();
  });

  ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", "12000", "-ac", "1", "-i", "pipe:0",
    "-c:a", "libmp3lame", "-b:a", "64k",
    "-flush_packets", "1", "-f", "mp3", "pipe:1", // flush each frame so the stream isn't block-buffered
  ], { stdio: ["pipe", "pipe", "ignore"] });

  rtl.stdout.pipe(ff.stdin);
  ff.stdout.on("data", (chunk) => {
    for (const res of audioClients) {
      try {
        res.write(chunk);
      } catch {}
    }
  });
  ff.on("error", (e) => {
    lastError = `ffmpeg failed: ${e.message}`;
    pushStatus();
  });

  pushStatus();
}

function stopMode() {
  stopAll();
  mode = "idle";
  pushStatus();
}

// Prune stale aircraft + push the live set once per second.
setInterval(() => {
  if (mode === "map") {
    const now = Date.now();
    for (const [hex, a] of aircraft) {
      if (now - a.seen > AIRCRAFT_TTL) aircraft.delete(hex);
    }
    broadcast("aircraft", [...aircraft.values()]);
  }
}, 1000);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function serveStatic(res, file, type) {
  try {
    const body = await readFile(join(__dirname, "public", file));
    res.writeHead(200, { "Content-Type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === "/") return serveStatic(res, "index.html", "text/html; charset=utf-8");

  if (p === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    sseClients.add(res);
    sseSend(res, "status", statusPayload());
    if (mode === "map") sseSend(res, "aircraft", [...aircraft.values()]);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (p === "/audio") {
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    audioClients.add(res);
    req.on("close", () => audioClients.delete(res));
    return;
  }

  if (p === "/api/mode" && req.method === "POST") {
    const body = await readBody(req);
    if (body.mode === "map") startMap(body.source);
    else if (body.mode === "listen")
      startListen(body.freq ?? 124.0, body.gain ?? "agc", body.squelch ?? 0);
    else stopMode();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(statusPayload()));
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`plane-radio listening on http://localhost:${PORT}`);
});

process.on("SIGINT", () => {
  stopAll();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopAll();
  process.exit(0);
});
