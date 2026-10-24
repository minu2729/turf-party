# Turf Party

A territory game for you and your friends. Make a private room, share the 4-letter code or link, and up to 20 friends play on the same map. Bots can fill empty space.

You do **not** need to buy a domain or pay for hosting. Pick one option below.

---

## Option A: Free link on Render (recommended, works on any phone)

You get a free link like `https://turf-party-xxxx.onrender.com` to send to friends.

1. **Put the files on GitHub** (free account at github.com).
   - Click **New repository**, name it `turf-party`, keep it Public, click **Create**.
   - Click **uploading an existing file**, drag in everything from this folder (`server.js`, `package.json`, the `public` folder, the rest), and click **Commit changes**.
2. **Create the Render service** (free account at render.com, sign in with GitHub, no card needed).
   - **New +** then **Web Service**, pick your `turf-party` repository.
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Region: **Singapore** (closest to Bangladesh, so the game feels faster)
   - Instance type: **Free**
   - Click **Create Web Service**. After a minute or two the link appears at the top.
3. Open the link, tap **Create a private room**, then **Invite friends** and send the link or code.

Good to know about the free plan:
- The server goes to sleep after 15 minutes with nobody connected. The next person to open the link waits about a minute while it wakes up. While you are playing, it stays awake.
- Rooms live in the server's memory. If the server restarts, rooms end and you create a new one.

## Option B: Run on your own computer

Needs Node.js 18 or newer (nodejs.org).

```
npm install
npm start
```

Open http://localhost:3000. Friends on the same Wi-Fi can open `http://YOUR-COMPUTER-IP:3000`.

To let friends join from anywhere without any account, run a free tunnel in a second window (cloudflared from cloudflare.com):

```
cloudflared tunnel --url http://localhost:3000
```

It prints a public `https://....trycloudflare.com` link. Send that link to friends. It stops working when you close the window.

## Solo practice file only

`node build-practice.js` writes `practice.html`, a single file that plays against bots with no server.

## How to play

- **Phone:** touch and drag anywhere, like a joystick. Your square glides toward wherever you point.
- **Computer:** hold the mouse and drag, or use the arrow keys / WASD.
- Steer in any direction, make circles, draw any shape. **Crossing your own line is safe.**
- Leave your land, loop back home, and everything you enclosed becomes yours.
- The map edge is safe: you just slide along it.
- **Eliminate a player and you take over all of their land.** Your line and theirs turn into land too, so what you win is joined to your own territory.
- **The round ends when someone owns half the map.** Everyone sees the winner and the top 5, then a new round starts after 10 seconds. Everyone stays in the room.
- If someone touches your trail, you are out. Touch theirs to eliminate them.

## Tuning

All in `public/game.js` (top of the file):

- **Speed:** `SPEED` (units per tick, default 1.1).
- **How sharply you can turn:** `TURN` (radians per tick, default 0.21). Higher is snappier.
- **How much of the map wins the round:** `WIN_SHARE` (default 0.5 = half). `OVER_TICKS` is how long the winner screen stays.
- **Starting land size:** `SPAWN_R`.
- **How close you must get to a trail to cut it:** `HIT_R`.

In `server.js`:

- **Map sizes:** `SIZES` (in units; a player head is about 5 units wide).
- **Max friends per room:** `MAX_HUMANS`.

Colors, names and look live in `public/index.html` and the `PALETTE` list in `public/game.js`.

## Files

- `public/game.js`: the game rules (same code runs on the server and in the browser)
- `public/index.html`: menus, drawing, controls
- `server.js`: rooms and live connections
- `tests/`: automatic checks (`npm test` runs the rules check; `node tests/server-smoke.js` and `node tests/load-test.js` check the live server)
