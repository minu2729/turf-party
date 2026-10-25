// Runs the engine with bots + wandering "humans" and checks that
//  (a) the engine's own bookkeeping is consistent, and
//  (b) a ClientWorld fed only with network messages ends up identical to the server.
const G = require('../public/game.js');

function check(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
}

function run(size, bots, steps) {
  const game = new G.Game(size);
  const W = game.W;
  const human = game.addPlayer('Tester', false);
  for (let i = 0; i < bots; i++) game.addPlayer(null, true);

  let world = new G.ClientWorld(JSON.parse(JSON.stringify(game.snapshot())));
  let lateJoin = null;
  let deaths = 0, claims = 0, maxCount = 0, maxStepMs = 0, takeovers = 0, ends = 0, rounds = 0;
  let spin = 0; // the human sometimes circles forever to test own-trail contact

  for (let s = 0; s < steps; s++) {
    if (Math.random() < 0.08) spin = (Math.random() < 0.3) ? 40 : 0;
    if (human.alive) {
      if (spin > 0) { spin--; game.setTarget(human.id, human.a + 1.2); }
      else if (Math.random() < 0.1) game.setTarget(human.id, Math.random() * 6.28 - 3.14);
    }
    if (!human.alive && Math.random() < 0.2) game.respawn(human.id);
    if (s === Math.floor(steps / 3)) {
      lateJoin = game.addPlayer('Late', false);
      world = new G.ClientWorld(JSON.parse(JSON.stringify(game.snapshot())));
    }
    if (s === Math.floor(steps / 2) && lateJoin) game.removePlayer(lateJoin.id);
    if (lateJoin && lateJoin.alive && Math.random() < 0.15) game.setTarget(lateJoin.id, Math.random() * 6.28 - 3.14);

    const before = new Map();
    game.players.forEach((p) => before.set(p.id, p.count));
    const t0 = process.hrtime.bigint();
    const ev = game.step();
    maxStepMs = Math.max(maxStepMs, Number(process.hrtime.bigint() - t0) / 1e6);
    deaths += ev.d.length;
    // whoever cuts a player off takes over their land
    ev.d.forEach(([victim, killer]) => {
      const kp = game.players.get(killer);
      if (killer && kp && kp.alive && before.get(victim) > 0) {
        check(ev.tk.some((c) => c[0] === killer), 'killer did not get the victim land');
        takeovers++;
      }
      const vp = game.players.get(victim);
      if (vp) check(vp.count === 0, 'victim still owns land');
    });
    claims += ev.c.length;
    if (ev.end) ends++;
    if (ev.rs) { rounds++; world = new G.ClientWorld(JSON.parse(JSON.stringify(game.snapshot()))); }
    else world.apply(JSON.parse(JSON.stringify(ev)));

    const full = s % 7 === 0 || s === steps - 1;
    const counts = new Map();
    if (full) {
      for (let i = 0; i < game.owner.length; i++) {
        const o = game.owner[i];
        if (o) counts.set(o, (counts.get(o) || 0) + 1);
      }
    }
    game.players.forEach((p) => {
      if (full) check((counts.get(p.id) || 0) === p.count, `count mismatch for ${p.name} at step ${s}: ${counts.get(p.id) || 0} vs ${p.count}`);
      if (p.alive) {
        check(p.x >= 0 && p.y >= 0 && p.x < size && p.y < size, `player out of bounds ${p.x},${p.y}`);
        check(Math.abs(p.a) <= Math.PI + 1e-9, 'angle range');
        // the trail's last cell is right under the head
        if (p.trail.length) {
          const hc = Math.floor(p.y * 2) * W + Math.floor(p.x * 2);
          check(p.trail[p.trail.length - 1] === hc || game.owner[hc] === p.id || game.trail[hc] === p.id, `head not at end of trail (${p.name}, step ${s})`);
          check(p.pts.length >= 4 && p.pts.length % 2 === 0, 'pts shape');
          check(p.pts[p.pts.length - 2] === p.x && p.pts[p.pts.length - 1] === p.y, 'pts end is not the head');
        } else {
          check(p.pts.length === 0, 'pts without trail');
        }
        maxCount = Math.max(maxCount, p.count);
      } else {
        check(p.count === 0 && p.trail.length === 0 && p.pts.length === 0, 'dead player kept state');
      }
      // the trail is one connected line (every cell touches another trail cell or the player's land)
      if (full) {
        for (const c of p.trail) {
          const nb = [c - 1, c + 1, c - W, c + W];
          check(nb.some((q) => q >= 0 && q < game.owner.length && (game.trail[q] === p.id || game.owner[q] === p.id)), `loose trail cell for ${p.name} at step ${s}`);
        }
      }
    });
    if (full) {
      let trailCells = 0;
      for (let i = 0; i < game.trail.length; i++) if (game.trail[i]) trailCells++;
      let expected = 0;
      game.players.forEach((p) => { expected += p.trail.length; });
      check(trailCells === expected, `stray trail cells: ${trailCells} vs ${expected} at step ${s}`);
    }

    // (b) client mirror
    check(world.owner.length === game.owner.length, 'size');
    if (full) {
      for (let i = 0; i < game.owner.length; i++) {
        if (world.owner[i] !== game.owner[i]) check(false, `owner mismatch at cell ${i} step ${s}: client ${world.owner[i]} server ${game.owner[i]}`);
      }
    }
    game.players.forEach((p) => {
      const c = world.players.get(p.id);
      check(!!c, `client missing player ${p.name}`);
      check(c.alive === p.alive, `alive mismatch ${p.name}`);
      if (p.alive) {
        check(c.x === p.x && c.y === p.y, `position mismatch ${p.name} step ${s}`);
        check(c.count === p.count, `client count mismatch ${p.name}`);
        check(JSON.stringify(c.pts) === JSON.stringify(p.pts), `trail line mismatch ${p.name} step ${s}`);
      }
    });
    check(world.players.size === game.players.size, 'player set mismatch');
  }
  return { deaths, claims, maxCount, selfCross: game.selfHits, maxStepMs, takeovers, ends, rounds };
}

