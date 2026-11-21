// Group Think: zero-dependency Node server (HTTP + Server-Sent Events)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const HOST_PASSWORD = process.env.HOST_PASSWORD || "changeme";

const game = { round: 0, phase: "lobby", question: "", endsAt: 0, duration: 60, answers: {}, rounds: [], scores: {} };
const players = {};          // pid -> {name}
const tokens = new Set();    // valid host tokens
const clients = new Set();   // {res, pid, token}
let timer = null;

const norm = s => {
  let t = String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().replace(/^(a|an|the) /, "");
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
};

function score() {
  const groups = {};
  for (const [pid, ans] of Object.entries(game.answers)) {
    const k = norm(ans);
    if (!k) continue;
    (groups[k] = groups[k] || []).push({ pid, ans });
  }
  const result = Object.values(groups).map(list => {
    const c = {};
    list.forEach(x => c[x.ans.trim()] = (c[x.ans.trim()] || 0) + 1);
    const label = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    return { label, pts: list.length, pids: list.map(x => x.pid) };
  }).sort((a, b) => b.pts - a.pts);
  return result;
}

function reveal() {
  if (game.phase !== "playing") return;
  clearTimeout(timer);
  const groups = score();
  groups.forEach(g => g.pids.forEach(pid => game.scores[pid] = (game.scores[pid] || 0) + g.pts));
  game.rounds[game.round] = groups;
  game.phase = "results";
  broadcast();
}

function view(c) {
  const pid = c.pid;
  const v = {
    round: game.round, phase: game.phase, question: game.question, duration: game.duration,
    remaining: Math.max(0, game.endsAt - Date.now()),
    players: Object.entries(players).map(([id, p]) => ({ id, name: p.name })),
    answeredCount: Object.keys(game.answers).length,
    joined: !!players[pid],
    mine: game.phase === "playing" ? (game.answers[pid] || "") : "",
    isHost: tokens.has(c.token),
    leaderboard: Object.entries(game.scores).map(([id, s]) => ({ id, name: players[id] ? players[id].name : "Someone", score: s })).sort((a, b) => b.score - a.score).slice(0, 15),
  };
  if (game.phase === "results") {
    const groups = game.rounds[game.round] || [];
    v.results = groups.map(g => ({ label: g.label, pts: g.pts, names: g.pids.map(id => players[id] ? players[id].name : "Someone") }));
    const mg = groups.find(g => g.pids.includes(pid));
    v.myPoints = mg ? mg.pts : null;
    v.answered = game.answers[pid] !== undefined;
  }
  return v;
}

function send(c) { c.res.write("data: " + JSON.stringify(view(c)) + "\n\n"); }
function broadcast() { clients.forEach(send); }

function body(req) {
  return new Promise(resolve => {
    let d = "";
    req.on("data", ch => { d += ch; if (d.length > 10000) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
  });
}

const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    const c = { res, pid: url.searchParams.get("pid") || "", token: url.searchParams.get("token") || "" };
    clients.add(c);
    send(c);
    req.on("close", () => clients.delete(c));
    return;
  }
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  }
  if (req.method !== "POST") { res.writeHead(404); return res.end(); }

  const b = await body(req);
  const hostOnly = () => {
    if (!tokens.has(req.headers["x-token"])) { json(res, 403, { error: "not host" }); return false; }
    return true;
  };

  switch (url.pathname) {
    case "/join": {
      const name = String(b.name || "").trim().slice(0, 24);
      if (!b.pid || !name) return json(res, 400, { error: "bad" });
      players[String(b.pid).slice(0, 40)] = { name };
      broadcast();
      return json(res, 200, { ok: true });
    }
    case "/answer": {
      if (game.phase !== "playing" || Date.now() > game.endsAt || !players[b.pid]) return json(res, 400, { error: "closed" });
      game.answers[b.pid] = String(b.answer || "").trim().slice(0, 60);
      broadcast();
      return json(res, 200, { ok: true });
    }
    case "/host/login": {
      const a = Buffer.from(String(b.password || "")), p = Buffer.from(HOST_PASSWORD);
      if (a.length !== p.length || !crypto.timingSafeEqual(a, p)) return json(res, 403, { error: "wrong password" });
      const t = crypto.randomBytes(16).toString("hex");
      tokens.add(t);
      return json(res, 200, { token: t });
    }
    case "/host/start": {
      if (!hostOnly()) return;
      const q = String(b.question || "").trim().slice(0, 200);
      if (!q) return json(res, 400, { error: "no question" });
      const dur = [30, 60, 90, 120].includes(+b.duration) ? +b.duration : 60;
      game.round++; game.phase = "playing"; game.question = q; game.duration = dur;
      game.endsAt = Date.now() + dur * 1000; game.answers = {};
      clearTimeout(timer);
      timer = setTimeout(reveal, dur * 1000 + 1500);
      broadcast();
      return json(res, 200, { ok: true });
    }
    case "/host/end": if (!hostOnly()) return; reveal(); return json(res, 200, { ok: true });
    case "/host/next": if (!hostOnly()) return; if (game.phase === "results") { game.phase = "lobby"; broadcast(); } return json(res, 200, { ok: true });
    case "/host/new": {
      if (!hostOnly()) return;
      clearTimeout(timer);
      Object.assign(game, { round: 0, phase: "lobby", question: "", endsAt: 0, answers: {}, rounds: [], scores: {} });
      broadcast();
      return json(res, 200, { ok: true });
    }
  }
  res.writeHead(404); res.end();
});

setInterval(() => clients.forEach(c => c.res.write(": ping\n\n")), 20000);
server.listen(PORT, () => console.log("Group Think running on port " + PORT));
