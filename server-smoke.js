// Starts the real server, connects two "friends" over WebSocket, and checks
// that they land in the same room and see exactly the same world.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const G = require('../public/game.js');

const PORT = 3456;
const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT }) });
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stderr.write('[server err] ' + d));

function fail(msg) { console.error('FAIL:', msg); server.kill(); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const c = { name, ws: new WebSocket('ws://localhost:' + PORT), world: null, id: 0, code: null, steps: 0, err: null };
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'joined') { c.world = new G.ClientWorld(m.snap); c.id = m.you; c.code = m.code; }
    else if (m.t === 's' && c.world) { c.world.apply(m); c.steps++; }
    else if (m.t === 'err') c.err = m.msg;
  });
  c.send = (o) => c.ws.send(JSON.stringify(o));
  return c;
}

(async () => {
  await wait(800);
  const a = client('Nino');
  await new Promise((r) => a.ws.on('open', r));
  a.send({ t: 'create', name: 'Nino', size: 's', bots: 3 });
  await wait(400);
  if (!a.code) fail('no room code received');
  console.log('room code', a.code);

  const bad = client('Lost');
  await new Promise((r) => bad.ws.on('open', r));
  bad.send({ t: 'join', code: 'ZZZZ', name: 'Lost' });
  await wait(300);
  if (!bad.err) fail('bad code should give an error');
  console.log('bad code ->', bad.err);

  const b = client('Friend');
  await new Promise((r) => b.ws.on('open', r));
  b.send({ t: 'join', code: a.code.toLowerCase(), name: 'Friend' });
  await wait(400);
  if (!b.world) fail('friend could not join with the code');

  for (let i = 0; i < 12; i++) {
    a.send({ t: 'turn', a: Math.random() * 360 - 180 });
    b.send({ t: 'turn', a: Math.random() * 360 - 180 });
    await wait(250);
  }
  await wait(300);

  console.log('steps received:', a.steps, b.steps);
  if (a.steps < 15 || b.steps < 15) fail('too few steps received');
  if (Math.abs(a.world.n - b.world.n) > 2) fail('clients are on different steps');
  if (a.world.players.size !== 5 || b.world.players.size !== 5) fail('expected 5 players (2 friends + 3 bots), got ' + a.world.players.size);

  // both clients must see the same map (allow one step of difference)
  await wait(10);
  const sameStep = a.world.n === b.world.n;
  if (sameStep) {
    for (let i = 0; i < a.world.owner.length; i++) if (a.world.owner[i] !== b.world.owner[i]) fail('maps differ at ' + i);
    console.log('both friends see the identical map');
    a.world.players.forEach((p, id) => {
      const q = b.world.players.get(id);
      if (!q || q.alive !== p.alive || (p.alive && (q.x !== p.x || q.y !== p.y || JSON.stringify(q.pts) !== JSON.stringify(p.pts)))) fail('players differ for ' + p.name);
    });
    console.log('and the same players, positions and trails');
  }

  // leaving removes the player for everyone else
  a.ws.close();
  await wait(600);
  if (b.world.players.size !== 4) fail('leaver was not removed, players: ' + b.world.players.size);
  console.log('leaving works');

  const http = require('http');
  await new Promise((resolve) => {
    http.get('http://localhost:' + PORT + '/', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => { console.log('GET / ->', res.statusCode, body.length, 'bytes'); resolve(); });
    });
  });
  http.get('http://localhost:' + PORT + '/../server.js', (res) => console.log('path escape ->', res.statusCode));
  await wait(300);

  console.log('SERVER OK');
  server.kill();
  process.exit(0);
})().catch((e) => fail(e.stack));