// walls are safe: a player driving into every wall stays alive and just slides along it
{
  const g = new G.Game(160);
  const me = g.addPlayer('Wall', false);
  for (const ang of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.8, 2.4, -2.4, -0.8]) {
    g.setTarget(me.id, ang);
    for (let i = 0; i < 400; i++) {
      g.step();
      check(me.alive, 'touching the wall must not kill');
      check(me.x >= 0 && me.y >= 0 && me.x <= 160 && me.y <= 160, 'stayed inside the map');
    }
  }
  console.log('wall test ok (speed ' + (G.SPEED * 24).toFixed(1) + ' units/s)');
}

// a loop that runs along the wall captures the strip between it and the wall (no gap at the border)
{
  const g = new G.Game(160);
  const me = g.addPlayer('Edge', false);
  // wipe the random start land, then give the player a block of land against the left wall
  for (let i = 0; i < g.owner.length; i++) if (g.owner[i] === me.id) g.owner[i] = 0;
  me.count = 0; g.bb = {};
  for (let y = 120; y < 200; y++) for (let x = 0; x < 40; x++) g._setOwner(me, y * g.W + x);
  me.x = me.px = 10; me.y = me.py = 80; me.a = me.tg = -Math.PI / 2;
  const c0 = me.count;
  const wps = [[-9, 62], [-9, 40], [28, 40], [28, 66], [10, 72]];   // the first two push into the wall
  let wi = 0;
  for (let i = 0; i < 2000 && wi < wps.length; i++) {
    const w = wps[wi];
    if (w[0] < 0 ? (me.x <= 1.01 && Math.abs(me.y - w[1]) < 3) : Math.hypot(w[0] - me.x, w[1] - me.y) < 3) wi++;
    if (wi < wps.length) g.setTarget(me.id, Math.atan2(wps[wi][1] - me.y, wps[wi][0] - me.x));
    g.step();
    check(me.alive, 'wall lasso died');
  }
  check(wi === wps.length, 'wall lasso never finished');
  let gap = 0;
  for (let y = 90; y < 116; y++) if (g.owner[y * g.W] !== me.id) gap++;   // wall column, units 45..58
  check(me.count > c0 + 800, 'wall lasso captured nothing: ' + c0 + ' -> ' + me.count);
  check(gap === 0, 'gap left between the loop and the wall: ' + gap + ' cells');
  console.log('wall lasso ok: land ' + c0 + ' -> ' + me.count + ', no gap at the wall');
}

