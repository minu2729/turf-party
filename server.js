'use strict';
/* Turf Party server: serves the game page and runs private rooms over WebSocket. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./public/game.js');

const PORT = process.env.PORT || 3000;
const STEP_MS = G.TICK_MS;    // 24 ticks per second
const MAX_HUMANS = 20;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SIZES = { s: 160, m: 220, l: 300 }; // map width in units (a player head is ~5 units wide)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
    if (!rooms.has(c)) return c;
  }
}

function cleanName(n) {
  const s = String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 14);
  return s || 'Player';
}

class Room {
  constructor(code, size, bots) {
    this.code = code;
    this.game = new G.Game(size, { winShare: Number(process.env.TURF_WIN_SHARE) || undefined }); // env var only for testing
    this.clients = new Map(); // ws -> player id
    this.emptySince = Date.now();
    for (let i = 0; i < bots; i++) this.game.addPlayer(null, true);
    this.next = Date.now() + STEP_MS;
    this.timer = setTimeout(() => this.loop(), STEP_MS);
  }

  loop() {
    if (this.clients.size > 0) {
      const ev = this.game.step();
      let msg;
      if (ev.rs) {
        // new round: everybody gets a fresh copy of the map
        msg = JSON.stringify({ t: 'round', stepMs: STEP_MS, snap: this.game.snapshot() });
      } else {
        for (const k of ['lv', 'sp', 'c0', 'd', 'tk', 'c', 'cn']) if (!ev[k].length) delete ev[k]; // keep messages tiny
        msg = JSON.stringify(Object.assign({ t: 's' }, ev));
      }
      for (const ws of this.clients.keys()) if (ws.readyState === 1) ws.send(msg);
    }
    this.next += STEP_MS;
    let wait = this.next - Date.now();
    if (wait < -500) { this.next = Date.now(); wait = 0; }
    this.timer = setTimeout(() => this.loop(), Math.max(0, wait));
  }

  join(ws, name) {
    const p = this.game.addPlayer(name, false);
    this.clients.set(ws, p.id);
    ws.room = this;
    ws.send(JSON.stringify({
      t: 'joined', code: this.code, you: p.id, stepMs: STEP_MS, snap: this.game.snapshot()
    }));
  }

  leave(ws) {
    const id = this.clients.get(ws);
    if (id === undefined) return;
    this.clients.delete(ws);
    this.game.removePlayer(id);
    if (this.clients.size === 0) this.emptySince = Date.now();
  }

  humans() { return this.clients.size; }

  destroy() { clearTimeout(this.timer); rooms.delete(this.code); }
}

/* ---------- static files ---------- */
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  let file = path.normalize(path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

/* ---------- websocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.msgs = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    if (++ws.msgs > 60) return; // flood guard (reset every second)
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'create' && !ws.room) {
      const size = SIZES[m.size] || SIZES.m;
      const bots = Math.max(0, Math.min(10, m.bots | 0));
      const room = new Room(newCode(), size, bots);
      rooms.set(room.code, room);
      room.join(ws, cleanName(m.name));
    } else if (m.t === 'join' && !ws.room) {
      const room = rooms.get(String(m.code || '').trim().toUpperCase());
      if (!room) return ws.send(JSON.stringify({ t: 'err', msg: 'Room not found. Check the code.' }));
      if (room.humans() >= MAX_HUMANS) return ws.send(JSON.stringify({ t: 'err', msg: 'That room is full (20 players).' }));
      room.join(ws, cleanName(m.name));
    } else if (m.t === 'turn' && ws.room) {
      const deg = Number(m.a);
      if (Number.isFinite(deg)) ws.room.game.setTarget(ws.room.clients.get(ws), deg * Math.PI / 180);
    } else if (m.t === 'respawn' && ws.room) {
      ws.room.game.respawn(ws.room.clients.get(ws));
    }
  });

  ws.on('close', () => { if (ws.room) ws.room.leave(ws); });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((ws) => { ws.msgs = 0; });
}, 1000);

// keep connections healthy and clean up abandoned rooms
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.clients.size === 0 && now - room.emptySince > 2 * 60 * 1000) room.destroy();
  }
}, 25000);

server.listen(PORT, () => console.log('Turf Party running on port ' + PORT));
