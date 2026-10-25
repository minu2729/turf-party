// 20 friends + 6 bots in one large room: checks tick rate, message size and server load.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const PORT = 3461;
const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT }) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(800);
  const clients = [];
  let code = null;
  for (let i = 0; i < 20; i++) {
    const c = { ws: new WebSocket('ws://localhost:' + PORT), msgs: 0, bytes: 0 };
    c.ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'joined') code = m.code;
      else { c.msgs++; c.bytes += raw.length; }
    });
    await new Promise((r) => c.ws.on('open', r));
    c.ws.send(JSON.stringify(i === 0 ? { t: 'create', name: 'P0', size: 'l', bots: 6 } : { t: 'join', code, name: 'P' + i }));
    await wait(120);
    clients.push(c);
  }
  const t0 = Date.now();
  const dirTimer = setInterval(() => clients.forEach((c) => c.ws.send(JSON.stringify({ t: 'turn', a: Math.random() * 360 - 180 }))), 400);
  clients.forEach((c) => { c.msgs = 0; c.bytes = 0; });
  await wait(10000);
  clearInterval(dirTimer);
  const secs = (Date.now() - t0) / 1000;
  const avgMsgs = clients.reduce((a, c) => a + c.msgs, 0) / clients.length / secs;
  const avgKB = clients.reduce((a, c) => a + c.bytes, 0) / clients.length / secs / 1024;
  console.log(`room ${code}: ${clients.length} friends, each got ${avgMsgs.toFixed(1)} updates/s, ${avgKB.toFixed(1)} KB/s`);
  const cpu = await new Promise((resolve) => {
    require('child_process').exec('ps -o %cpu= -p ' + server.pid, (e, out) => resolve(out.trim()));
  });
  console.log('server CPU %:', cpu);
  if (avgMsgs < 22 || avgMsgs > 26) { console.error('FAIL tick rate'); server.kill(); process.exit(1); }
  console.log('LOAD OK');
  server.kill(); process.exit(0);
})();