// cutting a player off joins their land to yours: one connected territory, no gap, line included
function components(game, id) {
  const W = game.W, seen = new Uint8Array(game.owner.length);
  let n = 0;
  for (let i = 0; i < game.owner.length; i++) {
    if (game.owner[i] !== id || seen[i]) continue;
    n++;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const c = st.pop(), x = c % W;
      for (const q of [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, c - W, c + W]) {
        if (q >= 0 && q < game.owner.length && !seen[q] && game.owner[q] === id) { seen[q] = 1; st.push(q); }
      }
    }
  }
  return n;
}
{
  const g = new G.Game(160);
  const A = g.addPlayer('Killer', false), B = g.addPlayer('Victim', false);
  for (let i = 0; i < g.owner.length; i++) g.owner[i] = 0;
  for (const p of [A, B]) { p.count = 0; p.trail = []; p.pts = []; }
  g.bb = {}; g.dirty = {}; g._cd = {};
  const block = (p, x0, x1) => { for (let y = 140; y < 180; y++) for (let x = x0 * 2; x < x1 * 2; x++) g._setOwner(p, y * g.W + x); };
  block(A, 20, 40); block(B, 100, 120);
  A.x = A.px = 40; A.y = A.py = 80; A.a = A.tg = -0.4;
  B.x = B.px = 100; B.y = B.py = 80; B.a = B.tg = -2.1;
  const a0 = A.count, b0 = B.count;
  let died = -1;
  for (let i = 0; i < 160 && died < 0; i++) {
    g.setTarget(A.id, Math.atan2(45 - A.y, 100 - A.x));
    g.setTarget(B.id, Math.atan2(30 - B.y, 70 - B.x));
    const ev = g.step();
    if (ev.d.length) { died = i; check(ev.d[0][0] === B.id && ev.d[0][1] === A.id, 'expected the killer to win: ' + JSON.stringify(ev.d)); }
  }
  check(died >= 0, 'victim was never cut off');
  check(!B.alive && B.count === 0, 'victim should be gone');
  check(A.alive && A.count > a0 + b0, 'killer should hold both lands and the line: ' + a0 + '+' + b0 + ' -> ' + A.count);
  check(components(g, A.id) === 1, 'killer land is split into ' + components(g, A.id) + ' pieces');
  check(A.trail.length === 0 && A.pts.length === 0, 'killer line should have been joined to the land');
  for (let i = 0; i < g.owner.length; i++) check(g.owner[i] !== B.id, 'victim cells left over');
  console.log('join test ok: ' + a0 + ' + ' + b0 + ' -> ' + A.count + ' cells, one piece');
}

// a round ends when someone owns half the map, the world freezes, then a new round starts
{
  const g = new G.Game(160);
  const A = g.addPlayer('Champ', false), B = g.addPlayer('Rival', true);
  const need = Math.ceil(G.WIN_SHARE * g.W * g.H);
  let idx = 0;
  for (; A.count < need - 5; idx++) if (g.owner[idx] === 0) g._setOwner(A, idx);
  let ev = g.step();
  check(!ev.end && !g.over, 'round must not end below the goal');
  for (; A.count < need; idx++) if (g.owner[idx] === 0) g._setOwner(A, idx);
  ev = g.step();
  check(ev.end && ev.end.id === A.id && g.over, 'round should end when someone reaches the goal');
  check(g.snapshot().end && g.snapshot().end.id === A.id, 'late joiners should see the winner screen');
  const ax = A.x, ay = A.y, bx = B.x, by = B.y;
  let reset = false;
  for (let i = 0; i < G.OVER_TICKS + 5 && !reset; i++) {
    A.tg = A.a + 1;
    ev = g.step();
    if (ev.rs) { reset = true; break; }
    check(A.x === ax && A.y === ay && B.x === bx && B.y === by, 'the world must stand still while the winner is shown');
  }
  check(reset, 'a new round never started');
  check(!g.over && A.alive && B.alive && A.kills === 0, 'new round state is wrong');
  let owned = 0;
  for (let i = 0; i < g.owner.length; i++) if (g.owner[i]) owned++;
  check(owned === A.count + B.count && A.count < need / 4, 'map should be fresh: ' + owned + ' cells for ' + (A.count + B.count));
  for (let i = 0; i < 100; i++) g.step();
  check(!g.over && g.players.size === 2, 'the new round should be playable');
  console.log('round test ok: goal ' + need + ' cells, winner shown, frozen, new round started');
}

const total = { deaths: 0, claims: 0, maxCount: 0, selfCross: 0, takeovers: 0, ends: 0, rounds: 0 };
for (const cfg of [[160, 5, 4000], [220, 8, 4000], [300, 10, 2500], [160, 0, 2500]]) {
  const r = run(cfg[0], cfg[1], cfg[2]);
  console.log(`size ${cfg[0]} bots ${cfg[1]} steps ${cfg[2]} -> deaths ${r.deaths}, captures ${r.claims}, biggest ${r.maxCount} cells, self-crossings survived ${r.selfCross}, slowest tick ${r.maxStepMs.toFixed(1)} ms`);
  total.deaths += r.deaths; total.claims += r.claims; total.maxCount = Math.max(total.maxCount, r.maxCount); total.selfCross += r.selfCross; total.takeovers += r.takeovers; total.ends += r.ends; total.rounds += r.rounds;
}
check(total.claims > 40, 'bots barely capture anything');
check(total.deaths > 5, 'nobody ever dies?');
check(total.takeovers > 10, 'killers never took over land');
check(total.selfCross > 0, 'never tested crossing your own line');
console.log('kills that transferred land:', total.takeovers, '| rounds won:', total.ends, '| new rounds started:', total.rounds);
check(total.ends > 0, 'no round was ever won in the long runs');
console.log('ALL OK');
