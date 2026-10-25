/* Turf Party - game engine shared by the server and the browser.
 *
 * Movement is free: every player glides forward at a constant speed and turns
 * smoothly toward the direction you steer, so you can draw circles, curves and
 * any line you like. Your own trail is harmless. Cut another player's trail
 * and they are out. Leave your land, loop back home and everything you
 * enclosed becomes yours.
 *
 * Positions are in "units" (a player head is about 5 units wide).
 * Land is stored on a fine raster: RES cells per unit.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TurfGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RES = 2;                  // raster cells per unit
  var SPEED = 1.1;              // units per tick
  var TURN = 0.21;              // max turn per tick (radians)
  var WALL = 1.0;               // how close a head can get to the map edge (walls are safe, you just slide)
  var SPAWN_R = 9;              // radius of starting land, in units
  var HIT_R = 2.0;              // how close a head must get to an enemy trail, in units
  var TICK_MS = 1000 / 24;
  var WIN_SHARE = 0.5;          // the round ends when someone owns this share of the map
  var OVER_TICKS = 24 * 10;     // how long the winner screen stays up before the next round
  var TAU = Math.PI * 2;

  var PALETTE = [
    '#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7',
    '#ec4899', '#06b6d4', '#eab308', '#f97316', '#6366f1',
    '#84cc16', '#14b8a6', '#f43f5e', '#0ea5e9', '#d946ef',
    '#10b981', '#fb7185', '#8b5cf6', '#65a30d', '#0891b2'
  ];

  var BOT_NAMES = ['Nova', 'Pixel', 'Turbo', 'Mango', 'Zippy', 'Echo', 'Blaze', 'Comet',
    'Rocket', 'Maple', 'Jelly', 'Ninja', 'Panda', 'Sparky', 'Waffle', 'Otter'];

  /* ---------- helpers ---------- */

  function wrapPi(d) { d = (d + Math.PI) % TAU; if (d < 0) d += TAU; return d - Math.PI; }
  function r2(v) { return Math.round(v * 100) / 100; }

  // list of cell indexes -> [start, length, start, length, ...]
  function rle(list) {
    var a = Int32Array.from(list).sort();
    var out = [], i = 0, n = a.length;
    while (i < n) {
      var s = a[i], l = 1;
      while (i + l < n && a[i + l] === s + l) l++;
      out.push(s, l);
      i += l;
    }
    return out;
  }

  function eachRun(runs, fn) {
    for (var i = 0; i < runs.length; i += 2) {
      var s = runs[i], l = runs[i + 1];
      for (var k = 0; k < l; k++) fn(s + k);
    }
  }

  // grow a bounding box [minx, miny, maxx, maxy] (cell coordinates) by a run of cells
  function growBox(boxes, id, s, l, W) {
    var y0 = (s / W) | 0, y1 = ((s + l - 1) / W) | 0, x0, x1;
    if (y0 === y1) { x0 = s - y0 * W; x1 = x0 + l - 1; } else { x0 = 0; x1 = W - 1; }
    var b = boxes[id];
    if (!b) { boxes[id] = [x0, y0, x1, y1]; return; }
    if (x0 < b[0]) b[0] = x0;
    if (y0 < b[1]) b[1] = y0;
    if (x1 > b[2]) b[2] = x1;
    if (y1 > b[3]) b[3] = y1;
  }

  function info(p) {
    return {
      id: p.id, name: p.name, color: p.color, bot: p.bot, alive: p.alive,
      x: p.x, y: p.y, px: p.px, py: p.py, count: p.count, pts: p.pts.slice()
    };
  }

  /* ---------- Game (authoritative simulation) ---------- */

  function Game(size, opts) {
    this.winShare = (opts && opts.winShare) || WIN_SHARE;
    this.U = size;                 // map side in units
    this.R = RES;
    this.W = this.H = size * RES;  // raster side in cells
    var N = this.W * this.H;
    this.owner = new Int16Array(N); // 0 = nobody, else player id
    this.trail = new Int16Array(N); // 0 = nothing, else player id (thin, for collisions)
    this.players = new Map();
    this.nextId = 1;
    this.n = 0;
    this.over = null;             // set when a round has been won: { id, name, pct, left }
    this.selfHits = 0;            // times a player drove over their own line (and lived)
    this.pend = { spawns: [], claims: [], leaves: [] };
    this.dirty = {};               // owners whose land changed (the renderer redraws these)
    this.bb = {};                  // rough bounding box of each owner's land
    this._cd = {};                 // players whose count changed this tick
    this._vis = new Uint8Array(N);
    this._stack = new Int32Array(N);
  }

  Game.prototype._pickColor = function () {
    var used = {};
    this.players.forEach(function (p) { used[p.color] = true; });
    for (var i = 0; i < PALETTE.length; i++) if (!used[PALETTE[i]]) return PALETTE[i];
    return PALETTE[(Math.random() * PALETTE.length) | 0];
  };

  Game.prototype._botName = function () {
    var used = {};
    this.players.forEach(function (p) { used[p.name] = true; });
    var free = BOT_NAMES.filter(function (n) { return !used[n]; });
    if (!free.length) return BOT_NAMES[(Math.random() * BOT_NAMES.length) | 0] + ((Math.random() * 90 + 10) | 0);
    return free[(Math.random() * free.length) | 0];
  };

  Game.prototype.addPlayer = function (name, bot) {
    var id = this.nextId++;
    if (!name) name = this._botName();
    var p = {
      id: id, name: name, bot: !!bot, color: this._pickColor(),
      alive: false, x: 0, y: 0, px: 0, py: 0, a: 0, tg: 0,
      trail: [], pts: [], count: 0, kills: 0,
      respawnIn: 0, plan: null, hunting: false, hx: 0, hy: 0, skill: 0.6 + Math.random() * 0.9
    };
    this.players.set(id, p);
    this.spawn(p);
    return p;
  };

  Game.prototype.removePlayer = function (id) {
    var p = this.players.get(id);
    if (!p) return;
    if (p.alive) this._kill(p, 0);
    this.players.delete(id);
    this.pend.leaves.push(id);
  };

  Game.prototype.respawn = function (id) {
    var p = this.players.get(id);
    if (p && !p.alive) this.spawn(p);
  };

  // steer toward an angle (radians; 0 = right, PI/2 = down)
  Game.prototype.setTarget = function (id, angle) {
    var p = this.players.get(id);
    if (!p || !p.alive || typeof angle !== 'number' || !isFinite(angle)) return;
    p.tg = wrapPi(angle);
  };

  Game.prototype._free = function (cx, cy, r) {
    var W = this.W;
    for (var dy = -r; dy <= r; dy += 2) {
      var row = (cy + dy) * W;
      for (var dx = -r; dx <= r; dx += 2) {
        var i = row + cx + dx;
        if (this.owner[i] !== 0 || this.trail[i] !== 0) return false;
      }
    }
    return true;
  };

  Game.prototype.spawn = function (p) {
    var U = this.U, W = this.W, R = RES, m = SPAWN_R + 8, x = 0, y = 0, ok = false, tries, r;
    var radii = [(SPAWN_R + 12) * R, (SPAWN_R + 6) * R, (SPAWN_R + 1) * R];
    for (r = 0; r < radii.length && !ok; r++) {
      for (tries = 0; tries < 50; tries++) {
        x = m + Math.random() * (U - 2 * m);
        y = m + Math.random() * (U - 2 * m);
        if (this._free(Math.floor(x * R), Math.floor(y * R), radii[r])) { ok = true; break; }
      }
    }
    if (!ok) { x = m + Math.random() * (U - 2 * m); y = m + Math.random() * (U - 2 * m); }
    p.x = p.px = r2(x);
    p.y = p.py = r2(y);
    // face the middle of the map so nobody starts by hitting a wall
    p.a = wrapPi(Math.atan2(U / 2 - p.y, U / 2 - p.x) + (Math.random() - 0.5) * 1.0);
    p.tg = p.a;
    p.alive = true;
    p.trail = [];
    p.pts = [];
    p.plan = null;
    p.hunting = false;
    p.hx = p.x; p.hy = p.y;
    p.count = 0;
    var cells = [], cx = Math.floor(p.x * R), cy = Math.floor(p.y * R), rc = SPAWN_R * R;
    for (var dy = -rc; dy <= rc; dy++) {
      for (var dx = -rc; dx <= rc; dx++) {
        if (dx * dx + dy * dy <= rc * rc) this._setOwner(p, (cy + dy) * W + (cx + dx), cells);
      }
    }
    this.pend.claims.push([p.id, rle(cells)]);
    this.pend.spawns.push(info(p));
  };

  Game.prototype._setOwner = function (p, idx, claimed) {
    var o = this.owner[idx];
    if (o === p.id) return;
    if (o) {
      var q = this.players.get(o);
      if (q) { q.count--; this._cd[q.id] = 1; }
      this.dirty[o] = 1;
    }
    this.owner[idx] = p.id;
    p.count++;
    this._cd[p.id] = 1;
    this.dirty[p.id] = 1;
    var W = this.W, y = (idx / W) | 0, x = idx - y * W, b = this.bb[p.id];
    if (!b) this.bb[p.id] = [x, y, x, y];
    else {
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
    if (claimed) claimed.push(idx);
  };

  // paint a small round blob of free cells for player k (used to give lines some width)
  Game.prototype._paint = function (k, cx, cy, taken) {
    var W = this.W, x, y;
    for (y = cy - 2; y <= cy + 2; y++) {
      if (y < 0 || y >= W) continue;
      for (x = cx - 2; x <= cx + 2; x++) {
        if (x < 0 || x >= W || (x - cx) * (x - cx) + (y - cy) * (y - cy) > 6) continue;
        if (this.owner[y * W + x] === 0) this._setOwner(k, y * W + x, taken);
      }
    }
  };

  // A player is out. If another player cut them off, the winner takes over all of their land,
  // and the two lines are joined up: the victim's trail and the winner's own trail become land,
  // with a bridge between them, so the new land is connected to the winner's old land.
  Game.prototype._kill = function (p, killer, ev, noLoot) {
    var i, W = this.W, R = RES, b = this.bb[p.id] || [0, 0, W - 1, W - 1], x, y;
    var k = killer && ev && !noLoot ? this.players.get(killer) : null;
    if (k && (!k.alive || k === p)) k = null;
    var taken = k ? [] : null;
    for (i = 0; i < p.trail.length; i++) this.trail[p.trail[i]] = 0;
    for (y = b[1]; y <= b[3]; y++) {
      for (x = b[0], i = y * W + b[0]; x <= b[2]; x++, i++) {
        if (this.owner[i] !== p.id) continue;
        if (k) { this.owner[i] = k.id; taken.push(i); } else this.owner[i] = 0;
      }
    }
    if (k) {
      var kb = this.bb[k.id];
      if (!kb) this.bb[k.id] = [b[0], b[1], b[2], b[3]];
      else {
        if (b[0] < kb[0]) kb[0] = b[0];
        if (b[1] < kb[1]) kb[1] = b[1];
        if (b[2] > kb[2]) kb[2] = b[2];
        if (b[3] > kb[3]) kb[3] = b[3];
      }
      k.count += taken.length;
      this._cd[k.id] = 1;
      this.dirty[k.id] = 1;

      // the victim's line becomes land
      var vt = p.trail, kt = k.trail, best = -1, bd = 1e9;
      var hx = Math.floor(k.x * R), hy = Math.floor(k.y * R);
      for (i = 0; i < vt.length; i++) {
        var vy = (vt[i] / W) | 0, vx = vt[i] - vy * W, dd = (vx - hx) * (vx - hx) + (vy - hy) * (vy - hy);
        if (dd < bd) { bd = dd; best = i; }
        if (i % 2 === 0) this._paint(k, vx, vy, taken);
      }
      // a bridge from the winner's head to the nearest bit of that line
      if (best >= 0) {
        var by = (vt[best] / W) | 0, bx = vt[best] - by * W, n = Math.max(1, Math.max(Math.abs(bx - hx), Math.abs(by - hy)));
        for (i = 0; i <= n; i++) this._paint(k, Math.round(hx + (bx - hx) * i / n), Math.round(hy + (by - hy) * i / n), taken);
      }
      // the winner's own line becomes land too, which also closes everything in between
      for (i = 0; i < kt.length; i += 2) {
        var ky = (kt[i] / W) | 0;
        this._paint(k, kt[i] - ky * W, ky, taken);
      }
      if (taken.length) ev.tk.push([k.id, rle(taken)]);
      if (kt.length) this._close(k, ev);
    }
    p.trail = [];
    p.pts = [];
    p.count = 0;
    p.alive = false;
    p.plan = null;
    this._cd[p.id] = 1;
    this.dirty[p.id] = 1;
    delete this.bb[p.id];
    if (k) k.kills++;
    if (p.bot) p.respawnIn = 72;
  };

  Game.prototype._close = function (p, ev) {
    var W = this.W, H = this.H, owner = this.owner, trail = this.trail;
    var claimed = [], i, x, y;

    // the trail becomes land
    for (i = 0; i < p.trail.length; i++) {
      trail[p.trail[i]] = 0;
      this._setOwner(p, p.trail[i], claimed);
    }
    p.trail = [];
    p.pts = [];

    // everything the outside can reach stays outside; the rest is enclosed.
    // Only the box around this player's land needs searching.
    var bb = this.bb[p.id] || [0, 0, W - 1, H - 1];
    var X0 = Math.max(0, bb[0] - 1), Y0 = Math.max(0, bb[1] - 1);
    var X1 = Math.min(W - 1, bb[2] + 1), Y1 = Math.min(H - 1, bb[3] + 1);
    var vis = this._vis, stack = this._stack, sp = 0;
    for (y = Y0; y <= Y1; y++) vis.fill(0, y * W + X0, y * W + X1 + 1);
    function seed(idx) {
      if (!vis[idx] && owner[idx] !== p.id) { vis[idx] = 1; stack[sp++] = idx; }
    }
    for (x = X0; x <= X1; x++) { seed(Y0 * W + x); seed(Y1 * W + x); }
    for (y = Y0; y <= Y1; y++) { seed(y * W + X0); seed(y * W + X1); }
    while (sp > 0) {
      var c = stack[--sp];
      x = c % W; y = (c / W) | 0;
      if (x > X0) seed(c - 1);
      if (x < X1) seed(c + 1);
      if (y > Y0) seed(c - W);
      if (y < Y1) seed(c + W);
    }
    for (y = Y0; y <= Y1; y++) {
      for (x = X0, i = y * W + X0; x <= X1; x++, i++) {
        if (!vis[i] && owner[i] !== p.id) this._setOwner(p, i, claimed);
      }
    }
    ev.c.push([p.id, rle(claimed)]);     // always sent, even when nothing new was won, so clients end the trail
  };

  // a player's head touched raster cell (cx, cy)
  Game.prototype._touch = function (p, cx, cy, ev) {
    var idx = cy * this.W + cx;
    if (this.owner[idx] === p.id) { if (p.trail.length) this._close(p, ev); return; }
    if (this.trail[idx] === p.id) { this.selfHits++; return; }   // crossing your own line is harmless
    if (!p.trail.length) p.pts = [p.px, p.py];
    this.trail[idx] = p.id;
    p.trail.push(idx);
  };

  // Near a wall the line is extended right up to the wall, so loops that run along the
  // edge capture the strip between them and the wall (no thin gaps left at the border).
  Game.prototype._stub = function (p, cx, cy, ev) {
    var m = Math.ceil(WALL * RES), W = this.W, xs = [cx], ys = [cy], i, j;
    if (cx <= m) { xs = []; for (i = cx; i >= 0; i--) xs.push(i); }
    else if (cx >= W - 1 - m) { xs = []; for (i = cx; i < W; i++) xs.push(i); }
    if (cy <= m) { ys = []; for (j = cy; j >= 0; j--) ys.push(j); }
    else if (cy >= W - 1 - m) { ys = []; for (j = cy; j < W; j++) ys.push(j); }
    if (xs.length === 1 && ys.length === 1) return;
    for (i = 0; i < xs.length; i++) for (j = 0; j < ys.length; j++) {
      if (xs[i] !== cx || ys[j] !== cy) this._touch(p, xs[i], ys[j], ev);
    }
  };

  // walk the raster cells between the previous and the new position
  Game.prototype._advance = function (p, ev) {
    var R = RES, x0 = p.px * R, y0 = p.py * R, dx = p.x * R - x0, dy = p.y * R - y0;
    var n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
    var lx = Math.floor(x0), ly = Math.floor(y0);
    for (var k = 1; k <= n; k++) {
      var cx = Math.floor(x0 + dx * k / n), cy = Math.floor(y0 + dy * k / n);
      if (cx === lx && cy === ly) continue;
      if (cx !== lx && cy !== ly) this._touch(p, cx, ly, ev);   // keep the line 4-connected
      this._touch(p, cx, cy, ev);
      if (p.trail.length) this._stub(p, cx, cy, ev);
      lx = cx; ly = cy;
    }
    if (p.trail.length) { p.pts.push(p.x, p.y); return 1; }
    return 0;
  };

  /* One tick of the whole world. Returns an event object (sent to clients). */
  Game.prototype.step = function () {
    var self = this, U = this.U, W = this.W, R = RES, i, j, p;
    this.n++;

    // a round has been won: the world stands still, then a fresh round starts
    if (this.over) {
      var fz = { n: this.n, lv: this.pend.leaves, sp: this.pend.spawns, c0: this.pend.claims, d: [], tk: [], c: [], m: [], cn: [] };
      this.pend = { spawns: [], claims: [], leaves: [] };
      if (--this.over.left <= 0) {
        this.reset();
        fz = { n: this.n, rs: 1, lv: [], sp: [], c0: [], d: [], tk: [], c: [], m: [], cn: [] };
      }
      return fz;
    }

    // bots that were eliminated come back after a short pause
    this.players.forEach(function (b) {
      if (!b.alive && b.bot && --b.respawnIn <= 0) self.spawn(b);
    });

    var ev = {
      n: this.n,
      lv: this.pend.leaves, sp: this.pend.spawns, c0: this.pend.claims,
      d: [], tk: [], c: [], m: [], cn: []
    };
    this.pend = { spawns: [], claims: [], leaves: [] };

    var alive = [];
    this.players.forEach(function (q) { if (q.alive) alive.push(q); });

    // 1) steer and move everyone
    for (i = 0; i < alive.length; i++) {
      p = alive[i];
      if (p.bot) this._think(p);
      var da = wrapPi(p.tg - p.a);
      if (da > TURN) da = TURN; else if (da < -TURN) da = -TURN;
      p.a = wrapPi(p.a + da);
      p.px = p.x; p.py = p.y;
      p.x = r2(Math.max(WALL, Math.min(U - WALL, p.x + SPEED * Math.cos(p.a))));
      p.y = r2(Math.max(WALL, Math.min(U - WALL, p.y + SPEED * Math.sin(p.a))));
    }

    // 2) deaths (checked against the trails as they were before this tick)
    var dying = new Map(); // id -> killer id (0 = crashed)
    var hr = Math.ceil(HIT_R * R), hr2 = HIT_R * R * HIT_R * R;
    for (i = 0; i < alive.length; i++) {
      p = alive[i];
      var cx = Math.floor(p.x * R), cy = Math.floor(p.y * R);
      for (var dy = -hr; dy <= hr; dy++) {
        var yy = cy + dy;
        if (yy < 0 || yy >= W) continue;
        for (var dx = -hr; dx <= hr; dx++) {
          if (dx * dx + dy * dy > hr2) continue;
          var xx = cx + dx;
          if (xx < 0 || xx >= W) continue;
          var t = this.trail[yy * W + xx];
          if (t !== 0 && t !== p.id && !dying.has(t)) dying.set(t, p.id);
        }
      }
    }
    // head-on: two exposed heads meet, the bigger land survives
    var exposed = [];
    for (i = 0; i < alive.length; i++) {
      p = alive[i];
      if (dying.has(p.id)) continue;
      if (p.trail.length || this.owner[Math.floor(p.y * R) * W + Math.floor(p.x * R)] !== p.id) exposed.push(p);
    }
    for (i = 0; i < exposed.length; i++) {
      for (j = i + 1; j < exposed.length; j++) {
        var a = exposed[i], b = exposed[j];
        if (dying.has(a.id) || dying.has(b.id)) continue;
        var ddx = a.x - b.x, ddy = a.y - b.y;
        if (ddx * ddx + ddy * ddy < 12.96) {
          if (a.count > b.count) dying.set(b.id, a.id);
          else if (b.count > a.count) dying.set(a.id, b.id);
          else { dying.set(a.id, 0); dying.set(b.id, 0); }
        }
      }
    }
    dying.forEach(function (killer, id) {
      var v = self.players.get(id);
      if (!v || !v.alive) return;
      self._kill(v, killer, ev, killer && dying.has(killer));   // a winner who is also out this tick gets nothing
      ev.d.push([id, killer]);
    });

    // 3) survivors lay trail or close their loop
    var flags = [];
    for (i = 0; i < alive.length; i++) {
      p = alive[i];
      if (!p.alive) continue;
      flags.push([p, this._advance(p, ev)]);
    }
    for (i = 0; i < flags.length; i++) {
      p = flags[i][0];
      ev.m.push([p.id, p.x, p.y, flags[i][1]]);
    }
    for (var id in this._cd) {
      var q = this.players.get(+id);
      if (q) ev.cn.push([q.id, q.count]);
    }
    this._cd = {};

    // has someone taken enough of the map to win?
    var total = W * this.H, best = null, goal = this.winShare * total;
    this.players.forEach(function (q) {
      if (q.alive && q.count >= goal && (!best || q.count > best.count)) best = q;
    });
    if (best) {
      this.over = { id: best.id, name: best.name, pct: best.count / total, left: OVER_TICKS };
      ev.end = { id: best.id, name: best.name, pct: best.count / total, left: OVER_TICKS };
    }
    return ev;
  };

  // start a fresh round: empty map, everybody (bots and humans) spawns again
  Game.prototype.reset = function () {
    var self = this;
    this.owner.fill(0);
    this.trail.fill(0);
    this.bb = {};
    this.dirty = {};
    this.over = null;
    this.players.forEach(function (p) {
      p.kills = 0; p.count = 0; p.trail = []; p.pts = []; p.alive = false; p.plan = null; p.respawnIn = 0;
    });
    this.players.forEach(function (p) { self.spawn(p); });
    this.pend = { spawns: [], claims: [], leaves: [] };   // clients get a full snapshot instead
    this._cd = {};
  };

  Game.prototype.snapshot = function () {
    var o = this.owner, N = o.length, i = 0, owner = [], players = [];
    while (i < N) {
      var v = o[i], l = 1;
      while (i + l < N && o[i + l] === v) l++;
      owner.push(v, l);
      i += l;
    }
    this.players.forEach(function (p) { players.push(info(p)); });
    return { n: this.n, U: this.U, owner: owner, players: players, end: this.over ? { id: this.over.id, name: this.over.name, pct: this.over.pct, left: this.over.left } : null };
  };

  /* ---------- Bots ---------- */

  Game.prototype._makePlan = function (p) {
    var U = this.U, k = p.skill, ang = Math.random() * TAU;
    var L = 14 + Math.random() * 38 * k, M = 10 + Math.random() * 30 * k;
    var side = ang + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
    function clamp(v) { return Math.max(9, Math.min(U - 9, v)); }
    var ax = clamp(p.x + Math.cos(ang) * L), ay = clamp(p.y + Math.sin(ang) * L);
    var bx = clamp(ax + Math.cos(side) * M), by = clamp(ay + Math.sin(side) * M);
    return { w: [[ax, ay], [bx, by], [p.hx, p.hy]], i: 0 };
  };

  Game.prototype._think = function (p) {
    var U = this.U, W = this.W, R = RES, i, k;
    var inside = this.owner[Math.floor(p.y * R) * W + Math.floor(p.x * R)] === p.id;
    if (inside) { p.hx = p.x; p.hy = p.y; }

    // keep away from the walls
    var lx = p.x + Math.cos(p.a) * 14, ly = p.y + Math.sin(p.a) * 14;
    if (lx < 8 || ly < 8 || lx > U - 8 || ly > U - 8) {
      p.tg = Math.atan2(U / 2 - p.y, U / 2 - p.x);
      p.plan = null; p.hunting = false;
      return;
    }

    // cut a nearby enemy trail
    if (p.pts.length < 200) {
      var best = 784, bx = 0, by = 0;       // 28 units
      this.players.forEach(function (q) {
        if (q === p || !q.alive || q.pts.length < 6) return;
        for (var j = 0; j < q.pts.length - 2; j += 8) {
          var dx = q.pts[j] - p.x, dy = q.pts[j + 1] - p.y, d = dx * dx + dy * dy;
          if (d < best) { best = d; bx = q.pts[j]; by = q.pts[j + 1]; }
        }
      });
      if (best < 784 && (p.hunting || Math.random() < 0.04)) {
        p.hunting = true;
        p.tg = Math.atan2(by - p.y, bx - p.x);
        return;
      }
    }
    p.hunting = false;

    if (!p.plan && inside && Math.random() < 0.05) p.plan = this._makePlan(p);
    if (p.plan) {
      var wp = p.plan.w[p.plan.i];
      if (Math.hypot(wp[0] - p.x, wp[1] - p.y) < 6.5) {
        p.plan.i++;
        if (p.plan.i >= p.plan.w.length) { p.plan = null; }
        else wp = p.plan.w[p.plan.i];
      }
      if (p.plan) { p.tg = Math.atan2(wp[1] - p.y, wp[0] - p.x); return; }
    }
    if (!inside) p.tg = Math.atan2(p.hy - p.y, p.hx - p.x);   // head home
  };

  /* ---------- ClientWorld (what a browser keeps when playing online) ---------- */

  function ClientWorld(snap) {
    this.U = snap.U;
    this.R = RES;
    this.W = this.H = snap.U * RES;
    this.n = snap.n;
    this.owner = new Int16Array(this.W * this.W);
    this.players = new Map();
    this.dirty = {};
    this.bb = {};
    this.onFx = null;
    var i = 0;
    for (var k = 0; k < snap.owner.length; k += 2) {
      var v = snap.owner[k], l = snap.owner[k + 1];
      if (v) { this.owner.fill(v, i, i + l); growBox(this.bb, v, i, l, this.W); this.dirty[v] = 1; }
      i += l;
    }
    for (var j = 0; j < snap.players.length; j++) this.players.set(snap.players[j].id, snap.players[j]);
  }

  ClientWorld.prototype._wipe = function (id) {
    var o = this.owner;
    for (var i = 0; i < o.length; i++) if (o[i] === id) o[i] = 0;
    delete this.bb[id];
    this.dirty[id] = 1;
  };

  ClientWorld.prototype.apply = function (m) {
    var self = this, o = this.owner, W = this.W;

    function claim(c) {
      var id = c[0], p = self.players.get(id), runs = c[1];
      for (var r = 0; r < runs.length; r += 2) {
        var s = runs[r], l = runs[r + 1];
        for (var q = 0; q < l; q++) {
          var old = o[s + q];
          if (old !== id) { if (old) self.dirty[old] = 1; o[s + q] = id; }
        }
        growBox(self.bb, id, s, l, W);
      }
      self.dirty[id] = 1;
      if (p) p.pts = [];
    }

    (m.lv || []).forEach(function (id) { self._wipe(id); self.players.delete(id); });
    (m.sp || []).forEach(function (s) { s.px = s.x; s.py = s.y; self.players.set(s.id, s); });
    (m.c0 || []).forEach(claim);
    (m.d || []).forEach(function (d) {
      var p = self.players.get(d[0]);
      if (!p) return;
      p.alive = false; p.pts = []; p.count = 0;
      self._wipe(p.id);
    });
    (m.tk || []).forEach(function (c) {          // the winner takes over the land of the player they cut off
      var p = self.players.get(c[0]), pts = p && p.pts;
      claim(c);
      if (p) p.pts = pts;                        // their own trail is untouched
    });
    (m.c || []).forEach(claim);
    (m.m || []).forEach(function (r) {
      var p = self.players.get(r[0]);
      if (!p) return;
      p.px = p.x; p.py = p.y;
      p.x = r[1]; p.y = r[2];
      if (r[3]) {
        if (!p.pts.length) p.pts.push(p.px, p.py);
        p.pts.push(p.x, p.y);
      }
    });
    (m.cn || []).forEach(function (r) {
      var p = self.players.get(r[0]);
      if (p) p.count = r[1];
    });
    this.n = m.n;
    if (this.onFx) this.onFx(m);
  };

  return {
    Game: Game, ClientWorld: ClientWorld, PALETTE: PALETTE,
    RES: RES, SPEED: SPEED, TURN: TURN, WIN_SHARE: WIN_SHARE, OVER_TICKS: OVER_TICKS, TICK_MS: TICK_MS, rle: rle, eachRun: eachRun, wrapPi: wrapPi
  };
});
